import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import * as command from '../src/server/command.js'
import { CommitStatsCache } from '../src/server/commitStatsCache.js'
import { type CachedCommitStats, resolveCommitSpan, resolvePinnedCommitDiff } from '../src/server/git.js'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function git(root: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'diff-review-stats-cache-'))
  directories.push(root)
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.name', 'Stats Tester'])
  git(root, ['config', 'user.email', 'stats@example.com'])
  return realpathSync(root)
}

function commit(root: string, text: string): string {
  writeFileSync(path.join(root, 'file.txt'), text)
  git(root, ['add', '.'])
  git(root, ['commit', '-m', text.trim()])
  return git(root, ['rev-parse', 'HEAD'])
}

function statsCalls(spy: ReturnType<typeof vi.spyOn<typeof command, 'runCommand'>>) {
  return spy.mock.calls.filter(([cmd, args]) => cmd === 'git' && args.includes('--numstat'))
}

function queriedOids(spy: ReturnType<typeof vi.spyOn<typeof command, 'runCommand'>>) {
  return statsCalls(spy).map(([, args]) => args.filter((arg) => /^[0-9a-f]{40,64}$/.test(arg)))
}

test('reuses unchanged and overlapping histories; index changes conservatively invalidate stats', async () => {
  const root = repository()
  const first = commit(root, 'one\n')
  const second = commit(root, 'one\ntwo\n')
  const third = commit(root, 'one\ntwo\nthree\n')
  const spy = vi.spyOn(command, 'runCommand')
  const initial = await resolveCommitSpan(root, first, second)
  expect(initial.commits.map((c) => c.stats)).toEqual([
    { additions: 1, deletions: 0 }, { additions: 1, deletions: 0 },
  ])
  const callsBeforeWarmRefresh = spy.mock.calls.length
  expect((await resolveCommitSpan(root, first, second)).commits).toEqual(initial.commits)
  expect(spy.mock.calls.slice(callsBeforeWarmRefresh).filter(([, args]) => ['config', 'var'].includes(args[0] ?? ''))).toHaveLength(0)
  const overlap = await resolveCommitSpan(root, second, third)
  expect(overlap.commits.map((c) => c.stats)).toEqual([
    { additions: 1, deletions: 0 }, { additions: 1, deletions: 0 },
  ])
  expect(queriedOids(spy)).toEqual([[first, second], [third]])

  const fourth = commit(root, 'one\ntwo\nthree\nfour\n')
  await resolveCommitSpan(root, first, 'HEAD')
  git(root, ['commit', '--amend', '-m', 'amended subject'])
  const amended = git(root, ['rev-parse', 'HEAD'])
  const amendedReview = await resolveCommitSpan(root, first, 'HEAD')
  expect(amendedReview.commits.at(-1)).toMatchObject({
    oid: amended, subject: 'amended subject', stats: { additions: 1, deletions: 0 },
  })
  expect(queriedOids(spy)).toEqual([[first, second], [third], [first, second, third, fourth], [first, second, third, amended]])
  expect((await resolvePinnedCommitDiff(root, amended, amended)).commits).toEqual([])
  expect(statsCalls(spy)).toHaveLength(4)
  // Even cache hits still read current metadata.
  expect(spy.mock.calls.filter(([, args]) => args.includes('--first-parent') && !args.includes('--numstat'))).toHaveLength(6)
})

test('isolates identical commit OIDs in separate repository roots', async () => {
  const root = repository()
  const oid = commit(root, 'one\n')
  const clone = repository()
  git(clone, ['fetch', root, 'main'])
  git(clone, ['reset', '--hard', 'FETCH_HEAD'])
  const spy = vi.spyOn(command, 'runCommand')
  const original = await resolveCommitSpan(root, oid, oid)
  const copied = await resolveCommitSpan(clone, oid, oid)
  expect(copied.commits).toEqual(original.commits)
  expect(queriedOids(spy)).toEqual([[oid], [oid]])
  expect(statsCalls(spy).map(([, , cwd]) => cwd)).toEqual([root, clone])
})

