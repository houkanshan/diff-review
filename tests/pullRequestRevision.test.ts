import { describe, expect, it } from 'vitest'

import {
  repairedPullRequestRevisionId,
  reusablePullRequestSession,
  selectOpenPullRequestSession,
} from '../src/shared/pullRequestRevision.js'

function session(
  id: string,
  number: number,
  repositoryRoot = '/repo',
) {
  return { id, repositoryRoot, target: { kind: 'pr' as const, number } }
}

describe('reusablePullRequestSession', () => {
  it('reuses a stored session when the head oid is unchanged', () => {
    const existing = { id: 'drs_current', revisionHeadOid: 'abc' }
    expect(reusablePullRequestSession(existing, 'abc')).toBe(existing)
  })

  it('resolves again when the head oid changed', () => {
    expect(reusablePullRequestSession(
      { id: 'drs_old', revisionHeadOid: 'abc' },
      'def',
    )).toBeNull()
  })

  it('resolves when no session exists for the head', () => {
    expect(reusablePullRequestSession(null, 'abc')).toBeNull()
  })
})

describe('selectOpenPullRequestSession', () => {
  const current = session('drs_current', 19657)

  it('keeps a valid older revision', () => {
    const older = session('drs_older', 19657)
    expect(selectOpenPullRequestSession(current, older)).toBe(older)
  })

  it('falls back when the revision is missing', () => {
    expect(selectOpenPullRequestSession(current, undefined)).toBe(current)
  })

  it('falls back when the revision belongs to another pull request', () => {
    expect(selectOpenPullRequestSession(current, session('drs_other', 1))).toBe(current)
  })

  it('falls back when the revision belongs to another repository', () => {
    expect(selectOpenPullRequestSession(
      current,
      session('drs_worktree', 19657, '/other'),
    )).toBe(current)
  })
})

describe('repairedPullRequestRevisionId', () => {
  const workspace = {
    details: { number: 19657 },
    selectedSession: { id: 'drs_current' },
  }

  it('does not rewrite a valid requested revision', () => {
    expect(repairedPullRequestRevisionId({
      pullRequestNumber: 19657,
      requestedRevisionId: 'drs_current',
      isPlaceholderData: false,
      workspace,
    })).toBeNull()
  })

  it('repairs a mismatched revision to the selected session', () => {
    expect(repairedPullRequestRevisionId({
      pullRequestNumber: 19657,
      requestedRevisionId: 'drs_stale',
      isPlaceholderData: false,
      workspace,
    })).toBe('drs_current')
  })

  it('does not repair while placeholder data is showing', () => {
    expect(repairedPullRequestRevisionId({
      pullRequestNumber: 19657,
      requestedRevisionId: 'drs_older',
      isPlaceholderData: true,
      workspace,
    })).toBeNull()
  })
})
