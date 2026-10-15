import { describe, expect, test, vi } from 'vitest'

import { writeClipboardText } from '../src/client/clipboard.js'

describe('writeClipboardText', () => {
  test('uses the async clipboard API in secure contexts', async () => {
    const writeText = vi.fn(async () => {})
    const doc = fakeDocument(true)
    await writeClipboardText('hello', {
      isSecureContext: true,
      navigator: { clipboard: { writeText } },
      document: doc.document,
    })
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(doc.execCommand).not.toHaveBeenCalled()
  })

  test('falls back to execCommand on insecure HTTP origins', async () => {
    const writeText = vi.fn(async () => {})
    const doc = fakeDocument(true)
    await writeClipboardText('remote text', {
      isSecureContext: false,
      navigator: { clipboard: { writeText } },
      document: doc.document,
    })
    expect(writeText).not.toHaveBeenCalled()
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(doc.copiedValues).toEqual(['remote text'])
    expect(doc.attached).toHaveLength(0)
    expect(doc.previousFocus.focus).toHaveBeenCalled()
  })

  test('falls back when the async clipboard API rejects', async () => {
    const doc = fakeDocument(true)
    await writeClipboardText('retry', {
      isSecureContext: true,
      navigator: { clipboard: { writeText: async () => { throw new Error('denied') } } },
      document: doc.document,
    })
    expect(doc.copiedValues).toEqual(['retry'])
  })

  test('rejects and cleans up when execCommand fails', async () => {
    const doc = fakeDocument(false)
    await expect(writeClipboardText('nope', {
      isSecureContext: false,
      document: doc.document,
    })).rejects.toThrow('Copy command was rejected')
    expect(doc.attached).toHaveLength(0)
  })

  test('rejects when no clipboard mechanism exists', async () => {
    await expect(writeClipboardText('x', { isSecureContext: false })).rejects.toThrow(
      'Clipboard is unavailable',
    )
  })
})

function fakeDocument(copySucceeds: boolean) {
  const attached: FakeTextarea[] = []
  const copiedValues: string[] = []
  const previousFocus = { focus: vi.fn() }
  const execCommand = vi.fn((command: string) => {
    if (command === 'copy' && copySucceeds) copiedValues.push(attached[0]?.value ?? '')
    return copySucceeds
  })
  const document = {
    activeElement: previousFocus,
    createElement: () => {
      const textarea: FakeTextarea = {
        value: '',
        style: {},
        setAttribute: () => {},
        focus: () => {},
        select: () => {},
        setSelectionRange: () => {},
        remove: () => { attached.splice(attached.indexOf(textarea), 1) },
      }
      return textarea
    },
    body: { appendChild: (node: FakeTextarea) => { attached.push(node) } },
    execCommand,
  } as unknown as Document
  return { document, attached, copiedValues, execCommand, previousFocus }
}

interface FakeTextarea {
  value: string
  style: Record<string, string>
  setAttribute(name: string, value: string): void
  focus(): void
  select(): void
  setSelectionRange(start: number, end: number): void
  remove(): void
}
