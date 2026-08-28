type CaretPositionLike = {
  offsetNode: Node
  offset: number
}

type CaretRangeLike = {
  startContainer: Node
  startOffset: number
}

type CaretDocument = {
  caretPositionFromPoint?(x: number, y: number): CaretPositionLike | null
  caretRangeFromPoint?(x: number, y: number): CaretRangeLike | null
  createRange(): {
    selectNodeContents(node: Node): void
    setEnd(node: Node, offset: number): void
    toString(): string
  }
  getSelection?(): Selection | null
}

type CaretRoot = {
  contains(node: Node): boolean
  ownerDocument: CaretDocument
}

export function caretOffsetFromPoint(
  root: CaretRoot,
  clientX: number,
  clientY: number,
): number | null {
  const document = root.ownerDocument
  let node: Node | null = null
  let nodeOffset = 0
  if (typeof document.caretPositionFromPoint === 'function') {
    const position = document.caretPositionFromPoint(clientX, clientY)
    if (position == null) return null
    node = position.offsetNode
    nodeOffset = position.offset
  } else if (typeof document.caretRangeFromPoint === 'function') {
    const range = document.caretRangeFromPoint(clientX, clientY)
    if (range == null) return null
    node = range.startContainer
    nodeOffset = range.startOffset
  } else {
    return null
  }

  if (node == null || (node !== root && !root.contains(node))) return null

  try {
    const prefix = document.createRange()
    prefix.selectNodeContents(root as Node)
    prefix.setEnd(node, nodeOffset)
    return prefix.toString().length
  } catch {
    return null
  }
}

export function annotationEditCaretOffset(
  root: CaretRoot,
  clientX: number,
  clientY: number,
  text: string,
): number {
  const offset = caretOffsetFromPoint(root, clientX, clientY)
  if (offset == null || offset < 0) return text.length
  return Math.min(offset, text.length)
}

export function hasNonCollapsedSelectionIn(root: CaretRoot): boolean {
  const selection = root.ownerDocument.getSelection?.()
  if (selection == null || selection.isCollapsed || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  const ancestor = range.commonAncestorContainer
  return ancestor === (root as Node) || root.contains(ancestor)
}
