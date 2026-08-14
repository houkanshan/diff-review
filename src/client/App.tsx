import {
  CodeView,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
} from '@pierre/diffs/react'
import {
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  parsePatchFiles,
} from '@pierre/diffs'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  RepositoryInfo,
  ReviewSession,
  ReviewTarget,
  SessionAnnotation,
} from '../shared/types'
import {
  addAnnotation,
  createSession,
  deleteAnnotation,
  getFileContents,
  getRepositoryInfo,
  getSession,
  getSessions,
  refreshSession,
  selectCommits,
} from './api'
import { applyImportance } from './importance'
import {
  BranchIcon,
  ChevronIcon,
  CloseIcon,
  CommentIcon,
  CopyIcon,
  FileIcon,
  RefreshIcon,
} from './icons'

type DiffLayout = 'unified' | 'split'

export default function App() {
  const [sessionId, setSessionId] = useState<string | null>(() => sessionIdFromPath())
  const [session, setSession] = useState<ReviewSession | null>(null)
  const [loading, setLoading] = useState(sessionId != null)
  const [error, setError] = useState<string | null>(null)

  const loadSession = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      setSession(await getSession(id))
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (sessionId == null) return
    void loadSession(sessionId)
    const events = new EventSource(`/api/events?session=${encodeURIComponent(sessionId)}`)
    events.onmessage = () => void loadSession(sessionId, true)
    return () => events.close()
  }, [loadSession, sessionId])

  useEffect(() => {
    const onPopState = () => setSessionId(sessionIdFromPath())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const openSession = useCallback((id: string) => {
    window.history.pushState(null, '', `/s/${id}`)
    setSessionId(id)
  }, [])

  if (sessionId == null) return <Welcome onOpenSession={openSession} />
  if (loading && session == null) return <LoadingScreen />
  if (error != null && session == null) {
    return <ErrorScreen message={error} onBack={() => openHome(setSessionId)} />
  }
  if (session == null) return null

  return (
    <ReviewWorkspace
      session={session}
      error={error}
      onSessionChange={setSession}
      onOpenSession={openSession}
      onReload={() => loadSession(session.id, true)}
    />
  )
}

function ReviewWorkspace({
  session,
  error,
  onSessionChange,
  onOpenSession,
  onReload,
}: {
  session: ReviewSession
  error: string | null
  onSessionChange(session: ReviewSession): void
  onOpenSession(id: string): void
  onReload(): Promise<void>
}) {
  const viewerRef = useRef<CodeViewHandle<SessionAnnotation>>(null)
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setSelection(null)
  }, [session.patch])

  const parsedFiles = useMemo(() => {
    if (!session.patch.trim()) return []
    try {
      return parsePatchFiles(session.patch, `${session.id}-${session.updatedAt}`, true).flatMap(
        (patch) => patch.files,
      )
    } catch (caught) {
      console.error('Could not parse diff', caught)
      return []
    }
  }, [session.id, session.patch, session.updatedAt])

  const items = useMemo<CodeViewItem<SessionAnnotation>[]>(() => {
    const version = Date.parse(session.updatedAt) + session.annotations.length
    return parsedFiles.map((fileDiff) => {
      fileDiff.cacheKey = `${session.id}:${session.updatedAt}:${fileDiff.name}`
      return {
        id: fileDiff.name,
        type: 'diff',
        fileDiff,
        version,
        annotations: annotationsForFile(session.annotations, fileDiff),
      }
    })
  }, [parsedFiles, session.annotations, session.id, session.updatedAt])

  const diffOptions = useMemo<CodeViewReactOptions<SessionAnnotation>>(
    () => ({
      theme: 'pierre-dark',
      themeType: 'dark',
      diffStyle: layout,
      diffIndicators: 'bars',
      overflow: 'scroll',
      enableLineSelection: true,
      lineHoverHighlight: 'both',
      hunkSeparators: 'line-info-basic',
      stickyHeaders: true,
      collapsedContextThreshold: 10,
      expansionLineCount: 20,
      lineDiffType: 'word-alt',
      async loadDiffFiles(fileDiff) {
        const oldPath = fileDiff.prevName ?? fileDiff.name
        const newPath = fileDiff.name
        if (fileDiff.type === 'rename-pure') {
          const contents = await getFileContents(session.id, newPath, 'new')
          if (contents == null) throw new Error(`Could not load ${newPath}`)
          return {
            oldFile: null,
            newFile: {
              name: newPath,
              contents,
              cacheKey: `${session.id}:${session.updatedAt}:new:${newPath}`,
            },
          }
        }
        const [oldContents, newContents] = await Promise.all([
          getFileContents(session.id, oldPath, 'old'),
          getFileContents(session.id, newPath, 'new'),
        ])
        if (oldContents == null || newContents == null) {
          throw new Error(`Could not load both versions of ${newPath}`)
        }
        return {
          oldFile: {
            name: oldPath,
            contents: oldContents,
            cacheKey: `${session.id}:${session.updatedAt}:old:${oldPath}`,
          },
          newFile: {
            name: newPath,
            contents: newContents,
            cacheKey: `${session.id}:${session.updatedAt}:new:${newPath}`,
          },
        }
      },
      onPostRender(node, _instance, phase, context) {
        applyImportance(node, phase, context, session.annotations)
      },
    }),
    [layout, session.annotations, session.id, session.updatedAt],
  )

  const handleSelection = useCallback((next: CodeViewLineSelection | null) => {
    if (
      next != null &&
      next.range.endSide != null &&
      next.range.side !== next.range.endSide
    ) {
      setSelection(null)
      setSelectionError('Choose lines from one side of the diff')
      return
    }
    setSelectionError(null)
    setSelection(next)
  }, [])

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      onSessionChange(await refreshSession(session.id))
    } finally {
      setBusy(false)
    }
  }, [onSessionChange, session.id])

  const copyForAgent = useCallback(async () => {
    const text = [
      `Session: ${session.id}`,
      `Repository: ${session.repositoryRoot}`,
      `Review with: ${session.gitCommand}`,
      '',
      `Add notes with: diff-review annotate ${session.id} --file <path> --new-line <line[-end]> --comment <text> --importance <0..1>`,
    ].join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }, [session])

  const selectFile = useCallback((id: string) => {
    viewerRef.current?.scrollTo({ type: 'item', id, align: 'start', offset: 8 })
  }, [])

  return (
    <main className="review-shell">
      <header className="topbar">
        <div className="brand" onClick={() => openHome()} role="button" tabIndex={0}>
          <span className="brand-mark">Δ</span>
          <span>Diff Review</span>
        </div>
        <TargetPicker session={session} onOpenSession={onOpenSession} />
        <div className="topbar-spacer" />
        <div className="layout-switch" aria-label="Diff layout">
          <button className={layout === 'unified' ? 'active' : ''} onClick={() => setLayout('unified')}>
            Stack
          </button>
          <button className={layout === 'split' ? 'active' : ''} onClick={() => setLayout('split')}>
            Split
          </button>
        </div>
        <button className="icon-button" onClick={refresh} aria-label="Refresh diff" disabled={busy}>
          <RefreshIcon className={busy ? 'spinning' : ''} />
        </button>
        <button className="agent-button" onClick={copyForAgent}>
          <CopyIcon />
          {copied ? 'Copied' : 'Copy for agent'}
        </button>
      </header>

      <CommitTimeline session={session} onSessionChange={onSessionChange} />

      <div className="workspace">
        <FileRail files={parsedFiles} annotations={session.annotations} onSelect={selectFile} />
        <section className="diff-stage">
          {error != null && <div className="error-banner">{error}</div>}
          {selectionError != null && <div className="selection-warning">{selectionError}</div>}
          {items.length === 0 ? (
            <EmptyDiff onRefresh={refresh} />
          ) : (
            <CodeView<SessionAnnotation>
              ref={viewerRef}
              key={`${session.id}:${layout}`}
              className="diff-view"
              items={items}
              options={diffOptions}
              selectedLines={selection}
              onSelectedLinesChange={handleSelection}
              renderAnnotation={(annotation) => (
                <InlineAnnotation annotation={annotation.metadata} />
              )}
            />
          )}
        </section>
        <Inspector
          session={session}
          selection={selection}
          onSelectionChange={setSelection}
          onReload={onReload}
          onNavigate={(annotation) => {
            viewerRef.current?.scrollTo({
              type: 'line',
              id: annotation.filePath,
              lineNumber: annotation.endLine,
              side: annotation.side === 'new' ? 'additions' : 'deletions',
              align: 'center',
              behavior: 'smooth-auto',
            })
          }}
        />
      </div>
    </main>
  )
}

