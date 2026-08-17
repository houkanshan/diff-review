import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { CodeViewItem } from '@pierre/diffs/react'
import type {
  CodeViewLineSelection,
  DiffLineAnnotation,
  FileDiffMetadata,
} from '@pierre/diffs'

import type { AnnotationIntent, SessionAnnotation } from '../shared/types'

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

export function annotationsForFile(
  annotations: SessionAnnotation[],
  fileDiff: FileDiffMetadata,
  selection: CodeViewLineSelection | null,
): DiffLineAnnotation<ReviewLineAnnotation>[] {
  const result: DiffLineAnnotation<ReviewLineAnnotation>[] = annotations
    .filter(
      (annotation) =>
        annotation.comment != null &&
        annotation.archivedAt == null &&
        (annotation.filePath === fileDiff.name || annotation.filePath === fileDiff.prevName),
    )
    .map((annotation) => ({
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
  sessionId: string,
  sessionUpdatedAt: string,
  previousItems: readonly CodeViewItem<ReviewLineAnnotation>[] = [],
): CodeViewItem<ReviewLineAnnotation>[] {
  const previousById = new Map(previousItems.map((item) => [item.id, item]))
  return parsedFiles.map((fileDiff) => {
    fileDiff.cacheKey = `${sessionId}:${sessionUpdatedAt}:${fileDiff.name}`
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
