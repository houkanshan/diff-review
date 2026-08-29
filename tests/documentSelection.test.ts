import { describe, expect, test } from 'vitest'

import { hasCopyableSelection } from '../src/client/documentSelection.js'

const collapsed = {
  isCollapsed: true,
  rangeCount: 0,
  toString() {
    return ''
  },
}

const selected = {
  isCollapsed: false,
  rangeCount: 1,
  toString() {
    return 'hello'
  },
}

describe('hasCopyableSelection', () => {
  test('ignores a collapsed window selection', () => {
    expect(hasCopyableSelection({
      windowSelection: collapsed,
      inputSelection: null,
    })).toBe(false)
  })

  test('detects a window selection', () => {
    expect(hasCopyableSelection({
      windowSelection: selected,
      inputSelection: null,
    })).toBe(true)
  })

  test('detects selected text in an input', () => {
    expect(hasCopyableSelection({
      windowSelection: collapsed,
      inputSelection: { start: 1, end: 4 },
    })).toBe(true)
  })

  test('ignores a caret in an input', () => {
    expect(hasCopyableSelection({
      windowSelection: collapsed,
      inputSelection: { start: 2, end: 2 },
    })).toBe(false)
  })

  test('detects a shadow-root selection', () => {
    expect(hasCopyableSelection({
      windowSelection: collapsed,
      inputSelection: null,
      shadowSelections: [selected],
    })).toBe(true)
  })

  test('detects a composed range inside a shadow root', () => {
    expect(hasCopyableSelection({
      windowSelection: collapsed,
      inputSelection: null,
      composedCollapsed: [false],
    })).toBe(true)
  })
})
