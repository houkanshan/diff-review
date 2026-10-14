import { describe, expect, it } from 'vitest'
import { canAutoRefreshReview } from '../src/client/sessionRefresh'
import type { ReviewSession, SessionAnnotation } from '../src/shared/types'

const session: ReviewSession = {
  id: 'drs_old', repositoryRoot: '/repo', repositoryName: 'repo',
  target: { kind: 'worktree' }, targetLabel: 'Worktree', gitCommand: '', patch: '',
  commits: [], selectedCommitStart: null, selectedCommitEnd: null,
  annotations: [], globalComments: [], viewedFiles: [], ignoreWhitespace: false,
  revisionBaseOid: null, revisionHeadOid: null, unstagedPaths: null, jevFileOrder: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}
const annotation: SessionAnnotation = {
  id: 'ann_one', shortId: 'A', sessionId: session.id, filePath: 'file.ts', side: 'new',
  startLine: 1, endLine: 1, endSide: null, comment: 'Keep this revision',
  importance: null, source: 'user', intent: 'annotation', replyToId: null,
  archivedAt: null, submittedAt: null, viewedAt: null,
  createdAt: session.createdAt, updatedAt: session.updatedAt,
}

describe('automatic review refresh eligibility', () => {
  it('refreshes an empty review but waits while editing or busy', () => {
    expect(canAutoRefreshReview(session, false)).toBe(true)
    expect(canAutoRefreshReview(session, true)).toBe(false)
  })

  it.each([
    annotation,
    { ...annotation, source: 'agent' as const },
    { ...annotation, intent: 'review-comment' as const },
    { ...annotation, archivedAt: session.createdAt },
  ])('keeps annotated revisions, including archived annotations', (note) => {
    expect(canAutoRefreshReview({ ...session, annotations: [note] }, false)).toBe(false)
  })

  it('keeps a revision with a global comment', () => {
    expect(canAutoRefreshReview({
      ...session,
      globalComments: [{ id: 'comment', sessionId: session.id, comment: 'Keep',
        source: 'user', archivedAt: null, createdAt: session.createdAt, updatedAt: session.updatedAt }],
    }, false)).toBe(false)
  })

  it('does not reset a narrowed commit selection', () => {
    const range = {
      ...session,
      commits: [
        { oid: 'first', shortOid: 'first', subject: 'First', author: 'User', authoredAt: session.createdAt },
        { oid: 'last', shortOid: 'last', subject: 'Last', author: 'User', authoredAt: session.createdAt },
      ],
      selectedCommitStart: 'first', selectedCommitEnd: 'last',
    }
    expect(canAutoRefreshReview(range, false)).toBe(true)
    expect(canAutoRefreshReview({ ...range, selectedCommitEnd: 'first' }, false)).toBe(false)
  })
})
