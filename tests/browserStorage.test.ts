import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStoredValue, writeStoredValue } from '../src/client/browserStorage'
import { storedPanelVisible, storedPanelWidth, storePanelVisible, storePanelWidth } from '../src/client/PanelResizeHandle'
import { storedEditor, storeEditor } from '../src/client/editor'

afterEach(() => vi.unstubAllGlobals())

function storageWindow() {
  const values = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    },
  })
  return values
}

describe('safe browser storage', () => {
  it('reads, writes, and deletes only the requested key', () => {
    const values = storageWindow()
    values.set('unrelated', 'keep')
    expect(readStoredValue('preference')).toBeNull()
    expect(writeStoredValue('preference', 'dark')).toBe(true)
    expect(readStoredValue('preference')).toBe('dark')
    expect(writeStoredValue('preference', null)).toBe(true)
    expect(readStoredValue('preference')).toBeNull()
    expect(values.get('unrelated')).toBe('keep')
  })

  it('tolerates a throwing localStorage getter', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage blocked') } })
    expect(readStoredValue('preference')).toBeNull()
    expect(writeStoredValue('preference', 'dark')).toBe(false)
    expect(writeStoredValue('preference', null)).toBe(false)
    expect(storedEditor()).toBe('cursor')
    expect(storedPanelWidth('left', 300, 200, 500)).toBe(300)
    expect(storedPanelVisible('left')).toBe(true)
    expect(() => {
      storeEditor('vscode')
      storePanelWidth('left', 320)
      storePanelVisible('left', false)
    }).not.toThrow()
  })

  it.each(['getItem', 'setItem', 'removeItem'])('tolerates a failing %s operation', (method) => {
    const localStorage = {
      getItem: () => 'dark',
      setItem: () => {},
      removeItem: () => {},
      [method]: () => { throw new Error('Storage unavailable or full') },
    }
    vi.stubGlobal('window', { localStorage })
    if (method === 'getItem') expect(readStoredValue('preference')).toBeNull()
    else expect(writeStoredValue('preference', method === 'removeItem' ? null : 'dark')).toBe(false)
  })

  it('preserves preference defaults and panel clamping', () => {
    const values = storageWindow()
    storeEditor('vscode')
    expect(storedEditor()).toBe('vscode')
    storeEditor('cursor')
    expect(values.has('diff-review-editor')).toBe(false)
    expect(storedEditor()).toBe('cursor')
    storePanelWidth('left', 900)
    expect(storedPanelWidth('left', 300, 200, 500)).toBe(500)
    storePanelVisible('left', false)
    expect(storedPanelVisible('left')).toBe(false)
    storePanelVisible('left', true)
    expect(storedPanelVisible('left')).toBe(true)
    expect(values.has('diff-review-left-panel-visible')).toBe(false)
  })
})
