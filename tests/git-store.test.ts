import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, describe, expect, test } from 'vitest'

import {
  getRepositoryInfo,
  resolveCommitSpan,
  resolveSelectedSpan,
  rerenderCommitReview,
  listMergeConflictFiles,
  resolvePullRequestRevision,
  resolveTarget,
  computeReviewFingerprint,
  storedReviewFingerprint,
  stageReviewFile,
  validateAnnotationTarget,
} from '../src/server/git.js'
import { LOCAL_CHANGES_OID } from '../src/shared/types.js'
import { ApiHandler } from '../src/server/api.js'
import { PiReviewRunner } from '../src/server/pi.js'
import { ReviewStore } from '../src/server/store.js'
import { PI_INSTALL_HINT } from '../src/shared/piChat.js'

const fixture = createGitFixture()

afterAll(() => {
  rmSync(fixture.directory, { recursive: true, force: true })
})

describe('Git review targets', () => {
  test('exposes the origin default branch comparison as a first-class range', async () => {
    const repository = await getRepositoryInfo(fixture.repository)

    expect(repository.defaultBranchRef).toBe('origin/main')
    expect(repository.branchRange).toBe('origin/main...HEAD')
  })

  test('resolves a merge-base range and lists only the first-parent timeline', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })

    expect(review.patch).toContain('feature one')
    expect(review.patch).toContain('from side')
    expect(review.commits.map((commit) => commit.subject)).toEqual([
      'feature one',
      'feature two',
      'merge side',
    ])
    expect(review.gitCommand).toBe("git diff 'origin/main...HEAD'")
  })

  test('can omit whitespace-only changes from a review', async () => {
    const review = await resolveTarget(
      fixture.repository,
      { kind: 'range', expression: 'origin/main...HEAD' },
      true,
    )

    expect(review.patch).not.toContain('spacing.txt')
    expect(review.patch).toContain('feature one')
    expect(review.gitCommand).toBe("git diff --ignore-all-space 'origin/main...HEAD'")
  })

  test('re-renders the exact pinned commit snapshots', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const rerendered = await rerenderCommitReview(fixture.repository, review, true)

    expect(rerendered.oldSnapshot).toEqual(review.oldSnapshot)
    expect(rerendered.newSnapshot).toEqual(review.newSnapshot)
    expect(rerendered.commits).toEqual(review.commits)
    expect(rerendered.label).toBe(review.label)
    expect(rerendered.patch).not.toContain('spacing.txt')
    expect(rerendered.gitCommand).toContain('--ignore-all-space')
  })

  test('resolves a single selected commit against its first parent', async () => {
    const range = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const commit = range.commits[1]
    expect(commit).toBeDefined()

    const review = await resolveCommitSpan(fixture.repository, commit!.oid, commit!.oid)

    expect(review.patch).toContain('\n+feature two')
    expect(review.patch).not.toContain('\n+feature one')
    expect(review.commits).toHaveLength(1)
  })

  test('treats a lone revision as one commit rather than an implicit branch range', async () => {
    const range = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const commit = range.commits[0]!

    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: commit.oid,
    })

    expect(review.commits.map((item) => item.oid)).toEqual([commit.oid])
    expect(review.patch).toContain('\n+feature one')
    expect(review.patch).not.toContain('\n+feature two')
    expect(review.gitCommand).toMatch(/^git show /)
  })

  test('keeps unstaged, staged, and all-uncommitted targets distinct', async () => {
    const [unstaged, staged, worktree] = await Promise.all([
      resolveTarget(fixture.repository, { kind: 'unstaged' }),
      resolveTarget(fixture.repository, { kind: 'staged' }),
      resolveTarget(fixture.repository, { kind: 'worktree' }),
    ])

    expect(unstaged.patch).toContain('two edited')
    expect(unstaged.patch).not.toContain('staged content')
    expect(unstaged.patch).not.toContain('untracked content')

    expect(staged.patch).toContain('staged content')
    expect(staged.patch).toContain('deleted.txt')
    expect(staged.patch).not.toContain('two edited')

    expect(worktree.patch).toContain('two edited')
    expect(worktree.patch).toContain('staged content')
    expect(worktree.patch).toContain('untracked content')
  })

  test('combines current branch, staged, unstaged, and untracked changes', async () => {
    const review = await resolveTarget(fixture.repository, { kind: 'branch-worktree' })

    expect(review.patch).toContain('feature one')
    expect(review.patch).toContain('from side')
    expect(review.patch).toContain('staged content')
    expect(review.patch).toContain('two edited')
    expect(review.patch).toContain('untracked content')
    expect(review.gitCommand).toBe("git diff --merge-base 'origin/main'")
    expect(review.oldSnapshot.kind).toBe('commit')
    expect(review.newSnapshot.kind).toBe('worktree')
    expect(review.commits.map((commit) => commit.subject)).toEqual([
      'feature one',
      'feature two',
      'merge side',
      'Local changes',
    ])
    expect(review.commits.at(-1)?.oid).toBe(LOCAL_CHANGES_OID)
  })

  test('can select local changes or a commit span ending in the working tree',
    async () => {
    const review = await resolveTarget(fixture.repository, { kind: 'branch-worktree' })
    const headCommit = review.commits.at(-2)
    expect(headCommit).toBeDefined()

    const localOnly = await resolveSelectedSpan(
      fixture.repository,
      LOCAL_CHANGES_OID,
      LOCAL_CHANGES_OID,
    )
    expect(localOnly.label).toBe('Local changes')
    expect(localOnly.newSnapshot.kind).toBe('worktree')
    expect(localOnly.patch).toContain('two edited')
    expect(localOnly.patch).toContain('staged content')
    expect(localOnly.patch).toContain('untracked content')
    expect(localOnly.patch).not.toContain('\n+feature one')
    expect(localOnly.patch).not.toContain('from side')

    const headAndLocal = await resolveSelectedSpan(
      fixture.repository,
      headCommit!.oid,
      LOCAL_CHANGES_OID,
    )
    expect(headAndLocal.newSnapshot.kind).toBe('worktree')
    expect(headAndLocal.patch).toContain('from side')
    expect(headAndLocal.patch).toContain('two edited')
    expect(headAndLocal.patch).toContain('untracked content')
    expect(headAndLocal.patch).not.toContain('\n+feature one')

    const committedOnly = await resolveSelectedSpan(
      fixture.repository,
      headCommit!.oid,
      headCommit!.oid,
    )
    expect(committedOnly.newSnapshot.kind).toBe('commit')
    expect(committedOnly.patch).toContain('from side')
    expect(committedOnly.patch).not.toContain('two edited')
    expect(committedOnly.patch).not.toContain('untracked content')
  })

  test('validates ranges in new, old, deleted, and untracked file snapshots', async () => {
    const review = await resolveTarget(fixture.repository, { kind: 'worktree' })

    await expect(
      validateAnnotationTarget(fixture.repository, review, 'tracked.txt', 'new', 1, 1),
    ).resolves.toBeUndefined()
    await expect(
      validateAnnotationTarget(fixture.repository, review, 'deleted.txt', 'old', 1, 2),
    ).resolves.toBeUndefined()
    await expect(
      validateAnnotationTarget(fixture.repository, review, 'untracked.txt', 'new', 1, 1),
    ).resolves.toBeUndefined()
    await expect(
      validateAnnotationTarget(fixture.repository, review, 'tracked.txt', 'new', 99, 99),
    ).rejects.toThrow(/does not exist/)
  })

  test('pins the merge base and head of a pull request revision', async () => {
    const bin = path.join(fixture.directory, 'bin')
    mkdirSync(bin, { recursive: true })
    const gh = path.join(bin, 'gh')
    const ghCalls = path.join(fixture.directory, 'gh-calls.txt')
    const baseRefOid = git(fixture.repository, ['rev-parse', 'origin/main']).trim()
    const headRefOid = git(fixture.repository, ['rev-parse', 'HEAD']).trim()
    const details = {
      number: 42,
      title: 'Fixture pull request',
      url: 'https://example.test/pull/42',
      state: 'OPEN' as const,
      baseRefName: 'main',
      headRefName: 'feature',
      baseRefOid,
      headRefOid,
    }
    writeFileSync(
      gh,
      `#!/bin/sh
printf '%s\n' "$*" >> "$GH_TEST_OUTPUT"
cat <<'JSON'
${JSON.stringify(details)}
JSON
`,
    )
    chmodSync(gh, 0o755)
    const originalPath = process.env.PATH
    const originalOutput = process.env.GH_TEST_OUTPUT
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.GH_TEST_OUTPUT = ghCalls

    try {
      const review = await resolveTarget(fixture.repository, { kind: 'pr', number: 42 })
      const mergeBase = git(fixture.repository, ['merge-base', baseRefOid, headRefOid]).trim()
      expect(review.oldSnapshot).toEqual({ kind: 'commit', id: mergeBase })
      expect(review.newSnapshot).toEqual({ kind: 'commit', id: headRefOid })
      const pinned = git(fixture.repository, [
        'for-each-ref',
        '--format=%(objectname)',
        'refs/diff-review/pull-requests/42/',
      ]).trim().split('\n').sort()
      expect(pinned).toEqual([mergeBase, headRefOid].sort())

      await resolvePullRequestRevision(fixture.repository, details, false)
      expect(readFileSync(ghCalls, 'utf8').trim().split('\n')).toHaveLength(1)
    } finally {
      process.env.PATH = originalPath
      process.env.GH_TEST_OUTPUT = originalOutput
    }
  })

  test('lists files that conflict between two commits', async () => {
    const conflictFixture = createConflictFixture()
    try {
      const baseOid = git(conflictFixture.repository, ['rev-parse', 'main']).trim()
      const headOid = git(conflictFixture.repository, ['rev-parse', 'feature']).trim()
      const cleanOid = git(conflictFixture.repository, ['rev-parse', 'clean']).trim()

      expect(await listMergeConflictFiles(conflictFixture.repository, baseOid, headOid)).toEqual([
        'conflict.txt',
        'other-conflict.txt',
      ])
      expect(await listMergeConflictFiles(conflictFixture.repository, baseOid, cleanOid)).toEqual([])
    } finally {
      rmSync(conflictFixture.directory, { recursive: true, force: true })
    }
  })

  test('adds one reviewed file to the index', async () => {
    const stagingFixture = createGitFixture()
    try {
      const review = await resolveTarget(stagingFixture.repository, { kind: 'unstaged' })
      const worktreeBefore = await resolveTarget(stagingFixture.repository, { kind: 'worktree' })
      expect(review.unstagedPaths).toContain('tracked.txt')
      expect(worktreeBefore.unstagedPaths).toContain('tracked.txt')

      await stageReviewFile(stagingFixture.repository, review.patch, 'tracked.txt')

      const staged = await resolveTarget(stagingFixture.repository, { kind: 'staged' })
      const unstaged = await resolveTarget(stagingFixture.repository, { kind: 'unstaged' })
      const worktree = await resolveTarget(stagingFixture.repository, { kind: 'worktree' })
      expect(staged.patch).toContain('two edited')
      expect(unstaged.patch).not.toContain('two edited')
      expect(unstaged.unstagedPaths).not.toContain('tracked.txt')
      expect(worktree.patch).toContain('two edited')
      expect(worktree.unstagedPaths).not.toContain('tracked.txt')
    } finally {
      rmSync(stagingFixture.directory, { recursive: true, force: true })
    }
  })
})

