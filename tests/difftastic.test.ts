import { describe, expect, test } from 'vitest'

import { buildDifftasticFileDiff, utf8OffsetToUtf16 } from '../src/shared/difftastic.js'

const rustOld = [
  'fn add(a: i32, b: i32) -> i32 {',
  '    a + b',
  '}',
  '',
].join('\n')

const rustNew = [
  'fn add(a: i32, b: i32) -> i32 {',
  '    a.saturating_add(b)',
  '}',
  'fn sub(a: i32, b: i32) -> i32 {',
  '    a - b',
  '}',
  '',
].join('\n')

const rustRaw = {
  chunks: [[
    {
      rhs: {
        line_number: 3,
        changes: [{ start: 0, end: 2, content: 'fn', highlight: 'keyword' }],
      },
    },
    {
      rhs: {
        line_number: 4,
        changes: [{ start: 4, end: 5, content: 'a', highlight: 'normal' }],
      },
    },
    {
      rhs: {
        line_number: 5,
        changes: [{ start: 0, end: 1, content: '}', highlight: 'delimiter' }],
      },
    },
    {
      lhs: {
        line_number: 1,
        changes: [{ start: 6, end: 7, content: '+', highlight: 'normal' }],
      },
      rhs: {
        line_number: 1,
        changes: [{ start: 6, end: 20, content: 'saturating_add', highlight: 'normal' }],
      },
    },
  ]],
  language: 'Rust',
  path: '/tmp/new.rs',
  status: 'changed',
}

