import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  chmodSync,
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
  rerenderCommitReview,
  resolvePullRequestRevision,
  resolveTarget,
  stageReviewFile,
  validateAnnotationTarget,
} from '../src/server/git.js'
import { ApiHandler } from '../src/server/api.js'
import { PiReviewRunner } from '../src/server/pi.js'
import { ReviewStore } from '../src/server/store.js'

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
    expect(review.commits).toEqual([])
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

  test('keeps a resumable Pi session and safely cleans it after retention', async () => {
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
    writeFileSync(
      pi,
      `#!/bin/sh
exec > "$PI_TEST_OUTPUT"
pwd
git rev-parse HEAD
printf '%s\n' "$@"
session_dir=''
session_id=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-dir) shift; session_dir="$1" ;;
    --session-id) shift; session_id="$1" ;;
  esac
  shift
done
mkdir -p "$session_dir"
printf '{"type":"session","id":"%s","cwd":"%s"}\n' "$session_id" "$PWD" \
  > "$session_dir/2026-01-01T00-00-00-000Z_$session_id.jsonl"
`
    )
    chmodSync(pi, 0o755)
    const originalPath = process.env.PATH
    const originalOutput = process.env.PI_TEST_OUTPUT
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.PI_TEST_OUTPUT = output
    const updates: string[] = []
    const runner = new PiReviewRunner(store, (sessionId) => updates.push(sessionId))

    try {
      expect(runner.start(session.id, 'Emphasize how the data model changed.').state).toBe('creating')
      expect(runner.start(session.id).state).toBe('creating')
      await waitFor(() => runner.getStatus(session.id).state === 'completed')
      const lines = readFileSync(output, 'utf8').split('\n')
      const worktree = lines[0] ?? ''
      expect(lines[1]).toBe(session.revisionHeadOid)
      expect(lines.join('\n')).toContain(`diff-review annotate ${session.id}`)
      expect(lines.join('\n')).toContain('Explain PR #42 in plain language')
      expect(lines).toContain('--session-dir')
      expect(lines).toContain('--session-id')
      expect(lines).not.toContain('--no-session')
      expect(lines.join('\n')).toContain('Emphasize how the data model changed.')
      const status = runner.getStatus(session.id)
      expect(status.state).toBe('completed')
      if (status.state !== 'completed') throw new Error('Expected completed Pi review')
      expect(path.basename(status.worktreePath)).toBe(path.basename(worktree))
      expect(status.piSessionPath).not.toBeNull()
      expect(existsSync(status.worktreePath)).toBe(true)
      expect(existsSync(status.piSessionPath ?? '')).toBe(true)

      store.updatePiReviewRun(status.id, { cleanupEligibleAt: '1970-01-01T00:00:00.000Z' })
      await runner.reconcileAndCleanup()
      expect(runner.getStatus(session.id).state).toBe('cleaned')
      expect(existsSync(status.worktreePath)).toBe(false)
      expect(existsSync(status.piSessionDir)).toBe(false)
    } finally {
      process.env.PATH = originalPath
      if (originalOutput == null) delete process.env.PI_TEST_OUTPUT
      else process.env.PI_TEST_OUTPUT = originalOutput
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

  test('leases a saved Pi session while it is being resumed', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-run-lease.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const worktree = path.join(fixture.directory, 'lease-worktree')
    const piSessionDir = path.join(fixture.directory, 'lease-session')
    const piSessionPath = path.join(piSessionDir, 'saved.jsonl')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(piSessionDir, { recursive: true })
    writeFileSync(piSessionPath, '{}\n')
    const run = store.createPiReviewRun(
      session.id,
      worktree,
      piSessionDir,
      'saved-session',
      '2026-01-01T00:00:00.000Z',
    )
    store.updatePiReviewRun(run.id, { state: 'completed', piSessionPath })
    const runner = new PiReviewRunner(store, () => undefined)

    const leased = runner.acquireLease(run.id, process.pid)
    expect(leased.activePid).toBe(process.pid)
    expect(leased.piSessionPath).toBe(piSessionPath)
    const released = runner.releaseLease(run.id, process.pid)
    expect(released.activePid).toBeNull()
    expect(released.cleanupEligibleAt >= leased.cleanupEligibleAt).toBe(true)
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

  test('a cleanup claim excludes a concurrent resume lease', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const store = new ReviewStore(path.join(fixture.directory, 'pi-run-cleanup-lease.db'))
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'pr', number: 42 },
      review,
      false,
    )
    const worktree = path.join(fixture.directory, 'cleanup-lease-worktree')
    const piSessionDir = path.join(fixture.directory, 'cleanup-lease-session')
    const piSessionPath = path.join(piSessionDir, 'saved.jsonl')
    mkdirSync(worktree, { recursive: true })
    mkdirSync(piSessionDir, { recursive: true })
    writeFileSync(piSessionPath, '{}\n')
    const run = store.createPiReviewRun(
      session.id,
      worktree,
      piSessionDir,
      'cleanup-session',
      '1970-01-01T00:00:00.000Z',
    )
    store.updatePiReviewRun(run.id, { state: 'completed', piSessionPath })
    expect(store.claimPiReviewRunForCleanup(run.id)?.state).toBe('cleaning')

    const runner = new PiReviewRunner(store, () => undefined)
    expect(() => runner.acquireLease(run.id, process.pid)).toThrow(/cleaned up/)
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
    expect(updated.globalComment).toBeNull()
    expect(updated.revisionBaseOid).toBe(review.oldSnapshot.id)
    expect(updated.revisionHeadOid).toBe(review.newSnapshot.id)

    expect(store.setGlobalComment(session.id, 'Review the routing behavior first').globalComment)
      .toBe('Review the routing behavior first')
    expect(store.getSession(session.id).globalComment).toBe('Review the routing behavior first')

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
    expect(
      archiveAll.annotations.find((item) => item.id === annotation.id)?.updatedAt,
    ).toBe(individuallyArchived.updatedAt)
    expect(store.archiveAllAnnotations(session.id).annotations).toEqual(archiveAll.annotations)
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
    expect(store.getSession('drs_legacy').globalComment).toBeNull()
    expect(store.getSession('drs_legacy').revisionBaseOid).toBe('b'.repeat(40))
    expect(store.getSession('drs_legacy').revisionHeadOid).toBe(commit.oid)
    expect(store.getSession('drs_legacy').annotations).toMatchObject([
      {
        id: 'ann_legacy',
        endSide: null,
        intent: 'annotation',
        archivedAt: null,
        submittedAt: null,
      },
    ])
    expect(store.getSession('drs_legacy_pr').revisionBaseOid).toBe('b'.repeat(40))
    expect(store.getSession('drs_legacy_pr').revisionHeadOid).toBe(commit.oid)
  })
})

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
