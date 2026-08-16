import type { PullRequestReviewEvent, PullRequestState } from './types.js'

export function pullRequestAllowsReviewEvent(
  state: PullRequestState,
  event: PullRequestReviewEvent,
): boolean {
  return event === 'COMMENT' || state === 'OPEN'

}
