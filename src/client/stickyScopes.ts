/**
 * Indentation-based enclosing scopes for sticky scope lines.
 *
 * A non-blank line opens a scope when the next non-blank line is indented
 * deeper. The scope ends at the last non-blank line before the indentation
 * returns to the opener's level. This is language-agnostic: it matches
 * functions, classes, blocks, object literals, YAML/JSON keys and Python
 * suites, and it never needs a grammar.
 */

export type Scope = {
  /** 1-based line shown when the scope is pinned. */
  start: number
  /** 1-based last line of the scope body. */
  end: number
  /** Index of the enclosing scope in `ScopeIndex.scopes`, or -1. */
  parent: number
}

export type ScopeIndex = {
  scopes: Scope[]
  /** Text of each scope's `start` line, keyed by line number. */
  headers: Map<number, string>
  /** Innermost scope containing each 1-based line (index 0 unused), or -1. */
  innermost: Int32Array
}

const TAB_WIDTH = 4
const LONE_OPENERS = new Set(['{', '(', '[', '{{', '[[', '({', '=> {'])
const MULTILINE_HEADER_LOOKBACK = 80
/** `) {`, `}: {`, `}) => {`, `] = [`; not `} else {` or `} catch (e) {`. */
const HEADER_CONTINUATION = /^[)\]}]+\s*(?:[^\sA-Za-z_$]|$)/

export function computeScopeIndex(lines: readonly string[]): ScopeIndex {
  const count = lines.length
  const indents = new Int32Array(count + 2).fill(-1)
  for (let line = 1; line <= count; line += 1) indents[line] = indentOf(lines[line - 1] ?? '')

  type Raw = { start: number; header: number; indent: number; end: number }
  const raw: Raw[] = []
  const open: Raw[] = []
  let lastNonBlank = 0
  for (let line = 1; line <= count; line += 1) {
    const indent = indents[line]
    if (indent < 0) continue
    while (open.length > 0 && open[open.length - 1].indent >= indent) {
      open.pop()!.end = lastNonBlank
    }
    const next = nextNonBlank(indents, line, count)
    if (next > 0 && indents[next] > indent && opensScope(lines[line - 1] ?? '')) {
      const scope = { start: line, header: headerLine(lines, indents, line), indent, end: line }
      raw.push(scope)
      open.push(scope)
    }
    lastNonBlank = line
  }
  for (const scope of open) scope.end = lastNonBlank

  // `): Type {`, `}: {` and `] = [` continue a header that opened its own
  // small scope (a parameter list or destructured props); fold that sibling
  // into the body scope so the pinned line is the declaration, not the
  // closing bracket.
  const removed = new Set<Raw>()
  for (let index = 0; index < raw.length; index += 1) {
    const scope = raw[index]
    if (!HEADER_CONTINUATION.test((lines[scope.start - 1] ?? '').trim())) continue
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const sibling = raw[previous]
      if (removed.has(sibling)) continue
      if (sibling.indent < scope.indent || scope.start - sibling.start > MULTILINE_HEADER_LOOKBACK) break
      if (sibling.indent === scope.indent && sibling.end === scope.start - 1 && scope.start - sibling.header <= MULTILINE_HEADER_LOOKBACK) {
        scope.header = sibling.header
        removed.add(sibling)
        break
      }
      if (sibling.indent === scope.indent) break
    }
  }

  const kept = raw.filter((scope) => !removed.has(scope) && scope.end > scope.header)
  // Sort by header, outer scopes first so parents precede children.
  kept.sort((left, right) => left.header - right.header || right.end - left.end)

  const scopes: Scope[] = []
  const headers = new Map<number, string>()
  const innermost = new Int32Array(count + 1).fill(-1)
  const stack: number[] = []
  let cursor = 1
  const fillUntil = (line: number) => {
    while (cursor < line && cursor <= count) {
      while (stack.length > 0 && scopes[stack[stack.length - 1]].end < cursor) stack.pop()
      innermost[cursor] = stack.length > 0 ? stack[stack.length - 1] : -1
      cursor += 1
    }
  }
  for (const scope of kept) {
    // Two raw scopes can share a header (an Allman `{` and its declaration);
    // keep the first, which is the wider one after sorting.
    if (headers.has(scope.header)) continue
    fillUntil(scope.header)
    while (stack.length > 0 && scopes[stack[stack.length - 1]].end < scope.header) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1] : -1
    const end = parent >= 0 ? Math.min(scope.end, scopes[parent].end) : scope.end
    scopes.push({ start: scope.header, end, parent })
    headers.set(scope.header, (lines[scope.header - 1] ?? '').replace(/\s+$/, ''))
    stack.push(scopes.length - 1)
  }
  fillUntil(count + 1)
  return { scopes, headers, innermost }
}