describe('GitHub review comments', () => {
  test('accepts comments on unchanged lines in a changed file', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-unchanged-line-'))
    const repository = path.join(directory, 'repo')
    mkdirSync(repository)
    git(repository, ['init', '-b', 'main'])
    git(repository, ['config', 'user.name', 'Diff Reviewer'])
    git(repository, ['config', 'user.email', 'reviewer@example.com'])
    writeFileSync(
      path.join(repository, 'example.ts'),
      Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') + '\n',
    )
    git(repository, ['add', 'example.ts'])
    git(repository, ['commit', '-m', 'base'])
    writeFileSync(
      path.join(repository, 'example.ts'),
      Array.from({ length: 20 }, (_, index) => {
        return index === 19 ? 'line 20 changed' : `line ${index + 1}`
      }).join('\n') + '\n',
    )
    git(repository, ['add', 'example.ts'])
    git(repository, ['commit', '-m', 'change the last line'])

    const review = await resolveTarget(repository, {
      kind: 'range',
      expression: 'HEAD~1...HEAD',
    })
    expect(review.patch).not.toContain('+line 1')

    const store = new ReviewStore(path.join(directory, 'store.db'))
    const session = store.createSession(
      repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const annotationsUrl = `http://127.0.0.1:${port}/api/sessions/${session.id}/annotations`

    try {
      const created = await fetch(annotationsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: 'example.ts',
          side: 'new',
          startLine: 1,
          endLine: 2,
          comment: 'This setup should have changed too.',
          source: 'user',
          intent: 'review-comment',
        }),
      })
      expect(created.status).toBe(201)
      const annotation = await created.json() as {
        id: string
        filePath: string
        side: string
        startLine: number
        endLine: number
        intent: string
      }
      expect(annotation).toMatchObject({
        filePath: 'example.ts',
        side: 'new',
        startLine: 1,
        endLine: 2,
        intent: 'review-comment',
      })
      const updated = await fetch(`${annotationsUrl}/${annotation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: 'Keep this as a local note instead.',
          intent: 'annotation',
        }),
      })
      expect(updated.status).toBe(200)
      await expect(updated.json()).resolves.toMatchObject({
        comment: 'Keep this as a local note instead.',
        intent: 'annotation',
      })
      const queued = await fetch(`${annotationsUrl}/${annotation.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          comment: 'Queue this for the review again.',
          intent: 'review-comment',
        }),
      })
      expect(queued.status).toBe(200)
      await expect(queued.json()).resolves.toMatchObject({
        comment: 'Queue this for the review again.',
        intent: 'review-comment',
      })

      const missing = await fetch(annotationsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: 'example.ts',
          side: 'new',
          startLine: 99,
          endLine: 99,
          comment: 'This line does not exist.',
          source: 'user',
          intent: 'review-comment',
        }),
      })
      expect(missing.status).toBe(400)
      await expect(missing.json()).resolves.toMatchObject({
        error: {
          code: 'ANNOTATION_LINE_NOT_FOUND',
          message: expect.stringMatching(/does not exist/),
        },
      })
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('difftastic API', () => {
  test('probes availability and renders a session file', async () => {
    const store = new ReviewStore(path.join(fixture.directory, 'difftastic-api.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const availabilityResponse = await fetch(`${baseUrl}/api/difftastic`)
      expect(availabilityResponse.status).toBe(200)
      const availability = await availabilityResponse.json() as {
        available: boolean
        version: string | null
        installHint: string
      }
      expect(availability.installHint).toContain('difft')
      if (!availability.available) return

      const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: fixture.repository,
          target: { kind: 'range', expression: 'origin/main...HEAD' },
        }),
      })
      expect(createdResponse.status).toBe(201)
      const session = await createdResponse.json() as { id: string }

      const fileResponse = await fetch(
        `${baseUrl}/api/sessions/${session.id}/difftastic?path=tracked.txt`,
      )
      expect(fileResponse.status).toBe(200)
      const file = await fileResponse.json() as {
        path: string
        status: string
        hunks: Array<{ lines: Array<{ kind: string; newText: string | null }> }>
      }
      expect(file.path).toBe('tracked.txt')
      expect(file.status).toBe('changed')
      expect(file.hunks.some((hunk) =>
        hunk.lines.some((line) => line.newText?.includes('feature two')),
      )).toBe(true)
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
    }
  })
})

describe('file pair API', () => {
  test('returns both snapshot sides in one response', async () => {
    const store = new ReviewStore(path.join(fixture.directory, 'file-pair-api.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: fixture.repository,
          target: { kind: 'range', expression: 'origin/main...HEAD' },
        }),
      })
      expect(createdResponse.status).toBe(201)
      const session = await createdResponse.json() as { id: string }

      const pairResponse = await fetch(
        `${baseUrl}/api/sessions/${session.id}/file?old=tracked.txt&new=tracked.txt`,
      )
      expect(pairResponse.status).toBe(200)
      const pair = await pairResponse.json() as { old: string | null; new: string | null }
      expect(pair.old).toContain('one')
      expect(pair.old).not.toContain('feature two')
      expect(pair.new).toContain('feature two')
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
    }
  })
})

