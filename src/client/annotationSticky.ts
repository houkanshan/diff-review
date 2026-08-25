import { nearestVisibleLine } from './annotationPlacement'

export type StickyRangeGeometry = {
  startBottom: number
  endBottom: number
  viewportTop: number
  viewportBottom: number
  fileTop: number
  fileBottom: number
}

export function stickyRangeIntersectsViewport(geometry: StickyRangeGeometry): boolean {
  return geometry.startBottom < geometry.viewportBottom && geometry.endBottom > geometry.viewportTop
}

export type StickyOverlayMode = 'hidden' | 'dock' | 'indoc'

export function rangeOccupiesDockEdge(
  geometry: StickyRangeGeometry,
  cardHeight: number,
): boolean {
  return geometry.startBottom < geometry.viewportBottom &&
    geometry.endBottom >= geometry.viewportBottom - cardHeight
}

export function stickyOverlayMode(
  geometry: StickyRangeGeometry,
  cardHeight: number,
  inDocTop: number | null,
): StickyOverlayMode {
  if (!fileOccupiesDockEdge(geometry.fileTop, geometry.fileBottom, geometry.viewportBottom)) {
    return 'hidden'
  }
  if (inDocTop != null && inDocTop <= geometry.viewportBottom - cardHeight) return 'indoc'
  if (rangeOccupiesDockEdge(geometry, cardHeight)) return 'dock'
  return 'hidden'
}

const LINE_TYPE_BY_SIDE = {
  old: 'change-deletion',
  new: 'change-addition',
} as const

function lineNumberOf(element: HTMLElement): number {
  return Number(element.dataset.line ?? element.dataset.columnNumber)
}

function pierreLineMatchesSide(element: HTMLElement, side: 'old' | 'new'): boolean {
  const lineType = element.dataset.lineType
  if (lineType === LINE_TYPE_BY_SIDE[side]) return true
  if (lineType !== 'context' && lineType !== 'context-expanded') return false
  if (element.closest('[data-deletions]') != null) return side === 'old'
  if (element.closest('[data-additions]') != null) return side === 'new'
  return true
}

function pierreLineElement(
  root: ShadowRoot,
  side: 'old' | 'new',
  line: number,
): HTMLElement | null {
  const preferred = LINE_TYPE_BY_SIDE[side]
  const selectors = [
    `[data-line-type="${preferred}"][data-line="${line}"]`,
    `[data-line-type="${preferred}"][data-column-number="${line}"]`,
    `[data-line-type="context"][data-line="${line}"]`,
    `[data-line-type="context"][data-column-number="${line}"]`,
    `[data-line-type="context-expanded"][data-line="${line}"]`,
    `[data-line-type="context-expanded"][data-column-number="${line}"]`,
  ]
  for (const selector of selectors) {
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      if (pierreLineMatchesSide(element, side)) return element
    }
  }
  return null
}

function relativeBottom(element: HTMLElement, scrollerTop: number): number {
  return element.getBoundingClientRect().bottom - scrollerTop
}

function pierreFileNode(scroller: HTMLElement, filePath: string): HTMLElement | null {
  return [...scroller.querySelectorAll<HTMLElement>('diffs-container')].find((node) => {
    const id = node.querySelector('[data-file-id]')?.getAttribute('data-file-id')
      ?? node.getAttribute('data-file-id')
    return id === filePath
  }) ?? null
}

function pierreFileRoot(scroller: HTMLElement, filePath: string): ShadowRoot | null {
  return pierreFileNode(scroller, filePath)?.shadowRoot ?? null
}

export function fileOccupiesDockEdge(
  fileTop: number,
  fileBottom: number,
  viewportBottom: number,
): boolean {
  return fileTop < viewportBottom && fileBottom >= viewportBottom - 4
}

export function measurePierreRangeGeometry(
  scroller: HTMLElement,
  filePath: string,
  side: 'old' | 'new',
  startLine: number,
  endSide: 'old' | 'new',
  endLine: number,
): StickyRangeGeometry | null {
  const fileNode = pierreFileNode(scroller, filePath)
  const root = fileNode?.shadowRoot
  if (fileNode == null || root == null) return null

  const scrollerRect = scroller.getBoundingClientRect()
  const fileRect = fileNode.getBoundingClientRect()
  const header = root.querySelector<HTMLElement>('[data-diffs-header]')
  const viewportTop = header == null
    ? 0
    : Math.max(0, header.getBoundingClientRect().bottom - scrollerRect.top)
  const viewportBottom = scroller.clientHeight

  const startEl = pierreLineElement(root, side, startLine)
  const endEl = pierreLineElement(root, endSide, endLine)
  let startBottom = startEl == null ? null : relativeBottom(startEl, scrollerRect.top)
  let endBottom = endEl == null ? null : relativeBottom(endEl, scrollerRect.top)

  if (startBottom == null || endBottom == null) {
    const startVisible: VisibleLineSample[] = []
    const endVisible: VisibleLineSample[] = []
    for (const element of root.querySelectorAll<HTMLElement>('[data-line-type]')) {
      const line = lineNumberOf(element)
      if (!Number.isFinite(line)) continue
      const sample = { line, bottom: relativeBottom(element, scrollerRect.top) }
      if (pierreLineMatchesSide(element, side)) startVisible.push(sample)
      if (pierreLineMatchesSide(element, endSide)) endVisible.push(sample)
    }
    const inferred = resolveUnmountedRangeEdges(
      startLine,
      endLine,
      startBottom,
      endBottom,
      startVisible,
      endVisible,
    )
    startBottom = inferred.startBottom
    endBottom = inferred.endBottom
  }

  if (startBottom == null || endBottom == null) return null
  return {
    startBottom,
    endBottom,
    viewportTop,
    viewportBottom,
    fileTop: fileRect.top - scrollerRect.top,
    fileBottom: fileRect.bottom - scrollerRect.top,
  }
}