test('preserves metadata on stats failure and retries rather than caching zero counts', async () => {
  const root = repository()
  const oid = commit(root, 'one\ntwo\n')
  const run = command.runCommand
  let fail = true
  const spy = vi.spyOn(command, 'runCommand').mockImplementation(async (...args) => {
    if (args[1].includes('--numstat') && fail) {
      fail = false
      throw new Error('stats unavailable')
    }
    return run(...args)
  })
  const failed = await resolveCommitSpan(root, oid, oid)
  expect(failed.commits).toHaveLength(1)
  expect(failed.commits[0]).toMatchObject({ oid, subject: 'one two' })
  expect(failed.commits[0]).not.toHaveProperty('stats')
  const retried = await resolveCommitSpan(root, oid, oid)
  expect(retried.commits[0]?.stats).toEqual({ additions: 2, deletions: 0 })
  await resolveCommitSpan(root, oid, oid)
  expect(queriedOids(spy)).toEqual([[oid], [oid]])
})

test('bounds arguments and retains all results when history exceeds LRU capacity', async () => {
  const tinyCache = new CommitStatsCache<CachedCommitStats>(2)
  const get = CommitStatsCache.prototype.get
  const set = CommitStatsCache.prototype.set
  vi.spyOn(CommitStatsCache.prototype, 'get').mockImplementation((root, oid) => get.call(tinyCache, root, oid))
  vi.spyOn(CommitStatsCache.prototype, 'set').mockImplementation((root, oid, stats) => set.call(tinyCache, root, oid, stats))
  const root = repository()
  const first = commit(root, 'root\n')
  const tree = git(root, ['rev-parse', 'HEAD^{tree}'])
  let head = first
  for (let index = 0; index < 129; index++) {
    head = git(root, ['commit-tree', tree, '-p', head, '-m', `empty ${index}`])
  }
  git(root, ['update-ref', 'refs/heads/main', head])
  const spy = vi.spyOn(command, 'runCommand')
  const review = await resolveCommitSpan(root, first, head)
  expect(review.commits).toHaveLength(130)
  expect(review.commits[0]?.stats).toEqual({ additions: 1, deletions: 0 })
  expect(review.commits.slice(1).every((c) => c.stats?.additions === 0 && c.stats.deletions === 0)).toBe(true)
  expect(queriedOids(spy).map((oids) => oids.length)).toEqual([128, 2])
  const repeated = await resolveCommitSpan(root, first, head)
  expect(repeated.commits).toEqual(review.commits)
  // Only the last two stats survived the bounded cache; misses are still batched.
  expect(queriedOids(spy).map((oids) => oids.length)).toEqual([128, 2, 128])
})

test('deepening and re-shallowing invalidate warm boundary-commit stats', async () => {
  const origin = repository()
  commit(origin, 'one\n')
  const boundary = commit(origin, 'one\ntwo\n')
  commit(origin, 'one\ntwo\nthree\n')
  const clone = repository()
  git(clone, ['remote', 'add', 'origin', `file://${origin}`])
  git(clone, ['fetch', '--depth=2', 'origin', 'main'])
  git(clone, ['reset', '--hard', 'FETCH_HEAD'])
  const spy = vi.spyOn(command, 'runCommand')
  expect((await resolveCommitSpan(clone, boundary, boundary)).commits[0]?.stats?.additions).toBe(2)
  await resolveCommitSpan(clone, boundary, boundary)
  expect(statsCalls(spy)).toHaveLength(1)
  git(clone, ['fetch', '--deepen=1', 'origin', 'main'])
  expect((await resolveCommitSpan(clone, boundary, boundary)).commits[0]?.stats?.additions).toBe(1)
  git(clone, ['fetch', '--depth=2', 'origin', 'main'])
  expect((await resolveCommitSpan(clone, boundary, boundary)).commits[0]?.stats?.additions).toBe(2)
  expect(statsCalls(spy)).toHaveLength(3)
})

