import { describe, expect, test } from 'vitest'

import {
  annotationEditCaretOffset,
  caretOffsetFromPoint,
  hasNonCollapsedSelectionIn,
} from '../src/client/annotationCaret.js'

type FakeNode = object

function fakeRoot(options: {
  node?: FakeNode | null
  offset?: number
  api?: 'position' | 'range' | 'none'
  contains?: boolean
  prefix?: string
  throws?: boolean
  selection?: {
    isCollapsed: boolean
    rangeCount: number
    ancestor?: FakeNode
  }
}) {
  const caretNode = options.node ?? {}
  const root = {
    contains(node: FakeNode) {
      if (options.contains === false) return false
      return node === caretNode || node === options.selection?.ancestor
    },
    ownerDocument: {
      caretPositionFromPoint: options.api === 'position'
        ? () => options.node === null ? null : { offsetNode: caretNode as Node, offset: options.offset ?? 0 }
        : undefined,
      caretRangeFromPoint: options.api === 'range'
        ? () => options.node === null ? null : {
          startContainer: caretNode as Node,
          startOffset: options.offset ?? 0,
        }
        : undefined,
      createRange() {
        if (options.throws) throw new Error('bad range')
        return {
          selectNodeContents() {},
          setEnd() {},
          toString() {
            return options.prefix ?? ''
          },
        }
      },
      getSelection: options.selection == null
        ? undefined
        : () => ({
          isCollapsed: options.selection!.isCollapsed,
          rangeCount: options.selection!.rangeCount,
          getRangeAt() {
            return { commonAncestorContainer: (options.selection!.ancestor ?? caretNode) as Node }
          },
        }),
    },
  }
  if (options.api == null || options.api === 'none') {
    delete root.ownerDocument.caretPositionFromPoint
    delete root.ownerDocument.caretRangeFromPoint
  }
  return root as unknown as Parameters<typeof caretOffsetFromPoint>[0]
}

describe('caretOffsetFromPoint', () => {
  test('returns null when no caret API is available', () => {
    expect(caretOffsetFromPoint(fakeRoot({ api: 'none' }), 4, 8)).toBeNull()
  })

  test('returns null when the caret API misses', () => {
    expect(caretOffsetFromPoint(fakeRoot({ api: 'range', node: null }), 4, 8)).toBeNull()
    expect(caretOffsetFromPoint(fakeRoot({ api: 'position', node: null }), 4, 8)).toBeNull()
  })

  test('returns null when the caret node is outside the root', () => {
    expect(caretOffsetFromPoint(fakeRoot({ api: 'range', contains: false }), 4, 8)).toBeNull()
  })

  test('maps a caret range to the prefix length', () => {
    expect(caretOffsetFromPoint(fakeRoot({ api: 'range', prefix: 'ab' }), 4, 8)).toBe(2)
  })

  test('prefers caretPositionFromPoint', () => {
    expect(caretOffsetFromPoint(fakeRoot({ api: 'position', prefix: 'hello' }), 1, 1)).toBe(5)
  })

  test('returns null when creating the prefix range fails', () => {
    expect(caretOffsetFromPoint(fakeRoot({ api: 'range', throws: true }), 1, 1)).toBeNull()
  })
})

describe('annotationEditCaretOffset', () => {
  test('falls back to the end when the click offset cannot be measured', () => {
    expect(annotationEditCaretOffset(fakeRoot({ api: 'none' }), 0, 0, 'note')).toBe(4)
  })

  test('clamps a measured offset to the comment length', () => {
    expect(annotationEditCaretOffset(fakeRoot({ api: 'range', prefix: 'too long' }), 0, 0, 'ab')).toBe(2)
    expect(annotationEditCaretOffset(fakeRoot({ api: 'range', prefix: 'a' }), 0, 0, 'abc')).toBe(1)
  })
})

describe('hasNonCollapsedSelectionIn', () => {
  test('ignores collapsed or missing selections', () => {
    expect(hasNonCollapsedSelectionIn(fakeRoot({}))).toBe(false)
    expect(hasNonCollapsedSelectionIn(fakeRoot({
      selection: { isCollapsed: true, rangeCount: 1 },
    }))).toBe(false)
  })

  test('detects a range inside the root', () => {
    const ancestor = {}
    expect(hasNonCollapsedSelectionIn(fakeRoot({
      contains: true,
      selection: { isCollapsed: false, rangeCount: 1, ancestor },
    }))).toBe(true)
  })
})
