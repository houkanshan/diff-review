import { annotationCoversLine } from './annotationComposer'
import type { SessionAnnotation } from '../shared/types'

interface ImportanceContext {
  item: { id: string }
}

export function applyImportance(
  node: HTMLElement,
  phase: 'mount' | 'update' | 'unmount',
  context: ImportanceContext,
  annotations: SessionAnnotation[],
): void {
  if (phase === 'unmount') return
  const root = node.shadowRoot
  if (root == null) return

  for (const element of root.querySelectorAll<HTMLElement>('[data-review-importance]')) {
    element.removeAttribute('data-review-importance')
    element.style.removeProperty('--mix-light')
    element.style.removeProperty('--mix-dark')
    element.style.removeProperty('--diffs-bg-addition-emphasis')
    element.style.removeProperty('--diffs-bg-deletion-emphasis')
  }

  const scores = new Map<string, number>()
  for (const annotation of annotations) {
    if (
      annotation.filePath !== context.item.id ||
      annotation.importance == null ||
      annotation.archivedAt != null
    ) continue
    const side = annotation.side === 'new' ? 'change-addition' : 'change-deletion'
    for (let line = annotation.startLine; line <= annotation.endLine; line += 1) {
      const key = `${side}:${line}`
      scores.set(key, Math.max(scores.get(key) ?? -1, annotation.importance))
    }
  }

  for (const [key, score] of scores) {
    const separator = key.lastIndexOf(':')
    const lineType = key.slice(0, separator)
    const lineNumber = key.slice(separator + 1)
    const selector = [
      `[data-line-type="${lineType}"][data-line="${lineNumber}"]`,
      `[data-line-type="${lineType}"][data-column-number="${lineNumber}"]`,
    ].join(',')
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      element.setAttribute('data-review-importance', String(score))
      element.style.setProperty('--mix-light', `${100 - score * 24}%`)
      element.style.setProperty('--mix-dark', `${100 - score * 40}%`)
      const alpha = Math.round(score * 20) / 100
      element.style.setProperty(
        '--diffs-bg-addition-emphasis',
        `rgb(from var(--diffs-addition-base) r g b / ${alpha})`,
      )
      element.style.setProperty(
        '--diffs-bg-deletion-emphasis',
        `rgb(from var(--diffs-deletion-base) r g b / ${alpha})`,
      )
    }
  }
}

export function applyHoveredRange(
  node: HTMLElement,
  context: ImportanceContext,
  annotation: SessionAnnotation | null,
): void {
  const root = node.shadowRoot
  if (root == null) return

  for (const element of root.querySelectorAll<HTMLElement>('[data-review-hover]')) {
    element.removeAttribute('data-review-hover')
  }
  if (annotation == null || annotation.filePath !== context.item.id) return

  for (const element of root.querySelectorAll<HTMLElement>('[data-line-type]')) {
    const line = Number(element.dataset.line ?? element.dataset.columnNumber)
    if (!Number.isFinite(line)) continue
    if (hoveredLineSides(element).some((side) => annotationCoversLine(annotation, side, line))) {
      element.setAttribute('data-review-hover', '')
    }
  }
}

function hoveredLineSides(element: HTMLElement): Array<'old' | 'new'> {
  const lineType = element.dataset.lineType
  if (lineType === 'change-addition') return ['new']
  if (lineType === 'change-deletion') return ['old']
  if (lineType !== 'context' && lineType !== 'context-expanded') return []
  if (element.closest('[data-deletions]') != null) return ['old']
  if (element.closest('[data-additions]') != null) return ['new']
  return ['old', 'new']
}
