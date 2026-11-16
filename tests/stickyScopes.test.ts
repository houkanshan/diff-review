import { describe, expect, test } from 'vitest'

import {
  computeScopeIndex,
  enclosingScopes,
  layoutPinnedRows,
  resolvePinnedScopes,
  type PinnedScope,
} from '../src/client/stickyScopes.js'

function headersAt(source: string, line: number): string[] {
  const lines = source.split('\n')
  const index = computeScopeIndex(lines)
  return enclosingScopes(index, line).map((scope) => (lines[scope.start - 1] ?? '').trim())
}

const ts = [
  'export class Store {',            // 1
  '  private items = new Map()',     // 2
  '',                                // 3
  '  load(id: string) {',            // 4
  '    if (id) {',                   // 5
  '      return this.items.get(id)', // 6
  '    }',                           // 7
  '    return null',                 // 8
  '  }',                             // 9
  '}',                               // 10
  'const x = 1',                     // 11
].join('\n')

describe('computeScopeIndex', () => {
  test('nests class, method and block scopes by indentation', () => {
    expect(headersAt(ts, 6)).toEqual(['export class Store {', 'load(id: string) {', 'if (id) {'])
    expect(headersAt(ts, 8)).toEqual(['export class Store {', 'load(id: string) {'])
    expect(headersAt(ts, 2)).toEqual(['export class Store {'])
    expect(headersAt(ts, 3)).toEqual(['export class Store {'])
    expect(headersAt(ts, 11)).toEqual([])
  })

  test('a scope header is not enclosed by its own scope', () => {
    expect(headersAt(ts, 4)).toEqual(['export class Store {'])
    expect(headersAt(ts, 1)).toEqual([])
  })

  test('scope ends before the closing line returns to the opener indent', () => {
    const index = computeScopeIndex(ts.split('\n'))
    const load = index.scopes.find((scope) => scope.start === 4)
    expect(load?.end).toBe(8)
    expect(headersAt(ts, 9)).toEqual(['export class Store {'])
  })

  test('python suites without braces', () => {
    const py = [
      'class A:',
      '    def f(self):',
      '        x = 1',
      '',
      '        return x',
      '    def g(self):',
      '        pass',
    ].join('\n')
    expect(headersAt(py, 5)).toEqual(['class A:', 'def f(self):'])
    expect(headersAt(py, 7)).toEqual(['class A:', 'def g(self):'])
  })

  test('pins the declaration for Allman-style braces', () => {
    const cs = [
      'void Run()',
      '{',
      '    Work();',
      '}',
    ].join('\n')
    expect(headersAt(cs, 3)).toEqual(['void Run()'])
  })

  test('pins the declaration of a multi-line signature', () => {
    const source = [
      'export function render(',
      '  props: Props,',
      '  options: Options,',
      '): Node {',
      '  return draw(props)',
      '}',
    ].join('\n')
    expect(headersAt(source, 5)).toEqual(['export function render('])
    expect(headersAt(source, 2)).toEqual(['export function render('])
  })

  test('pins the declaration of destructured props with a type literal', () => {
    const source = [
      'function View({',
      '  a,',
      '}: {',
      '  a: string',
      '}) {',
      '  return a',
      '}',
    ].join('\n')
    expect(headersAt(source, 6)).toEqual(['function View({'])
    expect(headersAt(source, 4)).toEqual(['function View({'])
  })

  test('keeps else and catch branches as their own scopes', () => {
    const source = [
      'function f() {',
      '  if (a) {',
      '    one()',
      '  } else {',
      '    two()',
      '  }',
      '}',
    ].join('\n')
    expect(headersAt(source, 5)).toEqual(['function f() {', '} else {'])
  })

  test('skips comment blocks as scope headers', () => {
    const source = [
      '/**',
      ' * docs',
      ' */',
      'function a() {',
      '  // note',
      '    // indented comment',
      '  return 1',
      '}',
    ].join('\n')
    expect(headersAt(source, 2)).toEqual([])
    expect(headersAt(source, 6)).toEqual(['function a() {'])
  })

  test('handles tabs and large files linearly', () => {
    const lines = ['func main() {']
    for (let index = 0; index < 50_000; index += 1) lines.push('\tcall()')
    lines.push('}')
    const started = performance.now()
    const index = computeScopeIndex(lines)
    expect(performance.now() - started).toBeLessThan(500)
    expect(enclosingScopes(index, 25_000).map((scope) => scope.start)).toEqual([1])
  })
})

describe('resolvePinnedScopes', () => {
  const lines = ts.split('\n')
  const index = computeScopeIndex(lines)
  const chainAt = (line: number): PinnedScope<'new'>[] => enclosingScopes(index, line).map((scope) => ({
    side: 'new',
    scope,
    text: lines[scope.start - 1] ?? '',
  }))

  test('pins one row per ancestor still enclosing the line under it', () => {
    // Top line is 5; row 0 covers line 5, row 1 covers 6, row 2 covers 7.
    const pinned = resolvePinnedScopes((depth) => chainAt(5 + depth), 5)
    expect(pinned.map((row) => row.scope.start)).toEqual([1, 4])
  })

  test('stops when the line under a row leaves the next scope', () => {
    const pinned = resolvePinnedScopes((depth) => chainAt(8 + depth), 5)
    expect(pinned.map((row) => row.scope.start)).toEqual([1])
  })

  test('respects the row limit', () => {
    const pinned = resolvePinnedScopes((depth) => chainAt(6 + depth), 1)
    expect(pinned.map((row) => row.scope.start)).toEqual([1])
  })

  test('matches counterpart scopes from the other side by text', () => {
    const oldChain = chainAt(6).map((row) => ({ ...row, side: 'old' as const }))
    const pinned = resolvePinnedScopes<'old' | 'new'>(
      (depth) => depth === 0 ? oldChain : chainAt(6),
      5,
    )
    expect(pinned.map((row) => row.scope.start)).toEqual([1, 4, 5])
    expect(pinned.map((row) => row.side)).toEqual(['new', 'new', 'new'])
  })
})

describe('layoutPinnedRows', () => {
  test('stacks rows when scope ends are far below', () => {
    expect(layoutPinnedRows([Infinity, 500, 200], 16)).toEqual([0, 16, 32])
  })

  test('pushes a row up with its scope end, under the rows above it', () => {
    expect(layoutPinnedRows([Infinity, 40], 16)).toEqual([0, 16])
    expect(layoutPinnedRows([Infinity, 20], 16)).toEqual([0, 4])
    expect(layoutPinnedRows([Infinity, 10], 16)).toEqual([0, -6])
    expect(layoutPinnedRows([10, 10], 16)).toEqual([-6, -6])
  })
})
