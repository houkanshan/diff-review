import { describe, expect, test } from 'vitest'

import type { SessionAnnotation } from '../src/shared/types.js'
import { applyImportance } from '../src/client/importance.js'

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

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}