test('git replace and packed replacement refs invalidate warm stats', async () => {
  const root = repository()
  const oid = commit(root, 'one\n')
  const replacement = commit(root, 'one\ntwo\nthree\n')
  const tree = git(root, ['rev-parse', `${replacement}^{tree}`])
  const replacementRoot = git(root, ['commit-tree', tree, '-m', 'replacement'])
  const spy = vi.spyOn(command, 'runCommand')
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(1)
  await resolveCommitSpan(root, oid, oid)
  expect(statsCalls(spy)).toHaveLength(1)
  git(root, ['replace', oid, replacementRoot])
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(3)
  git(root, ['pack-refs', '--all'])
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(3)
  git(root, ['replace', '-d', oid])
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(1)
  expect(statsCalls(spy)).toHaveLength(4)
})

test('nested missing attributes, info attributes, and index fallback change warm counts', async () => {
  const root = repository()
  mkdirSync(path.join(root, 'sub'))
  writeFileSync(path.join(root, 'sub/file.txt'), 'one\ntwo\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'nested'])
  const oid = git(root, ['rev-parse', 'HEAD'])
  const additions = async () => (await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions
  const spy = vi.spyOn(command, 'runCommand')
  expect(await additions()).toBe(2)
  expect(await additions()).toBe(2)
  expect(statsCalls(spy)).toHaveLength(1)
  const attrs = path.join(root, 'sub/.gitattributes')
  writeFileSync(attrs, '*.txt -diff\n')
  expect(await additions()).toBe(0)
  rmSync(attrs)
  expect(await additions()).toBe(2)
  const info = path.join(root, '.git/info/attributes')
  writeFileSync(info, '*.txt -diff\n')
  expect(await additions()).toBe(0)
  rmSync(info)
  expect(await additions()).toBe(2)
  writeFileSync(attrs, '*.txt -diff\n')
  git(root, ['add', 'sub/.gitattributes'])
  rmSync(attrs)
  // Git versions differ in whether log consults index-only attributes. Match fresh
  // Git rather than imposing index semantics on the historical stats query.
  const fresh = git(root, ['log', '--no-walk=unsorted', '--numstat', '--root', '--diff-merges=first-parent', '--find-renames', '--no-ext-diff', '--format=', oid, '--'])
  const count = /^(\d+|-)\t/.exec(fresh)?.[1]
  expect(count).toBeDefined()
  const expected = count === '-' ? 0 : Number(count)
  expect(await additions()).toBe(expected)
  expect(await additions()).toBe(expected)
  expect(statsCalls(spy)).toHaveLength(6)
})

test('NUL numstat preserves unusual rename paths and tracks both attribute ancestors', async () => {
  const root = repository()
  mkdirSync(path.join(root, 'old'))
  mkdirSync(path.join(root, 'new'))
  const old = 'old/a\twith\nnewline.txt'
  const renamed = 'new/b\twith\nnewline.txt'
  writeFileSync(path.join(root, old), 'one\ntwo\nthree\nfour\nfive\n')
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'before'])
  renameSync(path.join(root, old), path.join(root, renamed))
  writeFileSync(path.join(root, renamed), 'one\ntwo\nthree\nfour\nfive\nsix\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'rename'])
  const oid = git(root, ['rev-parse', 'HEAD'])
  const spy = vi.spyOn(command, 'runCommand')
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats).toEqual({ additions: 1, deletions: 0 })
  await resolveCommitSpan(root, oid, oid)
  expect(statsCalls(spy)).toHaveLength(1)
  // A newly created source-side attribute must invalidate even though that file moved.
  writeFileSync(path.join(root, 'old/.gitattributes'), '*.txt -diff\n')
  await resolveCommitSpan(root, oid, oid)
  expect(statsCalls(spy)).toHaveLength(2)
  writeFileSync(path.join(root, 'new/.gitattributes'), '*.txt -diff\n')
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats).toEqual({ additions: 0, deletions: 0 })
  git(root, ['config', 'diff.renameLimit', '1'])
  await resolveCommitSpan(root, oid, oid)
  expect(statsCalls(spy)).toHaveLength(4)
})

