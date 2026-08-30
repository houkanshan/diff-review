export type DiffSide = 'old' | 'new'
export type DiffRenderer = 'pierre' | 'difftastic'
export type DifftasticFileStatus = 'unchanged' | 'changed' | 'created' | 'deleted'
export type DifftasticLineKind = 'context' | 'delete' | 'insert' | 'change'
export type DifftasticHighlight =
  | 'delimiter'
  | 'normal'
  | 'string'
  | 'type'
  | 'comment'
  | 'keyword'
  | 'tree_sitter_error'

export interface DifftasticAvailability {
  available: boolean
  version: string | null
  installHint: string
}

export interface DifftasticSpan {
  start: number
  end: number
  content: string
  highlight: DifftasticHighlight
}

export interface DifftasticHunkLine {
  kind: DifftasticLineKind
  oldLine: number | null
  newLine: number | null
  oldText: string | null
  newText: string | null
  oldSpans: DifftasticSpan[]
  newSpans: DifftasticSpan[]
}

export interface DifftasticHunk {
  lines: DifftasticHunkLine[]
}

export interface DifftasticFileDiff {
  path: string
  language: string
  status: DifftasticFileStatus
  hunks: DifftasticHunk[]
}

export type AnnotationIntent = 'annotation' | 'review-comment'


export type ReviewTarget =
  | { kind: 'worktree' }
  | { kind: 'branch-worktree' }
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'range'; expression: string }
  | { kind: 'pr'; number: number }

export function targetSupportsStaging(target: ReviewTarget): boolean {
  switch (target.kind) {
    case 'worktree':
    case 'branch-worktree':
    case 'unstaged':
      return true
    case 'staged':
    case 'range':
    case 'pr':
      return false
  }
}

export function sessionUsesFullCommitRange(session: {
  commits: Array<{ oid: string }>
  selectedCommitStart: string | null
  selectedCommitEnd: string | null
}): boolean {
  const first = session.commits.at(0)?.oid ?? null
  const last = session.commits.at(-1)?.oid ?? null
  return session.commits.length === 0
    || (session.selectedCommitStart === first && session.selectedCommitEnd === last)
}

export function reviewTargetsEqual(left: ReviewTarget, right: ReviewTarget): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'range' && right.kind === 'range') {
    return left.expression.trim() === right.expression.trim()
  }
  if (left.kind === 'pr' && right.kind === 'pr') return left.number === right.number
  return true
}

/** Target to open after switching repositories. `null` means the pull request list. */
export function reviewTargetForRepositorySwitch(
  target: ReviewTarget,
  ranges: {
    sourceBranchRange?: string | null
    destinationBranchRange?: string | null
  } = {},
): ReviewTarget | null {
  switch (target.kind) {
    case 'pr':
      return null
    case 'range': {
      const source = ranges.sourceBranchRange?.trim() ?? null
      const destination = ranges.destinationBranchRange?.trim() ?? null
      if (source != null && destination != null && target.expression.trim() === source) {
        return { kind: 'range', expression: destination }
      }
      return target
    }
    case 'worktree':
    case 'branch-worktree':
    case 'unstaged':
    case 'staged':
      return target
  }
}

export type SessionUpdatedEvent = {
  type: 'session-updated'
  sessionId: string
}

export type PiChatEvent = {
  type: 'pi-chat'
  sessionId: string
  overlay: PiChatOverlay | null
  transcriptRevision: string
}

export type ServerEvent = SessionUpdatedEvent | PiChatEvent

export interface CommitSummary {
  oid: string
  shortOid: string
  subject: string
  author: string
  authoredAt: string
}

export const LOCAL_CHANGES_OID = 'local-changes'

export function isLocalChangesOid(oid: string | null | undefined): boolean {
  return oid === LOCAL_CHANGES_OID
}

export function localChangesCommit(): CommitSummary {
  return {
    oid: LOCAL_CHANGES_OID,
    shortOid: 'local',
    subject: 'Local changes',
    author: '',
    authoredAt: '',
  }
}

