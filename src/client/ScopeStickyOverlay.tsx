import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  getFiletypeFromFileName,
  getHighlighterIfLoaded,
  getSharedHighlighter,
  type FileDiffMetadata,
  type SupportedLanguages,
  type ThemedToken,
} from '@pierre/diffs'

import { loadReviewFilePair } from './fileContents'
import {
  computeScopeIndex,
  enclosingScopes,
  layoutPinnedRows,
  resolvePinnedScopes,
  type PinnedScope,
  type ScopeIndex,
} from './stickyScopes'

type Side = 'old' | 'new'
type FileScopes = { old: ScopeIndex | null; new: ScopeIndex | null }

const MAX_ROWS = 5
const ROW_HEIGHT = 16
const THEMES = { dark: 'pierre-dark', light: 'pierre-light' } as const
const SCOPE_CACHE_LIMIT = 64
const TOKEN_CACHE_LIMIT = 2000

const scopeCache = new Map<string, Promise<FileScopes>>()
const tokenCache = new Map<string, ThemedToken[]>()

type PinnedRow = {
  key: string
  side: Side
  line: number
  text: string
  top: number
}

type PinnedColumn = {
  key: string
  left: number
  width: number
  gutterWidth: number
  contentLeft: number
  scrollLeft: number
  rows: PinnedRow[]
}

type PinnedLayout = {
  fileId: string
  language: SupportedLanguages
  top: number
  height: number
  columns: PinnedColumn[]
}

/**
 * Sticky scope lines: while scrolling a diff, the declarations enclosing the
 * top visible line (function, class, block, object key) stay pinned under the
 * file header, stacked outermost first, and are pushed up as their scope ends.
 * Reads only the rows Pierre already rendered and runs at most once a frame.
 */
