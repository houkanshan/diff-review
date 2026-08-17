import { describe, expect, test } from 'vitest'
import type { CodeViewLineSelection, FileDiffMetadata } from '@pierre/diffs'

import {
  areReviewAnnotationsEqual,
  annotationsForFile,
  buildCodeViewItems,
} from '../src/client/annotationComposer.js'
import type { SessionAnnotation } from '../src/shared/types.js'

function fileDiff(name: string, prevName?: string): FileDiffMetadata {
  return {
    name,
    prevName,
    type: 'modified',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
  } as FileDiffMetadata
}

function annotation(filePath: string, id = 'note-1'): SessionAnnotation {
  return {
    id,
    sessionId: 'session',
    filePath,
    side: 'new',
    startLine: 4,
    endSide: null,
    endLine: 4,
    comment: 'look here',
    importance: null,
    source: 'user',
    intent: 'annotation',
    archivedAt: null,
    submittedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function selection(id: string, line = 8): CodeViewLineSelection {
  return {
    id,
    range: { start: line, end: line, side: 'additions' },
  }
}

describe('annotation composer items', () => {
  test('attaches a composer annotation only to the selected file', () => {
    const selected = fileDiff('src/a.ts')
    const other = fileDiff('src/b.ts')

    expect(annotationsForFile([], selected, selection('src/a.ts'))).toEqual([
      {
        side: 'additions',
        lineNumber: 8,
        metadata: { kind: 'composer', selection: selection('src/a.ts') },
      },
    ])
    expect(annotationsForFile([], other, selection('src/a.ts'))).toEqual([])
  })

  test('reuses unchanged file items and only versions the file that opened the composer', () => {
    const files = [fileDiff('src/a.ts'), fileDiff('src/b.ts')]
    const notes = [annotation('src/b.ts')]
    const initial = buildCodeViewItems(files, notes, null, new Set(), 's1', 't1')
    const next = buildCodeViewItems(
      files,
      notes,
      selection('src/a.ts'),
      new Set(),
      's1',
      't1',
      initial,
    )

    expect(next[1]).toBe(initial[1])
    expect(next[0]).not.toBe(initial[0])
    expect(next[0]?.version).toBe((initial[0]?.version ?? 0) + 1)
    expect(next[1]?.version).toBe(initial[1]?.version)
    expect(next[0]?.annotations).toHaveLength(1)
    expect(next[0]?.annotations?.[0]?.metadata).toMatchObject({ kind: 'composer' })
  })

  test('keeps item identity when the composer draft is not part of the item payload', () => {
    const files = [fileDiff('src/a.ts')]
    const notes = [annotation('src/a.ts')]
    const selected = selection('src/a.ts')
    const first = buildCodeViewItems(files, notes, selected, new Set(), 's1', 't1')
    const second = buildCodeViewItems(files, notes, selected, new Set(), 's1', 't1', first)

    expect(second[0]).toBe(first[0])
    expect(areReviewAnnotationsEqual(first[0]?.annotations, second[0]?.annotations ?? [])).toBe(true)
  })

  test('reuses file items when saved annotations are cloned but unchanged', () => {
    const files = [fileDiff('src/a.ts'), fileDiff('src/b.ts')]
    const initial = buildCodeViewItems(files, [annotation('src/b.ts')], null, new Set(), 's1', 't1')
    const next = buildCodeViewItems(
      files,
      [annotation('src/b.ts')],
      null,
      new Set(),
      's1',
      't1',
      initial,
    )

    expect(next[0]).toBe(initial[0])
    expect(next[1]).toBe(initial[1])
  })
})