describe('local review storage', () => {
  test('defaults API sessions to ignore whitespace and preserves pinned PR snapshots', async () => {
    const store = new ReviewStore(path.join(fixture.directory, 'whitespace-api.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: fixture.repository,
          target: { kind: 'range', expression: 'origin/main...HEAD' },
        }),
      })
      expect(createdResponse.status).toBe(201)
      const created = await createdResponse.json() as { ignoreWhitespace: boolean; patch: string }
      expect(created.ignoreWhitespace).toBe(true)
      expect(created.patch).not.toContain('spacing.txt')

      const pinned = await resolveTarget(fixture.repository, {
        kind: 'range',
        expression: 'origin/main...HEAD',
      })
      const prSession = store.createSession(
        fixture.repository,
        'repo',
        { kind: 'pr', number: 42 },
        pinned,
        false,
      )
      const updatedResponse = await fetch(
        `${baseUrl}/api/sessions/${prSession.id}/whitespace`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ignoreWhitespace: true }),
        },
      )
      expect(updatedResponse.status).toBe(200)
      const updated = await updatedResponse.json() as {
        ignoreWhitespace: boolean
        revisionBaseOid: string
        revisionHeadOid: string
        patch: string
      }
      expect(updated.ignoreWhitespace).toBe(true)
      expect(updated.revisionBaseOid).toBe(prSession.revisionBaseOid)
      expect(updated.revisionHeadOid).toBe(prSession.revisionHeadOid)
      expect(updated.patch).not.toContain('spacing.txt')
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
    }
  })

  test('narrows an immutable pull request revision without changing its snapshot bounds', async () => {
    const store = new ReviewStore(path.join(fixture.directory, 'pr-selection.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const pinned = await resolveTarget(fixture.repository, {
        kind: 'range',
        expression: 'origin/main...HEAD',
      })
      const prSession = store.createSession(
        fixture.repository,
        'repo',
        { kind: 'pr', number: 42 },
        pinned,
        false,
      )
      const selectedCommit = prSession.commits[1]
      expect(selectedCommit).toBeTruthy()
      const selected = await fetch(`${baseUrl}/api/sessions/${prSession.id}/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: selectedCommit!.oid, end: selectedCommit!.oid }),
      })
      expect(selected.status).toBe(200)
      const updated = await selected.json() as {
        commits: Array<{ oid: string }>
        selectedCommitStart: string
        selectedCommitEnd: string
        revisionBaseOid: string
        revisionHeadOid: string
        patch: string
      }
      expect(updated.commits.map((commit) => commit.oid)).toEqual(
        prSession.commits.map((commit) => commit.oid),
      )
      expect(updated.selectedCommitStart).toBe(selectedCommit!.oid)
      expect(updated.selectedCommitEnd).toBe(selectedCommit!.oid)
      expect(updated.revisionBaseOid).toBe(prSession.revisionBaseOid)
      expect(updated.revisionHeadOid).toBe(prSession.revisionHeadOid)
      expect(updated.patch).toContain('feature two')

      const rejected = await fetch(`${baseUrl}/api/sessions/${prSession.id}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filePath: 'tracked.txt',
          side: 'new',
          startLine: 1,
          endLine: 1,
          comment: 'Should stay local while a span is selected.',
          source: 'user',
          intent: 'review-comment',
        }),
      })
      expect(rejected.status).toBe(400)
      await expect(rejected.json()).resolves.toMatchObject({
        error: { code: 'INVALID_REVIEW_COMMENT' },
      })

      const restored = await fetch(`${baseUrl}/api/sessions/${prSession.id}/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: prSession.commits[0]!.oid,
          end: prSession.commits.at(-1)!.oid,
        }),
      })
      expect(restored.status).toBe(200)
      const full = await restored.json() as {
        patch: string
        revisionBaseOid: string
        revisionHeadOid: string
      }
      expect(full.revisionBaseOid).toBe(prSession.revisionBaseOid)
      expect(full.revisionHeadOid).toBe(prSession.revisionHeadOid)
      expect(full.patch).toBe(prSession.patch)
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
    }
  })

  test('restoring all PR commits stays inside the pinned merge-base snapshot', async () => {
    const isolated = createMergedBasePullRequestFixture()
    const store = new ReviewStore(path.join(isolated.directory, 'pr-merge-base.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const pinned = await resolveTarget(isolated.repository, {
        kind: 'range',
        expression: `${isolated.baseOid}...${isolated.headOid}`,
      })
      expect(pinned.oldSnapshot.id).toBe(isolated.baseOid)
      expect(pinned.patch).toContain('feature.txt')
      expect(pinned.patch).not.toContain('main.txt')

      const prSession = store.createSession(
        isolated.repository,
        'repo',
        { kind: 'pr', number: 7 },
        pinned,
        false,
      )
      const restored = await fetch(`${baseUrl}/api/sessions/${prSession.id}/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: prSession.commits[0]!.oid,
          end: prSession.commits.at(-1)!.oid,
        }),
      })
      expect(restored.status).toBe(200)
      const updated = await restored.json() as {
        patch: string
        revisionBaseOid: string
        revisionHeadOid: string
      }
      expect(updated.revisionBaseOid).toBe(isolated.baseOid)
      expect(updated.revisionHeadOid).toBe(isolated.headOid)
      expect(updated.patch).toBe(pinned.patch)
      expect(updated.patch).not.toContain('main.txt')
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
      rmSync(isolated.directory, { recursive: true, force: true })
    }
  })

  test('runs Pi chat over RPC and cleans the worktree after retention', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-review.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const bin = path.join(fixture.directory, 'bin')
    mkdirSync(bin, { recursive: true })
    const pi = path.join(bin, 'pi')
    const output = path.join(fixture.directory, 'pi-output.txt')
    copyFileSync(path.join(import.meta.dirname, 'fixtures/fake-pi-rpc.cjs'), pi)
    chmodSync(pi, 0o755)
    const originalPath = process.env.PATH
    const originalOutput = process.env.PI_TEST_OUTPUT
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.PI_TEST_OUTPUT = output
    const runner = new PiReviewRunner(store, () => undefined)

    try {
      const sent = await runner.send(session.id, 'Emphasize how the data model changed.')
      expect(sent.overlay?.userText ?? sent.turns[0]?.userText).toBe(
        'Emphasize how the data model changed.',
      )
      await waitFor(() => runner.getChat(session.id).turns.length === 1)
      const chat = runner.getChat(session.id)
      expect(chat.turns[0]?.userText).toBe('Emphasize how the data model changed.')
      expect(chat.turns[0]?.assistantText).toContain('Emphasize how the data model changed.')
      const lines = readFileSync(output, 'utf8').split('\n')
      const worktree = lines[0] ?? ''
      expect(lines[1]).toBe(session.revisionHeadOid)
      expect(lines.join('\n')).toContain(`diff-review annotate ${session.id}`)
      expect(lines.join('\n')).toContain('Help someone review PR #42.')
      expect(lines.join('\n')).toContain('[summary]')
      expect(lines.join('\n')).toContain('action(domain):')
      expect(lines).toContain('--mode')
      expect(lines).toContain('rpc')
      expect(lines).toContain('--session-dir')
      expect(lines).toContain('--session-id')
      expect(lines).not.toContain('--no-session')
      const status = runner.getStatus(session.id)
      expect(status.state).toBe('running')
      if (status.state === 'idle') throw new Error('Expected a Pi run')
      expect(path.basename(status.worktreePath)).toBe(path.basename(worktree))
      expect(existsSync(status.worktreePath)).toBe(true)
      runner.close()
      const closed = runner.getStatus(session.id)
      expect(closed.state === 'completed' || closed.state === 'interrupted').toBe(true)
      if (closed.state === 'idle') throw new Error('Expected a Pi run')
      store.updatePiReviewRun(closed.id, {
        state: 'completed',
        activePid: null,
        cleanupEligibleAt: '1970-01-01T00:00:00.000Z',
      })
      const cleaner = new PiReviewRunner(store, () => undefined)
      await cleaner.reconcileAndCleanup()
      expect(cleaner.getStatus(session.id).state).toBe('cleaned')
      expect(existsSync(status.worktreePath)).toBe(false)
      expect(existsSync(status.piSessionDir)).toBe(false)
      cleaner.close()
    } finally {
      runner.close()
      process.env.PATH = originalPath
      if (originalOutput == null) delete process.env.PI_TEST_OUTPUT
      else process.env.PI_TEST_OUTPUT = originalOutput
    }
  })

  test('reuses one Pi chat across pull request revisions', async () => {
    const laterReview = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const firstReview = await resolveCommitSpan(
      fixture.repository,
      laterReview.commits[0]!.oid,
      laterReview.commits[0]!.oid,
    )
    const store = new ReviewStore(path.join(fixture.directory, 'pi-pr-chat.db'))
    const first = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      firstReview,
      false,
    )
    const later = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      laterReview,
      false,
    )
    const bin = path.join(fixture.directory, 'pr-chat-bin')
    mkdirSync(bin, { recursive: true })
    const output = path.join(fixture.directory, 'pi-pr-chat-output.txt')
    copyFileSync(path.join(import.meta.dirname, 'fixtures/fake-pi-rpc.cjs'), path.join(bin, 'pi'))
    chmodSync(path.join(bin, 'pi'), 0o755)
    const originalPath = process.env.PATH
    const originalOutput = process.env.PI_TEST_OUTPUT
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.PI_TEST_OUTPUT = output
    const runner = new PiReviewRunner(store, () => undefined)
    try {
      expect(first.revisionHeadOid).not.toBe(later.revisionHeadOid)
      await runner.send(first.id, 'What moved?')
      await waitFor(() => {
        const chat = runner.getChat(first.id)
        return chat.turns.length === 1 && !chat.busy
      })
      await runner.send(later.id, 'What landed in the new head?')
      await waitFor(() => {
        const chat = runner.getChat(later.id)
        return chat.turns.length === 2 && !chat.busy
      })
      expect(later.id).not.toBe(first.id)
      expect(store.latestPiReviewRunForChat(later.id)?.id)
        .toBe(store.latestPiReviewRunForChat(first.id)?.id)
      expect(runner.getChat(later.id).turns.map((turn) => turn.userText)).toEqual([
        'What moved?',
        'What landed in the new head?',
      ])
      const status = runner.getStatus(later.id)
      if (status.state === 'idle') throw new Error('Expected a Pi run')
      expect(git(status.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(later.revisionHeadOid)
      const spawned = readFileSync(output, 'utf8')
      expect(spawned).toContain(later.revisionHeadOid)
      expect(spawned).toContain(`git diff ${later.revisionBaseOid} ${later.revisionHeadOid} --`)
      expect(spawned).toContain(`diff-review annotate ${later.id}`)
      expect(spawned).toContain('--session')
    } finally {
      runner.close()
      process.env.PATH = originalPath
      if (originalOutput == null) delete process.env.PI_TEST_OUTPUT
      else process.env.PI_TEST_OUTPUT = originalOutput
    }
  })

  test('rejects a send on another pull request while Pi is working', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-busy.db'))
    const first = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const other = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 43 },
      review,
      false,
    )
    const bin = path.join(fixture.directory, 'pi-busy-bin')
    mkdirSync(bin, { recursive: true })
    copyFileSync(path.join(import.meta.dirname, 'fixtures/fake-pi-rpc.cjs'), path.join(bin, 'pi'))
    chmodSync(path.join(bin, 'pi'), 0o755)
    const originalPath = process.env.PATH
    const originalHold = process.env.PI_TEST_HOLD
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.PI_TEST_HOLD = '1'
    const runner = new PiReviewRunner(store, () => undefined)
    try {
      const sent = await runner.send(first.id, 'Still working')
      expect(sent.overlay?.working).toBe(true)
      await expect(runner.send(other.id, 'Other PR')).rejects.toMatchObject({
        code: 'PI_CHAT_BUSY',
      })
      expect(runner.getChat(first.id).overlay?.working).toBe(true)
    } finally {
      runner.close()
      process.env.PATH = originalPath
      if (originalHold == null) delete process.env.PI_TEST_HOLD
      else process.env.PI_TEST_HOLD = originalHold
    }
  })

  test('guides the user to install Pi when it is missing', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-missing.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const originalPath = process.env.PATH
    process.env.PATH = path.join(fixture.directory, 'empty-bin')
    const runner = new PiReviewRunner(store, () => undefined)
    try {
      const page = runner.getChat(session.id)
      expect(page.piInstalled).toBe(false)
      expect(page.error).toBe(PI_INSTALL_HINT)
      await expect(runner.send(session.id, 'Explain this PR')).rejects.toMatchObject({
        code: 'COMMAND_NOT_FOUND',
        message: PI_INSTALL_HINT,
      })
      expect(store.latestPiReviewRun(session.id)).toBeNull()
    } finally {
      runner.close()
      process.env.PATH = originalPath
    }
  })

  test('indexes pull request sessions by immutable base and head revisions', async () => {
    const review = await resolveTarget(
      fixture.repository,
      { kind: 'range', expression: 'origin/main...HEAD' },
      true,
    )
    expect(review.oldSnapshot.kind).toBe('commit')
    expect(review.newSnapshot.kind).toBe('commit')
    const databasePath = path.join(fixture.directory, 'pr-revisions.db')
    const store = new ReviewStore(databasePath)
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      true,
    )
    const baseOid = review.oldSnapshot.id
    const headOid = review.newSnapshot.id

    expect(session.revisionBaseOid).toBe(baseOid)
    expect(session.revisionHeadOid).toBe(headOid)
    expect(session.ignoreWhitespace).toBe(true)
    expect(store.findPullRequestRevision(fixture.repository, 42, baseOid, headOid)?.id)
      .toBe(session.id)
    expect(store.findPullRequestHeadRevision(fixture.repository, 42, headOid)?.id)
      .toBe(session.id)
    expect(store.findPullRequestHeadRevision(fixture.repository, 43, headOid)).toBeNull()
    expect(store.findPullRequestHeadRevision(fixture.repository, 42, baseOid)).toBeNull()
    expect(store.findPullRequestRevision(fixture.repository, 43, baseOid, headOid)).toBeNull()

    store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'Revision-specific finding',
      source: 'agent',
    })
    expect(store.listPullRequestRevisions(fixture.repository, 42)).toEqual([
      {
        sessionId: session.id,
        baseOid,
        headOid,
        annotationCount: 1,
        createdAt: session.createdAt,
      },
    ])
  })


  test('indexes local range sessions by resolved commit SHAs', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    expect(review.oldSnapshot.kind).toBe('commit')
    expect(review.newSnapshot.kind).toBe('commit')
    const store = new ReviewStore(path.join(fixture.directory, 'local-revisions.db'))
    const first = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: 'origin/main...HEAD' },
      review,
      true,
    )
    store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: `${review.oldSnapshot.id}..${review.newSnapshot.id}` },
      review,
      true,
    )

    expect(first.revisionBaseOid).toBe(review.oldSnapshot.id)
    expect(first.revisionHeadOid).toBe(review.newSnapshot.id)
    expect(store.findLocalRevision(
      fixture.repository,
      review.oldSnapshot.id,
      review.newSnapshot.id,
    )?.revisionHeadOid).toBe(review.newSnapshot.id)
    expect(store.findPullRequestRevision(
      fixture.repository,
      42,
      review.oldSnapshot.id,
      review.newSnapshot.id,
    )).toBeNull()

    const nextHead = 'd'.repeat(40)
    const moved = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: 'origin/main...HEAD' },
      { ...review, newSnapshot: { kind: 'commit', id: nextHead } },
      true,
    )
    expect(moved.id).not.toBe(first.id)
    expect(store.findLocalRevision(fixture.repository, review.oldSnapshot.id, nextHead)?.id)
      .toBe(moved.id)
  })

  test('reuses a local session for the same resolved commit range', async () => {
    const store = new ReviewStore(path.join(fixture.directory, 'reuse-local.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const body = JSON.stringify({
        repositoryPath: fixture.repository,
        target: { kind: 'range', expression: 'origin/main...HEAD' },
      })
      const firstResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const secondResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(firstResponse.status).toBe(201)
      expect(secondResponse.status).toBe(201)
      const first = await firstResponse.json() as { id: string; annotations: unknown[] }
      const second = await secondResponse.json() as { id: string }
      expect(second.id).toBe(first.id)

      store.addAnnotation(first.id, {
        filePath: 'tracked.txt',
        side: 'new',
        startLine: 5,
        endLine: 5,
        comment: 'Keep this note',
        source: 'agent',
      })
      const thirdResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const third = await thirdResponse.json() as {
        id: string
        annotations: Array<{ comment: string | null }>
      }
      expect(third.id).toBe(first.id)
      expect(third.annotations).toMatchObject([{ comment: 'Keep this note' }])


      const range = await resolveTarget(fixture.repository, {
        kind: 'range',
        expression: 'origin/main...HEAD',
      })
      const aliasedResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: fixture.repository,
          target: {
            kind: 'range',
            expression: `${range.oldSnapshot.id}..${range.newSnapshot.id}`,
          },
        }),
      })
      expect(aliasedResponse.status).toBe(201)
      expect((await aliasedResponse.json() as { id: string }).id).toBe(first.id)
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
    }
  })


  test('opens a new local session when the resolved head advances', async () => {
    const isolated = createGitFixture()
    const store = new ReviewStore(path.join(isolated.directory, 'reuse-local-advance.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/api/sessions`
    const body = JSON.stringify({
      repositoryPath: isolated.repository,
      target: { kind: 'range', expression: 'origin/main...HEAD' },
    })

    try {
      const firstResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const first = await firstResponse.json() as { id: string }
      writeFileSync(path.join(isolated.repository, 'later.txt'), 'later\n')
      git(isolated.repository, ['add', 'later.txt'])
      git(isolated.repository, ['commit', '-m', 'later'])
      const secondResponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const second = await secondResponse.json() as { id: string }
      expect(firstResponse.status).toBe(201)
      expect(secondResponse.status).toBe(201)
      expect(second.id).not.toBe(first.id)
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
      rmSync(isolated.directory, { recursive: true, force: true })
    }
  })

  test('freshness stays current until the range or worktree changes', async () => {
    const isolated = createGitFixture()
    const store = new ReviewStore(path.join(isolated.directory, 'freshness.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const rangeResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: isolated.repository,
          target: { kind: 'range', expression: 'origin/main...HEAD' },
        }),
      })
      const rangeSession = await rangeResponse.json() as { id: string }
      const freshRange = await fetch(`${baseUrl}/api/sessions/${rangeSession.id}/freshness`)
      expect(await freshRange.json()).toEqual({ stale: false })

      writeFileSync(path.join(isolated.repository, 'later.txt'), 'later\n')
      git(isolated.repository, ['add', 'later.txt'])
      git(isolated.repository, ['commit', '-m', 'later'])
      const staleRange = await fetch(`${baseUrl}/api/sessions/${rangeSession.id}/freshness`)
      expect(await staleRange.json()).toEqual({ stale: true })

      const unstagedResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: isolated.repository,
          target: { kind: 'unstaged' },
        }),
      })
      const unstagedSession = await unstagedResponse.json() as { id: string }
      const freshUnstaged = await fetch(`${baseUrl}/api/sessions/${unstagedSession.id}/freshness`)
      expect(await freshUnstaged.json()).toEqual({ stale: false })

      writeFileSync(path.join(isolated.repository, 'tracked.txt'), 'edited again\n')
      const staleUnstaged = await fetch(`${baseUrl}/api/sessions/${unstagedSession.id}/freshness`)
      expect(await staleUnstaged.json()).toEqual({ stale: true })

      const resolved = await resolveTarget(isolated.repository, { kind: 'unstaged' })
      expect(resolved.fingerprint).toBe(
        await computeReviewFingerprint(isolated.repository, { kind: 'unstaged' }),
      )
      expect(storedReviewFingerprint(resolved)).toBe(resolved.fingerprint)

      const modeSessionResponse = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: isolated.repository,
          target: { kind: 'unstaged' },
        }),
      })
      const modeSession = await modeSessionResponse.json() as { id: string }
      chmodSync(path.join(isolated.repository, 'tracked.txt'), 0o755)
      const staleMode = await fetch(`${baseUrl}/api/sessions/${modeSession.id}/freshness`)
      expect(await staleMode.json()).toEqual({ stale: true })
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
      rmSync(isolated.directory, { recursive: true, force: true })
    }
  })

  test('legacy range sessions and partial selections keep a comparable fingerprint', async () => {
    const isolated = createGitFixture()
    const store = new ReviewStore(path.join(isolated.directory, 'freshness-legacy.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const review = await resolveTarget(isolated.repository, {
        kind: 'range',
        expression: 'origin/main...HEAD',
      })
      const { fingerprint: _fingerprint, ...legacyResolved } = review
      const legacy = store.createSession(
        isolated.repository,
        'repo',
        { kind: 'range', expression: 'origin/main...HEAD' },
        legacyResolved,
        true,
      )
      expect(storedReviewFingerprint(store.getResolvedReview(legacy.id))).toBe(
        `range:${review.oldSnapshot.id}:${review.newSnapshot.id}`,
      )
      const freshLegacy = await fetch(`${baseUrl}/api/sessions/${legacy.id}/freshness`)
      expect(await freshLegacy.json()).toEqual({ stale: false })

      const created = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: isolated.repository,
          target: { kind: 'range', expression: 'origin/main...HEAD' },
        }),
      })
      const session = await created.json() as {
        id: string
        commits: Array<{ oid: string }>
      }
      const start = session.commits[0]?.oid
      const mid = session.commits[1]?.oid ?? start
      expect(start).toBeTruthy()
      const selected = await fetch(`${baseUrl}/api/sessions/${session.id}/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start, end: mid }),
      })
      expect(selected.status).toBe(200)
      expect(store.getResolvedReview(session.id).fingerprint).toBe(review.fingerprint)

      const stillFresh = await fetch(`${baseUrl}/api/sessions/${session.id}/freshness`)
      expect(await stillFresh.json()).toEqual({ stale: false })
      writeFileSync(path.join(isolated.repository, 'later.txt'), 'later\n')
      git(isolated.repository, ['add', 'later.txt'])
      git(isolated.repository, ['commit', '-m', 'later'])
      const staleSelected = await fetch(`${baseUrl}/api/sessions/${session.id}/freshness`)
      expect(await staleSelected.json()).toEqual({ stale: true })
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
      rmSync(isolated.directory, { recursive: true, force: true })
    }
  })

  test('pull request sessions stay fresh after open, including legacy fingerprints', async () => {
    const isolated = createGitFixture()
    const store = new ReviewStore(path.join(isolated.directory, 'freshness-pr.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`
    const review = await resolveTarget(isolated.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })

    try {
      const current = store.createSession(
        isolated.repository,
        'repo',
        { kind: 'pr', number: 42 },
        { ...review, fingerprint: 'pr:42' },
        true,
      )
      const freshCurrent = await fetch(`${baseUrl}/api/sessions/${current.id}/freshness`)
      expect(await freshCurrent.json()).toEqual({ stale: false })

      const { fingerprint: _fingerprint, ...legacyResolved } = review
      const legacy = store.createSession(
        isolated.repository,
        'repo',
        { kind: 'pr', number: 7 },
        legacyResolved,
        true,
      )
      expect(legacyResolved.fingerprint).toBeUndefined()
      const freshLegacy = await fetch(`${baseUrl}/api/sessions/${legacy.id}/freshness`)
      expect(await freshLegacy.json()).toEqual({ stale: false })
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
      rmSync(isolated.directory, { recursive: true, force: true })
    }
  })

  test('opens a new pull request session when the revision changes', async () => {
    const review = await resolveTarget(
      fixture.repository,
      { kind: 'range', expression: 'origin/main...HEAD' },
      true,
    )
    expect(review.oldSnapshot.kind).toBe('commit')
    expect(review.newSnapshot.kind).toBe('commit')
    const store = new ReviewStore(path.join(fixture.directory, 'reuse-pr.db'))
    const first = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      true,
    )
    const nextHead = 'c'.repeat(40)
    const updated = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      {
        ...review,
        newSnapshot: { kind: 'commit', id: nextHead },
      },
      true,
    )

    expect(updated.id).not.toBe(first.id)
    expect(store.findPullRequestRevision(
      fixture.repository,
      42,
      review.oldSnapshot.id,
      review.newSnapshot.id,
    )?.id).toBe(first.id)
    expect(store.findPullRequestRevision(
      fixture.repository,
      42,
      review.oldSnapshot.id,
      nextHead,
    )?.id).toBe(updated.id)
  })

  test('persists Pi review runs and selects the latest run', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const databasePath = path.join(fixture.directory, 'persistent-pi-runs.db')
    const store = new ReviewStore(databasePath)
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: 'origin/main...HEAD' },
      review,
      false,
    )
    const first = store.createPiReviewRun(
      session.id,
      '/tmp/worktree-1',
      '/tmp/pi-session-1',
      'pi-session-1',
      '2026-02-01T00:00:00.000Z',
    )
    expect(first).toMatchObject({
      id: expect.stringMatching(/^pir_/),
      sessionId: session.id,
      state: 'creating',
      activePid: null,
      keep: false,
      error: null,
      completedAt: null,
      cleanedAt: null,
    })
    expect(store.dataDirectory).toBe(path.dirname(databasePath))

    store.updatePiReviewRun(first.id, {
      state: 'running',
      activePid: 1234,
      piSessionPath: '/tmp/pi-session-1/session.jsonl',
      error: 'temporary error',
    })
    const cleared = store.updatePiReviewRun(first.id, {
      activePid: null,
      piSessionPath: null,
      error: null,
    })
    expect(cleared).toMatchObject({ activePid: null, piSessionPath: null, error: null })

    const second = store.createPiReviewRun(
      session.id,
      '/tmp/worktree-2',
      '/tmp/pi-session-2',
      'pi-session-2',
      '2026-02-02T00:00:00.000Z',
    )
    expect(store.latestPiReviewRun(session.id)?.id).toBe(second.id)
    expect(store.getPiReviewRun('pir_missing')).toBeNull()
    expect(() => store.updatePiReviewRun('pir_missing', {})).toThrow(/Pi review run not found/)
    expect(() =>
      store.createPiReviewRun(
        'missing-session',
        '/tmp/worktree',
        '/tmp/pi-session',
        'pi-session',
        '2026-02-01T00:00:00.000Z',
      ),
    ).toThrow(/Review session not found/)

    const reopened = new ReviewStore(databasePath)
    expect(reopened.getPiReviewRun(first.id)).toEqual(cleared)
    expect(reopened.latestPiReviewRun(session.id)?.id).toBe(second.id)
  })

  test('filters Pi review runs eligible for cleanup', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-run-cleanup.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: 'origin/main...HEAD' },
      review,
      false,
    )
    const createRun = (suffix: string, cleanupEligibleAt = '2026-02-01T00:00:00.000Z') =>
      store.createPiReviewRun(
        session.id,
        `/tmp/worktree-${suffix}`,
        `/tmp/pi-session-${suffix}`,
        `pi-session-${suffix}`,
        cleanupEligibleAt,
      )

    const completed = createRun('completed')
    store.updatePiReviewRun(completed.id, { state: 'completed' })
    const blocked = createRun('blocked')
    store.updatePiReviewRun(blocked.id, { state: 'cleanup-blocked' })
    const cleaning = createRun('cleaning')
    store.updatePiReviewRun(cleaning.id, { state: 'cleaning' })
    const kept = createRun('kept')
    store.updatePiReviewRun(kept.id, { state: 'failed', keep: true })
    const future = createRun('future', '2026-04-01T00:00:00.000Z')
    store.updatePiReviewRun(future.id, { state: 'interrupted' })
    const running = createRun('running')
    store.updatePiReviewRun(running.id, { state: 'running' })
    const cleaned = createRun('cleaned')
    store.updatePiReviewRun(cleaned.id, { state: 'cleaned' })

    expect(
      store
        .listPiReviewRunsEligibleForCleanup('2026-03-01T00:00:00.000Z')
        .map((run) => run.id)
        .sort(),
    ).toEqual([blocked.id, cleaning.id, completed.id].sort())
  })

  test('rediscovers a saved Pi session after an interrupted daemon run', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-run-recovery.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const worktree = path.join(fixture.directory, 'recovery-worktree')
    const piSessionDir = path.join(fixture.directory, 'recovery-session')
    const piSessionId = 'recovery-session-id'
    const piSessionPath = path.join(piSessionDir, `timestamp_${piSessionId}.jsonl`)
    mkdirSync(worktree, { recursive: true })
    mkdirSync(piSessionDir, { recursive: true })
    writeFileSync(piSessionPath, '{}\n')
    const run = store.createPiReviewRun(
      session.id,
      worktree,
      piSessionDir,
      piSessionId,
      '2026-01-01T00:00:00.000Z',
    )
    store.updatePiReviewRun(run.id, { state: 'running', activePid: 999_999_999 })

    const recovered = new PiReviewRunner(store, () => undefined).getStatus(session.id)
    expect(recovered).toMatchObject({
      state: 'interrupted',
      activePid: null,
      piSessionPath,
    })
  })

  test('blocks untracked files but cleans a worktree containing only ignored files', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-run-dirty-cleanup.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const worktree = path.join(fixture.directory, 'dirty-worktree')
    const piSessionDir = path.join(fixture.directory, 'dirty-pi-session')
    execFileSync('git', ['worktree', 'add', '--detach', worktree, session.revisionHeadOid!], {
      cwd: fixture.repository,
    })
    mkdirSync(piSessionDir, { recursive: true })
    writeFileSync(path.join(worktree, 'untracked.txt'), 'keep me')
    const run = store.createPiReviewRun(
      session.id,
      worktree,
      piSessionDir,
      'dirty-session',
      '1970-01-01T00:00:00.000Z',
    )
    store.updatePiReviewRun(run.id, { state: 'completed' })
    const runner = new PiReviewRunner(store, () => undefined)
    const excludePath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: worktree,
      encoding: 'utf8',
    }).trim()
    const originalExclude = readFileSync(excludePath, 'utf8')

    try {
      await runner.reconcileAndCleanup()
      expect(store.getPiReviewRun(run.id)).toMatchObject({
        state: 'cleanup-blocked',
        error: expect.stringContaining('local or untracked files'),
      })
      expect(existsSync(worktree)).toBe(true)
      expect(existsSync(piSessionDir)).toBe(true)

      rmSync(path.join(worktree, 'untracked.txt'))
      writeFileSync(excludePath, `${originalExclude}\nignored-cleanup.log\n`)
      writeFileSync(path.join(worktree, 'ignored-cleanup.log'), 'delete me')
      store.updatePiReviewRun(run.id, { state: 'completed', error: null })
      await runner.reconcileAndCleanup()
      expect(store.getPiReviewRun(run.id)).toMatchObject({ state: 'cleaned', error: null })
      expect(existsSync(worktree)).toBe(false)
      expect(existsSync(piSessionDir)).toBe(false)
    } finally {
      writeFileSync(excludePath, originalExclude)
      if (existsSync(worktree)) {
        execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: fixture.repository })
      }
    }
  })

  test('lets branch + local reviews select local changes from the commit timeline', async () => {
    const store = new ReviewStore(path.join(fixture.directory, 'branch-worktree-selection.db'))
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const baseUrl = `http://127.0.0.1:${port}`

    try {
      const created = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repositoryPath: fixture.repository,
          target: { kind: 'branch-worktree' },
        }),
      })
      expect(created.status).toBe(201)
      const session = await created.json() as {
        id: string
        commits: Array<{ oid: string }>
        patch: string
      }
      expect(session.commits.at(-1)?.oid).toBe(LOCAL_CHANGES_OID)
      expect(session.patch).toContain('feature one')
      expect(session.patch).toContain('two edited')

      const selected = await fetch(`${baseUrl}/api/sessions/${session.id}/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: LOCAL_CHANGES_OID, end: LOCAL_CHANGES_OID }),
      })
      expect(selected.status).toBe(200)
      const local = await selected.json() as {
        commits: Array<{ oid: string }>
        selectedCommitStart: string
        selectedCommitEnd: string
        patch: string
        targetLabel: string
      }
      expect(local.commits.map((commit) => commit.oid)).toEqual(
        session.commits.map((commit) => commit.oid),
      )
      expect(local.selectedCommitStart).toBe(LOCAL_CHANGES_OID)
      expect(local.selectedCommitEnd).toBe(LOCAL_CHANGES_OID)
      expect(local.targetLabel).toBe('Local changes')
      expect(local.patch).toContain('two edited')
      expect(local.patch).not.toContain('\n+feature one')

      const restored = await fetch(`${baseUrl}/api/sessions/${session.id}/selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: session.commits[0]!.oid,
          end: LOCAL_CHANGES_OID,
        }),
      })
      expect(restored.status).toBe(200)
      const full = await restored.json() as { patch: string; targetLabel: string }
      expect(full.targetLabel).toBe('Current branch + working tree')
      expect(full.patch).toContain('feature one')
      expect(full.patch).toContain('two edited')
    } finally {
      handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error == null ? resolve() : reject(error))
      })
    }
  })

  test('preserves the full commit timeline while viewing a selected span', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const databasePath = path.join(fixture.directory, 'store.db')
    const store = new ReviewStore(databasePath)
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: 'origin/main...HEAD' },
      review,
      false,
    )
    const selectedCommit = review.commits[1]!
    const selected = await resolveCommitSpan(
      fixture.repository,
      selectedCommit.oid,
      selectedCommit.oid,
    )

    const updated = store.updateResolvedReview(
      session.id,
      selected,
      selectedCommit.oid,
      selectedCommit.oid,
    )

    expect(updated.commits).toEqual(review.commits)
    expect(updated.selectedCommitStart).toBe(selectedCommit.oid)
    expect(updated.patch).toContain('feature two')
    expect(updated.ignoreWhitespace).toBe(false)
    expect(updated.globalComments).toEqual([])
    expect(updated.revisionBaseOid).toBe(review.oldSnapshot.id)
    expect(updated.revisionHeadOid).toBe(review.newSnapshot.id)

    const userGlobal = store.addGlobalComment(session.id, {
      comment: 'Review the routing behavior first',
      source: 'user',
    })
    expect(userGlobal.comment).toBe('Review the routing behavior first')
    expect(userGlobal.source).toBe('user')
    expect(userGlobal.archivedAt).toBeNull()
    expect(store.getSession(session.id).globalComments).toHaveLength(1)

    const agentGlobal = store.addGlobalComment(session.id, {
      comment: 'Agent summary',
      source: 'agent',
    })
    expect(store.addGlobalComment(session.id, { comment: 'Second user note', source: 'user' }).source)
      .toBe('user')
    expect(store.getSession(session.id).globalComments).toHaveLength(3)
    expect(() => store.updateGlobalComment(session.id, agentGlobal.id, 'Edited by user')).toThrow(
      'User global comment not found',
    )
    expect(store.updateGlobalComment(session.id, userGlobal.id, 'Edited by user').comment).toBe(
      'Edited by user',
    )
    expect(store.setGlobalCommentArchived(session.id, agentGlobal.id, true).archivedAt).not.toBeNull()

    expect(
      store.updateResolvedReview(
        session.id,
        selected,
        selectedCommit.oid,
        selectedCommit.oid,
        undefined,
        true,
      ).ignoreWhitespace,
    ).toBe(true)

    const annotation = store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'The second feature change',
      source: 'agent',
    })
    expect(annotation.importance).toBeNull()
    expect(annotation.endSide).toBeNull()
    expect(annotation.archivedAt).toBeNull()
    expect(annotation.intent).toBe('annotation')
    expect(store.getSession(session.id).annotations).toEqual([annotation])

    const archived = store.setAnnotationArchived(session.id, annotation.id, true)
    expect(archived.archivedAt).not.toBeNull()
    expect(store.getSession(session.id).annotations[0]?.archivedAt).toBe(archived.archivedAt)

    const restored = store.setAnnotationArchived(session.id, annotation.id, false)
    expect(restored.archivedAt).toBeNull()

    const crossSide = store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'old',
      startLine: 4,
      endSide: 'new',
      endLine: 5,
      comment: 'The replacement as a whole',
      source: 'user',
    })
    expect(crossSide.endSide).toBe('new')
    expect(
      store.updateAnnotationComment(session.id, crossSide.id, 'Updated review comment').comment,
    ).toBe('Updated review comment')
    const localComment = store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'Keep this local for now',
      source: 'user',
    })
    expect(
      store.updateAnnotationComment(
        session.id,
        localComment.id,
        'Publish this with the review',
        'review-comment',
      ),
    ).toMatchObject({
      comment: 'Publish this with the review',
      intent: 'review-comment',
    })
    expect(
      store.updateAnnotationComment(
        session.id,
        localComment.id,
        'Keep this local after all',
        'annotation',
      ).intent,
    ).toBe('annotation')
    const reviewComment = store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'Publish this with the review',
      source: 'user',
      intent: 'review-comment',
    })
    expect(reviewComment.intent).toBe('review-comment')
    store.markAnnotationsSubmitted(session.id, [reviewComment.id])
    const submitted = store.getSession(session.id).annotations.find(
      (item) => item.id === reviewComment.id,
    )
    expect(submitted?.submittedAt).not.toBeNull()
    expect(submitted?.archivedAt).not.toBeNull()
    expect(() => store.setAnnotationArchived(session.id, reviewComment.id, false)).toThrow()
    expect(() =>
      store.updateAnnotationComment(session.id, reviewComment.id, 'Cannot edit submitted'),
    ).toThrow()
    expect(() =>
      store.updateAnnotationComment(session.id, annotation.id, 'Cannot edit an agent note'),
    ).toThrow('User annotation not found')

    expect(store.setFileViewed(session.id, 'tracked.txt', true).viewedFiles).toEqual([
      'tracked.txt',
    ])
    expect(store.setFileViewed(session.id, 'tracked.txt', true).viewedFiles).toEqual([
      'tracked.txt',
    ])
    expect(store.setFileViewed(session.id, 'tracked.txt', false).viewedFiles).toEqual([])

    const individuallyArchived = store.setAnnotationArchived(session.id, annotation.id, true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const archiveAll = store.archiveAllAnnotations(session.id)
    expect(archiveAll.annotations).toHaveLength(4)
    expect(archiveAll.annotations.every((item) => item.archivedAt !== null)).toBe(true)
    expect(archiveAll.globalComments.every((item) => item.archivedAt !== null)).toBe(true)
    expect(
      archiveAll.annotations.find((item) => item.id === annotation.id)?.updatedAt,
    ).toBe(individuallyArchived.updatedAt)
    expect(store.archiveAllAnnotations(session.id).annotations).toEqual(archiveAll.annotations)
  })

  test('stores a user reply on a top-level agent annotation', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'replies.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: 'origin/main...HEAD' },
      review,
      false,
    )
    const agent = store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'Look at this branch',
      source: 'agent',
    })
    const reply = store.addAnnotation(session.id, {
      filePath: 'ignored.ts',
      side: 'old',
      startLine: 1,
      endLine: 1,
      comment: 'Will keep this local',
      source: 'user',
      replyToId: agent.id,
    })
    expect(reply).toMatchObject({
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'Will keep this local',
      source: 'user',
      intent: 'annotation',
      replyToId: agent.id,
    })
    expect(() => store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'Nested',
      source: 'user',
      replyToId: reply.id,
    })).toThrow('Replies can only be added to a top-level agent annotation')
    expect(() => store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'Agent cannot reply',
      source: 'agent',
      replyToId: agent.id,
    })).toThrow('Only user replies')
  })

  test('migrates sessions created before commit timelines were stored separately', () => {
    const databasePath = path.join(fixture.directory, 'legacy.db')
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        repository_root TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        target_json TEXT NOT NULL,
        target_label TEXT NOT NULL,
        git_command TEXT NOT NULL,
        patch TEXT NOT NULL,
        resolved_json TEXT NOT NULL,
        selected_commit_start TEXT,
        selected_commit_end TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('old', 'new')),
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        comment TEXT,
        importance REAL,
        source TEXT NOT NULL CHECK(source IN ('user', 'agent')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const commit = {
      oid: 'a'.repeat(40),
      shortOid: 'aaaaaaaa',
      subject: 'legacy commit',
      author: 'Reviewer',
      authoredAt: '2026-01-01T00:00:00Z',
    }
    database
      .prepare(`
        INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'drs_legacy',
        fixture.repository,
        'repo',
        JSON.stringify({ kind: 'range', expression: 'main..HEAD' }),
        'main..HEAD',
        "git diff 'main..HEAD'",
        '',
        JSON.stringify({
          label: 'main..HEAD',
          gitCommand: "git diff 'main..HEAD'",
          oldSnapshot: { kind: 'commit', id: 'b'.repeat(40) },
          newSnapshot: { kind: 'commit', id: commit.oid },
          commits: [commit],
        }),
        commit.oid,
        commit.oid,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      )
    database
      .prepare(`
        INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'drs_legacy_pr',
        fixture.repository,
        'repo',
        JSON.stringify({ kind: 'pr', number: 42 }),
        'PR #42',
        'git diff base head',
        '',
        JSON.stringify({
          label: 'PR #42',
          gitCommand: 'git diff base head',
          oldSnapshot: { kind: 'commit', id: 'b'.repeat(40) },
          newSnapshot: { kind: 'commit', id: commit.oid },
          commits: [commit],
        }),
        commit.oid,
        commit.oid,
        '2026-01-02T00:00:00Z',
        '2026-01-02T00:00:00Z',
      )
    database
      .prepare('INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'ann_legacy',
        'drs_legacy',
        'tracked.txt',
        'new',
        5,
        5,
        'Legacy note',
        null,
        'agent',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      )
    database.close()

    const store = new ReviewStore(databasePath)

    expect(store.getSession('drs_legacy').commits).toEqual([commit])
    expect(store.getSession('drs_legacy').viewedFiles).toEqual([])
    expect(store.getSession('drs_legacy').ignoreWhitespace).toBe(false)
    expect(store.getSession('drs_legacy').globalComments).toEqual([])
    expect(store.getSession('drs_legacy').revisionBaseOid).toBe('b'.repeat(40))
    expect(store.getSession('drs_legacy').revisionHeadOid).toBe(commit.oid)
    expect(store.getSession('drs_legacy').annotations).toMatchObject([
      {
        id: 'ann_legacy',
        endSide: null,
        intent: 'annotation',
        replyToId: null,
        archivedAt: null,
        submittedAt: null,
      },
    ])
    expect(store.getSession('drs_legacy_pr').revisionBaseOid).toBe('b'.repeat(40))
    expect(store.getSession('drs_legacy_pr').revisionHeadOid).toBe(commit.oid)
  })

  test('migrates dual-slot global comments into global_comments rows once', () => {
    const databasePath = path.join(fixture.directory, 'legacy-globals.db')
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        repository_root TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        target_json TEXT NOT NULL,
        target_label TEXT NOT NULL,
        git_command TEXT NOT NULL,
        patch TEXT NOT NULL,
        resolved_json TEXT NOT NULL,
        selected_commit_start TEXT,
        selected_commit_end TEXT,
        global_comment TEXT,
        global_comment_source TEXT,
        global_comment_archived_at TEXT,
        agent_global_comment TEXT,
        agent_global_comment_archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('old', 'new')),
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        comment TEXT,
        importance REAL,
        source TEXT NOT NULL CHECK(source IN ('user', 'agent')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const commit = {
      oid: 'a'.repeat(40),
      shortOid: 'aaaaaaaa',
      subject: 'legacy commit',
      author: 'Reviewer',
      authoredAt: '2026-01-01T00:00:00Z',
    }
    database
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'drs_legacy_globals',
        fixture.repository,
        'repo',
        JSON.stringify({ kind: 'range', expression: 'main..HEAD' }),
        'main..HEAD',
        "git diff 'main..HEAD'",
        '',
        JSON.stringify({
          label: 'main..HEAD',
          gitCommand: "git diff 'main..HEAD'",
          oldSnapshot: { kind: 'commit', id: 'b'.repeat(40) },
          newSnapshot: { kind: 'commit', id: commit.oid },
          commits: [commit],
        }),
        commit.oid,
        commit.oid,
        'User overview',
        'user',
        null,
        'Agent overview',
        '2026-01-03T00:00:00Z',
        '2026-01-01T00:00:00Z',
        '2026-01-02T00:00:00Z',
      )
    database.close()

    const first = new ReviewStore(databasePath).getSession('drs_legacy_globals')
    expect(first.globalComments).toEqual([
      expect.objectContaining({
        comment: 'User overview',
        source: 'user',
        archivedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      }),
      expect.objectContaining({
        comment: 'Agent overview',
        source: 'agent',
        archivedAt: '2026-01-03T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
      }),
    ])

    const second = new ReviewStore(databasePath).getSession('drs_legacy_globals')
    expect(second.globalComments.map((comment) => comment.id)).toEqual(
      first.globalComments.map((comment) => comment.id),
    )
  })
})

