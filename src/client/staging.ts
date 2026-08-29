import type { ReviewTarget } from '../shared/types'

export type FileStageAction = 'add' | 'unstage'

export function stageActionForFile(
  targetKind: ReviewTarget['kind'],
  filePath: string,
  unstagedPaths: ReadonlySet<string>,
  stagedPaths: ReadonlySet<string>,
): FileStageAction | null {
  if (targetKind === 'staged') return stagedPaths.has(filePath) ? 'unstage' : null
  if (targetKind === 'unstaged') return unstagedPaths.has(filePath) ? 'add' : null
  if (targetKind !== 'worktree' && targetKind !== 'branch-worktree') return null
  if (unstagedPaths.has(filePath)) return 'add'
  return stagedPaths.has(filePath) ? 'unstage' : null
}

export function allFilesStageChange(
  targetKind: ReviewTarget['kind'],
  filePaths: string[],
  unstagedPaths: ReadonlySet<string>,
  stagedPaths: ReadonlySet<string>,
): { filePaths: string[]; staged: boolean } | null {
  const unstagedFiles = filePaths.filter((filePath) => unstagedPaths.has(filePath))
  const stagedFiles = filePaths.filter((filePath) => stagedPaths.has(filePath))

  if (targetKind === 'staged') {
    return stagedFiles.length === 0 ? null : { filePaths: stagedFiles, staged: false }
  }
  if (targetKind === 'unstaged') {
    return unstagedFiles.length === 0 ? null : { filePaths: unstagedFiles, staged: true }
  }
  if (targetKind !== 'worktree' && targetKind !== 'branch-worktree') return null
  if (unstagedFiles.length > 0) return { filePaths: unstagedFiles, staged: true }
  return stagedFiles.length === 0 ? null : { filePaths: stagedFiles, staged: false }
}