function TargetPicker({
  session,
  onOpenSession,
}: {
  session: ReviewSession
  onOpenSession(id: string): void
}) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState<RepositoryInfo | null>(null)
  const [customRange, setCustomRange] = useState('')
  const [prNumber, setPrNumber] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || repository != null) return
    void getRepositoryInfo(session.repositoryRoot)
      .then(setRepository)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [open, repository, session.repositoryRoot])

  const choose = async (target: ReviewTarget) => {
    setBusy(true)
    setError(null)
    try {
      const next = await createSession({ repositoryPath: session.repositoryRoot, target })
      setOpen(false)
      onOpenSession(next.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="target-picker">
      <button className="target-trigger" onClick={() => setOpen((value) => !value)}>
        <BranchIcon />
        <span className="target-repo">{session.repositoryName}</span>
        <span className="target-divider">/</span>
        <span className="target-label">{session.targetLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="target-menu">
          <div className="menu-kicker">Review target</div>
          <TargetOption label="Working tree" detail="git diff HEAD" onClick={() => void choose({ kind: 'worktree' })} />
          <TargetOption label="Unstaged changes" detail="git diff" onClick={() => void choose({ kind: 'unstaged' })} />
          <TargetOption label="Staged changes" detail="git diff --cached" onClick={() => void choose({ kind: 'staged' })} />
          {repository?.branchRange != null && (
            <TargetOption
              featured
              label="Current branch changes"
              detail={repository.branchRange}
              onClick={() => void choose({ kind: 'range', expression: repository.branchRange! })}
            />
          )}

          <div className="menu-section-label">GitHub pull request</div>
          {repository?.pullRequests.slice(0, 4).map((pullRequest) => (
            <TargetOption
              key={pullRequest.number}
              label={`#${pullRequest.number} ${pullRequest.title}`}
              detail={`${pullRequest.baseRefName} ← ${pullRequest.headRefName}`}
              onClick={() => void choose({ kind: 'pr', number: pullRequest.number })}
            />
          ))}
          <form
            className="compact-form"
            onSubmit={(event) => {
              event.preventDefault()
              void choose({ kind: 'pr', number: Number(prNumber) })
            }}
          >
            <input value={prNumber} onChange={(event) => setPrNumber(event.target.value)} placeholder="PR number" inputMode="numeric" />
            <button disabled={!prNumber || busy}>Open</button>
          </form>

          <div className="menu-section-label">Revision range</div>
          <form
            className="compact-form"
            onSubmit={(event) => {
              event.preventDefault()
              void choose({ kind: 'range', expression: customRange })
            }}
          >
            <input value={customRange} onChange={(event) => setCustomRange(event.target.value)} placeholder="origin/master...HEAD" />
            <button disabled={!customRange || busy}>Open</button>
          </form>
          {error != null && <div className="menu-error">{error}</div>}
        </div>
      )}
    </div>
  )
}

