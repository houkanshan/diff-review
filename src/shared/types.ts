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

export function reviewTargetsEqual(left: ReviewTarget, right: ReviewTarget): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'range' && right.kind === 'range') {
    return left.expression.trim() === right.expression.trim()
  }
  if (left.kind === 'pr' && right.kind === 'pr') return left.number === right.number
  return true
}

export type SessionUpdatedEvent = {
  type: 'session-updated'
  sessionId: string
}

export interface CommitSummary {
  oid: string
  shortOid: string
  subject: string
  author: string
  authoredAt: string
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
  archivedAt: string | null
  submittedAt: string | null
  createdAt: string
  updatedAt: string
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
  globalComment: string | null
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
}

export interface GitHubLabel {
  name: string
  color: string
}

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

export interface StartPiReviewInput {
  additionalInstructions: string
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
