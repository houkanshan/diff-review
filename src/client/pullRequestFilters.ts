import type { PullRequestSummary } from '../shared/types'
import { readStoredValue } from './browserStorage'

export interface PullRequestFilters {
  excludeUserGuides: boolean
  excludeE2e: boolean
}

export function readPullRequestFilters(): PullRequestFilters {
  return {
    excludeUserGuides: readStoredValue('diff-review-exclude-user-guides') !== 'false',
    excludeE2e: readStoredValue('diff-review-exclude-e2e') !== 'false',
  }
}

export function matchesPullRequestFilters(
  item: Pick<PullRequestSummary, 'title' | 'author' | 'viewerDidAuthor'>,
  filters: PullRequestFilters,
  authorLogin: string,
): boolean {
  if (authorLogin !== '' && item.author.login !== authorLogin) return false
  if (item.viewerDidAuthor === true) return true
  if (filters.excludeUserGuides && /^\[User Guides?\]/i.test(item.title)) return false
  if (filters.excludeE2e && /^\[E2E\]/i.test(item.title)) return false
  return true
}
