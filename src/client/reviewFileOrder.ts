export type ReviewPathEntry = {
  isDirectory: boolean
  segments: readonly string[]
}

export function compareReviewFilePaths(left: string, right: string): number {
  return compareReviewPathEntries(pathEntry(left), pathEntry(right))
}

export function compareReviewPathEntries(left: ReviewPathEntry, right: ReviewPathEntry): number {
  const sharedDepth = Math.min(left.segments.length, right.segments.length)
  for (let depth = 0; depth < sharedDepth; depth++) {
    const leftSegment = left.segments[depth]
    const rightSegment = right.segments[depth]
    if (leftSegment === rightSegment) continue
    const leftKind = kindAtDepth(left, depth)
    const rightKind = kindAtDepth(right, depth)
    if (leftKind !== rightKind) return leftKind === 'file' ? -1 : 1
    return compareSegment(leftSegment, rightSegment)
  }
  if (left.segments.length !== right.segments.length) {
    return left.segments.length < right.segments.length ? -1 : 1
  }
  if (left.isDirectory === right.isDirectory) return 0
  return left.isDirectory ? 1 : -1
}

function pathEntry(path: string): ReviewPathEntry {
  return {
    isDirectory: false,
    segments: path.split('/').filter((segment) => segment !== ''),
  }
}

function kindAtDepth(entry: ReviewPathEntry, depth: number): 'file' | 'directory' {
  return depth === entry.segments.length - 1 && !entry.isDirectory ? 'file' : 'directory'
}

function compareSegment(left: string, right: string): number {
  const comparison = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
  if (comparison !== 0) return comparison
  return left < right ? -1 : left > right ? 1 : 0
}