export function ScopeStickyOverlay({
  scroller,
  files,
  sessionId,
  contentKey,
  onNavigate,
}: {
  scroller: HTMLElement | null
  files: readonly FileDiffMetadata[]
  sessionId: string
  contentKey: string
  onNavigate(fileId: string, side: Side, line: number, depth: number): void
}) {
  const [layout, setLayout] = useState<PinnedLayout | null>(null)
  const [, setTokenVersion] = useState(0)
  const scopes = useRef(new Map<string, FileScopes>())
  const scheduleSync = useRef<() => void>(() => {})
  const layerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (scroller == null) return
    const byName = new Map(files.map((file) => [file.name, file]))
    const listenedRoots = new Set<ShadowRoot>()
    let frame = 0
    let signature = ''

    const requestScopes = (file: FileDiffMetadata) => {
      const key = scopeKey(sessionId, contentKey, file)
      if (scopes.current.has(key)) return scopes.current.get(key)
      void loadFileScopes(key, sessionId, contentKey, file).then((loaded) => {
        scopes.current.set(key, loaded)
        schedule()
      }, () => {
        scopes.current.set(key, { old: null, new: null })
      })
      return undefined
    }

    const sync = () => {
      const host = layerRef.current?.parentElement
      const next = host == null ? null : measure(scroller, host, byName, requestScopes, listenRoot)
      const nextSignature = next == null ? '' : layoutSignature(next)
      if (nextSignature === signature) return
      signature = nextSignature
      setLayout(next)
    }
    const schedule = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }
    // Horizontal scrolling happens inside each file's shadow root and does
    // not reach the outer scroller.
    const listenRoot = (root: ShadowRoot) => {
      if (listenedRoots.has(root)) return
      listenedRoots.add(root)
      root.addEventListener('scroll', schedule, { capture: true, passive: true })
    }
    scheduleSync.current = schedule
    sync()
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(scroller)
    // Pierre renders asynchronously (highlighting, hydration, expansion).
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule)
    mutations?.observe(scroller, { childList: true, subtree: true })
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      mutations?.disconnect()
      for (const root of listenedRoots) root.removeEventListener('scroll', schedule, { capture: true })
      scheduleSync.current = () => {}
    }
  }, [contentKey, files, scroller, sessionId])

  // Highlight pinned lines with Pierre's shared highlighter and themes.
  useEffect(() => {
    if (layout == null) return
    const pending = layout.columns.flatMap((column) => column.rows)
      .filter((row) => !tokenCache.has(tokenKey(layout.language, row.text)))
    if (pending.length === 0) return
    let cancelled = false
    void highlighterFor(layout.language).then((highlighter) => {
      if (cancelled || highlighter == null) return
      for (const row of pending) highlightLine(highlighter, layout.language, row.text)
      setTokenVersion((version) => version + 1)
    })
    return () => {
      cancelled = true
    }
  }, [layout])

  if (layout == null) return <div ref={layerRef} className="scope-sticky-layer" aria-hidden />

  return (
    <div ref={layerRef} className="scope-sticky-layer" aria-hidden>
      <div
        className="scope-sticky-stack"
        style={{ top: layout.top, height: layout.height }}
        onWheel={(event) => {
          const scale = event.deltaMode === 1 ? ROW_HEIGHT : event.deltaMode === 2 ? scroller?.clientHeight ?? 1 : 1
          scroller?.scrollBy({ top: event.deltaY * scale, left: event.deltaX * scale })
        }}
      >
        {layout.columns.map((column) => (
          <div
            key={column.key}
            className="scope-sticky-column"
            style={{ left: column.left, width: column.width }}
          >
            {column.rows.map((row, depth) => (
              <button
                key={row.key}
                type="button"
                tabIndex={-1}
                className="scope-sticky-row"
                data-side={row.side}
                style={{ top: row.top, zIndex: MAX_ROWS - depth }}
                title={`Go to line ${row.line}`}
                onClick={() => onNavigate(layout.fileId, row.side, row.line, depth)}
              >
                <span className="scope-sticky-gutter" style={{ width: column.gutterWidth }}>
                  {row.line}
                </span>
                <span
                  className="scope-sticky-code"
                  style={{ left: column.contentLeft, transform: `translateX(${-column.scrollLeft}px)` }}
                >
                  {renderTokens(layout.language, row.text)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

type LineRow = { element: HTMLElement; old: number | null; new: number | null; side: Side }

function measure(
  scroller: HTMLElement,
  host: HTMLElement,
  files: ReadonlyMap<string, FileDiffMetadata>,
  requestScopes: (file: FileDiffMetadata) => FileScopes | undefined,
  listenRoot: (root: ShadowRoot) => void,
): PinnedLayout | null {
  const scrollerRect = scroller.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  for (const node of scroller.querySelectorAll<HTMLElement>('diffs-container')) {
    const rect = node.getBoundingClientRect()
    if (rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) continue
    // Only the file crossing the top edge pins scopes.
    if (rect.top > scrollerRect.top + 1) continue
    const root = node.shadowRoot
    if (root == null) continue
    const header = root.querySelector<HTMLElement>('[data-diffs-header]')
    const headerBottom = header?.getBoundingClientRect().bottom ?? scrollerRect.top
    const fileId = fileIdOf(node)
    const file = fileId == null ? undefined : files.get(fileId)
    if (fileId == null || file == null) return null
    const scopes = requestScopes(file)
    if (scopes == null) return null
    listenRoot(root)
    const columns: PinnedColumn[] = []
    const areaTop = Math.max(scrollerRect.top, Math.min(headerBottom, rect.bottom))
    const areaBottom = Math.min(rect.bottom, scrollerRect.bottom)
    for (const code of root.querySelectorAll<HTMLElement>('[data-code]')) {
      const column = measureColumn(code, scopes, areaTop, areaBottom, scrollerRect, hostRect)
      if (column != null) columns.push(column)
    }
    const height = Math.min(
      Math.max(0, ...columns.map((column) => Math.max(0, ...column.rows.map((row) => row.top + ROW_HEIGHT)))),
      Math.max(0, areaBottom - areaTop),
    )
    if (height <= 0) return null
    return {
      fileId,
      language: getFiletypeFromFileName(file.name),
      top: areaTop - hostRect.top,
      height,
      columns: columns.filter((column) => column.rows.length > 0),
    }
  }
  return null
}

function measureColumn(
  code: HTMLElement,
  scopes: FileScopes,
  areaTop: number,
  areaBottom: number,
  scrollerRect: DOMRect,
  hostRect: DOMRect,
): PinnedColumn | null {
  const content = code.querySelector<HTMLElement>(':scope > [data-content]')
  const gutter = code.querySelector<HTMLElement>(':scope > [data-gutter]')
  if (content == null || gutter == null) return null
  const kind = code.closest('[data-deletions]') != null
    ? 'old'
    : code.closest('[data-additions]') != null ? 'new' : 'unified'
  const rows = lineRows(content, kind)
  if (rows.length === 0) return null

  const probe = (depth: number): PinnedScope<Side>[] | null => {
    const y = areaTop + depth * ROW_HEIGHT
    if (y >= areaBottom) return null
    const row = rowAt(rows, y)
    if (row == null) return null
    const line = row[row.side]
    const index = scopes[row.side]
    if (line == null || index == null) return []
    return enclosingScopes(index, line).map((scope) => ({
      side: row.side,
      scope,
      text: index.headers.get(scope.start) ?? '',
    }))
  }
  const pinned = resolvePinnedScopes(probe, MAX_ROWS)
  // Split wrap mode lays `[data-code]` out with `display: contents`, so use
  // its gutter and content boxes for the column extent.
  const gutterRect = gutter.getBoundingClientRect()
  const contentRect = content.getBoundingClientRect()
  const codeRect = code.getBoundingClientRect()
  const columnRight = codeRect.width > 0 ? codeRect.right : contentRect.right
  const left = Math.max(gutterRect.left, scrollerRect.left)
  const right = Math.min(columnRight, scrollerRect.right)
  const endBottoms = pinned.map((row) => scopeEndBottom(rows, row.side, row.scope.end) - areaTop)
  const tops = layoutPinnedRows(endBottoms, ROW_HEIGHT)
  return {
    key: kind,
    left: left - hostRect.left,
    width: Math.max(0, right - left),
    gutterWidth: Math.max(0, gutterRect.right - left),
    contentLeft: Math.max(0, contentRect.left + code.scrollLeft - left),
    scrollLeft: code.scrollLeft,
    rows: pinned
      .map((row, depth) => ({
        key: `${row.side}:${row.scope.start}`,
        side: row.side,
        line: row.scope.start,
        text: row.text,
        top: Math.round(tops[depth]),
      }))
      .filter((row) => row.top + ROW_HEIGHT > 0),
  }
}

function lineRows(content: HTMLElement, kind: Side | 'unified'): LineRow[] {
  const rows: LineRow[] = []
  for (const element of content.querySelectorAll<HTMLElement>(':scope > [data-line]')) {
    const line = Number(element.dataset.line)
    if (!Number.isFinite(line)) continue
    const type = element.dataset.lineType
    if (kind !== 'unified') {
      rows.push({ element, old: kind === 'old' ? line : null, new: kind === 'new' ? line : null, side: kind })
      continue
    }
    if (type === 'change-deletion') rows.push({ element, old: line, new: null, side: 'old' })
    else if (type === 'change-addition') rows.push({ element, old: null, new: line, side: 'new' })
    else {
      const alt = Number(element.dataset.altLine)
      rows.push({ element, old: Number.isFinite(alt) ? alt : null, new: line, side: 'new' })
    }
  }
  return rows
}

/** First rendered line whose bottom is below `y` (rows are in visual order). */
function rowAt(rows: readonly LineRow[], y: number): LineRow | null {
  let low = 0
  let high = rows.length - 1
  let found: LineRow | null = null
  while (low <= high) {
    const middle = (low + high) >> 1
    if (rows[middle].element.getBoundingClientRect().bottom > y) {
      found = rows[middle]
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return found
}

/**
 * Bottom of a scope's last line, or the top of the next rendered line on that
 * side when the end is folded into a collapsed gap. Infinity when it is below
 * the rendered window.
 */
function scopeEndBottom(rows: readonly LineRow[], side: Side, end: number): number {
  for (const row of rows) {
    const line = row[side]
    if (line == null) continue
    if (line === end) return row.element.getBoundingClientRect().bottom
    if (line > end) return row.element.getBoundingClientRect().top
  }
  return Number.POSITIVE_INFINITY
}

function fileIdOf(node: HTMLElement): string | null {
  return node.querySelector('[data-file-id]')?.getAttribute('data-file-id')
    ?? node.closest('[data-file-id]')?.getAttribute('data-file-id')
    ?? null
}

function layoutSignature(layout: PinnedLayout): string {
  return JSON.stringify(layout)
}

function scopeKey(sessionId: string, contentKey: string, file: FileDiffMetadata): string {
  return JSON.stringify([sessionId, contentKey, file.prevName ?? file.name, file.name, file.type])
}

function loadFileScopes(
  key: string,
  sessionId: string,
  contentKey: string,
  file: FileDiffMetadata,
): Promise<FileScopes> {
  const cached = scopeCache.get(key)
  if (cached != null) return cached
  const oldPath = file.type === 'new' ? null : file.prevName ?? file.name
  const newPath = file.type === 'deleted' ? null : file.name
  const pending = loadReviewFilePair(sessionId, contentKey, oldPath, newPath).then((pair) => ({
    old: pair.old == null ? null : computeScopeIndex(splitLines(pair.old)),
    new: pair.new == null ? null : computeScopeIndex(splitLines(pair.new)),
  }))
  scopeCache.set(key, pending)
  pending.catch(() => {
    if (scopeCache.get(key) === pending) scopeCache.delete(key)
  })
  trimCache(scopeCache, SCOPE_CACHE_LIMIT)
  return pending
}

function splitLines(source: string): string[] {
  const lines = source.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

type Highlighter = Awaited<ReturnType<typeof getSharedHighlighter>>

async function highlighterFor(language: SupportedLanguages): Promise<Highlighter | null> {
  if (language === 'text') return null
  const loaded = getHighlighterIfLoaded({ theme: THEMES, lang: language })
  if (loaded != null) return loaded
  try {
    return await getSharedHighlighter({ themes: [THEMES.dark, THEMES.light], langs: [language] })
  } catch {
    return null
  }
}

function highlightLine(highlighter: Highlighter, language: SupportedLanguages, text: string): void {
  const key = tokenKey(language, text)
  if (tokenCache.has(key)) return
  try {
    const result = highlighter.codeToTokens(text, {
      lang: language,
      themes: THEMES,
      defaultColor: false,
      cssVariablePrefix: '--diffs-token-',
      tokenizeMaxLineLength: 1000,
      tokenizeTimeLimit: 0,
    })
    tokenCache.set(key, result.tokens[0] ?? [])
  } catch {
    tokenCache.set(key, [])
  }
  trimCache(tokenCache, TOKEN_CACHE_LIMIT)
}

function renderTokens(language: SupportedLanguages, text: string) {
  const tokens = tokenCache.get(tokenKey(language, text))
  if (tokens == null || tokens.length === 0) return text
  return tokens.map((token, index) => (
    <span key={index} style={tokenCSS(token)}>{token.content}</span>
  ))
}

function tokenCSS(token: ThemedToken): CSSProperties | undefined {
  if (token.htmlStyle != null) return token.htmlStyle as CSSProperties
  return token.color == null ? undefined : { color: token.color }
}

function tokenKey(language: string, text: string): string {
  return `${language}\u0000${text}`
}

function trimCache<Value>(cache: Map<string, Value>, limit: number): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest == null) break
    cache.delete(oldest)
  }
}
