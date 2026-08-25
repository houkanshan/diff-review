import type {
  GitHubLabel,
  GitHubReviewer,
  GitHubUser,
  PullRequestCheckStatus,
  PullRequestListResponse,
  PullRequestListView,
  PullRequestState,
  PullRequestSummary,
} from '../shared/types'

const STORAGE_PREFIX = 'diff-review-pull-requests:'
const STORAGE_VERSION = 2

const PULL_REQUEST_STATES = new Set<PullRequestState>(['OPEN', 'CLOSED', 'MERGED'])
const CHECK_STATUSES = new Set<PullRequestCheckStatus>(['none', 'unknown', 'pending', 'pass', 'fail'])

export function pullRequestListStorageKey(
  repositoryPath: string,
  view: PullRequestListView,
): string {
  return `${STORAGE_PREFIX}${repositoryPath}:${view}`
}

export function parseStoredPullRequestList(raw: string | null): PullRequestListResponse | undefined {
  if (raw == null || raw === '') return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.list)) return undefined
    const items = parsed.list.items
    if (!Array.isArray(items) || typeof parsed.list.fetchedAt !== 'string') return undefined
    const pageInfo = parseStoredPageInfo(parsed.list.pageInfo)
    if (pageInfo == null) return undefined
    const summaries: PullRequestSummary[] = []
    for (const item of items) {
      const summary = parsePullRequestSummary(item)
      if (summary == null) return undefined
      summaries.push(summary)
    }
    return {
      items: summaries,
      fetchedAt: parsed.list.fetchedAt,
      stale: parsed.list.stale === true,
      pageInfo,
    }
  } catch {
    return undefined
  }
}

export function readStoredPullRequestList(
  repositoryPath: string,
  view: PullRequestListView,
): PullRequestListResponse | undefined {
  try {
    return parseStoredPullRequestList(
      window.localStorage.getItem(pullRequestListStorageKey(repositoryPath, view)),
    )
  } catch {
    return undefined
  }
}

export function storePullRequestList(
  repositoryPath: string,
  view: PullRequestListView,
  list: PullRequestListResponse,
): void {
  try {
    window.localStorage.setItem(
      pullRequestListStorageKey(repositoryPath, view),
      JSON.stringify({ version: STORAGE_VERSION, list }),
    )
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function parseStoredPageInfo(value: unknown): PullRequestListResponse['pageInfo'] | undefined {
  if (!isRecord(value) || typeof value.hasNextPage !== 'boolean') return undefined
  if (value.endCursor !== null && typeof value.endCursor !== 'string') return undefined
  return {
    hasNextPage: value.hasNextPage,
    endCursor: value.endCursor === '' ? null : value.endCursor,
  }
}

function parsePullRequestSummary(value: unknown): PullRequestSummary | undefined {
  if (!isRecord(value)) return undefined
  if (
    typeof value.number !== 'number' ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.state !== 'string' ||
    !PULL_REQUEST_STATES.has(value.state as PullRequestState) ||
    typeof value.isDraft !== 'boolean' ||
    typeof value.baseRefName !== 'string' ||
    typeof value.headRefName !== 'string' ||
    typeof value.additions !== 'number' ||
    typeof value.deletions !== 'number' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.checkStatus !== 'string' ||
    !CHECK_STATUSES.has(value.checkStatus as PullRequestCheckStatus)
  ) {
    return undefined
  }
  const author = parseGitHubUser(value.author)
  if (author == null || !Array.isArray(value.assignees) || !Array.isArray(value.reviewers) || !Array.isArray(value.labels)) {
    return undefined
  }
  const assignees: GitHubUser[] = []
  for (const assignee of value.assignees) {
    const parsed = parseGitHubUser(assignee)
    if (parsed == null) return undefined
    assignees.push(parsed)
  }
  const reviewers: GitHubReviewer[] = []
  for (const reviewer of value.reviewers) {
    const parsed = parseGitHubReviewer(reviewer)
    if (parsed == null) return undefined
    reviewers.push(parsed)
  }
  const labels: GitHubLabel[] = []
  for (const label of value.labels) {
    const parsed = parseGitHubLabel(label)
    if (parsed == null) return undefined
    labels.push(parsed)
  }
  return {
    number: value.number,
    title: value.title,
    url: value.url,
    state: value.state as PullRequestState,
    isDraft: value.isDraft,
    baseRefName: value.baseRefName,
    headRefName: value.headRefName,
    additions: value.additions,
    deletions: value.deletions,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    author,
    assignees,
    reviewers,
    labels,
    checkStatus: value.checkStatus as PullRequestCheckStatus,
  }
}

function parseGitHubUser(value: unknown): GitHubUser | undefined {
  if (!isRecord(value) || typeof value.login !== 'string') return undefined
  return {
    login: value.login,
    name: typeof value.name === 'string' ? value.name : null,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : null,
  }
}

function parseGitHubReviewer(value: unknown): GitHubReviewer | undefined {
  const user = parseGitHubUser(value)
  if (user == null || !isRecord(value) || (value.kind !== 'user' && value.kind !== 'team')) return undefined
  return { ...user, kind: value.kind }
}

function parseGitHubLabel(value: unknown): GitHubLabel | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.color !== 'string') return undefined
  return { name: value.name, color: value.color }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
