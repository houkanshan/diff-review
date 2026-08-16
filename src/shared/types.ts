export type DiffSide = 'old' | 'new'

export type ReviewTarget =
  | { kind: 'worktree' }
  | { kind: 'unstaged' }
  | { kind: 'staged' }
  | { kind: 'range'; expression: string }
  | { kind: 'pr'; number: number }

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
  archivedAt: string | null
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
export type PullRequestCheckStatus = 'none' | 'pending' | 'pass' | 'fail'
export type PullRequestCheckRunStatus = 'pending' | 'pass' | 'fail' | 'skipped'

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

export interface GitHubLabel {
  name: string
  color: string
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
  labels: GitHubLabel[]
  checkStatus: PullRequestCheckStatus
}

export type PullRequestActivity =
  | {
      kind: 'comment'
      id: string
      author: GitHubUser
      body: string
      createdAt: string
      updatedAt: string
      url: string | null
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
      replyToId: string | null
      createdAt: string
      updatedAt: string
      url: string | null
    }

export interface PullRequestDetails extends PullRequestSummary {
  body: string
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

export interface AddAnnotationInput {
  filePath: string
  side: DiffSide
  startLine: number
  endSide?: DiffSide
  endLine: number
  comment?: string
  importance?: number
  source: 'user' | 'agent'
}

export interface ApiErrorShape {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