describe('difftastic file reconstruction', () => {
  test('fills complete source lines and surrounding context', () => {
    const file = buildDifftasticFileDiff({
      path: 'src/add.rs',
      oldText: rustOld,
      newText: rustNew,
      raw: rustRaw,
    })

    expect(file.path).toBe('src/add.rs')
    expect(file.language).toBe('Rust')
    expect(file.status).toBe('changed')
    expect(file.hunks).toHaveLength(1)

    const texts = file.hunks[0]!.lines.map((line) => ({
      kind: line.kind,
      oldLine: line.oldLine,
      newLine: line.newLine,
      oldText: line.oldText,
      newText: line.newText,
    }))

    expect(texts).toContainEqual({
      kind: 'context',
      oldLine: 1,
      newLine: 1,
      oldText: 'fn add(a: i32, b: i32) -> i32 {',
      newText: 'fn add(a: i32, b: i32) -> i32 {',
    })
    expect(texts).toContainEqual({
      kind: 'change',
      oldLine: 2,
      newLine: 2,
      oldText: '    a + b',
      newText: '    a.saturating_add(b)',
    })
    expect(texts).toContainEqual({
      kind: 'insert',
      oldLine: null,
      newLine: 4,
      oldText: null,
      newText: 'fn sub(a: i32, b: i32) -> i32 {',
    })
    expect(file.hunks[0]!.lines.find((line) => line.kind === 'change')?.oldSpans).toEqual([
      { start: 6, end: 7, content: '+', highlight: 'normal' },
    ])
  })

  test('turns created files without chunks into a full insert hunk', () => {
    const file = buildDifftasticFileDiff({
      path: 'src/new.txt',
      oldText: null,
      newText: 'hello\nworld\n',
      raw: { language: 'Text', path: '/tmp/new.txt', status: 'created' },
    })

    expect(file.status).toBe('created')
    expect(file.hunks[0]!.lines.map((line) => line.newText)).toEqual(['hello', 'world'])
    expect(file.hunks[0]!.lines.every((line) => line.kind === 'insert')).toBe(true)
  })

  test('turns deleted files without chunks into a full delete hunk', () => {
    const file = buildDifftasticFileDiff({
      path: 'src/old.txt',
      oldText: 'gone\n',
      newText: null,
      raw: { language: 'Text', path: '/tmp/old.txt', status: 'deleted' },
    })

    expect(file.status).toBe('deleted')
    expect(file.hunks[0]!.lines).toEqual([
      {
        kind: 'delete',
        oldLine: 1,
        newLine: null,
        oldText: 'gone',
        newText: null,
        oldSpans: [],
        newSpans: [],
      },
    ])
  })

  test('reconstructs both-side context for a pure insertion', () => {
    const file = buildDifftasticFileDiff({
      path: 'notes.txt',
      oldText: 'line1\nline2\nline3\nline4\nline5\n',
      newText: 'line1\nline2\nINSERTED\nline3\nline4\nline5\n',
      raw: {
        language: 'Text',
        path: '/tmp/new-insert.txt',
        status: 'changed',
        chunks: [[{
          rhs: {
            line_number: 2,
            changes: [{ start: 0, end: 8, content: 'INSERTED', highlight: 'normal' }],
          },
        }]],
      },
    })

    expect(file.hunks[0]!.lines).toEqual(expect.arrayContaining([
      {
        kind: 'context',
        oldLine: 1,
        newLine: 1,
        oldText: 'line1',
        newText: 'line1',
        oldSpans: [],
        newSpans: [],
      },
      {
        kind: 'insert',
        oldLine: null,
        newLine: 3,
        oldText: null,
        newText: 'INSERTED',
        oldSpans: [],
        newSpans: [{ start: 0, end: 8, content: 'INSERTED', highlight: 'normal' }],
      },
      {
        kind: 'context',
        oldLine: 3,
        newLine: 4,
        oldText: 'line3',
        newText: 'line3',
        oldSpans: [],
        newSpans: [],
      },
    ]))
  })

  test('reconstructs both-side context for a pure deletion', () => {
    const file = buildDifftasticFileDiff({
      path: 'notes.txt',
      oldText: 'line1\nline2\nREMOVE_ME\nline3\nline4\nline5\n',
      newText: 'line1\nline2\nline3\nline4\nline5\n',
      raw: {
        language: 'Text',
        path: '/tmp/new-delete.txt',
        status: 'changed',
        chunks: [[{
          lhs: {
            line_number: 2,
            changes: [{ start: 0, end: 9, content: 'REMOVE_ME', highlight: 'normal' }],
          },
        }]],
      },
    })

    expect(file.hunks[0]!.lines).toEqual(expect.arrayContaining([
      {
        kind: 'context',
        oldLine: 2,
        newLine: 2,
        oldText: 'line2',
        newText: 'line2',
        oldSpans: [],
        newSpans: [],
      },
      {
        kind: 'delete',
        oldLine: 3,
        newLine: null,
        oldText: 'REMOVE_ME',
        newText: null,
        oldSpans: [{ start: 0, end: 9, content: 'REMOVE_ME', highlight: 'normal' }],
        newSpans: [],
      },
      {
        kind: 'context',
        oldLine: 4,
        newLine: 3,
        oldText: 'line3',
        newText: 'line3',
        oldSpans: [],
        newSpans: [],
      },
    ]))
  })

  test('keeps inserted functions that appear before a later change in the same chunk', () => {
    const oldText = [
      'export const steps = map((step) => {',
      '  if (step.name === "ResidenceType") {',
      '    return {',
      '      ...step,',
      '      Component: TypeQuestion,',
      '    };',
      '  }',
      '  return step;',
      '});',
      '',
      'export const getSteps = (',
      '  values: OldFormData,',
      '): Step[] => {',
      '  return [];',
      '};',
      '',
    ].join('\n')
    const newText = [
      'export const steps = map((step) => {',
      '  if (step.name === "ResidenceType") {',
      '    return {',
      '      ...step,',
      '      Component: TypeQuestion,',
      '    };',
      '  }',
      '  return step;',
      '});',
      '',
      'export const shouldCollect = (',
      '  values: NewFormData,',
      '): boolean => {',
      '  return true;',
      '};',
      '',
      'export const getSteps = (',
      '  values: NewFormData,',
      '): Step[] => {',
      '  return [];',
      '};',
      '',
    ].join('\n')

    const file = buildDifftasticFileDiff({
      path: 'steps.ts',
      oldText,
      newText,
      raw: {
        language: 'TypeScript',
        path: '/tmp/steps.ts',
        status: 'changed',
        chunks: [[
          {
            rhs: {
              line_number: 10,
              changes: [{ start: 0, end: 7, content: 'export', highlight: 'keyword' }],
            },
          },
          {
            rhs: {
              line_number: 11,
              changes: [{ start: 2, end: 8, content: 'values', highlight: 'normal' }],
            },
          },
          {
            rhs: {
              line_number: 12,
              changes: [{ start: 0, end: 11, content: '): boolean', highlight: 'type' }],
            },
          },
          {
            rhs: {
              line_number: 13,
              changes: [{ start: 2, end: 8, content: 'return', highlight: 'keyword' }],
            },
          },
          {
            rhs: {
              line_number: 14,
              changes: [{ start: 0, end: 3, content: '};', highlight: 'delimiter' }],
            },
          },
          {
            lhs: {
              line_number: 11,
              changes: [{ start: 10, end: 21, content: 'OldFormData', highlight: 'type' }],
            },
            rhs: {
              line_number: 17,
              changes: [{ start: 10, end: 21, content: 'NewFormData', highlight: 'type' }],
            },
          },
        ]],
      },
    })

    const inserted = file.hunks[0]!.lines.filter((line) => line.newLine != null && line.newLine >= 11 && line.newLine <= 15)
    expect(inserted.map((line) => ({ kind: line.kind, newLine: line.newLine, newText: line.newText }))).toEqual([
      { kind: 'insert', newLine: 11, newText: 'export const shouldCollect = (' },
      { kind: 'insert', newLine: 12, newText: '  values: NewFormData,' },
      { kind: 'insert', newLine: 13, newText: '): boolean => {' },
      { kind: 'insert', newLine: 14, newText: '  return true;' },
      { kind: 'insert', newLine: 15, newText: '};' },
    ])
    const change = file.hunks[0]!.lines.find((line) => line.kind === 'change')
    expect(change).toMatchObject({ oldLine: 12, newLine: 18, oldText: '  values: OldFormData,', newText: '  values: NewFormData,' })
  })

  test('emits a one-line replacement as delete then insert', () => {
    const file = buildDifftasticFileDiff({
      path: 'swap.txt',
      oldText: 'keep\nold\nkeep\n',
      newText: 'keep\nnew\nkeep\n',
      raw: {
        language: 'Text',
        path: '/tmp/swap.txt',
        status: 'changed',
        chunks: [[
          { lhs: { line_number: 1, changes: [{ start: 0, end: 3, content: 'old', highlight: 'normal' }] } },
          { rhs: { line_number: 1, changes: [{ start: 0, end: 3, content: 'new', highlight: 'normal' }] } },
        ]],
      },
    })

    expect(file.hunks[0]!.lines.filter((line) => line.kind !== 'context').map((line) => line.kind)).toEqual([
      'delete',
      'insert',
    ])
  })

  test('merges nearby chunks without repeating context lines', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line${index + 1}`)
    const oldText = `${lines.join('\n')}\n`
    const newText = lines.map((line, index) => index === 7 ? 'changed-a' : index === 12 ? 'changed-b' : line).join('\n') + '\n'
    const file = buildDifftasticFileDiff({
      path: 'near.txt',
      oldText,
      newText,
      raw: {
        language: 'Text',
        path: '/tmp/near.txt',
        status: 'changed',
        chunks: [
          [{
            lhs: { line_number: 7, changes: [{ start: 0, end: 5, content: 'line8', highlight: 'normal' }] },
            rhs: { line_number: 7, changes: [{ start: 0, end: 9, content: 'changed-a', highlight: 'normal' }] },
          }],
          [{
            lhs: { line_number: 12, changes: [{ start: 0, end: 6, content: 'line13', highlight: 'normal' }] },
            rhs: { line_number: 12, changes: [{ start: 0, end: 9, content: 'changed-b', highlight: 'normal' }] },
          }],
        ],
      },
    })

    expect(file.hunks).toHaveLength(1)
    const newNumbers = file.hunks[0]!.lines.map((line) => line.newLine).filter((line): line is number => line != null)
    expect(newNumbers).toEqual([...new Set(newNumbers)])
    expect(file.hunks[0]!.lines.filter((line) => line.kind === 'change').map((line) => line.newLine)).toEqual([8, 13])
  })

  test('keeps distant chunks as separate hunks', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line${index + 1}`)
    const file = buildDifftasticFileDiff({
      path: 'far.txt',
      oldText: `${lines.join('\n')}\n`,
      newText: lines.map((line, index) => index === 2 ? 'a' : index === 24 ? 'b' : line).join('\n') + '\n',
      raw: {
        language: 'Text',
        path: '/tmp/far.txt',
        status: 'changed',
        chunks: [
          [{
            lhs: { line_number: 2, changes: [{ start: 0, end: 5, content: 'line3', highlight: 'normal' }] },
            rhs: { line_number: 2, changes: [{ start: 0, end: 1, content: 'a', highlight: 'normal' }] },
          }],
          [{
            lhs: { line_number: 24, changes: [{ start: 0, end: 6, content: 'line25', highlight: 'normal' }] },
            rhs: { line_number: 24, changes: [{ start: 0, end: 1, content: 'b', highlight: 'normal' }] },
          }],
        ],
      },
    })

    expect(file.hunks).toHaveLength(2)
  })

  test('converts difftastic UTF-8 offsets to JavaScript string indexes', () => {
    expect(utf8OffsetToUtf16('😀foo', 4)).toBe(2)
    expect(utf8OffsetToUtf16('😀foo', 7)).toBe(5)

    const file = buildDifftasticFileDiff({
      path: 'emoji.txt',
      oldText: '😀foo\n',
      newText: '😀bar\n',
      raw: {
        language: 'Text',
        path: '/tmp/new-uni.txt',
        status: 'changed',
        chunks: [[{
          lhs: {
            line_number: 0,
            changes: [
              { start: 0, end: 4, content: '😀', highlight: 'normal' },
              { start: 4, end: 7, content: 'foo', highlight: 'normal' },
            ],
          },
          rhs: {
            line_number: 0,
            changes: [
              { start: 0, end: 4, content: '😀', highlight: 'normal' },
              { start: 4, end: 7, content: 'bar', highlight: 'normal' },
            ],
          },
        }]],
      },
    })

    const line = file.hunks[0]!.lines.find((item) => item.kind === 'change')
    expect(line?.oldSpans.map((span) => ({ start: span.start, end: span.end, content: span.content }))).toEqual([
      { start: 0, end: 2, content: '😀' },
      { start: 2, end: 5, content: 'foo' },
    ])
    expect(line?.newSpans.map((span) => ({ start: span.start, end: span.end, content: span.content }))).toEqual([
      { start: 0, end: 2, content: '😀' },
      { start: 2, end: 5, content: 'bar' },
    ])
  })

  test('rejects malformed difftastic output', () => {
    expect(() =>
      buildDifftasticFileDiff({
        path: 'src/bad.rs',
        oldText: 'a\n',
        newText: 'b\n',
        raw: { language: 'Rust' },
      }),
    ).toThrow(/status/)
  })
})
