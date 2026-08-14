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
  createdAt: string
  updatedAt: string
}

export interface RepositoryInfo {
  root: string
  name: string
  branch: string | null
  defaultBranchRef: string | null
  branchRange: string | null
  pullRequests: PullRequestSummary[]
}

export interface PullRequestSummary {
  number: number
  title: string
  baseRefName: string
  headRefName: string
}

export interface CreateSessionInput {
  repositoryPath: string
  target: ReviewTarget
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
