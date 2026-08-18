import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { CodeViewItem } from '@pierre/diffs/react'
import type {
  CodeViewLineSelection,
  DiffLineAnnotation,
  FileDiffMetadata,
} from '@pierre/diffs'

import type { AnnotationIntent, DifftasticHunk, SessionAnnotation } from '../shared/types'

export type ReviewLineAnnotation =
  | { kind: 'saved'; annotation: SessionAnnotation }
  | { kind: 'composer'; selection: CodeViewLineSelection }

export interface ComposerDraft {
  comment: string
  intent: AnnotationIntent
  error: string | null
  busy: boolean
}

export const EMPTY_COMPOSER_DRAFT: ComposerDraft = {
  comment: '',
  intent: 'annotation',
  error: null,
  busy: false,
}

export const composerSelectionAtom = atom<CodeViewLineSelection | null>(null)
export const composerDraftAtom = atom<ComposerDraft>(EMPTY_COMPOSER_DRAFT)
export const fileCollapsedAtom = atomFamily((filePath: string) => atom(false))
export const fileViewedAtom = atomFamily((filePath: string) => atom(false))
export const composerSessionIdAtom = atom<string | null>(null)
export const reviewCommentAvailableAtom = atom(false)

export function visibleAnnotationsForFile(
  annotations: SessionAnnotation[],
  filePath: string,
  prevName?: string | null,
): SessionAnnotation[] {
  return annotations.filter(
    (annotation) =>
      annotation.comment != null &&
      annotation.archivedAt == null &&
      (annotation.filePath === filePath || annotation.filePath === prevName),
  )
}

export function annotationsForFile(
  annotations: SessionAnnotation[],
  fileDiff: FileDiffMetadata,
  selection: CodeViewLineSelection | null,
): DiffLineAnnotation<ReviewLineAnnotation>[] {
  const result: DiffLineAnnotation<ReviewLineAnnotation>[] = visibleAnnotationsForFile(
    annotations,
    fileDiff.name,
    fileDiff.prevName,
  ).map((annotation) => ({
    side: (annotation.endSide ?? annotation.side) === 'new' ? 'additions' : 'deletions',
    lineNumber: annotation.endLine,
    metadata: { kind: 'saved', annotation },
  }))

  if (
    selection != null &&
    (selection.id === fileDiff.name || selection.id === fileDiff.prevName)
  ) {
    const side = selection.range.endSide ?? selection.range.side ?? 'additions'
    const lineNumber = selection.range.endSide == null
      ? Math.max(selection.range.start, selection.range.end)
      : selection.range.end
    result.push({
      side,
      lineNumber,
      metadata: { kind: 'composer', selection },
    })
  }
  return result
}

export function annotationAnchorSide(annotation: SessionAnnotation): 'old' | 'new' {
  return annotation.endSide ?? annotation.side
}

export function placeDifftasticAnnotations(
  annotations: SessionAnnotation[],
  hunks: DifftasticHunk[],
): Map<string, SessionAnnotation[]> {
  const oldSlots: Array<{ key: string; line: number }> = []
  const newSlots: Array<{ key: string; line: number }> = []
  hunks.forEach((hunk, hunkIndex) => {
    hunk.lines.forEach((line, lineIndex) => {
      if (line.oldLine != null) {
        oldSlots.push({ key: difftasticRowKey(hunkIndex, lineIndex, 'old'), line: line.oldLine })
      }
      if (line.newLine != null) {
        newSlots.push({ key: difftasticRowKey(hunkIndex, lineIndex, 'new'), line: line.newLine })
      }
    })
  })

  const byRow = new Map<string, SessionAnnotation[]>()
  for (const annotation of annotations) {
    const preferred = annotationAnchorSide(annotation)
    const sameSide = preferred === 'new' ? newSlots : oldSlots
    const otherSide = preferred === 'new' ? oldSlots : newSlots
    const hit = nearestVisibleSlot(annotation.endLine, sameSide)
      ?? nearestVisibleSlot(annotation.endLine, otherSide)
    if (hit == null) continue
    const existing = byRow.get(hit.key)
    if (existing == null) byRow.set(hit.key, [annotation])
    else existing.push(annotation)
  }
  return byRow
}