/**
 * Scopes whose header is above `line` and whose body contains it, outermost
 * first. A scope's own header line is not enclosed by that scope.
 */
export function enclosingScopes(index: ScopeIndex, line: number): Scope[] {
  if (line < 1 || line >= index.innermost.length) return []
  const chain: Scope[] = []
  let current = index.innermost[line]
  while (current >= 0) {
    const scope = index.scopes[current]
    if (scope.start < line && scope.end >= line) chain.push(scope)
    current = scope.parent
  }
  return chain.reverse()
}

export type PinnedScope<Side extends string = string> = {
  side: Side
  scope: Scope
  text: string
}

/**
 * Pick the pinned stack the way sticky scroll does: probe the line just below
 * the rows pinned so far and pin one more ancestor while that line still sits
 * inside it. `probe(depth)` returns the enclosing chain of the line under row
 * `depth`, outermost first. In a unified diff consecutive lines may come from
 * different sides, so a scope also matches its counterpart with the same text.
 */
export function resolvePinnedScopes<Side extends string>(
  probe: (depth: number) => readonly PinnedScope<Side>[] | null,
  maxRows: number,
): PinnedScope<Side>[] {
  const pinned: PinnedScope<Side>[] = []
  while (pinned.length < maxRows) {
    const chain = probe(pinned.length)
    if (chain == null || chain.length <= pinned.length) break
    if (!pinned.every((row, depth) => samePinnedScope(row, chain[depth]))) break
    // Take every row from the latest chain so all pinned rows describe one
    // side (one line-number space).
    pinned.splice(0, pinned.length, ...chain.slice(0, pinned.length + 1))
  }
  return pinned
}

function samePinnedScope(left: PinnedScope, right: PinnedScope): boolean {
  if (left.side === right.side) return left.scope.start === right.scope.start
  return left.text === right.text
}

/**
 * Row tops relative to the pinned area: each row sits at `depth * rowHeight`
 * until its scope's last line scrolls up to it, then it is pushed up with the
 * code and slides under the rows above it (they are drawn on top). Outer
 * scopes end no earlier than inner ones, so an outer row never pushes past an
 * inner row. `endBottoms` are the scope end lines' bottoms relative to the
 * same origin (Infinity when below the rendered window).
 */
export function layoutPinnedRows(endBottoms: readonly number[], rowHeight: number): number[] {
  return endBottoms.map((endBottom, depth) => Math.min(depth * rowHeight, endBottom - rowHeight))
}

function indentOf(text: string): number {
  let width = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === ' ') width += 1
    else if (char === '\t') width += TAB_WIDTH - (width % TAB_WIDTH)
    else if (char === '\r' || char === '\n') return -1
    else return width
  }
  return -1
}

function nextNonBlank(indents: Int32Array, line: number, count: number): number {
  for (let next = line + 1; next <= count; next += 1) {
    if (indents[next] >= 0) return next
  }
  return 0
}

function opensScope(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('//')) return false
  if (trimmed.startsWith('<!--') || trimmed === '"""' || trimmed === "'''") return false
  if (/^#(\s|!|$)/.test(trimmed)) return false
  return true
}

/** Allman-style `{` on its own line pins the declaration above it. */
function headerLine(lines: readonly string[], indents: Int32Array, line: number): number {
  const trimmed = (lines[line - 1] ?? '').trim()
  if (!LONE_OPENERS.has(trimmed)) return line
  for (let previous = line - 1; previous >= 1; previous -= 1) {
    if (indents[previous] < 0) continue
    return indents[previous] === indents[line] ? previous : line
  }
  return line
}