function createConflictFixture(): { directory: string; repository: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-conflict-'))
  const repository = path.join(directory, 'repo')
  mkdirSync(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.name', 'Diff Reviewer'])
  git(repository, ['config', 'user.email', 'reviewer@example.com'])
  writeFileSync(path.join(repository, 'conflict.txt'), 'base\n')
  writeFileSync(path.join(repository, 'other-conflict.txt'), 'base other\n')
  writeFileSync(path.join(repository, 'clean.txt'), 'shared\n')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'base'])

  git(repository, ['switch', '-c', 'feature'])
  writeFileSync(path.join(repository, 'conflict.txt'), 'feature\n')
  writeFileSync(path.join(repository, 'other-conflict.txt'), 'feature other\n')
  writeFileSync(path.join(repository, 'clean.txt'), 'shared\nfeature only\n')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'feature'])

  git(repository, ['switch', 'main'])
  writeFileSync(path.join(repository, 'conflict.txt'), 'main\n')
  writeFileSync(path.join(repository, 'other-conflict.txt'), 'main other\n')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'main'])

  git(repository, ['switch', '-c', 'clean'])
  writeFileSync(path.join(repository, 'clean.txt'), 'shared\nmain only\n')
  git(repository, ['add', 'clean.txt'])
  git(repository, ['commit', '-m', 'clean'])
  git(repository, ['switch', 'main'])

  return { directory, repository }
}

