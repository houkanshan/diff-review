import type {
  AddAnnotationInput,
  UpdateAnnotationInput,
  AddPullRequestCommentInput,
  ApiErrorShape,
  CreateSessionInput,
  DifftasticAvailability,
  DifftasticFileDiff,
  OpenPullRequestInput,
  PiReviewStatus,
  PullRequestListView,
  PullRequestRevision,
  PullRequestSummary,
  PullRequestWorkspace,
  SquashMergePullRequestInput,
  SubmitPullRequestReviewInput,
  UpdatePullRequestLabelInput,
  RepositoryInfo,
  ReviewSession,
  SessionAnnotation,
  StartPiReviewInput,
} from '../shared/types'

export class ClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function getSession(id: string): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}`)
}

export function getSessions(repositoryPath?: string): Promise<ReviewSession[]> {
  const query = repositoryPath == null
    ? ''
    : `?repositoryPath=${encodeURIComponent(repositoryPath)}`
  return request(`/api/sessions${query}`)
}

export function getRepositoryInfo(repositoryPath: string): Promise<RepositoryInfo> {
  return request(`/api/repository?path=${encodeURIComponent(repositoryPath)}`)
}

export function getPullRequests(
  repositoryPath: string,
  view: PullRequestListView,
): Promise<PullRequestSummary[]> {
  return request(
    `/api/pull-requests?repositoryPath=${encodeURIComponent(repositoryPath)}&view=${view}`,
  )
}

export function openPullRequest(
  number: number,
  input: OpenPullRequestInput,
): Promise<PullRequestWorkspace> {
  return request(`/api/pull-requests/${number}/open`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function removePullRequestLabel(
  number: number,
  label: string,
  input: UpdatePullRequestLabelInput,
): Promise<void> {
  return request(
    `/api/pull-requests/${number}/labels/${encodeURIComponent(label)}`,
    { method: 'DELETE', body: JSON.stringify(input) },
  )
}

export function addPullRequestComment(
  number: number,
  input: AddPullRequestCommentInput,
): Promise<void> {
  return request(`/api/pull-requests/${number}/comments`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function submitPullRequestReview(
  number: number,
  input: SubmitPullRequestReviewInput,
): Promise<void> {
  return request(`/api/pull-requests/${number}/reviews`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function squashMergePullRequest(
  number: number,
  input: SquashMergePullRequestInput,
): Promise<void> {
  return request(`/api/pull-requests/${number}/merge`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getPullRequestRevisions(
  repositoryPath: string,
  number: number,
): Promise<PullRequestRevision[]> {
  return request(
    `/api/pull-requests/${number}/revisions?repositoryPath=${encodeURIComponent(repositoryPath)}`,
  )
}

export function createSession(input: CreateSessionInput): Promise<ReviewSession> {
  return request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function refreshSession(id: string): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
}

export function getPiReviewStatus(id: string): Promise<PiReviewStatus> {
  return request(`/api/sessions/${encodeURIComponent(id)}/pi-review`)
}

export function startPiReview(id: string, input: StartPiReviewInput): Promise<PiReviewStatus> {
  return request(`/api/sessions/${encodeURIComponent(id)}/pi-review`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function selectCommits(
  id: string,
  start: string,
  end: string,
): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/selection`, {
    method: 'POST',
    body: JSON.stringify({ start, end }),
  })
}

export function setIgnoreWhitespace(
  id: string,
  ignoreWhitespace: boolean,
): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/whitespace`, {
    method: 'POST',
    body: JSON.stringify({ ignoreWhitespace }),
  })
}

export function addAnnotation(
  id: string,
  input: AddAnnotationInput,
): Promise<SessionAnnotation> {
  return request(`/api/sessions/${encodeURIComponent(id)}/annotations`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function deleteAnnotation(id: string, annotationId: string): Promise<void> {
  await request(`/api/sessions/${encodeURIComponent(id)}/annotations/${annotationId}`, {
    method: 'DELETE',
  })
}

export function setAnnotationArchived(
  id: string,
  annotationId: string,
  archived: boolean,
): Promise<SessionAnnotation> {
  return request(
    `/api/sessions/${encodeURIComponent(id)}/annotations/${annotationId}/archive`,
    {
      method: 'POST',
      body: JSON.stringify({ archived }),
    },
  )
}

export function updateAnnotationComment(
  id: string,
  annotationId: string,
  input: UpdateAnnotationInput,
): Promise<SessionAnnotation> {
  return request(`/api/sessions/${encodeURIComponent(id)}/annotations/${annotationId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function updateGlobalComment(id: string, comment: string): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/global-comment`, {
    method: 'PATCH',
    body: JSON.stringify({ comment }),
  })
}

export function archiveAllAnnotations(id: string): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/annotations/archive`, {
    method: 'POST',
  })
}

export function setFileViewed(
  id: string,
  filePath: string,
  viewed: boolean,
): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/files/viewed`, {
    method: 'POST',
    body: JSON.stringify({ filePath, viewed }),
  })
}

export function stageFile(id: string, filePath: string): Promise<ReviewSession> {
  return request(`/api/sessions/${encodeURIComponent(id)}/files/stage`, {
    method: 'POST',
    body: JSON.stringify({ filePath }),
  })
}

export async function getFileContents(
  sessionId: string,
  filePath: string,
  side: 'old' | 'new',
): Promise<string | null> {
  const result = await request<{ contents: string | null }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(filePath)}&side=${side}`,
  )
  return result.contents
}

export function getDifftasticAvailability(): Promise<DifftasticAvailability> {
  return request('/api/difftastic')
}

export function getDifftasticFile(
  sessionId: string,
  filePath: string,
): Promise<DifftasticFileDiff> {
  return request(
    `/api/sessions/${encodeURIComponent(sessionId)}/difftastic?path=${encodeURIComponent(filePath)}`,
  )
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (response.status === 204) return undefined as T
  const body = (await response.json()) as T | ApiErrorShape
  if (!response.ok) {
    const error = body as ApiErrorShape
    throw new ClientError(
      error.error?.code ?? 'REQUEST_FAILED',
      error.error?.message ?? `Request failed with ${response.status}`,
    )
  }
  return body as T
}