export interface SessionAnnotation {
  id: string
  sessionId: string
  filePath: string
  side: DiffSide
  startLine: number
  endSide: DiffSide | null
  endLine: number
  comment: string | null
  importance: number | null
  source: 'user' | 'agent'
  intent: AnnotationIntent
  replyToId: string | null
  archivedAt: string | null
  submittedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SessionGlobalComment {
  id: string
  sessionId: string
  comment: string
  source: 'user' | 'agent'
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface AddGlobalCommentInput {
  comment: string
  source: 'user' | 'agent'
}

export interface SessionFreshness {
  stale: boolean
}

export interface ReviewSession {
  id: string
  repositoryRoot: string
  repositoryName: string
  target: ReviewTarget
  targetLabel: string
  gitCommand: string
  patch: string
  commits: CommitSummary[]
  selectedCommitStart: string | null
  selectedCommitEnd: string | null
  annotations: SessionAnnotation[]
  globalComments: SessionGlobalComment[]
  viewedFiles: string[]
  ignoreWhitespace: boolean
  revisionBaseOid: string | null
  revisionHeadOid: string | null
  unstagedPaths: string[] | null
  createdAt: string
  updatedAt: string
}

export interface RepositoryInfo {
  root: string
  name: string
  branch: string | null
  defaultBranchRef: string | null
  branchRange: string | null
}

export type PullRequestListView = 'open' | 'additional-review' | 'merged'
export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'
export type PullRequestCheckStatus = 'none' | 'unknown' | 'pending' | 'pass' | 'fail'
export type PullRequestCheckRunStatus = 'pending' | 'pass' | 'fail' | 'skipped'
export type PullRequestMergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export interface PullRequestCheckRun {
  name: string
  workflowName: string | null
  status: PullRequestCheckRunStatus
  url: string | null
}

export interface GitHubUser {
  login: string
  name: string | null
  avatarUrl: string | null
}

export interface GitHubReviewer extends GitHubUser {
  kind: 'user' | 'team'
  reviewStatus: PullRequestReviewStatus
}

export interface GitHubLabel {
  name: string
  color: string
}

export type PullRequestReviewStatus = 'none' | 'approved' | 'rejected'

export interface GitHubIssueReference {
  token: string
  label: string
  owner: string
  repository: string
  number: number
  kind: 'issue' | 'pull-request'
  title: string
  url: string
}

export interface PullRequestSummary {
  number: number
  title: string
  url: string
  state: PullRequestState
  isDraft: boolean
  baseRefName: string
  headRefName: string
  additions: number
  deletions: number
  createdAt: string
  updatedAt: string
  author: GitHubUser
  assignees: GitHubUser[]
  reviewers: GitHubReviewer[]
  labels: GitHubLabel[]
  checkStatus: PullRequestCheckStatus
  commentCount: number
}

export interface PullRequestListPageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

export interface PullRequestListResponse {
  items: PullRequestSummary[]
  fetchedAt: string
  stale: boolean
  pageInfo: PullRequestListPageInfo
}

export type MinimizedCommentReason =
  | 'abuse'
  | 'off-topic'
  | 'outdated'
  | 'resolved'
  | 'duplicate'
  | 'spam'
  | 'low-quality'

export type PullRequestActivity =
  | {
      kind: 'comment'
      id: string
      author: GitHubUser
      body: string
      createdAt: string
      updatedAt: string
      url: string | null
      minimizedReason: MinimizedCommentReason | null
    }
  | {
      kind: 'review'
      id: string
      author: GitHubUser
      body: string
      state: string
      createdAt: string
      updatedAt: string
      url: string | null
    }
  | {
      kind: 'review-comment'
      id: string
      author: GitHubUser
      body: string
      path: string
      line: number | null
      side: DiffSide | null
      reviewId: string | null
      replyToId: string | null
      createdAt: string
      updatedAt: string
      url: string | null
      diffHunk: string
      minimizedReason: MinimizedCommentReason | null
    }
  | {
      kind: 'timeline'
      id: string
      event: string
      author: GitHubUser | null
      createdAt: string
      label: string | null
      subject: string | null
      commitId: string | null
      source: GitHubTimelineSource | null
      previousTitle: string | null
      currentTitle: string | null
    }

export interface GitHubTimelineSource {
  kind: 'issue' | 'pull-request'
  number: number
  title: string
  url: string | null
  repository: string | null
}

export interface PullRequestDetails extends PullRequestSummary {
  body: string
  mergedBy: GitHubUser | null
  mergeable: PullRequestMergeable
  conflictFiles: string[]
  issueReferences: GitHubIssueReference[]
  baseRefOid: string
  headRefOid: string
  checks: PullRequestCheckRun[]
  activity: PullRequestActivity[]
}

export interface PullRequestRevision {
  sessionId: string
  baseOid: string
  headOid: string
  annotationCount: number
  createdAt: string
}

export interface PullRequestWorkspace {
  details: PullRequestDetails
  currentSession: ReviewSession
  selectedSession: ReviewSession
  revisions: PullRequestRevision[]
  piStatus: PiReviewStatus
}

export type PiReviewRunState =
  | 'creating'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cleaning'
  | 'cleanup-blocked'
  | 'cleaned'

export interface PiReviewRun {
  id: string
  sessionId: string
  worktreePath: string
  piSessionDir: string
  piSessionId: string
  piSessionPath: string | null
  state: PiReviewRunState
  activePid: number | null
  keep: boolean
  error: string | null
  startedAt: string
  completedAt: string | null
  lastUsedAt: string
  cleanupEligibleAt: string
  cleanedAt: string | null
}

export type PiReviewStatus = { state: 'idle' } | PiReviewRun

export interface PiChatWork {
  durationMs: number | null
  detail: string
}

export interface PiChatTurn {
  id: string
  userText: string
  assistantText: string
  work: PiChatWork | null
}

export interface PiChatOverlay {
  overlayId: string
  requestId: string
  afterTurnId: string | null
  baseRevision: string
  userText: string
  assistantText: string
  working: boolean
  hasWork: boolean
  workDetail: string
  startedAt: string
  seq: number
}

export interface PiChatPage {
  turns: PiChatTurn[]
  nextBefore: string | null
  transcriptRevision: string
  overlay: PiChatOverlay | null
  busy: boolean
  error: string | null
  piInstalled: boolean
}

export interface SendPiChatInput {
  message: string
}

export interface CreateSessionInput {
  repositoryPath: string
  target: ReviewTarget
}

export interface OpenPullRequestInput {
  repositoryPath: string
  revisionId?: string | null
}

export interface UpdatePullRequestLabelInput {
  repositoryPath: string
}

export interface AddPullRequestCommentInput {
  repositoryPath: string
  body: string
  replyToId?: string | null
}

export type PullRequestReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES'

export interface SubmitPullRequestReviewInput {
  repositoryPath: string
  event: PullRequestReviewEvent
  sessionId: string
  body: string
}

export interface SquashMergePullRequestInput {
  repositoryPath: string
  expectedHeadOid: string
}

export interface AddAnnotationInput {
  filePath: string
  side: DiffSide
  startLine: number
  endSide?: DiffSide
  endLine: number
  comment?: string
  importance?: number
  source: 'user' | 'agent'
  intent?: AnnotationIntent
  replyToId?: string
}

export interface UpdateAnnotationInput {
  comment: string
  intent?: AnnotationIntent
}

export interface ApiErrorShape {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