function createMergedBasePullRequestFixture(): {
  directory: string
  repository: string
  baseOid: string
  headOid: string
} {
  const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-pr-base-'))
  const repository = path.join(directory, 'repo')
  mkdirSync(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.name', 'Diff Reviewer'])
  git(repository, ['config', 'user.email', 'reviewer@example.com'])

  writeFileSync(path.join(repository, 'shared.txt'), 'shared\n')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'root'])

  git(repository, ['switch', '-c', 'feature'])
  writeFileSync(path.join(repository, 'feature.txt'), 'feature\n')
  git(repository, ['add', 'feature.txt'])
  git(repository, ['commit', '-m', 'feature'])

  git(repository, ['switch', 'main'])
  writeFileSync(path.join(repository, 'main.txt'), 'from main\n')
  git(repository, ['add', 'main.txt'])
  git(repository, ['commit', '-m', 'main'])
  const baseOid = git(repository, ['rev-parse', 'HEAD']).trim()

  git(repository, ['switch', 'feature'])
  git(repository, ['merge', '--no-ff', 'main', '-m', 'merge main'])
  const headOid = git(repository, ['rev-parse', 'HEAD']).trim()

  return { directory, repository, baseOid, headOid }
}

function createGitFixture(): { directory: string; repository: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-'))
  const repository = path.join(directory, 'repo')
  const remote = path.join(directory, 'remote.git')
  mkdirSync(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.name', 'Diff Reviewer'])
  git(repository, ['config', 'user.email', 'reviewer@example.com'])

  writeFileSync(path.join(repository, 'tracked.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(repository, 'deleted.txt'), 'old\nremoved\n')
  writeFileSync(path.join(repository, 'spacing.txt'), 'const value = 1\n')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'base'])

  git(directory, ['init', '--bare', '--initial-branch=main', remote])
  git(repository, ['remote', 'add', 'origin', remote])
  git(repository, ['push', '-u', 'origin', 'main'])
  git(repository, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

  git(repository, ['switch', '-c', 'feature'])
  writeFileSync(path.join(repository, 'tracked.txt'), 'one\ntwo\nthree\nfeature one\n')
  writeFileSync(path.join(repository, 'spacing.txt'), 'const value  =  1\n')
  git(repository, ['add', 'tracked.txt', 'spacing.txt'])
  git(repository, ['commit', '-m', 'feature one'])

  git(repository, ['switch', '-c', 'side'])
  writeFileSync(path.join(repository, 'side.txt'), 'from side\n')
  git(repository, ['add', 'side.txt'])
  git(repository, ['commit', '-m', 'side branch commit'])

  git(repository, ['switch', 'feature'])
  writeFileSync(
    path.join(repository, 'tracked.txt'),
    'one\ntwo\nthree\nfeature one\nfeature two\n',
  )
  git(repository, ['add', 'tracked.txt'])
  git(repository, ['commit', '-m', 'feature two'])
  git(repository, ['merge', '--no-ff', 'side', '-m', 'merge side'])

  writeFileSync(path.join(repository, 'staged.txt'), 'staged content\n')
  git(repository, ['add', 'staged.txt'])
  git(repository, ['rm', 'deleted.txt'])
  writeFileSync(
    path.join(repository, 'tracked.txt'),
    'one\ntwo edited\nthree\nfeature one\nfeature two\n',
  )
  writeFileSync(path.join(repository, 'untracked.txt'), 'untracked content\n')

  return { directory, repository }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for asynchronous work')
}
