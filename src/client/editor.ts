import { parseEditorId, type EditorId } from '../shared/editor'

const STORAGE_KEY = 'diff-review-editor'
const DEFAULT_EDITOR: EditorId = 'cursor'

export interface HoveredDiffLine {
  filePath: string
  line: number
  element: HTMLElement
}

export function storedEditor(): EditorId {
  return parseEditorId(window.localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_EDITOR
}

export function storeEditor(editor: EditorId): void {
  if (editor === DEFAULT_EDITOR) window.localStorage.removeItem(STORAGE_KEY)
  else window.localStorage.setItem(STORAGE_KEY, editor)
}

export function pierreOpenLineNumber(input: {
  lineType: string | undefined
  line?: string
  altLine?: string
  columnNumber?: string
  inDeletions: boolean
}): number | null {
  const type = input.lineType
  if (
    type !== 'context' &&
    type !== 'context-expanded' &&
    type !== 'change-addition' &&
    type !== 'change-deletion'
  ) {
    return null
  }
  const primary = positiveInt(input.line) ?? positiveInt(input.columnNumber)
  const alt = positiveInt(input.altLine)
  if (type === 'change-deletion' || type === 'change-addition') return primary
  if (input.inDeletions) return alt ?? primary
  return primary ?? alt
}

export function difftasticOpenLineNumber(
  oldLine: number | null,
  newLine: number | null,
): number | null {
  return newLine ?? oldLine
}

export function hoveredDiffLineAtClientPoint(x: number, y: number): HoveredDiffLine | null {
  for (const top of document.elementsFromPoint(x, y)) {
    if (!(top instanceof HTMLElement)) continue
    if (top.classList.contains('open-in-editor-button')) continue
    let node: Element = top
    while (node instanceof HTMLElement && node.shadowRoot != null) {
      const inner = node.shadowRoot.elementFromPoint(x, y)
      if (inner == null || inner === node) break
      node = inner
    }
    const found = hoveredDiffLineFromPath(composedAncestors(node))
    if (found != null) return found
  }
  return null
}

export function hoveredDiffLineFromPath(path: readonly EventTarget[]): HoveredDiffLine | null {
  const filePath = fileIdFromPath(path)
  if (filePath == null) return null
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue
    if (node.classList.contains('open-in-editor-button')) return null
    if (isLineNumberGutter(node)) return null
    if (node.classList.contains('difftastic-row') || node.classList.contains('difftastic-side')) {
      const line = difftasticOpenLineNumber(
        positiveInt(node.dataset.dftOld),
        positiveInt(node.dataset.dftNew),
      )
      if (line == null) continue
      return { filePath, line, element: node }
    }
    if (node.dataset.lineType == null || node.dataset.line == null) continue
    const line = pierreOpenLineNumber({
      lineType: node.dataset.lineType,
      line: node.dataset.line,
      altLine: node.dataset.altLine,
      inDeletions: node.closest('[data-deletions]') != null,
    })
    if (line == null) continue
    return { filePath, line, element: node }
  }
  return null
}

function isLineNumberGutter(node: HTMLElement): boolean {
  return (
    node.classList.contains('difftastic-gutter') ||
    node.hasAttribute('data-gutter') ||
    node.hasAttribute('data-line-number-content') ||
    (node.hasAttribute('data-column-number') && !node.hasAttribute('data-line'))
  )
}

function fileIdFromPath(path: readonly EventTarget[]): string | null {
  for (const node of path) {
    if (node instanceof HTMLElement && node.dataset.fileId != null && node.dataset.fileId !== '') {
      return node.dataset.fileId
    }
  }
  for (const node of path) {
    if (node instanceof HTMLElement && node.tagName === 'DIFFS-CONTAINER') {
      return node.querySelector('[data-file-id]')?.getAttribute('data-file-id') ?? null
    }
  }
  return null
}

function composedAncestors(start: Element): EventTarget[] {
  const path: EventTarget[] = []
  let node: EventTarget | null = start
  while (node instanceof Node) {
    path.push(node)
    if (node instanceof ShadowRoot) {
      node = node.host
      continue
    }
    node = node.parentNode
  }
  return path
}

function positiveInt(value: string | undefined): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
