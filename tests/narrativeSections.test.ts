import { describe, expect, test } from 'vitest'
import { groupReviewFiles, orderReviewFiles, visibleAnnotationsForFile, areSavedAnnotationsEqual } from '../src/client/annotationComposer'
import type { SessionAnnotation, SessionSection } from '../src/shared/types'

const files = [{ name: 'a.ts' }, { name: 'new.ts', prevName: 'old.ts' }, { name: 'b.ts' }, { name: 'other.ts' }]
const createdAt = '2026-01-01T00:00:00Z'
function section(prefix: string, order: number, created = createdAt): SessionSection {
  return { prefix, order, sessionId: 's', body: `Overview ${prefix}`, createdAt: created, updatedAt: created }
}
function note(id: string, filePath: string, sectionPrefix: string | null, overrides: Partial<SessionAnnotation> = {}): SessionAnnotation {
  return { id, shortId: id, sessionId: 's', filePath, sectionPrefix, side: 'new', startLine: 1,
    endLine: 1, endSide: null, comment: 'Note', source: 'agent', intent: 'annotation',
    replyToId: null, archivedAt: null, submittedAt: null, viewedAt: null, importance: null,
    createdAt, updatedAt: createdAt, ...overrides }
}

describe('narrative section grouping', () => {
  test('sorts finite order numerically, then creation time, with stable creation ties and empty overviews', () => {
    const sections = [section('late', 10), section('same-new', 2, '2026-01-03'),
      section('same-old', 2), section('same-tie', 2), section('first', -1),
      section('invalid', NaN), section('infinite', Infinity)]
    expect(groupReviewFiles([], [], sections).map((group) => group.section?.prefix))
      .toEqual(['first', 'same-old', 'same-tie', 'same-new', 'late', 'invalid', 'infinite'])
    expect(groupReviewFiles([], [], sections).every((group) => group.files.length === 0)).toBe(true)
  })

  test('owns each file once at its earliest current section, resolving renames and note creation order', () => {
    const notes = [note('ABC-2', 'a.ts', 'ABC', { createdAt: '2026-01-02' }),
      note('DEF-1', 'old.ts', 'DEF'), note('ABC-1', 'old.ts', 'ABC'),
      note('ABC-3', 'old.ts', 'ABC'), note('DEF-2', 'b.ts', 'DEF')]
    const groups = groupReviewFiles(files, notes, [section('DEF', 2), section('ABC', 1)], ['other.ts'])
    expect(groups.map((group) => [group.section?.prefix, group.files.map((file) => file.name)]))
      .toEqual([['ABC', ['new.ts', 'a.ts']], ['DEF', ['b.ts']], [undefined, ['other.ts']]])
    expect(groups[1].references.map((note) => note.shortId)).toEqual(['DEF-1'])
    expect(groups[0].references).toEqual([])
    expect(new Set(groups.flatMap((group) => group.files.map((file) => file.name))).size).toBe(files.length)
  })

  test('regroups files and references when section order or membership changes', () => {
    const notes = [note('ABC-1', 'old.ts', 'ABC'), note('DEF-1', 'new.ts', 'DEF')]
    const original = [section('ABC', 1), section('DEF', 2)]
    expect(orderReviewFiles(files, notes, null, original).map((file) => file.name))
      .toEqual(['new.ts', 'a.ts', 'b.ts', 'other.ts'])
    const reordered = groupReviewFiles(files, notes, [section('ABC', 3), section('DEF', 2)])
    expect(reordered[0].section?.prefix).toBe('DEF')
    expect(reordered[0].files.map((file) => file.name)).toEqual(['new.ts'])
    expect(reordered[1].references.map((note) => note.id)).toEqual(['ABC-1'])
    const updated = groupReviewFiles(files, [{ ...notes[0], sectionPrefix: 'DEF' }], original)
    expect(updated[0].files).toEqual([])
    expect(updated[1].files.map((file) => file.name)).toEqual(['new.ts'])
  })

  test('only active top-level agent notes claim files; missing sections and legacy notes remain visible', () => {
    const notes = [note('archived', 'a.ts', 'ABC', { archivedAt: createdAt }),
      note('reply', 'b.ts', 'ABC', { replyToId: 'legacy' }),
      note('human', 'a.ts', 'ABC', { source: 'user' }),
      note('legacy', 'b.ts', null), note('unknown', 'old.ts', 'MISSING'),
      note('score-only', 'a.ts', 'ABC', { comment: null, importance: 1 })]
    const groups = groupReviewFiles(files, notes, [section('ABC', 1)], ['other.ts', 'b.ts'])
    expect(groups[0].files).toEqual([])
    expect(groups[1].files.map((file) => file.name)).toEqual(['other.ts', 'b.ts', 'a.ts', 'new.ts'])
    expect(visibleAnnotationsForFile(notes, 'b.ts').map((note) => note.id)).toEqual(['reply', 'legacy'])
    expect(visibleAnnotationsForFile(notes, 'new.ts', 'old.ts').map((note) => note.id)).toEqual(['unknown'])
  })

  test('ignores importance and handles duplicate and unknown Jev paths', () => {
    const notes = [note('ABC-1', 'a.ts', 'ABC', { importance: 0 }),
      note('ABC-2', 'b.ts', 'ABC', { importance: 1 })]
    const sections = [section('ABC', 1)]
    const names = (notes: SessionAnnotation[]) => orderReviewFiles(files, notes, ['other.ts', 'missing', 'other.ts', 'new.ts'], sections).map((file) => file.name)
    expect(names(notes)).toEqual(['a.ts', 'b.ts', 'other.ts', 'new.ts'])
    expect(names(notes.map((note) => ({ ...note, importance: 1 - (note.importance ?? 0) })))).toEqual(names(notes))
    expect(areSavedAnnotationsEqual(notes[0], { ...notes[0], importance: 1 })).toBe(true)
    expect(areSavedAnnotationsEqual(notes[0], { ...notes[0], sectionPrefix: 'DEF' })).toBe(false)
  })
})
