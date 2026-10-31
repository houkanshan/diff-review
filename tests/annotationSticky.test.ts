import { describe, expect, test } from 'vitest'

import {
  dockedCardBottom,
  resolveUnmountedRangeEdges,
  overlayCardBox,
  selectDockedAnnotationIds,
  stickyOverlayMode,
  stickyRangeIntersectsViewport,
} from '../src/client/annotationSticky.js'

const midRange = {
  startBottom: -40,
  endBottom: 1800,
  viewportTop: 32,
  viewportBottom: 600,
  fileTop: 0,
  fileBottom: 2000,
}

describe('annotation sticky geometry', () => {
  test('docks while the range is on screen and in-doc is still below', () => {
    expect(stickyOverlayMode(midRange, 80, null)).toBe('dock')
    expect(stickyOverlayMode(midRange, 80, 900)).toBe('dock')
  })

  test('uses in-doc once the parked card would cover it', () => {
    expect(stickyOverlayMode({
      startBottom: -400,
      endBottom: 90,
      viewportTop: 32,
      viewportBottom: 600,
      fileTop: 0,
      fileBottom: 2000,
    }, 80, 90)).toBe('indoc')
  })

  test('hides when the file no longer occupies the viewport bottom', () => {
    expect(stickyOverlayMode({
      ...midRange,
      fileTop: -200,
      fileBottom: 400,
    }, 80, null)).toBe('hidden')
  })

  test('hides once the range has scrolled above the dock edge', () => {
    expect(stickyOverlayMode({
      ...midRange,
      startBottom: -400,
      endBottom: 80,
    }, 80, null)).toBe('hidden')
  })

  test('hides when the range is fully below or above the viewport', () => {
    expect(stickyRangeIntersectsViewport({
      startBottom: 700,
      endBottom: 900,
      viewportTop: 32,
      viewportBottom: 600,
      fileTop: 0,
      fileBottom: 2000,
    })).toBe(false)
    expect(stickyOverlayMode({
      startBottom: 700,
      endBottom: 900,
      viewportTop: 32,
      viewportBottom: 600,
      fileTop: 0,
      fileBottom: 2000,
    }, 80, null)).toBe('hidden')
  })

  test('parks a docked card at the stack position when its range starts above it', () => {
    expect(dockedCardBottom(100, 800, null, 300)).toBe(0)
    expect(dockedCardBottom(100, 800, 120, 300)).toBe(120)
  })

  test('keeps a tall docked card below the first line of its range', () => {
    // Range starts at 600; a 500px card would otherwise reach up to 300.
    expect(dockedCardBottom(600, 800, null, 500)).toBe(-300)
    expect(dockedCardBottom(600, 800, 100, 50)).toBe(100)
  })

  test('does not dock a stacked card that would cross its range start', () => {
    // Two 300px cards whose ranges both start at 600 in an 800px viewport.
    const first = dockedCardBottom(600, 800, null, 300)
    expect(first).toBe(-100)
    expect(dockedCardBottom(600, 800, first! + 300 + 8, 300)).toBeNull()
    expect(dockedCardBottom(600, 800, 180, 50)).toBeNull()
  })

  test('keeps a stable width when the in-doc card is not mounted', () => {
    const scroller = { clientWidth: 900 } as HTMLElement
    expect(overlayCardBox(scroller, null, 48)).toEqual({
      left: 48,
      width: 590,
      top: undefined,
      height: undefined,
    })
  })

  test('keeps a nested range and drops the outer one', () => {
    expect(selectDockedAnnotationIds([
      { id: 'outer', fileId: 'src.ts', side: 'new', startLine: 1, endLine: 100 },
      { id: 'inner', fileId: 'src.ts', side: 'new', startLine: 40, endLine: 50 },
    ])).toEqual(['inner'])
  })

  test('stacks partial overlaps and keeps opposite sides', () => {
    expect(selectDockedAnnotationIds([
      { id: 'a', fileId: 'src.ts', side: 'new', startLine: 1, endLine: 50 },
      { id: 'b', fileId: 'src.ts', side: 'new', startLine: 40, endLine: 80 },
      { id: 'c', fileId: 'src.ts', side: 'old', startLine: 10, endLine: 12 },
    ])).toEqual(['a', 'b', 'c'])
  })

  test('infers missing start or end from nearby visible lines', () => {
    expect(resolveUnmountedRangeEdges(40, 50, null, null, [
      { line: 42, bottom: 80 },
      { line: 48, bottom: 120 },
    ])).toEqual({
      startBottom: Number.NEGATIVE_INFINITY,
      endBottom: Number.POSITIVE_INFINITY,
    })
  })

  test('snaps a folded-away range to the closest visible line', () => {
    expect(resolveUnmountedRangeEdges(2329, 2329, null, null, [
      { line: 2320, bottom: 100 },
      { line: 2340, bottom: 140 },
    ])).toEqual({
      startBottom: 100,
      endBottom: 100,
    })
  })

  test('does not treat the opposite side as a mounted line', () => {
    expect(resolveUnmountedRangeEdges(20, 20, null, null, [
      { line: 8, bottom: 10 },
      { line: 30, bottom: 90 },
    ], [
      { line: 8, bottom: 10 },
      { line: 20, bottom: 50 },
      { line: 30, bottom: 90 },
    ])).toEqual({
      startBottom: 90,
      endBottom: Number.POSITIVE_INFINITY,
    })
  })
})
