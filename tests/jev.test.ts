import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ApiHandler } from '../src/server/api.js'
import { currentFilePathsFromPatch } from '../src/server/git.js'
import {
  jevFileOrderFingerprint,
  rankFilesForReview,
  reviewCommitMessages,
} from '../src/server/jev.js'
import { ReviewStore } from '../src/server/store.js'
import {
  JEV_FILE_ORDER_API_KEY_HINT,
  LOCAL_CHANGES_OID,
  localChangesCommit,
  type JevFileOrderResponse,
} from '../src/shared/types.js'

const twoFilePatch = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1 @@
-old
+new
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
--- a/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-old
+new
`

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.TYPESAFE_API_KEY
})

describe('jev file order', () => {
  test('reads current paths from a patch, including deletions and renames', () => {
    expect(currentFilePathsFromPatch(twoFilePatch)).toEqual([
      'src/auth.ts',
      'gone.ts',
      'new.ts',
    ])
  })

  test('fingerprints file set, branch, and commit messages', () => {
    const left = jevFileOrderFingerprint({
      files: ['b.ts', 'a.ts'],
      branch: 'fix-auth',
      commitMessages: ['Fix login'],
    })
    const right = jevFileOrderFingerprint({
      files: ['a.ts', 'b.ts'],
      branch: 'fix-auth',
      commitMessages: ['Fix login'],
    })
    expect(left).toBe(right)
    expect(jevFileOrderFingerprint({
      files: ['a.ts', 'b.ts'],
      branch: 'other',
      commitMessages: ['Fix login'],
    })).not.toBe(left)
  })

  test('uses selected commit subjects and skips local changes', () => {
    expect(reviewCommitMessages({
      commits: [
        {
          oid: 'aaa',
          shortOid: 'aaa',
          subject: 'First',
          author: 'A',
          authoredAt: '2026-01-01T00:00:00Z',
        },
        {
          oid: 'bbb',
          shortOid: 'bbb',
          subject: 'Second',
          author: 'A',
          authoredAt: '2026-01-02T00:00:00Z',
        },
        localChangesCommit(),
      ],
      selectedCommitStart: 'bbb',
      selectedCommitEnd: LOCAL_CHANGES_OID,
    })).toEqual(['Second'])
  })

  test('sorts files by the choice distribution and keeps original order on ties', async () => {
    process.env.TYPESAFE_API_KEY = 'test-key'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        answers: {
          read_first: {
            type: 'choice',
            choice: 'src/auth.ts',
            probabilities: {
              'src/auth.ts': 0.7,
              'src/auth.test.ts': 0.2,
              'package-lock.json': 0.1,
            },
          },
        },
      }),
    })) as typeof fetch)

    await expect(rankFilesForReview({
      files: ['package-lock.json', 'src/auth.test.ts', 'src/auth.ts'],
      branch: 'fix-auth-redirect',
      commitMessages: ['Fix login redirect after SSO'],
    })).resolves.toEqual([
      'src/auth.ts',
      'src/auth.test.ts',
      'package-lock.json',
    ])

    const body = JSON.parse(
      String((vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as {
      state: { branch: string; commit_messages: string[] }
      questions: { read_first: { criteria: Record<string, null> } }
    }
    expect(body.state).toEqual({
      branch: 'fix-auth-redirect',
      commit_messages: ['Fix login redirect after SSO'],
    })
    expect(body.questions.read_first.criteria).toEqual({
      'package-lock.json': null,
      'src/auth.test.ts': null,
      'src/auth.ts': null,
    })
  })

  test('returns a missing-key hint without calling TypeSafe', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-jev-'))
    const store = new ReviewStore(path.join(directory, 'reviews.db'))
    const session = store.createSession(
      directory,
      'repo',
      { kind: 'worktree' },
      {
        label: 'Worktree',
        gitCommand: 'git diff',
        patch: twoFilePatch,
        oldSnapshot: { kind: 'worktree', id: 'old' },
        newSnapshot: { kind: 'worktree', id: 'new' },
        commits: [],
      },
      true,
    )
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/file-order`, {
        method: 'POST',
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        status: 'unavailable',
        reason: 'missing-api-key',
        message: JEV_FILE_ORDER_API_KEY_HINT,
      } satisfies JevFileOrderResponse)
      expect(store.getSession(session.id).jevFileOrder).toBeNull()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      handler.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