test('effective included config and configured global attributes invalidate warm stats', async () => {
  const root = repository()
  const oid = commit(root, 'one\ntwo\n')
  const include = path.join(root, '.git/included-config')
  const attrs = path.join(root, '.git/global-attrs')
  writeFileSync(include, `[core]\n attributesFile = ${attrs}\n`)
  git(root, ['config', 'include.path', include])
  const additions = async () => (await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions
  const spy = vi.spyOn(command, 'runCommand')
  expect(await additions()).toBe(2)
  expect(await additions()).toBe(2)
  expect(statsCalls(spy)).toHaveLength(1)
  writeFileSync(attrs, '*.txt -diff\n')
  expect(await additions()).toBe(0)
  writeFileSync(include, '[diff]\n renameLimit = 1\n')
  expect(await additions()).toBe(2)
  expect(statsCalls(spy)).toHaveLength(3)
})

test('discovery failure bypasses caching and retries on the next refresh', async () => {
  const root = repository()
  const oid = commit(root, 'one\n')
  const run = command.runCommand
  let fail = true
  const spy = vi.spyOn(command, 'runCommand').mockImplementation(async (...args) => {
    if (args[1][0] === 'config' && fail) {
      fail = false
      throw new Error('config unavailable')
    }
    return run(...args)
  })
  for (let index = 0; index < 3; index++) {
    expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(1)
  }
  expect(statsCalls(spy)).toHaveLength(2)
})

test.each([false, true])('in-flight stats cannot repopulate after dependencies/context change (new refresh: %s)', async (newRefresh) => {
  const root = repository()
  const oid = commit(root, 'one\ntwo\n')
  const run = command.runCommand
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const ready = new Promise<void>((resolve) => { started = resolve })
  let first = true
  const spy = vi.spyOn(command, 'runCommand').mockImplementation(async (...args) => {
    const result = await run(...args)
    if (args[1].includes('--numstat') && first) {
      first = false
      started()
      await blocked
    }
    return result
  })
  const oldRefresh = resolveCommitSpan(root, oid, oid)
  await ready
  try {
    writeFileSync(path.join(root, '.gitattributes'), '*.txt -diff\n')
    if (newRefresh) {
      expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(0)
    }
  } finally { release() }
  expect((await oldRefresh).commits[0]?.stats?.additions).toBe(2)
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(0)
  await resolveCommitSpan(root, oid, oid)
  expect(statsCalls(spy)).toHaveLength(2)
})

test('unsupported replacement namespaces bypass caching without overriding Git semantics', async () => {
  const root = repository()
  const oid = commit(root, 'one\n')
  vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/custom/')
  const spy = vi.spyOn(command, 'runCommand')
  for (let index = 0; index < 2; index++) {
    expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(1)
  }
  expect(statsCalls(spy)).toHaveLength(2)
})

test('mutable attr.tree sources bypass caching and follow ref moves', async () => {
  const root = repository()
  const oid = commit(root, 'one\ntwo\n')
  const attrs = git(root, ['hash-object', '-w', '--stdin'], 'file.txt -diff\n')
  const tree = git(root, ['mktree'], `100644 blob ${attrs}\t.gitattributes\n`)
  const binaryPolicy = git(root, ['commit-tree', tree, '-m', 'binary policy'])
  git(root, ['update-ref', 'refs/heads/attr-policy', oid])
  git(root, ['config', 'attr.tree', 'attr-policy'])
  const spy = vi.spyOn(command, 'runCommand')
  const additions = async () => (await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions
  expect(await additions()).toBe(2)
  expect(await additions()).toBe(2)
  git(root, ['update-ref', 'refs/heads/attr-policy', binaryPolicy])
  expect(await additions()).toBe(0)
  expect(statsCalls(spy)).toHaveLength(3)
  git(root, ['config', '--unset', 'attr.tree'])
  expect(await additions()).toBe(2)
  expect(await additions()).toBe(2)
  expect(statsCalls(spy)).toHaveLength(4)
})

test('metadata relocation rediscovers info attributes instead of watching the old git directory', async () => {
  const root = repository()
  const oid = commit(root, 'one\ntwo\n')
  const external = `${root}-git`
  directories.push(external)
  const spy = vi.spyOn(command, 'runCommand')
  const additions = async () => (await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions
  expect(await additions()).toBe(2)
  git(root, ['init', '--separate-git-dir', external])
  expect(await additions()).toBe(2)
  writeFileSync(path.join(external, 'info/attributes'), 'file.txt -diff\n')
  expect(await additions()).toBe(0)
  expect(await additions()).toBe(0)
  expect(statsCalls(spy)).toHaveLength(3)
})

test('attribute deletion while computing stats prevents stale cache insertion', async () => {
  const root = repository()
  const oid = commit(root, 'one\ntwo\n')
  const attrs = path.join(root, '.gitattributes')
  writeFileSync(attrs, 'file.txt -diff\n')
  const run = command.runCommand
  let remove = true
  const spy = vi.spyOn(command, 'runCommand').mockImplementation(async (...args) => {
    const result = await run(...args)
    if (remove && args[1].includes('--numstat')) {
      remove = false
      rmSync(attrs)
    }
    return result
  })
  const additions = async () => (await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions
  expect(await additions()).toBe(0)
  expect(await additions()).toBe(2)
  expect(await additions()).toBe(2)
  expect(statsCalls(spy)).toHaveLength(2)
})

test('unrelated directory entries do not invalidate existing attribute files', async () => {
  const root = repository()
  const oid = commit(root, 'one\n')
  writeFileSync(path.join(root, '.gitattributes'), 'file.txt diff\n')
  const spy = vi.spyOn(command, 'runCommand')
  await resolveCommitSpan(root, oid, oid)
  writeFileSync(path.join(root, 'unrelated.txt'), 'unrelated\n')
  expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(1)
  expect(statsCalls(spy)).toHaveLength(1)
})

test('oversized replacement namespaces bypass the bounded context scan', async () => {
  const root = repository()
  const oid = commit(root, 'one\n')
  const refs = path.join(root, '.git/refs/replace')
  mkdirSync(refs)
  for (let index = 0; index < 129; index++) {
    writeFileSync(path.join(refs, index.toString(16).padStart(40, '0')), `${oid}\n`)
  }
  const spy = vi.spyOn(command, 'runCommand')
  for (let index = 0; index < 2; index++) {
    expect((await resolveCommitSpan(root, oid, oid)).commits[0]?.stats?.additions).toBe(1)
  }
  expect(statsCalls(spy)).toHaveLength(2)
})

test('LRU evicts the least recently used stats and bounds retention across repositories', () => {
  const cache = new CommitStatsCache(2)
  const stats = { additions: 1, deletions: 2 }
  cache.set('/a', 'one', stats)
  cache.set('/a', 'two', stats)
  expect(cache.get('/a', 'one')).toEqual(stats)
  cache.set('/b', 'one', stats)
  expect(cache.get('/a', 'two')).toBeUndefined()
  expect(cache.get('/a', 'one')).toEqual(stats)
  cache.set('/a', 'one', { additions: 3, deletions: 0 })
  cache.set('/c', 'three', stats)
  expect(cache.get('/b', 'one')).toBeUndefined()
  expect(cache.get('/a', 'one')).toEqual({ additions: 3, deletions: 0 })
})