function TargetOption({
  label,
  detail,
  featured = false,
  onClick,
}: {
  label: string
  detail: string
  featured?: boolean
  onClick(): void
}) {
  return (
    <button className={`target-option ${featured ? 'featured' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <code>{detail}</code>
    </button>
  )
}

function CommitTimeline({
  session,
  onSessionChange,
}: {
  session: ReviewSession
  onSessionChange(session: ReviewSession): void
}) {
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  if (session.commits.length === 0) return null

  const selectedStart = session.commits.findIndex(
    (commit) => commit.oid === session.selectedCommitStart,
  )
  const selectedEnd = session.commits.findIndex(
    (commit) => commit.oid === session.selectedCommitEnd,
  )

  const choose = async (startIndex: number, endIndex: number) => {
    const start = session.commits[Math.min(startIndex, endIndex)]
    const end = session.commits[Math.max(startIndex, endIndex)]
    if (start == null || end == null) return
    setBusy(true)
    try {
      onSessionChange(await selectCommits(session.id, start.oid, end.oid))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`commit-strip ${busy ? 'busy' : ''}`}>
      <div className="commit-strip-label">
        <span>Commits</span>
        <small>click one · shift-click a range</small>
      </div>
      <div className="commit-track">
        <span className="track-line" />
        {session.commits.map((commit, index) => {
          const selected = index >= selectedStart && index <= selectedEnd
          return (
            <button
              key={commit.oid}
              className={`commit-node ${selected ? 'selected' : ''}`}
              title={`${commit.shortOid} ${commit.subject}`}
              onClick={(event) => {
                if (event.shiftKey && anchorIndex != null) void choose(anchorIndex, index)
                else {
                  setAnchorIndex(index)
                  void choose(index, index)
                }
              }}
            >
              <span className="commit-dot" />
              <span className="commit-copy">
                <code>{commit.shortOid}</code>
                <span>{commit.subject}</span>
              </span>
            </button>
          )
        })}
      </div>
      <button
        className="all-commits"
        onClick={() => {
          setAnchorIndex(0)
          void choose(0, session.commits.length - 1)
        }}
      >
        All
      </button>
    </div>
  )
}

function FileRail({
  files,
  annotations,
  onSelect,
}: {
  files: FileDiffMetadata[]
  annotations: SessionAnnotation[]
  onSelect(id: string): void
}) {
  return (
    <nav className="file-rail" aria-label="Changed files">
      <div className="rail-heading">
        <span>Files</span>
        <em>{files.length}</em>
      </div>
      <div className="file-list">
        {files.map((file) => {
          const noteCount = annotations.filter(
            (annotation) => annotation.filePath === file.name && annotation.comment,
          ).length
          return (
            <button key={file.name} className="file-row" onClick={() => onSelect(file.name)}>
              <FileIcon />
              <span>{file.name}</span>
              {noteCount > 0 && <em>{noteCount}</em>}
            </button>
          )
        })}
      </div>
    </nav>
  )
}

function Inspector({
  session,
  selection,
  onSelectionChange,
  onReload,
  onNavigate,
}: {
  session: ReviewSession
  selection: CodeViewLineSelection | null
  onSelectionChange(selection: CodeViewLineSelection | null): void
  onReload(): Promise<void>
  onNavigate(annotation: SessionAnnotation): void
}) {
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const comments = session.annotations.filter((annotation) => annotation.comment != null)

  const submit = async () => {
    if (selection == null || !comment.trim()) return
    const side = selection.range.side === 'deletions' ? 'old' : 'new'
    const startLine = Math.min(selection.range.start, selection.range.end)
    const endLine = Math.max(selection.range.start, selection.range.end)
    setBusy(true)
    setError(null)
    try {
      await addAnnotation(session.id, {
        filePath: selection.id,
        side,
        startLine,
        endLine,
        comment: comment.trim(),
        source: 'user',
      })
      setComment('')
      onSelectionChange(null)
      await onReload()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="inspector">
      {selection != null ? (
        <section className="composer">
          <div className="composer-heading">
            <div>
              <span>Add comment</span>
              <code>{selectionLabel(selection)}</code>
            </div>
            <button onClick={() => onSelectionChange(null)} aria-label="Cancel selection">
              <CloseIcon />
            </button>
          </div>
          <textarea
            autoFocus
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What should the reviewer know?"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
            }}
          />
          {error != null && <div className="composer-error">{error}</div>}
          <div className="composer-actions">
            <small>⌘ Enter</small>
            <button disabled={!comment.trim() || busy} onClick={() => void submit()}>
              Add comment
            </button>
          </div>
        </section>
      ) : (
        <section className="selection-hint">
          <CommentIcon />
          <span>Select changed lines to comment</span>
        </section>
      )}

      <section className="notes-panel">
        <div className="notes-heading">
          <span>Notes</span>
          <em>{comments.length}</em>
        </div>
        {comments.length === 0 ? (
          <p className="notes-empty">Human and agent explanations will collect here.</p>
        ) : (
          <div className="notes-list">
            {comments.map((annotation) => (
              <article key={annotation.id} className="note-card">
                <button className="note-target" onClick={() => onNavigate(annotation)}>
                  <code>{compactPath(annotation.filePath)}</code>
                  <span>{lineLabel(annotation)}</span>
                </button>
                <p>{annotation.comment}</p>
                <footer>
                  <span className={`source ${annotation.source}`}>{annotation.source}</span>
                  <button
                    onClick={async () => {
                      await deleteAnnotation(session.id, annotation.id)
                      await onReload()
                    }}
                  >
                    Remove
                  </button>
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}

function InlineAnnotation({ annotation }: { annotation: SessionAnnotation }) {
  return (
    <div className={`inline-annotation ${annotation.source}`}>
      <div className="inline-source">
        <span>{annotation.source === 'agent' ? 'Agent note' : 'Review comment'}</span>
        <code>{lineLabel(annotation)}</code>
      </div>
      <p>{annotation.comment}</p>
    </div>
  )
}

function Welcome({ onOpenSession }: { onOpenSession(id: string): void }) {
  const [repositoryPath, setRepositoryPath] = useState('')
  const [range, setRange] = useState('')
  const [sessions, setSessions] = useState<ReviewSession[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void getSessions().then(setSessions).catch(() => undefined)
  }, [])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await createSession({
        repositoryPath,
        target: range.trim() ? { kind: 'range', expression: range.trim() } : { kind: 'worktree' },
      })
      onOpenSession(session.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="welcome">
      <div className="welcome-grid" />
      <section className="welcome-copy">
        <span className="welcome-mark">Δ</span>
        <p className="eyebrow">LOCAL CODE REVIEW</p>
        <h1>Read the change,<br />not the noise.</h1>
        <p>
          A focused review desk for working trees, branch ranges, and GitHub pull requests—with agent rationale kept beside the code.
        </p>
      </section>
      <section className="start-card">
        <div>
          <span className="step-number">01</span>
          <h2>Open a repository</h2>
        </div>
        <label>
          Repository path
          <input value={repositoryPath} onChange={(event) => setRepositoryPath(event.target.value)} placeholder="/path/to/repository" />
        </label>
        <label>
          Revision range <em>optional</em>
          <input value={range} onChange={(event) => setRange(event.target.value)} placeholder="origin/master...HEAD" />
        </label>
        {error != null && <div className="welcome-error">{error}</div>}
        <button className="start-button" disabled={!repositoryPath || busy} onClick={() => void start()}>
          {busy ? 'Resolving…' : 'Open review'}
        </button>
        <code className="cli-hint">or run: diff-review origin/master...HEAD</code>
      </section>
      {sessions.length > 0 && (
        <section className="recent-sessions">
          <span>Recent</span>
          {sessions.slice(0, 4).map((session) => (
            <button key={session.id} onClick={() => onOpenSession(session.id)}>
              <strong>{session.repositoryName}</strong>
              <span>{session.targetLabel}</span>
              <time>{relativeTime(session.updatedAt)}</time>
            </button>
          ))}
        </section>
      )}
    </main>
  )
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <span>Δ</span>
      <div className="loading-line" />
      <p>Resolving change set</p>
    </main>
  )
}

function ErrorScreen({ message, onBack }: { message: string; onBack(): void }) {
  return (
    <main className="error-screen">
      <span>Session unavailable</span>
      <h1>{message}</h1>
      <button onClick={onBack}>Back to reviews</button>
    </main>
  )
}

function EmptyDiff({ onRefresh }: { onRefresh(): void }) {
  return (
    <div className="empty-diff">
      <span className="empty-glyph">∅</span>
      <h2>No changes in this range</h2>
      <p>The selected snapshots resolve to the same content.</p>
      <button onClick={onRefresh}>Refresh</button>
    </div>
  )
}

function annotationsForFile(
  annotations: SessionAnnotation[],
  fileDiff: FileDiffMetadata,
): DiffLineAnnotation<SessionAnnotation>[] {
  return annotations
    .filter(
      (annotation) =>
        annotation.comment != null &&
        (annotation.filePath === fileDiff.name || annotation.filePath === fileDiff.prevName),
    )
    .map((annotation) => ({
      side: annotation.side === 'new' ? 'additions' : 'deletions',
      lineNumber: annotation.endLine,
      metadata: annotation,
    }))
}

function sessionIdFromPath(): string | null {
  return /^\/s\/([^/]+)$/.exec(window.location.pathname)?.[1] ?? null
}

function openHome(setter?: (id: string | null) => void): void {
  window.history.pushState(null, '', '/')
  setter?.(null)
  if (setter == null) window.location.assign('/')
}

function selectionLabel(selection: CodeViewLineSelection): string {
  const side = selection.range.side === 'deletions' ? 'old' : 'new'
  const start = Math.min(selection.range.start, selection.range.end)
  const end = Math.max(selection.range.start, selection.range.end)
  return `${compactPath(selection.id)} · ${side} ${start}${start === end ? '' : `–${end}`}`
}

function lineLabel(annotation: SessionAnnotation): string {
  const prefix = annotation.side === 'new' ? '+' : '−'
  return `${prefix}${annotation.startLine}${annotation.startLine === annotation.endLine ? '' : `–${annotation.endLine}`}`
}

function compactPath(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length <= 2 ? filePath : `…/${parts.slice(-2).join('/')}`
}

function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}
