import { describe, expect, test } from 'vitest'

import type { SessionAnnotation } from '../src/shared/types.js'
import { applyHoveredRange, applyImportance } from '../src/client/importance.js'

describe('importance rendering', () => {
  test.each([
    [0, '100%', '100%', '0'],
    [0.5, '88%', '80%', '0.1'],
    [1, '76%', '60%', '0.2'],
  ])(
    'maps importance %s from no background through normal to strongest',
    (importance, expectedLight, expectedDark, expectedAlpha) => {
      const line = new FakeElement()
      const host = {
        shadowRoot: {
          querySelectorAll(selector: string) {
            return selector === '[data-review-importance]' || selector.includes('data-line="8"')
              ? [line]
              : []
          },
        },
      } as unknown as HTMLElement

      applyImportance(host, 'mount', { item: { id: 'src/change.ts' } }, [
        annotation(importance),
      ])

      expect(line.attributes.get('data-review-importance')).toBe(String(importance))
      expect(line.style.values.get('--mix-light')).toBe(expectedLight)
      expect(line.style.values.get('--mix-dark')).toBe(expectedDark)
      expect(line.style.values.get('--diffs-bg-addition-emphasis')).toContain(`/ ${expectedAlpha})`)
    },
  )

  test('leaves unscored lines at the renderer default', () => {
    const line = new FakeElement()
    line.attributes.set('data-review-importance', '1')
    line.style.values.set('--mix-light', '76%')
    const host = {
      shadowRoot: {
        querySelectorAll(selector: string) {
          return selector === '[data-review-importance]' ? [line] : []
        },
      },
    } as unknown as HTMLElement

    applyImportance(host, 'update', { item: { id: 'src/change.ts' } }, [annotation(null)])

    expect(line.attributes.has('data-review-importance')).toBe(false)
    expect(line.style.values.size).toBe(0)
  })
})

describe('hover range rendering', () => {
  test('highlights added, removed, and unchanged lines in the annotation range', () => {
    const addition = lineElement({ lineType: 'change-addition', line: '8' })
    const deletion = lineElement({ lineType: 'change-deletion', line: '8' })
    const context = lineElement({ lineType: 'context', line: '8' })
    const host = {
      shadowRoot: {
        querySelectorAll(selector: string) {
          if (selector === '[data-review-hover]') {
            return [addition, deletion, context].filter((element) => element.attributes.has('data-review-hover'))
          }
          if (selector === '[data-line-type]') return [addition, deletion, context]
          return []
        },
      },
    } as unknown as HTMLElement

    applyHoveredRange(host, { item: { id: 'src/change.ts' } }, annotation(null))
    expect(addition.attributes.has('data-review-hover')).toBe(true)
    expect(deletion.attributes.has('data-review-hover')).toBe(false)
    expect(context.attributes.has('data-review-hover')).toBe(true)

    applyHoveredRange(host, { item: { id: 'src/change.ts' } }, {
      ...annotation(null),
      side: 'old',
    })
    expect(addition.attributes.has('data-review-hover')).toBe(false)
    expect(deletion.attributes.has('data-review-hover')).toBe(true)
    expect(context.attributes.has('data-review-hover')).toBe(true)
  })

  test('keeps split-view context on the matching column', () => {
    const oldContext = lineElement({
      lineType: 'context',
      line: '8',
      column: 'deletions',
    })
    const newContext = lineElement({
      lineType: 'context',
      line: '8',
      column: 'additions',
    })
    const host = {
      shadowRoot: {
        querySelectorAll(selector: string) {
          if (selector === '[data-review-hover]') {
            return [oldContext, newContext].filter((element) => element.attributes.has('data-review-hover'))
          }
          if (selector === '[data-line-type]') return [oldContext, newContext]
          return []
        },
      },
    } as unknown as HTMLElement

    applyHoveredRange(host, { item: { id: 'src/change.ts' } }, annotation(null))
    expect(oldContext.attributes.has('data-review-hover')).toBe(false)
    expect(newContext.attributes.has('data-review-hover')).toBe(true)
  })

  test('clears the range when the hovered annotation is archived', () => {
    const addition = lineElement({ lineType: 'change-addition', line: '8' })
    const host = {
      shadowRoot: {
        querySelectorAll(selector: string) {
          if (selector === '[data-review-hover]') {
            return addition.attributes.has('data-review-hover') ? [addition] : []
          }
          if (selector === '[data-line-type]') return [addition]
          return []
        },
      },
    } as unknown as HTMLElement

    applyHoveredRange(host, { item: { id: 'src/change.ts' } }, annotation(null))
    expect(addition.attributes.has('data-review-hover')).toBe(true)

    applyHoveredRange(host, { item: { id: 'src/change.ts' } }, {
      ...annotation(null),
      archivedAt: '2026-01-02T00:00:00Z',
    })
    expect(addition.attributes.has('data-review-hover')).toBe(false)
  })
})

class FakeStyle {
  values = new Map<string, string>()

  setProperty(name: string, value: string): void {
    this.values.set(name, value)
  }

  removeProperty(name: string): void {
    this.values.delete(name)
  }
}

class FakeElement {
  attributes = new Map<string, string>()
  style = new FakeStyle()
  dataset: Record<string, string> = {}
  column: 'deletions' | 'additions' | null = null

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  closest(selector: string): HTMLElement | null {
    if (selector === '[data-deletions]' && this.column === 'deletions') return this as unknown as HTMLElement
    if (selector === '[data-additions]' && this.column === 'additions') return this as unknown as HTMLElement
    return null
  }
}

function lineElement(input: {
  lineType: string
  line: string
  column?: 'deletions' | 'additions'
}): FakeElement {
  const element = new FakeElement()
  element.dataset.lineType = input.lineType
  element.dataset.line = input.line
  element.column = input.column ?? null
  return element
}

function annotation(importance: number | null): SessionAnnotation {
  return {
    id: 'ann_test',
    sessionId: 'drs_test',
    filePath: 'src/change.ts',
    side: 'new',
    startLine: 8,
    endLine: 8,
    comment: null,
    importance,
    source: 'agent',
    intent: 'annotation',
    replyToId: null,
    endSide: null,
    archivedAt: null,
    submittedAt: null,
    viewedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}
