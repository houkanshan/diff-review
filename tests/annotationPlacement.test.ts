import { describe, expect, test } from 'vitest'

import { nearestVisibleLine, snapPierreLineNumber } from '../src/client/annotationPlacement.js'
import type { FileDiffMetadata } from '@pierre/diffs'

describe('annotation placement', () => {
  test('picks the closer line and the lower line on a tie', () => {
    expect(nearestVisibleLine(10, [4, 16, 12])).toBe(12)
    expect(nearestVisibleLine(10, [8, 12])).toBe(8)
  })

  test('snaps a line inside a collapsed inter-hunk gap', () => {
    const file = {
      name: 'a.go',
      type: 'modified',
      isPartial: false,
      hunks: [{
        collapsedBefore: 0,
        additionStart: 10,
        additionCount: 5,
        additionLines: 2,
        additionLineIndex: 0,
        deletionStart: 10,
        deletionCount: 3,
        deletionLines: 0,
        deletionLineIndex: 0,
        hunkContent: [],
        splitLineStart: 0,
        splitLineCount: 5,
        unifiedLineStart: 0,
        unifiedLineCount: 5,
      }, {
        collapsedBefore: 40,
        additionStart: 55,
        additionCount: 3,
        additionLines: 1,
        additionLineIndex: 5,
        deletionStart: 55,
        deletionCount: 2,
        deletionLines: 0,
        deletionLineIndex: 3,
        hunkContent: [],
        splitLineStart: 5,
        splitLineCount: 3,
        unifiedLineStart: 5,
        unifiedLineCount: 3,
      }],
      splitLineCount: 8,
      unifiedLineCount: 8,
      additionLines: Array.from({ length: 80 }, () => 'x'),
      deletionLines: Array.from({ length: 80 }, () => 'x'),
    } as FileDiffMetadata

    expect(snapPierreLineNumber(file, 'new', 20)).toBe(14)
  })
})
