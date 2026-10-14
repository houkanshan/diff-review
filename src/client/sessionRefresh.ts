import { sessionUsesFullCommitRange, type ReviewSession } from '../shared/types'

// Archived annotations still belong to the revision; never move away from them automatically.
export function canAutoRefreshReview(
  session: ReviewSession,
  editing: boolean,
): boolean {
  return !editing &&
    session.annotations.length === 0 &&
    session.globalComments.length === 0 &&
    sessionUsesFullCommitRange(session)
}
