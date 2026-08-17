import { useQuery } from '@tanstack/react-query'
import type { FileDiffMetadata } from '@pierre/diffs'
import { Checkbox } from '@base-ui/react/checkbox'
import {
  Check as CheckIcon,
  ChevronDown as ChevronIcon,
  Copy as CopyIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { ThemedToken } from 'shiki'

import { ClientError, getDifftasticFile, getFileContents } from './api'
import {
  annotationsAtDifftasticRow,
  placeDifftasticAnnotations,
  visibleAnnotationsForFile,
} from './annotationComposer'
import { highlightFileLines, syntaxLanguageFor } from './syntaxHighlight'
import { formatTimestamp, relativeTimeAgo } from './time'
import type {
  DifftasticFileDiff,
  DifftasticHunkLine,
  DifftasticSpan,
  ReviewSession,
  SessionAnnotation,
} from '../shared/types'

export function DifftasticView({
  session,
  files,
  layout,
  resolvedTheme,
  collapsedFiles,
  viewedFiles,
  onToggleCollapsed,
  onSetViewed,
  onVisibleFileChange,
}: {
  session: ReviewSession
  files: FileDiffMetadata[]
  layout: 'unified' | 'split'
  resolvedTheme: 'light' | 'dark'
  collapsedFiles: Set<string>
  viewedFiles: Set<string>
  onToggleCollapsed(filePath: string): void
  onSetViewed(filePath: string, viewed: boolean): Promise<void>
  onVisibleFileChange?(filePath: string): void
}) {
  return (
    <div
      className="diff-view difftastic-view"
      onScroll={(event) => {
        const next = fileIdAtDifftasticScroll(event.currentTarget)
        if (next != null) onVisibleFileChange?.(next)
      }}
    >
      {files.map((file) => (
        <DifftasticFile
          key={file.name}
          sessionId={session.id}
          updatedAt={session.updatedAt}
          annotations={session.annotations}
          file={file}
          layout={layout}
          resolvedTheme={resolvedTheme}
          collapsed={collapsedFiles.has(file.name)}
          viewed={viewedFiles.has(file.name)}
          onToggleCollapsed={() => onToggleCollapsed(file.name)}
          onSetViewed={(viewed) => onSetViewed(file.name, viewed)}
        />
      ))}
    </div>
  )
}

function DifftasticFile({
  sessionId,
  updatedAt,
  annotations,
  file,
  layout,
  resolvedTheme,
  collapsed,
  viewed,
  onToggleCollapsed,
  onSetViewed,
}: {
  sessionId: string
  updatedAt: string
  annotations: SessionAnnotation[]
  file: FileDiffMetadata
  layout: 'unified' | 'split'
  resolvedTheme: 'light' | 'dark'
  collapsed: boolean
  viewed: boolean
  onToggleCollapsed(): void
  onSetViewed(viewed: boolean): Promise<void>
}) {
  const articleRef = useRef<HTMLElement>(null)
  const nearViewport = useNearViewport(articleRef, !collapsed)
  const query = useQuery({
    queryKey: ['difftastic', sessionId, updatedAt, file.name],
    queryFn: () => getDifftasticFile(sessionId, file.name),
    enabled: !collapsed && nearViewport,
  })

  return (
    <article
      ref={articleRef}
      className="difftastic-file"
      data-file-id={file.name}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <header className="difftastic-file-header" data-diffs-header="default">
        <div className="difftastic-file-title">
          <span className="difftastic-file-name">{file.name}</span>
          {file.prevName != null && file.prevName !== file.name && (
            <span className="difftastic-file-prev">{file.prevName}</span>
          )}
          {query.data != null && (
            <span className="difftastic-file-language">{query.data.language}</span>
          )}
        </div>
        <div
          className="file-header-controls"
          data-file-id={file.name}
          onClick={(event) => event.stopPropagation()}
        >
          <CopyFileButton filePath={file.name} />
          <button
            className="file-collapse-button"
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${file.name}`}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          >
            <ChevronIcon />
          </button>
          <ViewedToggle viewed={viewed} onChange={onSetViewed} />
        </div>
      </header>
      {!collapsed && (
        <DifftasticFileBody
          sessionId={sessionId}
          updatedAt={updatedAt}
          layout={layout}
          resolvedTheme={resolvedTheme}
          filePath={file.name}
          oldFilePath={file.prevName ?? file.name}
          annotations={visibleAnnotationsForFile(annotations, file.name, file.prevName)}
          file={query.data}
          loading={nearViewport && query.isPending}
          error={query.error}
          waiting={!nearViewport}
        />
      )}
    </article>
  )
}

function DifftasticFileBody({
  sessionId,
  updatedAt,
  layout,
  resolvedTheme,
  filePath,
  oldFilePath,
  annotations,
  file,
  loading,
  error,
  waiting,
}: {
  sessionId: string
  updatedAt: string
  layout: 'unified' | 'split'
  resolvedTheme: 'light' | 'dark'
  filePath: string
  oldFilePath: string
  annotations: SessionAnnotation[]
  file: DifftasticFileDiff | undefined
  loading: boolean
  error: unknown
  waiting: boolean
}) {
  const language = syntaxLanguageFor(filePath, file?.language)
  const highlightReady = !waiting && file != null && file.language !== 'Binary'
  const oldTokens = useSnapshotTokens(
    sessionId,
    updatedAt,
    oldFilePath,
    'old',
    language,
    resolvedTheme,
    highlightReady,
  )
  const newTokens = useSnapshotTokens(
    sessionId,
    updatedAt,
    filePath,
    'new',
    language,
    resolvedTheme,
    highlightReady,
  )
  const placed = useMemo(
    () => placeDifftasticAnnotations(annotations, file?.hunks ?? []),
    [annotations, file],
  )

  if (waiting) return <div className="difftastic-status">Waiting to render…</div>
  if (loading) return <div className="difftastic-status">Rendering structural diff…</div>
  if (error != null) {
    return (
      <div className="difftastic-status is-error">
        {error instanceof ClientError ? error.message : 'Could not render this file with difftastic.'}
      </div>
    )
  }
  if (file?.language === 'Binary') return <div className="difftastic-status">Binary file.</div>
  if (file == null || file.hunks.length === 0) {
    return <div className="difftastic-status">No syntactic changes.</div>
  }

  return (
    <div className={`difftastic-hunks difftastic-${layout}`}>
      {file.hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="difftastic-hunk">
          {hunk.lines.map((line, lineIndex) => (
            <DifftasticLine
              key={lineIndex}
              line={line}
              layout={layout}
              oldNotes={annotationsAtDifftasticRow(placed, hunkIndex, lineIndex, 'old')}
              newNotes={annotationsAtDifftasticRow(placed, hunkIndex, lineIndex, 'new')}
              oldTokens={line.oldLine == null ? null : oldTokens?.[line.oldLine - 1] ?? null}
              newTokens={line.newLine == null ? null : newTokens?.[line.newLine - 1] ?? null}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function DifftasticLine({
  line,
  layout,
  oldNotes,
  newNotes,
  oldTokens,
  newTokens,
}: {
  line: DifftasticHunkLine
  layout: 'unified' | 'split'
  oldNotes: SessionAnnotation[]
  newNotes: SessionAnnotation[]
  oldTokens: ThemedToken[] | null
  newTokens: ThemedToken[] | null
} ) {

  if (layout === 'split') {
    return (
      <div className={`difftastic-row is-${line.kind}`}>
        <LineSide
          side="old"
          lineNumber={line.oldLine}
          text={line.oldText}
          spans={line.oldSpans}
          tokens={oldTokens}
          kind={line.kind === 'insert' ? 'empty' : line.kind}
          annotations={oldNotes}
        />
        <LineSide
          side="new"
          lineNumber={line.newLine}
          text={line.newText}
          spans={line.newSpans}
          tokens={newTokens}
          kind={line.kind === 'delete' ? 'empty' : line.kind}
          annotations={newNotes}
        />
      </div>
    )
  }

  if (line.kind === 'change') {
    return (
      <>
        <UnifiedLine
          kind="delete"
          lineNumber={line.oldLine}
          text={line.oldText ?? ''}
          spans={line.oldSpans}
          tokens={oldTokens}
          annotations={oldNotes}
        />
        <UnifiedLine
          kind="insert"
          lineNumber={line.newLine}
          text={line.newText ?? ''}
          spans={line.newSpans}
          tokens={newTokens}
          annotations={newNotes}
        />
      </>
    )
  }

  return (
    <UnifiedLine
      kind={line.kind}
      lineNumber={line.newLine ?? line.oldLine}
      text={line.newText ?? line.oldText ?? ''}
      spans={line.newText != null ? line.newSpans : line.oldSpans}
      tokens={line.newText != null ? newTokens : oldTokens}
      annotations={uniqueAnnotations(oldNotes, newNotes)}
    />
  )
}

function UnifiedLine({
  kind,
  lineNumber,
  text,
  spans,
  tokens,
  annotations,
}: {
  kind: DifftasticHunkLine['kind']
  lineNumber: number | null
  text: string
  spans: DifftasticSpan[]
  tokens: ThemedToken[] | null
  annotations: SessionAnnotation[]
}) {
  return (
    <div className={`difftastic-row is-${kind}`}>
      <span className={`difftastic-gutter is-${kind}`}>{formatLineNumber(lineNumber)}</span>
      <div className="difftastic-line-body">
        <code className="difftastic-code">
          <HighlightedText text={text} spans={spans} tokens={tokens} />
        </code>
        <ReadOnlyAnnotations annotations={annotations} />
      </div>
    </div>
  )
}

function LineSide({
  side,
  lineNumber,
  text,
  spans,
  tokens,
  kind,
  annotations,
}: {
  side: 'old' | 'new'
  lineNumber: number | null
  text: string | null
  spans: DifftasticSpan[]
  tokens: ThemedToken[] | null
  kind: DifftasticHunkLine['kind'] | 'empty'
  annotations: SessionAnnotation[]
} ) {
  return (
    <div className={`difftastic-side is-${side} is-${kind}`}>
      <span className={`difftastic-gutter is-${kind}`}>{formatLineNumber(lineNumber)}</span>
      <div className="difftastic-line-body">
        <code className="difftastic-code">
          {text == null ? null : <HighlightedText text={text} spans={spans} tokens={tokens} />}
        </code>
        <ReadOnlyAnnotations annotations={annotations} />
      </div>
    </div>
  )
}

function ReadOnlyAnnotations({ annotations }: { annotations: SessionAnnotation[] }) {
  if (annotations.length === 0) return null
  return (
    <div className="difftastic-annotations">
      {annotations.map((annotation) => (
        <div key={annotation.id} className={`inline-annotation ${annotation.source}`}>
          <div className="inline-source">
            <div>
              <span>{annotationSourceLabel(annotation)}</span>
              <time className="note-time" title={formatTimestamp(annotation.createdAt)}>
                {relativeTimeAgo(annotation.createdAt)}
              </time>
              <code>{lineLabel(annotation)}</code>
            </div>
          </div>
          <p>{annotation.comment}</p>
        </div>
      ))}
    </div>
  )
}

function annotationSourceLabel(annotation: SessionAnnotation): string {
  if (annotation.source === 'agent') return 'Agent note'
  if (annotation.submittedAt != null) return 'Submitted review comment'
  if (annotation.intent === 'review-comment') return 'Pending review comment'
  return 'Annotation'
}

function lineLabel(annotation: SessionAnnotation): string {
  const prefix = annotation.side === 'new' ? '+' : '−'
  if (annotation.endSide != null && annotation.endSide !== annotation.side) {
    const endPrefix = annotation.endSide === 'new' ? '+' : '−'
    return `${prefix}${annotation.startLine} → ${endPrefix}${annotation.endLine}`
  }
  return `${prefix}${annotation.startLine}${annotation.startLine === annotation.endLine ? '' : `–${annotation.endLine}`}`
}

function uniqueAnnotations(
  ...groups: SessionAnnotation[][]
): SessionAnnotation[] {
  const seen = new Set<string>()
  const result: SessionAnnotation[] = []
  for (const group of groups) {
    for (const annotation of group) {
      if (seen.has(annotation.id)) continue
      seen.add(annotation.id)
      result.push(annotation)
    }
  }
  return result
}

function HighlightedText({
  text,
  spans,
  tokens,
}: {
  text: string
  spans: DifftasticSpan[]
  tokens: ThemedToken[] | null
} ) {
  const changed = changedRanges(spans)
  if (tokens == null || tokens.length === 0) {
    return wrapChangedRanges(text, 0, changed)
  }

  const lineStart = tokens[0]?.offset ?? 0
  const pieces: ReactNode[] = []
  let cursor = 0
  tokens.forEach((token, index) => {
    const localOffset = Math.max(0, token.offset - lineStart)
    if (localOffset > cursor) {
      pieces.push(...wrapChangedRanges(text.slice(cursor, localOffset), cursor, changed, `gap-${index}`))
    }
    const end = Math.min(text.length, localOffset + token.content.length)
    if (end > localOffset) {
      pieces.push(
        <span key={`tok-${index}`} className="dft-token" style={tokenStyle(token)}>
          {wrapChangedRanges(text.slice(localOffset, end), localOffset, changed, `tok-${index}`)}
        </span>,
      )
    }
    cursor = Math.max(cursor, end)
  })
  if (cursor < text.length) {
    pieces.push(...wrapChangedRanges(text.slice(cursor), cursor, changed, 'tail'))
  }
  return pieces
}

function wrapChangedRanges(
  text: string,
  start: number,
  ranges: Array<{ start: number; end: number }>,
  keyPrefix = 'plain',
): ReactNode[] {
  if (text === '') return []
  const end = start + text.length
  const pieces: ReactNode[] = []
  let cursor = start
  for (const range of ranges) {
    const from = Math.max(cursor, range.start)
    const to = Math.min(end, range.end)
    if (to <= from) continue
    if (from > cursor) pieces.push(text.slice(cursor - start, from - start))
    pieces.push(
      <span key={`${keyPrefix}-${from}`} className="dft-change">
        {text.slice(from - start, to - start)}
      </span>,
    )
    cursor = to
  }
  if (cursor < end) pieces.push(text.slice(cursor - start))
  return pieces
}

function changedRanges(spans: DifftasticSpan[]): Array<{ start: number; end: number }> {
  return spans
    .filter((span) => span.end > span.start)
    .map((span) => ({ start: span.start, end: span.end }))
    .sort((left, right) => left.start - right.start)
}

function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const color = token.htmlStyle?.color ?? token.color
  if (color == null) return undefined
  return { color }
}

function useSnapshotTokens(
  sessionId: string,
  updatedAt: string,
  filePath: string,
  side: 'old' | 'new',
  language: string,
  theme: 'light' | 'dark',
  enabled: boolean,
): ThemedToken[][] | null {
  const query = useQuery({
    queryKey: ['difftastic-source', sessionId, updatedAt, filePath, side],
    queryFn: () => getFileContents(sessionId, filePath, side),
    enabled: enabled && language !== 'text' && language !== 'binary',
  })
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null)

  useEffect(() => {
    let cancelled = false
    const source = query.data
    if (source == null) {
      setTokens(null)
      return
    }
    void highlightFileLines(source, language, theme).then((next) => {
      if (!cancelled) setTokens(next)
    })
    return () => {
      cancelled = true
    }
  }, [language, query.data, theme])

  return tokens
}

function CopyFileButton({ filePath }: { filePath: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="file-copy-button"
      type="button"
      aria-label={copied ? `Copied ${filePath}` : `Copy ${filePath}`}
      title={copied ? 'Copied' : 'Copy file name'}
      onClick={async (event) => {
        event.stopPropagation()
        await navigator.clipboard.writeText(filePath)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

function ViewedToggle({
  viewed,
  onChange,
}: {
  viewed: boolean
  onChange(viewed: boolean): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Checkbox.Root
      className="file-viewed-toggle"
      checked={viewed}
      disabled={busy}
      onCheckedChange={async (checked) => {
        setBusy(true)
        try {
          await onChange(checked === true)
        } finally {
          setBusy(false)
        }
      }}
    >
      <span className="file-viewed-checkbox">
        <Checkbox.Indicator>
          <CheckIcon />
        </Checkbox.Indicator>
      </span>
      <span>Viewed</span>
    </Checkbox.Root>
  )
}

function useNearViewport(target: { current: HTMLElement | null }, enabled: boolean): boolean {
  const [near, setNear] = useState(false)

  useEffect(() => {
    if (!enabled) {
      setNear(false)
      return
    }
    const node = target.current
    if (node == null) return
    const root = node.closest('.diff-view')
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      {
        root: root instanceof Element ? root : null,
        rootMargin: '800px 0px',
        threshold: 0,
      },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [enabled, target])

  return near
}

function fileIdAtDifftasticScroll(scroller: HTMLElement): string | null {
  const marker = scroller.scrollTop + 24
  let current: string | null = null
  for (const node of scroller.querySelectorAll<HTMLElement>('[data-file-id]')) {
    if (node.offsetTop > marker) break
    current = node.dataset.fileId ?? current
  }
  return current
}

function formatLineNumber(line: number | null): string {
  return line == null ? '' : String(line)
}
