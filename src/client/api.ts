import type {
  AddAnnotationInput,
  ApiErrorShape,
  CreateSessionInput,
  RepositoryInfo,
  ReviewSession,
  SessionAnnotation,
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

export function getSessions(): Promise<ReviewSession[]> {
  return request('/api/sessions')
}

export function getRepositoryInfo(repositoryPath: string): Promise<RepositoryInfo> {
  return request(`/api/repository?path=${encodeURIComponent(repositoryPath)}`)
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