export function annotationsAtDifftasticRow(
  placed: Map<string, SessionAnnotation[]>,
  hunkIndex: number,
  lineIndex: number,
  side: 'old' | 'new',
): SessionAnnotation[] {
  return placed.get(difftasticRowKey(hunkIndex, lineIndex, side)) ?? []
}

function difftasticRowKey(hunkIndex: number, lineIndex: number, side: 'old' | 'new'): string {
  return `${hunkIndex}:${lineIndex}:${side}`
}

function nearestVisibleSlot(
  target: number,
  candidates: Array<{ key: string; line: number }>,
): { key: string; line: number } | null {
  let best: { key: string; line: number } | null = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.line - target)
    if (
      best == null ||
      distance < bestDistance ||
      (distance === bestDistance && candidate.line < best.line)
    ) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

export function areCodeViewSelectionsEqual(
  left: CodeViewLineSelection,
  right: CodeViewLineSelection | null,
): boolean {
  return right != null &&
    left.id === right.id &&
    left.range.start === right.range.start &&
    left.range.end === right.range.end &&
    left.range.side === right.range.side &&
    left.range.endSide === right.range.endSide
}

export function areSavedAnnotationsEqual(
  left: SessionAnnotation,
  right: SessionAnnotation,
): boolean {
  return left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.filePath === right.filePath &&
    left.side === right.side &&
    left.startLine === right.startLine &&
    left.endSide === right.endSide &&
    left.endLine === right.endLine &&
    left.comment === right.comment &&
    left.importance === right.importance &&
    left.source === right.source &&
    left.intent === right.intent &&
    left.archivedAt === right.archivedAt &&
    left.submittedAt === right.submittedAt &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
}

export function areReviewAnnotationsEqual(
  left: DiffLineAnnotation<ReviewLineAnnotation>[] | undefined,
  right: DiffLineAnnotation<ReviewLineAnnotation>[],
): boolean {
  if (left == null || left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const current = left[index]
    const next = right[index]
    if (current == null || next == null) return false
    if (current.side !== next.side || current.lineNumber !== next.lineNumber) return false
    const currentMetadata = current.metadata
    const nextMetadata = next.metadata
    if (currentMetadata == null || nextMetadata == null) return false
    if (currentMetadata.kind !== nextMetadata.kind) return false
    if (currentMetadata.kind === 'saved' && nextMetadata.kind === 'saved') {
      if (!areSavedAnnotationsEqual(currentMetadata.annotation, nextMetadata.annotation)) {
        return false
      }
      continue
    }
    if (currentMetadata.kind === 'composer' && nextMetadata.kind === 'composer') {
      if (!areCodeViewSelectionsEqual(currentMetadata.selection, nextMetadata.selection)) {
        return false
      }
      continue
    }
    return false
  }
  return true
}

export function buildCodeViewItems(
  parsedFiles: FileDiffMetadata[],
  annotations: SessionAnnotation[],
  composerSelection: CodeViewLineSelection | null,
  collapsedFiles: Set<string>,
  previousItems: readonly CodeViewItem<ReviewLineAnnotation>[] = [],
): CodeViewItem<ReviewLineAnnotation>[] {
  const previousById = new Map(previousItems.map((item) => [item.id, item]))
  return parsedFiles.map((fileDiff) => {
    const collapsed = collapsedFiles.has(fileDiff.name)
    const nextAnnotations = annotationsForFile(annotations, fileDiff, composerSelection)
    const previous = previousById.get(fileDiff.name)
    if (
      previous != null &&
      previous.type === 'diff' &&
      previous.fileDiff === fileDiff &&
      previous.collapsed === collapsed &&
      areReviewAnnotationsEqual(previous.annotations, nextAnnotations)
    ) {
      return previous
    }
    return {
      id: fileDiff.name,
      type: 'diff',
      fileDiff,
      collapsed,
      annotations: nextAnnotations,
      version: (previous?.version ?? 0) + 1,
    }
  })
}
