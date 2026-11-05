import { annotationCoversLine } from './annotationComposer'
import type { SessionAnnotation } from '../shared/types'

interface HoverContext {
  item: { id: string }
}

export function applyHoveredRange(
  node: HTMLElement,
  context: HoverContext,
  annotation: SessionAnnotation | null,
): void {
  const root = node.shadowRoot
  if (root == null) return

  for (const element of root.querySelectorAll<HTMLElement>('[data-review-hover]')) {
    element.removeAttribute('data-review-hover')
  }
  if (annotation == null || annotation.archivedAt != null || annotation.filePath !== context.item.id) return

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