export type VisibleLineSample = { line: number; bottom: number }

export function resolveUnmountedRangeEdges(
  startLine: number,
  endLine: number,
  startBottom: number | null,
  endBottom: number | null,
  startVisible: readonly VisibleLineSample[],
  endVisible: readonly VisibleLineSample[] = startVisible,
): { startBottom: number | null; endBottom: number | null } {
  const start = edgePresence(startLine, startVisible)
  const end = edgePresence(endLine, endVisible)
  const startFolded = !start.inside && start.before && start.after
  const endFolded = !end.inside && end.before && end.after
  const nextStart = startBottom ?? (startFolded
    ? sampleBottom(startVisible, nearestVisibleLine(startLine, startVisible.map(lineOf)))
    : startBottom)
  const nextEnd = endBottom ?? (endFolded
    ? sampleBottom(endVisible, nearestVisibleLine(endLine, endVisible.map(lineOf)))
    : endBottom)
  return {
    startBottom: nextStart == null && (start.inside || start.after)
      ? Number.NEGATIVE_INFINITY
      : nextStart,
    endBottom: nextEnd == null && (end.inside || end.before)
      ? Number.POSITIVE_INFINITY
      : nextEnd,
  }
}

function edgePresence(
  line: number,
  visible: readonly VisibleLineSample[],
): { before: boolean; inside: boolean; after: boolean } {
  let before = false
  let inside = false
  let after = false
  for (const sample of visible) {
    if (sample.line < line) before = true
    else if (sample.line > line) after = true
    else inside = true
  }
  return { before, inside, after }
}

export type StickyCardBox = {
  left: number
  width: number
  top?: number
  height?: number
}

export function measureStickyCardBox(
  scroller: HTMLElement,
  annotationId: string,
): StickyCardBox | null {
  const card = scroller.querySelector<HTMLElement>(`[data-annotation-id="${annotationId}"]`)
  if (card == null) return null
  const scrollerRect = scroller.getBoundingClientRect()
  const rect = card.getBoundingClientRect()
  if (rect.width < 2) return null
  return {
    left: rect.left - scrollerRect.left,
    width: rect.width,
    top: rect.top - scrollerRect.top,
    height: rect.height,
  }
}

export function overlayCardBox(
  scroller: HTMLElement,
  inDoc: StickyCardBox | null,
  columnLeft: number | null,
): StickyCardBox {
  const left = inDoc?.left ?? columnLeft ?? 52
  const width = inDoc?.width
    ?? Math.min(590, Math.max(200, scroller.clientWidth - left - 8))
  return {
    left,
    width,
    top: inDoc?.top,
    height: inDoc?.height,
  }
}

export type DockCandidate = {
  id: string
  fileId: string
  side: 'old' | 'new'
  startLine: number
  endLine: number
}

function rangeContains(outer: DockCandidate, inner: DockCandidate): boolean {
  return outer.id !== inner.id &&
    outer.startLine <= inner.startLine &&
    outer.endLine >= inner.endLine &&
    (outer.startLine < inner.startLine || outer.endLine > inner.endLine)
}

export function selectDockedAnnotationIds(
  candidates: readonly DockCandidate[],
): string[] {
  const byColumn = new Map<string, DockCandidate[]>()
  for (const item of candidates) {
    const key = `${item.fileId}:${item.side}`
    const list = byColumn.get(key)
    if (list == null) byColumn.set(key, [item])
    else list.push(item)
  }
  const selected: DockCandidate[] = []
  for (const group of byColumn.values()) {
    const visible = group.filter((item) =>
      !group.some((other) => rangeContains(item, other)),
    )
    visible.sort((left, right) => left.endLine - right.endLine || left.startLine - right.startLine)
    selected.push(...visible)
  }
  return selected.map((item) => item.id)
}

export function measurePierreColumnLeft(
  scroller: HTMLElement,
  filePath: string,
  side: 'old' | 'new',
): number | null {
  const root = pierreFileRoot(scroller, filePath)
  if (root == null) return null
  const selectors = side === 'new'
    ? ['[data-additions] [data-content]', '[data-unified] [data-content]', '[data-content]']
    : ['[data-deletions] [data-content]', '[data-unified] [data-content]', '[data-content]']
  let pane: HTMLElement | null = null
  for (const selector of selectors) {
    pane = root.querySelector<HTMLElement>(selector)
    if (pane != null) break
  }
  if (pane == null) return null
  const rect = pane.getBoundingClientRect()
  if (rect.width < 2) return null
  return rect.left - scroller.getBoundingClientRect().left + 6
}

function lineOf(sample: VisibleLineSample): number {
  return sample.line
}

function sampleBottom(
  visible: readonly VisibleLineSample[],
  line: number | null,
): number | null {
  if (line == null) return null
  return visible.find((sample) => sample.line === line)?.bottom ?? null
}
