import type { FileDiffMetadata, Hunk } from '@pierre/diffs'

export const PIERRE_COLLAPSED_CONTEXT_THRESHOLD = 10

export function nearestVisibleLine(target: number, lines: readonly number[]): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const line of lines) {
    const distance = Math.abs(line - target)
    if (best == null || distance < bestDistance || (distance === bestDistance && line < best)) {
      best = line
      bestDistance = distance
    }
  }
  return best
}

export function snapPierreLineNumber(
  fileDiff: FileDiffMetadata,
  side: 'old' | 'new',
  line: number,
  collapsedContextThreshold = PIERRE_COLLAPSED_CONTEXT_THRESHOLD,
): number {
  return nearestVisibleLine(line, pierreVisibleLines(fileDiff, side, collapsedContextThreshold))
    ?? line
}

export function pierreVisibleLines(
  fileDiff: FileDiffMetadata,
  side: 'old' | 'new',
  collapsedContextThreshold = PIERRE_COLLAPSED_CONTEXT_THRESHOLD,
): number[] {
  const lines: number[] = []
  const hunks = fileDiff.hunks
  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
    const hunk = hunks[hunkIndex]
    if (hunk == null) continue
    const [hunkStart, hunkEnd] = hunkSideRange(hunk, side)
    const gapSize = Math.max(hunk.collapsedBefore, 0)
    if (rendersCollapsedGap(gapSize, fileDiff.isPartial, collapsedContextThreshold)) {
      pushRange(lines, hunkStart - gapSize, hunkStart)
    }
    pushRange(lines, hunkStart, hunkEnd)
    if (hunkIndex !== hunks.length - 1) continue
    const trailingSize = trailingContextSize(fileDiff, side)
    if (rendersCollapsedGap(trailingSize, fileDiff.isPartial, collapsedContextThreshold)) {
      pushRange(lines, hunkEnd, hunkEnd + trailingSize)
    }
  }
  return lines
}

function hunkSideRange(hunk: Hunk, side: 'old' | 'new'): [number, number] {
  const start = side === 'new' ? hunk.additionStart : hunk.deletionStart
  const count = side === 'new' ? hunk.additionCount : hunk.deletionCount
  const startIndex = start - (count === 0 ? 0 : 1)
  return [startIndex + 1, startIndex + 1 + count]
}

function trailingContextSize(fileDiff: FileDiffMetadata, side: 'old' | 'new'): number {
  const last = fileDiff.hunks[fileDiff.hunks.length - 1]
  if (last == null || fileDiff.isPartial) return 0
  const [, hunkEnd] = hunkSideRange(last, side)
  const total = side === 'new' ? fileDiff.additionLines.length : fileDiff.deletionLines.length
  return Math.max(0, total - (hunkEnd - 1))
}

function rendersCollapsedGap(
  rangeSize: number,
  isPartial: boolean,
  collapsedContextThreshold: number,
): boolean {
  return rangeSize > 0 && !isPartial && rangeSize <= collapsedContextThreshold
}

function pushRange(lines: number[], start: number, end: number): void {
  for (let line = start; line < end; line += 1) lines.push(line)
}
