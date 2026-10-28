import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

import * as command from '../src/server/command.js'
import { CommitStatsCache } from '../src/server/commitStatsCache.js'
import { resolveCommitSpan, resolvePinnedCommitDiff } from '../src/server/git.js'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
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

test('reuses repeated and overlapping histories, computing only new and amended OIDs', async () => {
  const root = repository()
  const first = commit(root, 'one\n')
  const second = commit(root, 'one\ntwo\n')
  const third = commit(root, 'one\ntwo\nthree\n')
  const spy = vi.spyOn(command, 'runCommand')
  const initial = await resolveCommitSpan(root, first, second)
  expect(initial.commits.map((c) => c.stats)).toEqual([
    { additions: 1, deletions: 0 }, { additions: 1, deletions: 0 },
  ])
  expect((await resolveCommitSpan(root, first, second)).commits).toEqual(initial.commits)
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
  expect(queriedOids(spy)).toEqual([[first, second], [third], [fourth], [amended]])
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
  const tinyCache = new CommitStatsCache(2)
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
