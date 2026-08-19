import { describe, expect, test } from 'vitest'
import type { CodeViewLineSelection, FileDiffMetadata } from '@pierre/diffs'

import {
  areReviewAnnotationsEqual,
  annotationCoversLine,
  annotationsAtDifftasticRow,
  annotationsForFile,
  buildCodeViewItems,
  placeDifftasticAnnotations,
} from '../src/client/annotationComposer.js'
import type { DifftasticHunk, SessionAnnotation } from '../src/shared/types.js'

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
    replyToId: null,
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

  test('does not place replies as their own line annotations', () => {
    const file = fileDiff('src/a.ts')
    const parent = annotation('src/a.ts', 'agent')
    const reply = { ...annotation('src/a.ts', 'reply'), replyToId: parent.id }
    expect(annotationsForFile([parent, reply], file, null)).toEqual([
      {
        side: 'additions',
        lineNumber: 4,
        metadata: { kind: 'saved', annotation: parent },
      },
    ])
  })

  test('reuses unchanged file items and only versions the file that opened the composer', () => {
    const files = [fileDiff('src/a.ts'), fileDiff('src/b.ts')]
    const notes = [annotation('src/b.ts')]
    const initial = buildCodeViewItems(files, notes, null, new Set())
    const next = buildCodeViewItems(
      files,
      notes,
      selection('src/a.ts'),
      new Set(),
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
    const first = buildCodeViewItems(files, notes, selected, new Set())
    const second = buildCodeViewItems(files, notes, selected, new Set(), first)

    expect(second[0]).toBe(first[0])
    expect(areReviewAnnotationsEqual(first[0]?.annotations, second[0]?.annotations ?? [])).toBe(true)
  })

  test('reuses file items when saved annotations are cloned but unchanged', () => {
    const files = [fileDiff('src/a.ts'), fileDiff('src/b.ts')]
    const initial = buildCodeViewItems(files, [annotation('src/b.ts')], null, new Set())
    const next = buildCodeViewItems(
      files,
      [annotation('src/b.ts')],
      null,
      new Set(),
      initial,
    )

    expect(next[0]).toBe(initial[0])
    expect(next[1]).toBe(initial[1])
  })
})

describe('difftastic annotation placement', () => {
  test('anchors to the matching visible line when it exists', () => {
    const placed = placeDifftasticAnnotations(
      [annotation('src/a.ts', 'note-1')],
      [hunk({ kind: 'insert', oldLine: null, newLine: 4 })],
    )

    expect(idsAt(placed, 0, 0, 'new')).toEqual(['note-1'])
  })

  test('falls back to the nearest same-side visible line', () => {
    const note = annotation('src/a.ts', 'near')
    note.endLine = 12
    const placed = placeDifftasticAnnotations(
      [note],
      [hunk(
        { kind: 'context', oldLine: 8, newLine: 8 },
        { kind: 'insert', oldLine: null, newLine: 10 },
        { kind: 'context', oldLine: 16, newLine: 17 },
      )],
    )

    expect(idsAt(placed, 0, 1, 'new')).toEqual(['near'])
    expect(idsAt(placed, 0, 2, 'new')).toEqual([])
  })

  test('uses the other side only when the preferred side is missing', () => {
    const note = annotation('src/a.ts', 'cross')
    note.side = 'old'
    note.endLine = 9
    const placed = placeDifftasticAnnotations(
      [note],
      [hunk({ kind: 'insert', oldLine: null, newLine: 11 })],
    )

    expect(idsAt(placed, 0, 0, 'new')).toEqual(['cross'])
  })

  test('places an overlapping line on only the first rendered row', () => {
    const note = annotation('src/a.ts', 'once')
    note.endLine = 12
    const placed = placeDifftasticAnnotations(
      [note],
      [
        hunk(
          { kind: 'insert', oldLine: null, newLine: 10 },
          { kind: 'context', oldLine: 12, newLine: 12 },
          { kind: 'context', oldLine: 13, newLine: 13 },
        ),
        hunk(
          { kind: 'context', oldLine: 11, newLine: 11 },
          { kind: 'context', oldLine: 12, newLine: 12 },
          { kind: 'insert', oldLine: null, newLine: 14 },
        ),
      ],
    )

    expect(idsAt(placed, 0, 1, 'new')).toEqual(['once'])
    expect(idsAt(placed, 1, 1, 'new')).toEqual([])
  })
})

describe('annotationCoversLine', () => {
  test('covers an inclusive same-side range', () => {
    const note = {
      ...annotation('src/a.ts'),
      side: 'new' as const,
      startLine: 4,
      endSide: null,
      endLine: 6,
    }
    expect(annotationCoversLine(note, 'new', 4)).toBe(true)
    expect(annotationCoversLine(note, 'new', 6)).toBe(true)
    expect(annotationCoversLine(note, 'new', 7)).toBe(false)
    expect(annotationCoversLine(note, 'old', 5)).toBe(false)
  })

  test('covers only the endpoints when the range crosses sides', () => {
    const note = {
      ...annotation('src/a.ts'),
      side: 'old' as const,
      startLine: 10,
      endSide: 'new' as const,
      endLine: 12,
    }
    expect(annotationCoversLine(note, 'old', 10)).toBe(true)
    expect(annotationCoversLine(note, 'new', 12)).toBe(true)
    expect(annotationCoversLine(note, 'old', 11)).toBe(false)
    expect(annotationCoversLine(note, 'new', 10)).toBe(false)
  })
})

function hunk(...lines: Array<{
  kind: 'context' | 'delete' | 'insert' | 'change'
  oldLine: number | null
  newLine: number | null
}>): DifftasticHunk {
  return {
    lines: lines.map((line) => ({
      ...line,
      oldText: line.oldLine == null ? null : 'old',
      newText: line.newLine == null ? null : 'new',
      oldSpans: [],
      newSpans: [],
    })),
  }
}

function idsAt(
  placed: Map<string, SessionAnnotation[]>,
  hunkIndex: number,
  lineIndex: number,
  side: 'old' | 'new',
): string[] {
  return annotationsAtDifftasticRow(placed, hunkIndex, lineIndex, side).map((note) => note.id)
}
