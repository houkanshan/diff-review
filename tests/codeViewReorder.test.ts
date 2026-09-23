import { describe, expect, test } from 'vitest'
import { CodeView } from '@pierre/diffs'

// A reordered list must not leave an old visible DOM node mounted outside the
// new virtual window. Exercise the installed CodeView reconciliation without a
// browser; rendering and DOM removal are represented by the mounted records.
describe('CodeView file reorder', () => {
  test('releases the old rendered range before reusing its indices', () => {
    const records = ['a', 'b', 'c'].map((id, index) => ({
      type: 'diff', item: { type: 'diff', id, version: 1 }, version: 1,
      index, top: index * 100, height: 100, instance: {},
      element: id === 'a' ? {} : undefined as object | undefined,
    }))
    const released: string[] = []
    const view = Object.assign(Object.create(CodeView.prototype) as CodeView, {
      items: records,
      idToItem: new Map(records.map((record) => [record.item.id, record])),
      instanceToItem: new Map(records.map((record) => [record.instance, record])),
      renderState: {
        firstIndex: 0, lastIndex: 0, scrollTop: 0,
        stickyHeight: 100, stickyTop: 0, stickyBottom: 100,
      },
      capturePendingLayoutAnchor() {
        this.pendingLayoutAnchor = { id: this.items[0].item.id }
      },
      releaseRenderedItem(record: (typeof records)[number]) {
        if (record.element != null) released.push(record.item.id)
        record.element = undefined
      },
      render() {},
    })
    const reconcile = view as unknown as {
      reconcileItems(items: (typeof records)[number]['item'][]): void
      pendingLayoutAnchor: { id: string }
    }

    reconcile.reconcileItems([records[1].item, records[2].item, records[0].item])

    expect(released).toEqual(['a'])
    expect(records.every((record) => record.element == null)).toBe(true)
    expect(reconcile.pendingLayoutAnchor.id).toBe('a')
    expect(view.getRenderedItems()).toEqual([])
  })
})
