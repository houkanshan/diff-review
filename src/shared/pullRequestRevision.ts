export function reusablePullRequestSession<T extends { revisionHeadOid?: string | null }>(
  existing: T | null,
  headOid: string,
): T | null {
  if (existing == null || existing.revisionHeadOid !== headOid) return null
  return existing
}

export function selectOpenPullRequestSession<T extends {
  repositoryRoot: string
  target: { kind: string; number?: number }
}>(
  current: T,
  requested: T | undefined,
): T {
  if (requested == null) return current
  if (
    requested.repositoryRoot === current.repositoryRoot &&
    requested.target.kind === 'pr' &&
    current.target.kind === 'pr' &&
    requested.target.number === current.target.number
  ) {
    return requested
  }
  return current
}

export function repairedPullRequestRevisionId(input: {
  pullRequestNumber: number | null
  requestedRevisionId: string | null
  isPlaceholderData: boolean
  workspace: {
    details: { number: number }
    selectedSession: { id: string }
  } | null
}): string | null {
  if (input.isPlaceholderData || input.pullRequestNumber == null || input.workspace == null) {
    return null
  }
  if (input.workspace.details.number !== input.pullRequestNumber) return null
  const revisionId = input.workspace.selectedSession.id
  return input.requestedRevisionId === revisionId ? null : revisionId
}
