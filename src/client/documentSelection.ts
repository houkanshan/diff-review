type SelectionSnapshot = {
  isCollapsed: boolean
  rangeCount: number
  toString(): string
}

type InputSelection = {
  start: number
  end: number
}

type ComposedSelection = Selection & {
  getComposedRanges?(options?: { shadowRoots?: readonly ShadowRoot[] }): ReadonlyArray<{ collapsed: boolean }>
}

type SelectableShadowRoot = ShadowRoot & {
  getSelection?: () => Selection | null
}

export function hasCopyableSelection(input: {
  windowSelection: SelectionSnapshot | null
  inputSelection: InputSelection | null
  shadowSelections?: ReadonlyArray<SelectionSnapshot | null>
  composedCollapsed?: readonly boolean[]
}): boolean {
  if (isNonCollapsedSelection(input.windowSelection)) return true
  if (input.inputSelection != null && input.inputSelection.start !== input.inputSelection.end) return true
  if ((input.composedCollapsed ?? []).some((collapsed) => !collapsed)) return true
  return (input.shadowSelections ?? []).some((selection) => isNonCollapsedSelection(selection))
}

export function hasDocumentSelection(): boolean {
  const windowSelection = window.getSelection()
  const shadowRoots = collectOpenShadowRoots(document)
  return hasCopyableSelection({
    windowSelection,
    inputSelection: inputSelectionOf(document.activeElement),
    shadowSelections: shadowRoots.map(shadowSelectionOf),
    composedCollapsed: composedCollapsedOf(windowSelection, shadowRoots),
  })
}

function isNonCollapsedSelection(selection: SelectionSnapshot | null): boolean {
  if (selection == null || selection.rangeCount === 0) return false
  return !selection.isCollapsed || selection.toString().length > 0
}

function collectOpenShadowRoots(root: ParentNode): ShadowRoot[] {
  const roots: ShadowRoot[] = []
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot != null) roots.push(element.shadowRoot)
  }
  return roots
}

function inputSelectionOf(element: Element | null): InputSelection | null {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return null
  const start = element.selectionStart
  const end = element.selectionEnd
  if (start == null || end == null) return null
  return { start, end }
}

function shadowSelectionOf(root: ShadowRoot): Selection | null {
  const getSelection = (root as SelectableShadowRoot).getSelection
  return typeof getSelection === 'function' ? getSelection.call(root) : null
}

function composedCollapsedOf(
  selection: Selection | null,
  shadowRoots: readonly ShadowRoot[],
): readonly boolean[] {
  const getComposedRanges = (selection as ComposedSelection | null)?.getComposedRanges
  if (selection == null || typeof getComposedRanges !== 'function') return []
  try {
    return getComposedRanges.call(selection, { shadowRoots }).map((range) => range.collapsed)
  } catch {
    return []
  }
}
