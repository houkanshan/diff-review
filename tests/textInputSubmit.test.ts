import { describe, expect, test } from 'vitest'
import { isModifiedSubmitEnter } from '../src/client/textInputSubmit'

const enter = {
  key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false,
  altKey: false, repeat: false, isComposing: false, keyCode: 13,
}

describe('PR text submission shortcut', () => {
  test('submits with Cmd+Enter or Ctrl+Enter', () => {
    expect(isModifiedSubmitEnter({ ...enter, metaKey: true })).toBe(true)
    expect(isModifiedSubmitEnter({ ...enter, ctrlKey: true })).toBe(true)
  })

  test('leaves plain Enter and Shift+Enter available for newlines', () => {
    expect(isModifiedSubmitEnter(enter)).toBe(false)
    expect(isModifiedSubmitEnter({ ...enter, shiftKey: true })).toBe(false)
    expect(isModifiedSubmitEnter({ ...enter, metaKey: true, shiftKey: true })).toBe(false)
    expect(isModifiedSubmitEnter({ ...enter, ctrlKey: true, altKey: true })).toBe(false)
  })

  test('does not submit IME confirmation or repeated keydowns', () => {
    expect(isModifiedSubmitEnter({ ...enter, metaKey: true, isComposing: true })).toBe(false)
    expect(isModifiedSubmitEnter({ ...enter, metaKey: true, keyCode: 229 })).toBe(false)
    expect(isModifiedSubmitEnter({ ...enter, metaKey: true, repeat: true })).toBe(false)
    expect(isModifiedSubmitEnter({ ...enter, metaKey: true, key: 'a' })).toBe(false)
  })
})
