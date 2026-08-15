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
import { Checkbox } from '@base-ui/react/checkbox'
import { Menu } from '@base-ui/react/menu'
import { Popover } from '@base-ui/react/popover'
import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { Tooltip } from '@base-ui/react/tooltip'
import type { GitStatusEntry } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from 'react'

import type {
  DiffSide,
  PiReviewStatus,
  PullRequestActivity,
  PullRequestDetails,
  PullRequestListView,
  PullRequestRevision,
  PullRequestSummary,
  RepositoryInfo,
  ReviewSession,
  ReviewTarget,
  SessionAnnotation,
} from '../shared/types'
import {
  addAnnotation,
  archiveAllAnnotations,
  createSession,
  getFileContents,
  getPiReviewStatus,
  getPullRequest,
  getPullRequestRevisions,
  getPullRequests,
  getRepositoryInfo,
  getSession,
  getSessions,
  refreshSession,
  selectCommits,
  setAnnotationArchived,
  setFileViewed,
  setIgnoreWhitespace,
  stageFile,
  startPiReview,
  updateAnnotationComment,
  updateGlobalComment,
} from './api'
import { applyImportance } from './importance'
import {
  AddCommentIcon,
  ArchiveIcon,
  BranchIcon,
  CheckIcon,
  ChevronIcon,
  CloseIcon,
  CommentIcon,
  CommitIcon,
  CopyIcon,
  EditIcon,
  RefreshIcon,
  RestoreIcon,
  ThemeIcon,
  WrapIcon,
} from './icons'

type DiffLayout = 'unified' | 'split'
type DiffOverflow = 'wrap' | 'scroll'
type ThemePreference = 'system' | 'light' | 'dark'
type ResolvedTheme = 'light' | 'dark'
type ReviewLineAnnotation =
  | { kind: 'saved'; annotation: SessionAnnotation }
  | { kind: 'composer'; selection: CodeViewLineSelection }

type AppRoute =
  | { kind: 'root' }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'pull-requests'
      repositoryPath: string
      pullRequestNumber: number | null
      revisionId: string | null
    }

interface PullRequestWorkspaceContext {
  details: PullRequestDetails
  revisions: PullRequestRevision[]
  currentSessionId: string
  list: ReactNode
  piStatus: PiReviewStatus
  onSelectRevision(sessionId: string): void
  onStartPiReview(): Promise<void>
}

interface FileChangeStats {
  additions: number
  deletions: number
  modifications: number
}

export default function App() {
  const theme = useThemePreference()
  const [route, setRoute] = useState<AppRoute>(() => routeFromLocation())

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const openSession = useCallback((id: string, replace = false) => {
    const pathname = `/s/${encodeURIComponent(id)}`
    window.history[replace ? 'replaceState' : 'pushState'](null, '', pathname)
    setRoute({ kind: 'session', sessionId: id })
  }, [])

  const openPullRequests = useCallback((
    repositoryPath: string,
    pullRequestNumber: number | null = null,
    revisionId: string | null = null,
    replace = false,
  ) => {
    const query = new URLSearchParams({ repo: repositoryPath })
    if (pullRequestNumber != null) query.set('pr', String(pullRequestNumber))
    if (revisionId != null) query.set('revision', revisionId)
    window.history[replace ? 'replaceState' : 'pushState'](
      null,
      '',
      `/pull-requests?${query}`,
    )
    setRoute({ kind: 'pull-requests', repositoryPath, pullRequestNumber, revisionId })
  }, [])

  if (route.kind === 'root') {
    return <RootRedirect onOpenSession={openSession} />
  }
  if (route.kind === 'pull-requests') {
    return (
      <PullRequestsPage
        route={route}
        onOpenSession={openSession}
        onOpenPullRequests={openPullRequests}
        themePreference={theme.preference}
        resolvedTheme={theme.resolved}
        onThemeChange={theme.setPreference}
      />
    )
  }
  return (
    <SessionPage
      sessionId={route.sessionId}
      onOpenSession={openSession}
      onOpenPullRequests={openPullRequests}
      themePreference={theme.preference}
      resolvedTheme={theme.resolved}
      onThemeChange={theme.setPreference}
    />
  )
}

function SessionPage({
  sessionId,
  onOpenSession,
  onOpenPullRequests,
  themePreference,
  resolvedTheme,
  onThemeChange,
}: {
  sessionId: string
  onOpenSession(id: string, replace?: boolean): void
  onOpenPullRequests(
    repositoryPath: string,
    pullRequestNumber?: number | null,
    revisionId?: string | null,
    replace?: boolean,
  ): void
  themePreference: ThemePreference
  resolvedTheme: ResolvedTheme
  onThemeChange(theme: ThemePreference): void
}) {
  const [session, setSession] = useState<ReviewSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadSession = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const next = await getSession(id)
      if (next.target.kind === 'pr') {
        onOpenPullRequests(next.repositoryRoot, next.target.number, next.id, true)
        return
      }
      setSession(next)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [onOpenPullRequests])

  useEffect(() => {
    if (sessionId == null) return
    void loadSession(sessionId)
    const events = new EventSource(`/api/events?session=${encodeURIComponent(sessionId)}`)
    events.onmessage = () => void loadSession(sessionId, true)
    return () => events.close()
  }, [loadSession, sessionId])

  if (loading && session == null) return <LoadingScreen />
  if (error != null && session == null) {
    return <ErrorScreen message={error} onBack={() => window.history.back()} />
  }
  if (session == null) return null

  return (
    <ReviewWorkspace
      session={session}
      error={error}
      onSessionChange={setSession}
      onOpenSession={onOpenSession}
      onOpenPullRequests={onOpenPullRequests}
      onReload={() => loadSession(session.id, true)}
      themePreference={themePreference}
      resolvedTheme={resolvedTheme}
      onThemeChange={onThemeChange}
    />
  )
}

function RootRedirect({
  onOpenSession,
}: {
  onOpenSession(id: string, replace?: boolean): void
}) {
  const [empty, setEmpty] = useState(false)
  useEffect(() => {
    void getSessions()
      .then((sessions) => {
        const latest = sessions.at(0)
        if (latest == null) setEmpty(true)
        else onOpenSession(latest.id, true)
      })
      .catch(() => setEmpty(true))
  }, [onOpenSession])
  if (!empty) return <LoadingScreen />
  return (
    <main className="root-empty">
      <span className="welcome-mark">Δ</span>
      <h1>No local reviews yet</h1>
      <p>Run <code>diff-review</code> from a Git repository to open the review desk.</p>
    </main>
  )
}

function PullRequestsPage({
  route,
  onOpenSession,
  onOpenPullRequests,
  themePreference,
  resolvedTheme,
  onThemeChange,
}: {
  route: Extract<AppRoute, { kind: 'pull-requests' }>
  onOpenSession(id: string, replace?: boolean): void
  onOpenPullRequests(
    repositoryPath: string,
    pullRequestNumber?: number | null,
    revisionId?: string | null,
    replace?: boolean,
  ): void
  themePreference: ThemePreference
  resolvedTheme: ResolvedTheme
  onThemeChange(theme: ThemePreference): void
}) {
  const [view, setView] = useState<PullRequestListView>('open')
  const [repository, setRepository] = useState<RepositoryInfo | null>(null)
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [details, setDetails] = useState<PullRequestDetails | null>(null)
  const [session, setSession] = useState<ReviewSession | null>(null)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [revisions, setRevisions] = useState<PullRequestRevision[]>([])
  const [piStatus, setPiStatus] = useState<PiReviewStatus>({ state: 'idle' })
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  useEffect(() => {
    void getRepositoryInfo(route.repositoryPath).then(setRepository).catch(() => undefined)
  }, [route.repositoryPath])

  useEffect(() => {
    let active = true
    setListLoading(true)
    setListError(null)
    void getPullRequests(route.repositoryPath, view)
      .then((items) => {
        if (active) setPullRequests(items)
      })
      .catch((caught) => {
        if (active) setListError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (active) setListLoading(false)
      })
    return () => {
      active = false
    }
  }, [route.repositoryPath, view])

  useEffect(() => {
    const number = route.pullRequestNumber
    if (number == null) {
      setDetails(null)
      setSession(null)
      setCurrentSessionId(null)
      setRevisions([])
      return
    }
    let active = true
    setDetailLoading(true)
    setDetailError(null)
    setDetails(null)
    setSession(null)
    setCurrentSessionId(null)
    setRevisions([])
    const currentRequest = createSession({
      repositoryPath: route.repositoryPath,
      target: { kind: 'pr', number },
    })
    void Promise.all([
      getPullRequest(route.repositoryPath, number),
      currentRequest,
      route.revisionId == null ? currentRequest : getSession(route.revisionId),
    ])
      .then(async ([nextDetails, current, selected]) => {
        if (
          selected.repositoryRoot !== current.repositoryRoot ||
          selected.target.kind !== 'pr' ||
          selected.target.number !== number
        ) {
          throw new Error('The selected revision does not belong to this pull request')
        }
        const [nextRevisions, nextPiStatus] = await Promise.all([
          getPullRequestRevisions(route.repositoryPath, number),
          getPiReviewStatus(selected.id),
        ])
        if (!active) return
        setDetails(nextDetails)
        setSession(selected)
        setCurrentSessionId(current.id)
        setRevisions(nextRevisions)
        setPiStatus(nextPiStatus)
        if (route.revisionId == null) {
          onOpenPullRequests(route.repositoryPath, number, current.id, true)
        }
      })
      .catch((caught) => {
        if (active) setDetailError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [
    onOpenPullRequests,
    route.pullRequestNumber,
    route.repositoryPath,
    route.revisionId,
  ])

  useEffect(() => {
    if (session == null || route.pullRequestNumber == null) return
    const sessionId = session.id
    const events = new EventSource(`/api/events?session=${encodeURIComponent(sessionId)}`)
    events.onmessage = () => {
      void Promise.all([
        getSession(sessionId),
        getPullRequestRevisions(route.repositoryPath, route.pullRequestNumber!),
        getPiReviewStatus(sessionId),
      ]).then(([nextSession, nextRevisions, nextPiStatus]) => {
        setSession(nextSession)
        setRevisions(nextRevisions)
        setPiStatus(nextPiStatus)
      })
    }
    return () => events.close()
  }, [route.pullRequestNumber, route.repositoryPath, session?.id])

  const rail = (
    <PullRequestRail
      view={view}
      items={pullRequests}
      selectedNumber={route.pullRequestNumber}
      loading={listLoading}
      error={listError}
      onViewChange={setView}
      onSelect={(number) => onOpenPullRequests(route.repositoryPath, number)}
    />
  )

  if (session == null || details == null || currentSessionId == null) {
    return (
      <main className="review-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">Δ</span>
            <span>Diff Review</span>
          </div>
          <button className="global-nav-tab active">Pull requests</button>
          <LocalReviewPicker
            repositoryRoot={route.repositoryPath}
            repositoryName={repository?.name ?? repositoryNameFromPath(route.repositoryPath)}
            currentSession={null}
            active={false}
            onOpenSession={onOpenSession}
          />
          <div className="topbar-spacer" />
          <ThemePicker value={themePreference} onChange={onThemeChange} />
        </header>
        <div className="pr-empty-workspace">
          {rail}
          <section className="pr-selection-empty">
            {detailError != null ? (
              <><span>Pull request unavailable</span><p>{detailError}</p></>
            ) : detailLoading ? (
              <><span className="loading-ring" /><p>Resolving pull request revision…</p></>
            ) : (
              <><span className="empty-glyph">↗</span><p>Select a pull request to begin.</p></>
            )}
          </section>
        </div>
      </main>
    )
  }

  const number = details.number
  return (
    <ReviewWorkspace
      session={session}
      error={detailError}
      onSessionChange={setSession}
      onOpenSession={(id) => onOpenPullRequests(route.repositoryPath, number, id)}
      onOpenPullRequests={onOpenPullRequests}
      onReload={async () => setSession(await getSession(session.id))}
      themePreference={themePreference}
      resolvedTheme={resolvedTheme}
      onThemeChange={onThemeChange}
      pullRequest={{
        details,
        revisions,
        currentSessionId,
        list: rail,
        piStatus,
        onSelectRevision: (id) => onOpenPullRequests(route.repositoryPath, number, id),
        onStartPiReview: async () => setPiStatus(await startPiReview(session.id)),
      }}
    />
  )
}

function ReviewWorkspace({
  session,
  error,
  onSessionChange,
  onOpenSession,
  onOpenPullRequests,
  onReload,
  themePreference,
  resolvedTheme,
  onThemeChange,
  pullRequest,
}: {
  session: ReviewSession
  error: string | null
  onSessionChange(session: ReviewSession): void
  onOpenSession(id: string): void
  onOpenPullRequests(repositoryPath: string, pullRequestNumber?: number | null): void
  onReload(): Promise<void>
  themePreference: ThemePreference
  resolvedTheme: ResolvedTheme
  onThemeChange(theme: ThemePreference): void
  pullRequest?: PullRequestWorkspaceContext
}) {
  const viewerRef = useRef<CodeViewHandle<ReviewLineAnnotation>>(null)
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [overflow, setOverflow] = useState<DiffOverflow>('wrap')
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [composerSelection, setComposerSelection] = useState<CodeViewLineSelection | null>(null)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [comment, setComment] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState<string | null>(null)
  const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
    storedPanelWidth('left', 235, 160, 440),
  )
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    storedPanelWidth('right', 310, 240, 480),
  )
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const viewedFiles = useMemo(() => new Set(session.viewedFiles), [session.viewedFiles])
  const [collapsedFiles, setCollapsedFiles] = useState(() => new Set(session.viewedFiles))

  const setFileCollapsed = useCallback((filePath: string, collapsed: boolean) => {
    setCollapsedFiles((current) => {
      if (current.has(filePath) === collapsed) return current
      const next = new Set(current)
      if (collapsed) next.add(filePath)
      else next.delete(filePath)
      return next
    })
  }, [])

  useEffect(() => {
    setSelection(null)
    setComposerSelection(null)
    setComment('')
    setCommentError(null)
  }, [session.patch])

  useEffect(() => {
    setCollapsedFiles(new Set(session.viewedFiles))
  }, [session.id])

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

  const items = useMemo<CodeViewItem<ReviewLineAnnotation>[]>(() => {
    const annotationVersion = session.annotations.reduce(
      (latest, annotation) => Math.max(latest, Date.parse(annotation.updatedAt)),
      Date.parse(session.updatedAt),
    )
    const version = annotationVersion + session.annotations.length + selectionRevision
    return parsedFiles.map((fileDiff) => {
      fileDiff.cacheKey = `${session.id}:${session.updatedAt}:${fileDiff.name}`
      const collapsed = collapsedFiles.has(fileDiff.name)
      return {
        id: fileDiff.name,
        type: 'diff',
        fileDiff,
        version: version * 2 + Number(collapsed),
        collapsed,
        annotations: annotationsForFile(session.annotations, fileDiff, composerSelection),
      }
    })
  }, [collapsedFiles, composerSelection, parsedFiles, selectionRevision, session.annotations, session.id, session.updatedAt])

  const diffOptions = useMemo<CodeViewReactOptions<ReviewLineAnnotation>>(
    () => ({
      theme: { dark: 'pierre-dark', light: 'pierre-light' },
      themeType: resolvedTheme,
      diffStyle: layout,
      diffIndicators: 'bars',
      overflow,
      enableLineSelection: true,
      lineHoverHighlight: 'both',
      hunkSeparators: 'line-info-basic',
      stickyHeaders: true,
      unsafeCSS: '[data-diffs-header="default"] { cursor: pointer; }',
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      collapsedContextThreshold: 10,
      expansionLineCount: 20,
      lineDiffType: 'word-alt',
      itemMetrics: { lineHeight: 16 },
      onLineSelectionEnd(range, context) {
        if (range == null) return
        const next = { id: context.item.id, range }
        setSelection(next)
        setComposerSelection(next)
        setSelectionRevision((revision) => revision + 1)
      },
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
    [layout, overflow, resolvedTheme, session.annotations, session.id, session.updatedAt],
  )

  const handleSelection = useCallback((next: CodeViewLineSelection | null) => {
    if (composerSelection != null && !areCodeViewSelectionsEqual(composerSelection, next)) {
      setComposerSelection(null)
      setComment('')
      setCommentError(null)
      setSelectionRevision((revision) => revision + 1)
    }
    setSelection(next)
  }, [composerSelection])

  const submitComment = useCallback(async () => {
    if (selection == null || !comment.trim()) return
    const range = annotationRangeFromSelection(selection)
    setCommentBusy(true)
    setCommentError(null)
    try {
      await addAnnotation(session.id, {
        filePath: selection.id,
        ...range,
        comment: comment.trim(),
        source: 'user',
      })
      setComment('')
      setSelection(null)
      setComposerSelection(null)
      setSelectionRevision((revision) => revision + 1)
      await onReload()
    } catch (caught) {
      setCommentError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setCommentBusy(false)
    }
  }, [comment, onReload, selection, session.id])

  const setArchived = useCallback(async (annotationId: string, archived: boolean) => {
    await setAnnotationArchived(session.id, annotationId, archived)
    await onReload()
  }, [onReload, session.id])

  const editAnnotation = useCallback(async (annotationId: string, nextComment: string) => {
    await updateAnnotationComment(session.id, annotationId, nextComment)
    await onReload()
  }, [onReload, session.id])

  const editGlobalComment = useCallback(async (nextComment: string) => {
    onSessionChange(await updateGlobalComment(session.id, nextComment))
  }, [onSessionChange, session.id])

  const archiveAll = useCallback(async () => {
    onSessionChange(await archiveAllAnnotations(session.id))
  }, [onSessionChange, session.id])

  const setViewed = useCallback(async (filePath: string, viewed: boolean) => {
    const updated = await setFileViewed(session.id, filePath, viewed)
    setFileCollapsed(filePath, viewed)
    onSessionChange(updated)
  }, [onSessionChange, session.id, setFileCollapsed])

  const addFile = useCallback(async (filePath: string) => {
    onSessionChange(await stageFile(session.id, filePath))
  }, [onSessionChange, session.id])

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const updated = await refreshSession(session.id)
      if (updated.id === session.id) onSessionChange(updated)
      else onOpenSession(updated.id)
    } finally {
      setBusy(false)
    }
  }, [onOpenSession, onSessionChange, session.id])

  const updateIgnoreWhitespace = useCallback(async (ignoreWhitespace: boolean) => {
    setBusy(true)
    try {
      onSessionChange(await setIgnoreWhitespace(session.id, ignoreWhitespace))
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
    setFileCollapsed(id, false)
    window.requestAnimationFrame(() => {
      viewerRef.current?.scrollTo({ type: 'item', id, align: 'start', offset: 8 })
    })
  }, [setFileCollapsed])

  const workspaceStyle = {
    '--left-panel-width': `${leftPanelWidth}px`,
    '--right-panel-width': `${rightPanelWidth}px`,
  } as CSSProperties

  return (
    <main className="review-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">Δ</span>
          <span>Diff Review</span>
        </div>
        <button
          className={`global-nav-tab${pullRequest == null ? '' : ' active'}`}
          onClick={() => onOpenPullRequests(
            session.repositoryRoot,
            session.target.kind === 'pr' ? session.target.number : null,
          )}
        >
          Pull requests
        </button>
        <LocalReviewPicker
          repositoryRoot={session.repositoryRoot}
          repositoryName={session.repositoryName}
          currentSession={session}
          active={pullRequest == null}
          onOpenSession={onOpenSession}
        />
        {pullRequest != null && (
          <RevisionPicker
            revisions={pullRequest.revisions}
            selectedSessionId={session.id}
            currentSessionId={pullRequest.currentSessionId}
            onSelect={pullRequest.onSelectRevision}
          />
        )}
        {pullRequest == null && (
          <CommitPicker session={session} onSessionChange={onSessionChange} />
        )}
        <div className="topbar-spacer" />
        <ToggleGroup
          className="layout-switch"
          aria-label="Diff layout"
          value={[layout]}
          onValueChange={(value) => {
            const next = value.at(0)
            if (next === 'unified' || next === 'split') setLayout(next)
          }}
        >
          <Toggle value="unified">
            Stack
          </Toggle>
          <Toggle value="split">
            Split
          </Toggle>
        </ToggleGroup>
        <DiffOptionsMenu
          wrap={overflow === 'wrap'}
          ignoreWhitespace={session.ignoreWhitespace}
          busy={busy}
          showIgnoreWhitespace={pullRequest == null}
          onWrapChange={(wrap) => setOverflow(wrap ? 'wrap' : 'scroll')}
          onIgnoreWhitespaceChange={updateIgnoreWhitespace}
        />
        <ThemePicker value={themePreference} onChange={onThemeChange} />
        <button className="icon-button" onClick={refresh} aria-label="Refresh diff" disabled={busy}>
          <RefreshIcon className={busy ? 'spinning' : ''} />
        </button>
        {pullRequest == null ? (
          <button className="agent-button" onClick={copyForAgent}>
            <CopyIcon />
            {copied ? 'Copied' : 'Agent instruction'}
          </button>
        ) : (
          <button
            className="agent-button"
            disabled={pullRequest.piStatus.state === 'running'}
            title={pullRequest.piStatus.state === 'failed' ? pullRequest.piStatus.error : undefined}
            onClick={() => void pullRequest.onStartPiReview()}
          >
            <span className={pullRequest.piStatus.state === 'running' ? 'pi-pulse' : ''}>π</span>
            {piReviewButtonLabel(pullRequest.piStatus)}
          </button>
        )}
      </header>

      <div className={`workspace${pullRequest == null ? '' : ' pr-workspace'}`} style={workspaceStyle}>
        {pullRequest?.list}
        <FileRail
          files={parsedFiles}
          resolvedTheme={resolvedTheme}
          onSelect={selectFile}
        />
        <PanelResizeHandle
          label="Resize file panel"
          side="left"
          size={leftPanelWidth}
          min={160}
          max={440}
          onChange={(width) => {
            setLeftPanelWidth(width)
            storePanelWidth('left', width)
          }}
        />
        <section
          className="diff-stage"
          onClick={(event) => {
            const fileId = fileHeaderIdFromEvent(event.nativeEvent)
            if (fileId != null) {
              setFileCollapsed(fileId, !collapsedFiles.has(fileId))
            }
          }}
        >
          {error != null && <div className="error-banner">{error}</div>}
          {items.length === 0 ? (
            <EmptyDiff onRefresh={refresh} />
          ) : (
            <CodeView<ReviewLineAnnotation>
              ref={viewerRef}
              key={`${session.id}:${layout}:${resolvedTheme}`}
              className="diff-view"
              items={items}
              options={diffOptions}
              selectedLines={selection}
              onSelectedLinesChange={handleSelection}
              renderCodeViewHeader={pullRequest == null ? undefined : () => (
                <PullRequestConversation
                  details={pullRequest.details}
                  oldRevision={session.id !== pullRequest.currentSessionId}
                  onNavigate={(activity) => {
                    if (activity.kind !== 'review-comment' || activity.line == null) return
                    viewerRef.current?.scrollTo({
                      type: 'line',
                      id: activity.path,
                      lineNumber: activity.line,
                      side: activity.side === 'old' ? 'deletions' : 'additions',
                      align: 'start',
                      behavior: 'smooth-auto',
                    })
                  }}
                />
              )}
              renderHeaderMetadata={(item) => (
                <div
                  className="file-header-controls"
                  data-file-id={item.id}
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    className="file-collapse-button"
                    aria-label={`${collapsedFiles.has(item.id) ? 'Expand' : 'Collapse'} ${item.id}`}
                    aria-expanded={!collapsedFiles.has(item.id)}
                    onClick={(event) => {
                      event.stopPropagation()
                      setFileCollapsed(item.id, !collapsedFiles.has(item.id))
                    }}
                  >
                    <ChevronIcon />
                  </button>
                  {(session.target.kind === 'worktree' || session.target.kind === 'unstaged') && (
                    <FileStageButton filePath={item.id} onAdd={() => addFile(item.id)} />
                  )}
                  <FileViewedToggle
                    viewed={viewedFiles.has(item.id)}
                    onChange={(viewed) => setViewed(item.id, viewed)}
                  />
                </div>
              )}
              renderAnnotation={(annotation) => {
                const metadata = annotation.metadata
                return metadata.kind === 'composer' ? (
                  <InlineComposer
                    comment={comment}
                    error={commentError}
                    busy={commentBusy}
                    onCommentChange={setComment}
                    onCancel={() => {
                      setComment('')
                      setCommentError(null)
                      setSelection(null)
                      setComposerSelection(null)
                      setSelectionRevision((revision) => revision + 1)
                    }}
                    onSubmit={submitComment}
                  />
                ) : (
                  <InlineAnnotation
                    annotation={metadata.annotation}
                    onArchive={() => setArchived(metadata.annotation.id, true)}
                    onUpdateComment={(comment) => editAnnotation(metadata.annotation.id, comment)}
                  />
                )
              }}
            />
          )}
        </section>
        <PanelResizeHandle
          label="Resize annotations panel"
          side="right"
          size={rightPanelWidth}
          min={240}
          max={480}
          onChange={(width) => {
            setRightPanelWidth(width)
            storePanelWidth('right', width)
          }}
        />
        <Inspector
          session={session}
          files={parsedFiles}
          onSetArchived={setArchived}
          onUpdateComment={editAnnotation}
          onUpdateGlobalComment={editGlobalComment}
          allowGlobalComment={pullRequest == null}
          onArchiveAll={archiveAll}
          onNavigate={(annotation) => {
            viewerRef.current?.scrollTo({
              type: 'line',
              id: annotation.filePath,
              lineNumber: annotation.endLine,
              side: annotation.side === 'new' ? 'additions' : 'deletions',
              align: 'start',
              behavior: 'smooth-auto',
            })
          }}
        />
      </div>
    </main>
  )
}

function PanelResizeHandle({
  label,
  side,
  size,
  min,
  max,
  onChange,
}: {
  label: string
  side: 'left' | 'right'
  size: number
  min: number
  max: number
  onChange(size: number): void
}) {
  const dragStart = useRef<{ x: number; size: number } | null>(null)
  const resize = (clientX: number) => {
    if (dragStart.current == null) return
    const delta = clientX - dragStart.current.x
    const next = dragStart.current.size + (side === 'left' ? delta : -delta)
    onChange(Math.min(max, Math.max(min, Math.round(next))))
  }
  const stop = () => {
    dragStart.current = null
    document.body.classList.remove('resizing-panels')
  }

  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      tabIndex={0}
      onPointerDown={(event) => {
        dragStart.current = { x: event.clientX, size }
        event.currentTarget.setPointerCapture(event.pointerId)
        document.body.classList.add('resizing-panels')
      }}
      onPointerMove={(event) => resize(event.clientX)}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowRight' ? 10 : -10
        const next = size + (side === 'left' ? delta : -delta)
        onChange(Math.min(max, Math.max(min, next)))
      }}
    />
  )
}

function ThemePicker({
  value,
  onChange,
  className = '',
}: {
  value: ThemePreference
  onChange(theme: ThemePreference): void
  className?: string
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={`icon-button theme-trigger ${className}`.trim()}
        aria-label="Choose color theme"
        title={`Theme: ${value}`}
      >
        <ThemeIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="popup-positioner" sideOffset={8} align="end">
          <Menu.Popup className="theme-menu">
            <Menu.Group>
              <Menu.GroupLabel className="menu-kicker">Color theme</Menu.GroupLabel>
              <Menu.RadioGroup value={value} onValueChange={onChange}>
                {(['system', 'light', 'dark'] as const).map((theme) => (
                  <Menu.RadioItem
                    key={theme}
                    value={theme}
                    closeOnClick
                    className="theme-option"
                  >
                    <Menu.RadioItemIndicator className="theme-check">
                      <CheckIcon />
                    </Menu.RadioItemIndicator>
                    <span>{theme === 'system' ? 'System' : capitalize(theme)}</span>
                    <small>{theme === 'system' ? 'Follow device' : `${capitalize(theme)} colors`}</small>
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function DiffOptionsMenu({
  wrap,
  ignoreWhitespace,
  busy,
  showIgnoreWhitespace,
  onWrapChange,
  onIgnoreWhitespaceChange,
}: {
  wrap: boolean
  ignoreWhitespace: boolean
  busy: boolean
  showIgnoreWhitespace: boolean
  onWrapChange(wrap: boolean): void
  onIgnoreWhitespaceChange(ignoreWhitespace: boolean): void
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="diff-options-trigger" aria-label="Diff options">
        <WrapIcon />
        <span>Options</span>
        <ChevronIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="popup-positioner" sideOffset={8} align="end">
          <Menu.Popup className="diff-options-menu">
            <Menu.Group>
              <Menu.GroupLabel className="menu-kicker">Diff options</Menu.GroupLabel>
              <Menu.CheckboxItem
                checked={wrap}
                onCheckedChange={onWrapChange}
                className="diff-option"
              >
                <Menu.CheckboxItemIndicator className="diff-option-check">
                  <CheckIcon />
                </Menu.CheckboxItemIndicator>
                <span>Wrap lines</span>
              </Menu.CheckboxItem>
              {showIgnoreWhitespace && (
                <Menu.CheckboxItem
                  checked={ignoreWhitespace}
                  disabled={busy}
                  onCheckedChange={onIgnoreWhitespaceChange}
                  className="diff-option"
                >
                  <Menu.CheckboxItemIndicator className="diff-option-check">
                    <CheckIcon />
                  </Menu.CheckboxItemIndicator>
                  <span>Ignore whitespace</span>
                </Menu.CheckboxItem>
              )}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function PullRequestRail({
  view,
  items,
  selectedNumber,
  loading,
  error,
  onViewChange,
  onSelect,
}: {
  view: PullRequestListView
  items: PullRequestSummary[]
  selectedNumber: number | null
  loading: boolean
  error: string | null
  onViewChange(view: PullRequestListView): void
  onSelect(number: number): void
}) {
  const views: { id: PullRequestListView; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'additional-review', label: 'Additional' },
    { id: 'merged', label: 'Merged' },
  ]
  return (
    <aside className="pr-rail">
      <div className="pr-rail-heading">
        <div><span>Pull requests</span><strong>{loading ? '…' : items.length}</strong></div>
        <div className="pr-view-tabs" role="tablist" aria-label="Pull request view">
          {views.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={view === item.id}
              className={view === item.id ? 'active' : ''}
              onClick={() => onViewChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="pr-list">
        {error != null ? (
          <div className="pr-list-message error">{error}</div>
        ) : loading ? (
          <div className="pr-list-message"><span className="loading-ring" /> Loading pull requests…</div>
        ) : items.length === 0 ? (
          <div className="pr-list-message">No pull requests in this view.</div>
        ) : items.map((pullRequest) => (
          <button
            key={pullRequest.number}
            className={`pr-list-item${selectedNumber === pullRequest.number ? ' selected' : ''}`}
            onClick={() => onSelect(pullRequest.number)}
          >
            <div className="pr-item-kicker">
              <span className={`pr-state ${pullRequest.isDraft ? 'draft' : pullRequest.state.toLowerCase()}`}>
                {pullRequest.isDraft ? 'Draft' : titleCase(pullRequest.state)}
              </span>
              <span className={`check-state ${pullRequest.checkStatus}`}>
                <i />{checkStatusLabel(pullRequest.checkStatus)}
              </span>
              <code>#{pullRequest.number}</code>
            </div>
            <strong className="pr-item-title">{pullRequest.title}</strong>
            <div className="pr-item-people">
              <span>{pullRequest.author.login}</span>
              {pullRequest.assignees.length > 0 && (
                <span>→ {pullRequest.assignees.map((assignee) => assignee.login).join(', ')}</span>
              )}
            </div>
            <div className="pr-item-stats">
              <span className="addition">+{pullRequest.additions}</span>
              <span className="deletion">−{pullRequest.deletions}</span>
              <time title={`Created ${formatTimestamp(pullRequest.createdAt)}`}>
                created {relativeTime(pullRequest.createdAt)}
              </time>
              <time title={`Updated ${formatTimestamp(pullRequest.updatedAt)}`}>
                updated {relativeTime(pullRequest.updatedAt)}
              </time>
            </div>
          </button>
        ))}
      </div>
    </aside>
  )
}

function RevisionPicker({
  revisions,
  selectedSessionId,
  currentSessionId,
  onSelect,
}: {
  revisions: PullRequestRevision[]
  selectedSessionId: string
  currentSessionId: string
  onSelect(sessionId: string): void
}) {
  const selected = revisions.find((revision) => revision.sessionId === selectedSessionId)
  const isCurrent = selectedSessionId === currentSessionId
  return (
    <Popover.Root>
      <Popover.Trigger className={`revision-trigger${isCurrent ? '' : ' old'}`}>
        <CommitIcon />
        <span>{isCurrent ? 'Current' : 'Older revision'}</span>
        <code>{selected?.headOid.slice(0, 8) ?? 'revision'}</code>
        <ChevronIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="popup-positioner" sideOffset={8} align="start">
          <Popover.Popup className="revision-menu">
            <Popover.Title className="menu-kicker">Pull request revisions</Popover.Title>
            {revisions.map((revision) => {
              const current = revision.sessionId === currentSessionId
              const selectedRevision = revision.sessionId === selectedSessionId
              return (
                <button
                  key={revision.sessionId}
                  className={selectedRevision ? 'selected' : ''}
                  onClick={() => onSelect(revision.sessionId)}
                >
                  <span className="revision-status">{current ? 'Current' : 'Previous'}</span>
                  <code>{revision.headOid.slice(0, 8)}</code>
                  <time>{relativeTime(revision.createdAt)}</time>
                  <small>{revision.annotationCount} annotations</small>
                </button>
              )
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PullRequestConversation({
  details,
  oldRevision,
  onNavigate,
}: {
  details: PullRequestDetails
  oldRevision: boolean
  onNavigate(activity: PullRequestActivity): void
}) {
  return (
    <section className="pr-conversation">
      {oldRevision && (
        <div className="old-revision-banner">
          You are viewing an older code revision. The GitHub conversation below is current.
        </div>
      )}
      <header className="pr-conversation-header">
        <div className="pr-conversation-kicker">
          <span className={`pr-state ${details.isDraft ? 'draft' : details.state.toLowerCase()}`}>
            {details.isDraft ? 'Draft' : titleCase(details.state)}
          </span>
          <span className={`check-state ${details.checkStatus}`}>
            <i />{checkStatusLabel(details.checkStatus)}
          </span>
          <code>#{details.number}</code>
        </div>
        <h1>{details.title}</h1>
        <div className="pr-conversation-meta">
          <span>{details.author.name ?? details.author.login}</span>
          <span>{details.baseRefName} ← {details.headRefName}</span>
          <span className="addition">+{details.additions}</span>
          <span className="deletion">−{details.deletions}</span>
          <a href={details.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
        </div>
        {details.labels.length > 0 && (
          <div className="pr-labels">
            {details.labels.map((label) => (
              <span key={label.name} style={{ '--label-color': `#${label.color}` } as CSSProperties}>
                {label.name}
              </span>
            ))}
          </div>
        )}
      </header>
      <ConversationCard
        eyebrow="Description"
        author={details.author.login}
        body={details.body || 'No description provided.'}
        timestamp={details.createdAt}
      />
      {details.activity.map((activity) => (
        <ConversationCard
          key={`${activity.kind}:${activity.id}`}
          eyebrow={activityLabel(activity)}
          author={activity.author.login}
          body={activity.body || activityLabel(activity)}
          timestamp={activity.createdAt}
          target={activity.kind === 'review-comment'
            ? `${activity.path}${activity.line == null ? '' : `:${activity.line}`}`
            : undefined}
          onTarget={activity.kind === 'review-comment' ? () => onNavigate(activity) : undefined}
          url={activity.url}
        />
      ))}
      <div className="diff-divider"><span>Files changed</span></div>
    </section>
  )
}

function ConversationCard({
  eyebrow,
  author,
  body,
  timestamp,
  target,
  onTarget,
  url,
}: {
  eyebrow: string
  author: string
  body: string
  timestamp: string
  target?: string
  onTarget?: () => void
  url?: string | null
}) {
  return (
    <article className="conversation-card">
      <div className="conversation-avatar">{author.slice(0, 2).toUpperCase()}</div>
      <div className="conversation-card-body">
        <header>
          <div><strong>{author}</strong><span>{eyebrow}</span></div>
          <time title={formatTimestamp(timestamp)}>{relativeTime(timestamp)}</time>
        </header>
        {target != null && (
          <button className="conversation-target" onClick={onTarget}><code>{target}</code></button>
        )}
        <div className="markdown-body">
          <Markdown remarkPlugins={[remarkGfm]}>{body}</Markdown>
        </div>
        {url != null && <a href={url} target="_blank" rel="noreferrer">View on GitHub ↗</a>}
      </div>
    </article>
  )
}

function LocalReviewPicker({
  repositoryRoot,
  repositoryName,
  currentSession,
  active,
  onOpenSession,
}: {
  repositoryRoot: string
  repositoryName: string
  currentSession: ReviewSession | null
  active: boolean
  onOpenSession(id: string): void
}) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState<RepositoryInfo | null>(null)
  const visitedSessions = useRef(new Map<string, string>())
  const [customRange, setCustomRange] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (currentSession == null || currentSession.target.kind === 'pr') return
    visitedSessions.current.set(
      reviewTargetKey(repositoryRoot, currentSession.target),
      currentSession.id,
    )
  }, [currentSession, repositoryRoot])

  useEffect(() => {
    if (!open) return
    void getRepositoryInfo(repositoryRoot)
      .then(setRepository)
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [open, repositoryRoot])

  const choose = async (target: ReviewTarget) => {
    if (currentSession != null && reviewTargetsEqual(currentSession.target, target)) {
      setOpen(false)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const targetKey = reviewTargetKey(repositoryRoot, target)
      const visitedId = visitedSessions.current.get(targetKey)
      if (visitedId != null) {
        setOpen(false)
        onOpenSession(visitedId)
        return
      }
      const matchingSessions = (await getSessions(repositoryRoot)).filter((item) =>
        reviewTargetsEqual(item.target, target)
      )
      const existing =
        matchingSessions.find((item) => item.annotations.length > 0) ?? matchingSessions.at(0)
      if (existing != null) {
        visitedSessions.current.set(targetKey, existing.id)
        setOpen(false)
        onOpenSession(existing.id)
        return
      }
      const next = await createSession({ repositoryPath: repositoryRoot, target })
      visitedSessions.current.set(targetKey, next.id)
      setOpen(false)
      onOpenSession(next.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className={`global-nav-tab local-review-trigger${active ? ' active' : ''}`}>
        <BranchIcon />
        <span>Local diff review</span>
        <ChevronIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="popup-positioner" sideOffset={8} align="start">
          <Popover.Popup className="target-menu">
            <Popover.Title className="menu-kicker">{repositoryName} · Local review</Popover.Title>
            <TargetOption
              selected={currentSession?.target.kind === 'worktree'}
              label="Working tree"
              detail="git diff HEAD"
              onClick={() => void choose({ kind: 'worktree' })}
            />
            <TargetOption
              selected={currentSession?.target.kind === 'unstaged'}
              label="Unstaged changes"
              detail="git diff"
              onClick={() => void choose({ kind: 'unstaged' })}
            />
            <TargetOption
              selected={currentSession?.target.kind === 'staged'}
              label="Staged changes"
              detail="git diff --cached"
              onClick={() => void choose({ kind: 'staged' })}
            />
            {repository?.branchRange != null && (
              <TargetOption
                selected={
                  currentSession != null &&
                  reviewTargetsEqual(currentSession.target, {
                    kind: 'range',
                    expression: repository.branchRange,
                  })
                }
                label="Current branch changes"
                detail={repository.branchRange}
                onClick={() => void choose({ kind: 'range', expression: repository.branchRange! })}
              />
            )}

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
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function TargetOption({
  label,
  detail,
  selected = false,
  onClick,
}: {
  label: string
  detail: string
  selected?: boolean
  onClick(): void
}) {
  return (
    <button
      className={`target-option ${selected ? 'selected' : ''}`}
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
    >
      <span>{label}</span>
      <code>{detail}</code>
    </button>
  )
}

function reviewTargetsEqual(left: ReviewTarget, right: ReviewTarget): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'range' && right.kind === 'range') {
    return left.expression.trim() === right.expression.trim()
  }
  if (left.kind === 'pr' && right.kind === 'pr') return left.number === right.number
  return true
}

function reviewTargetKey(repositoryRoot: string, target: ReviewTarget): string {
  if (target.kind === 'range') return `${repositoryRoot}:range:${target.expression.trim()}`
  if (target.kind === 'pr') return `${repositoryRoot}:pr:${target.number}`
  return `${repositoryRoot}:${target.kind}`
}

function CommitPicker({
  session,
  onSessionChange,
}: {
  session: ReviewSession
  onSessionChange(session: ReviewSession): void
}) {
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  if (session.commits.length === 0) return null

  const rawStart = session.commits.findIndex((commit) => commit.oid === session.selectedCommitStart)
  const rawEnd = session.commits.findIndex((commit) => commit.oid === session.selectedCommitEnd)
  const selectedStart = rawStart < 0 ? 0 : Math.min(rawStart, rawEnd)
  const selectedEnd = rawEnd < 0 ? session.commits.length - 1 : Math.max(rawStart, rawEnd)
  const selectedCount = selectedEnd - selectedStart + 1
  const firstSelected = session.commits[selectedStart]
  const lastSelected = session.commits[selectedEnd]
  const selectionLabel = selectedCount === 1
    ? `${firstSelected?.shortOid} ${firstSelected?.subject}`
    : `${firstSelected?.shortOid}…${lastSelected?.shortOid} · ${selectedCount} commits`

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
    <Popover.Root>
      <Popover.Trigger className="commit-trigger" disabled={busy} title={selectionLabel}>
        <CommitIcon />
        <span className="commit-trigger-copy">
          <small>Commits</small>
          <span>{selectionLabel}</span>
        </span>
        <ChevronIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="popup-positioner" sideOffset={8} align="start">
          <Popover.Popup className={`commit-menu ${busy ? 'busy' : ''}`} aria-busy={busy}>
            <div className="commit-menu-header">
              <div>
                <Popover.Title>Select commits</Popover.Title>
                <Popover.Description>Choose one, or Shift-click for a continuous range.</Popover.Description>
              </div>
              <button
                onClick={() => {
                  setAnchorIndex(0)
                  void choose(0, session.commits.length - 1)
                }}
              >
                All commits
              </button>
            </div>
            <div className="commit-options">
              {session.commits.map((commit, index) => {
                const selected = index >= selectedStart && index <= selectedEnd
                return (
                  <label key={commit.oid} className={`commit-option ${selected ? 'selected' : ''}`}>
                    <Checkbox.Root
                      checked={selected}
                      onCheckedChange={(_checked, details) => {
                        const shiftKey = details.event instanceof MouseEvent && details.event.shiftKey
                        if (shiftKey && anchorIndex != null) void choose(anchorIndex, index)
                        else {
                          setAnchorIndex(index)
                          void choose(index, index)
                        }
                      }}
                      className="commit-checkbox"
                    >
                      <Checkbox.Indicator className="commit-checkbox-indicator">
                        <CheckIcon />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    <span className="commit-option-copy">
                      <span>{commit.subject}</span>
                      <small>
                        <code>{commit.shortOid}</code>
                        <span>{commit.author}</span>
                      </small>
                    </span>
                  </label>
                )
              })}
            </div>
            <div className="commit-menu-footer">
              Reviewing {selectedCount} of {session.commits.length} commits
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function FileRail({
  files,
  resolvedTheme,
  onSelect,
}: {
  files: FileDiffMetadata[]
  resolvedTheme: ResolvedTheme
  onSelect(id: string): void
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredFiles =
    normalizedQuery === ''
      ? files
      : files.filter((file) => file.name.toLowerCase().includes(normalizedQuery))
  const stats = new Map<string, FileChangeStats>()
  const treeKeyParts: string[] = []
  for (const file of filteredFiles) {
    const fileStats = fileChangeStats(file)
    stats.set(file.name, fileStats)
    treeKeyParts.push(
      `${file.name}:${file.type}:${fileStats.additions}:${fileStats.deletions}:${fileStats.modifications}`,
    )
  }
  const treeKey = treeKeyParts.join('|')

  return (
    <nav className="file-rail" aria-label="Changed files">
      <div className="rail-heading">
        <div className="rail-heading-title">
          <span>Files</span>
          <em>{normalizedQuery === '' ? files.length : `${filteredFiles.length}/${files.length}`}</em>
        </div>
        <input
          className="file-filter"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('')
          }}
          placeholder="Search"
          aria-label="Filter files"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {filteredFiles.length > 0 && (
        <ChangedFileTree
          key={treeKey}
          files={filteredFiles}
          stats={stats}
          resolvedTheme={resolvedTheme}
          onSelect={onSelect}
        />
      )}
      {files.length > 0 && filteredFiles.length === 0 && (
        <p className="file-filter-empty">No matching files</p>
      )}
    </nav>
  )
}

function ChangedFileTree({
  files,
  stats,
  resolvedTheme,
  onSelect,
}: {
  files: FileDiffMetadata[]
  stats: Map<string, FileChangeStats>
  resolvedTheme: ResolvedTheme
  onSelect(id: string): void
}) {
  const filePaths = new Set(files.map((file) => file.name))
  const gitStatus: GitStatusEntry[] = files.map((file) => ({
    path: file.name,
    status:
      file.type === 'new'
        ? 'added'
        : file.type === 'deleted'
          ? 'deleted'
          : file.type.startsWith('rename')
            ? 'renamed'
            : 'modified',
  }))
  const { model } = useFileTree({
    paths: files.map((file) => file.name),
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    density: 'compact',
    icons: { set: 'standard', colored: false },
    unsafeCSS: `
      [data-item-type="file"] > [data-item-section="icon"] { display: none; }
      [data-item-section="content"] { flex: 1 1 auto; }
      [data-item-section="decoration"] {
        flex: 0 0 auto;
        min-width: max-content;
        overflow: visible;
      }
      [data-item-section="decoration"] > span {
        min-width: max-content;
        max-width: none;
        overflow: visible;
      }
    `,
    gitStatus,
    onSelectionChange(selectedPaths) {
      const selectedFile = selectedPaths.find((path) => filePaths.has(path))
      if (selectedFile != null) onSelect(selectedFile)
    },
    renderRowDecoration({ item }) {
      if (item.kind !== 'file') return null
      const fileStats = stats.get(item.path)
      if (fileStats == null) return null
      const parts: { text: string; color: string }[] = []
      if (fileStats.additions > 0) {
        parts.push({ text: `+${fileStats.additions}`, color: 'var(--green)' })
      }
      if (fileStats.deletions > 0) {
        parts.push({
          text: `${parts.length > 0 ? ' ' : ''}-${fileStats.deletions}`,
          color: 'var(--red)',
        })
      }
      if (fileStats.modifications > 0) {
        parts.push({
          text: `${parts.length > 0 ? ' ' : ''}~${fileStats.modifications}`,
          color: 'var(--accent)',
        })
      }
      if (parts.length === 0) return null
      return {
        text: parts.map((part) => part.text).join(''),
        title: `${fileStats.additions} added, ${fileStats.deletions} deleted, ${fileStats.modifications} modified`,
        parts,
      }
    },
  })

  return (
    <FileTree
      model={model}
      className="changed-file-tree"
      style={{ colorScheme: resolvedTheme }}
    />
  )
}

function FileStageButton({
  filePath,
  onAdd,
}: {
  filePath: string
  onAdd(): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className="file-stage-button"
      disabled={busy}
      title={`git add -- ${filePath}`}
      onClick={async () => {
        setBusy(true)
        try {
          await onAdd()
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? 'Adding…' : 'Add'}
    </button>
  )
}

function FileViewedToggle({
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

function Inspector({
  session,
  files,
  onSetArchived,
  onUpdateComment,
  onUpdateGlobalComment,
  allowGlobalComment,
  onArchiveAll,
  onNavigate,
}: {
  session: ReviewSession
  files: FileDiffMetadata[]
  onSetArchived(annotationId: string, archived: boolean): Promise<void>
  onUpdateComment(annotationId: string, comment: string): Promise<void>
  onUpdateGlobalComment(comment: string): Promise<void>
  allowGlobalComment: boolean
  onArchiveAll(): Promise<void>
  onNavigate(annotation: SessionAnnotation): void
}) {
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [commentsCopied, setCommentsCopied] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [globalEditing, setGlobalEditing] = useState(false)
  const active = session.annotations.filter((annotation) => annotation.archivedAt == null)
  const archived = session.annotations.filter((annotation) => annotation.archivedAt != null)
  const myComments = active.filter(
    (annotation) => annotation.source === 'user' && Boolean(annotation.comment?.trim()),
  )
  const visible = view === 'active' ? active : archived
  const showGlobalComment =
    allowGlobalComment &&
    view === 'active' &&
    (session.globalComment != null || globalEditing)

  return (
    <aside className="inspector">
      <section className="notes-panel">
        <div className="notes-heading">
          <span>Annotations</span>
          <div>
            {allowGlobalComment &&
              view === 'active' &&
              session.globalComment == null &&
              !globalEditing && (
              <AnnotationIconButton
                label="Add global comment"
                onClick={() => setGlobalEditing(true)}
              >
                <AddCommentIcon />
              </AnnotationIconButton>
            )}
            {((allowGlobalComment && session.globalComment != null) || myComments.length > 0) && (
              <AnnotationIconButton
                label={commentsCopied ? 'Copied' : 'Copy my comments'}
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    await formatCommentsForAgent(
                      session.id,
                      allowGlobalComment ? session.globalComment : null,
                      myComments,
                      files,
                    ),
                  )
                  setCommentsCopied(true)
                  window.setTimeout(() => setCommentsCopied(false), 1600)
                }}
              >
                {commentsCopied ? <CheckIcon /> : <CopyIcon />}
              </AnnotationIconButton>
            )}
            {view === 'active' && active.length > 0 && (
              <AnnotationIconButton
                label="Archive all"
                disabled={bulkBusy}
                onClick={async () => {
                  setBulkBusy(true)
                  try {
                    await onArchiveAll()
                  } finally {
                    setBulkBusy(false)
                  }
                }}
              >
                <ArchiveIcon />
              </AnnotationIconButton>
            )}
            <em>{active.length}</em>
          </div>
        </div>
        <ToggleGroup
          className="annotation-filter"
          aria-label="Annotation view"
          value={[view]}
          onValueChange={(value) => {
            const next = value.at(0)
            if (next === 'active' || next === 'archived') setView(next)
          }}
        >
          <Toggle value="active">Active {active.length}</Toggle>
          <Toggle value="archived">Archived {archived.length}</Toggle>
        </ToggleGroup>
        {visible.length === 0 && !showGlobalComment ? (
          <p className="notes-empty">
            {view === 'active'
              ? 'Comments and importance highlights will collect here.'
              : 'Archived annotations will remain available here.'}
          </p>
        ) : (
          <div className="notes-list">
            {showGlobalComment && (
              <article className="note-card global-comment-card">
                <div className="global-comment-heading">
                  <strong>Global comment</strong>
                  {session.globalComment != null && !globalEditing && (
                    <AnnotationIconButton
                      label="Edit global comment"
                      onClick={() => setGlobalEditing(true)}
                    >
                      <EditIcon />
                    </AnnotationIconButton>
                  )}
                </div>
                {globalEditing ? (
                  <CommentEditor
                    comment={session.globalComment ?? ''}
                    onCancel={() => setGlobalEditing(false)}
                    onSave={async (comment) => {
                      await onUpdateGlobalComment(comment)
                      setGlobalEditing(false)
                    }}
                  />
                ) : (
                  <p>{session.globalComment}</p>
                )}
              </article>
            )}
            {visible.map((annotation) => {
              const viewed = session.viewedFiles.includes(annotation.filePath)
              const editing = editingId === annotation.id
              return (
                <article key={annotation.id} className="note-card">
                  <button className="note-target" onClick={() => onNavigate(annotation)}>
                    <span
                      className={`note-viewed-status ${viewed ? 'viewed' : ''}`}
                      aria-label={viewed ? 'Viewed' : 'Not viewed'}
                      title={viewed ? 'Viewed' : 'Not viewed'}
                    >
                      {viewed && <CheckIcon />}
                    </span>
                    <code>{compactPath(annotation.filePath)}</code>
                    <span className={`note-position ${annotation.side}`}>
                      {annotationPosition(annotation)}
                    </span>
                  </button>
                  {editing ? (
                    <CommentEditor
                      comment={annotation.comment ?? ''}
                      onCancel={() => setEditingId(null)}
                      onSave={async (comment) => {
                        await onUpdateComment(annotation.id, comment)
                        setEditingId(null)
                      }}
                    />
                  ) : annotation.comment != null ? (
                    <p>{annotation.comment}</p>
                  ) : null}
                  <footer>
                    <div className="note-source">
                      <span className={`source ${annotation.source}`}>{annotation.source}</span>
                      {annotation.importance != null && (
                        <span className="importance-inline">
                          importance {formatImportance(annotation.importance)}
                        </span>
                      )}
                    </div>
                    <div className="note-actions">
                      {annotation.source === 'user' && annotation.comment != null && !editing && (
                        <AnnotationIconButton
                          label="Edit comment"
                          onClick={() => {
                            setEditingId(annotation.id)
                          }}
                        >
                          <EditIcon />
                        </AnnotationIconButton>
                      )}
                      <AnnotationIconButton
                        label={view === 'active' ? 'Archive' : 'Restore'}
                        disabled={busyId === annotation.id}
                        onClick={async () => {
                          setBusyId(annotation.id)
                          try {
                            await onSetArchived(annotation.id, view === 'active')
                          } finally {
                            setBusyId(null)
                          }
                        }}
                      >
                        {view === 'active' ? <ArchiveIcon /> : <RestoreIcon />}
                      </AnnotationIconButton>
                    </div>
                  </footer>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </aside>
  )
}

function CommentEditor({
  comment,
  onCancel,
  onSave,
}: {
  comment: string
  onCancel(): void
  onSave(comment: string): Promise<void>
}) {
  const [value, setValue] = useState(comment)
  const [busy, setBusy] = useState(false)
  return (
    <div className="note-editor">
      <textarea autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
      <div>
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          disabled={busy || !value.trim()}
          onClick={async () => {
            setBusy(true)
            try {
              await onSave(value.trim())
            } finally {
              setBusy(false)
            }
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

function AnnotationIconButton({
  label,
  className,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'> & {
  label: string
  children: ReactNode
}) {
  const trigger = (
    <button
      {...props}
      className={`annotation-action-button${className == null ? '' : ` ${className}`}`}
      aria-label={label}
    >
      {children}
    </button>
  )
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={trigger} />
      <Tooltip.Portal>
        <Tooltip.Positioner className="tooltip-positioner" sideOffset={6}>
          <Tooltip.Popup className="tooltip-popup">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function InlineComposer({
  comment,
  error,
  busy,
  onCommentChange,
  onCancel,
  onSubmit,
}: {
  comment: string
  error: string | null
  busy: boolean
  onCommentChange(comment: string): void
  onCancel(): void
  onSubmit(): Promise<void>
}) {
  return (
    <section className="inline-composer">
      <div className="composer-heading">
        <span><CommentIcon /> Add comment</span>
        <button onClick={onCancel} aria-label="Cancel selection">
          <CloseIcon />
        </button>
      </div>
      <textarea
        autoFocus
        value={comment}
        onChange={(event) => onCommentChange(event.target.value)}
        placeholder="What should the reviewer know?"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void onSubmit()
        }}
      />
      {error != null && <div className="composer-error">{error}</div>}
      <div className="composer-actions">
        <small>⌘ Enter</small>
        <button disabled={!comment.trim() || busy} onClick={() => void onSubmit()}>
          Add comment
        </button>
      </div>
    </section>
  )
}

function InlineAnnotation({
  annotation,
  onArchive,
  onUpdateComment,
}: {
  annotation: SessionAnnotation
  onArchive(): Promise<void>
  onUpdateComment(comment: string): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  return (
    <div className={`inline-annotation ${annotation.source}`}>
      <div className="inline-source">
        <div>
          <span>{annotation.source === 'agent' ? 'Agent note' : 'Review comment'}</span>
          <code>{lineLabel(annotation)}</code>
        </div>
        <div>
          {annotation.source === 'user' && annotation.comment != null && !editing && (
            <AnnotationIconButton
              label="Edit comment"
              onClick={() => setEditing(true)}
            >
              <EditIcon />
            </AnnotationIconButton>
          )}
          <AnnotationIconButton
            label="Archive"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onArchive()
              } finally {
                setBusy(false)
              }
            }}
          >
            <ArchiveIcon />
          </AnnotationIconButton>
        </div>
      </div>
      {editing ? (
        <CommentEditor
          comment={annotation.comment ?? ''}
          onCancel={() => setEditing(false)}
          onSave={async (comment) => {
            await onUpdateComment(comment)
            setEditing(false)
          }}
        />
      ) : (
        <p>{annotation.comment}</p>
      )}
    </div>
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
  selection: CodeViewLineSelection | null,
): DiffLineAnnotation<ReviewLineAnnotation>[] {
  const result: DiffLineAnnotation<ReviewLineAnnotation>[] = annotations
    .filter(
      (annotation) =>
        annotation.comment != null &&
        annotation.archivedAt == null &&
        (annotation.filePath === fileDiff.name || annotation.filePath === fileDiff.prevName),
    )
    .map((annotation) => ({
      side: (annotation.endSide ?? annotation.side) === 'new' ? 'additions' : 'deletions',
      lineNumber: annotation.endLine,
      metadata: { kind: 'saved', annotation },
    }))

  if (
    selection != null &&
    (selection.id === fileDiff.name || selection.id === fileDiff.prevName)
  ) {
    const side = selection.range.endSide ?? selection.range.side ?? 'additions'
    const lineNumber = selection.range.endSide == null
      ? Math.max(selection.range.start, selection.range.end)
      : selection.range.end
    result.push({
      side,
      lineNumber,
      metadata: { kind: 'composer', selection },
    })
  }
  return result
}

function routeFromLocation(): AppRoute {
  const sessionMatch = /^\/s\/([^/]+)$/.exec(window.location.pathname)
  if (sessionMatch != null) {
    try {
      return { kind: 'session', sessionId: decodeURIComponent(sessionMatch[1] ?? '') }
    } catch {
      return { kind: 'root' }
    }
  }
  if (window.location.pathname === '/pull-requests') {
    const query = new URLSearchParams(window.location.search)
    const repositoryPath = query.get('repo')
    if (repositoryPath != null) {
      const rawNumber = query.get('pr')
      const parsedNumber = rawNumber == null ? null : Number(rawNumber)
      return {
        kind: 'pull-requests',
        repositoryPath,
        pullRequestNumber:
          parsedNumber != null && Number.isInteger(parsedNumber) && parsedNumber > 0
            ? parsedNumber
            : null,
        revisionId: query.get('revision'),
      }
    }
  }
  return { kind: 'root' }
}

function lineLabel(annotation: SessionAnnotation): string {
  const prefix = annotation.side === 'new' ? '+' : '−'
  if (annotation.endSide != null && annotation.endSide !== annotation.side) {
    const endPrefix = annotation.endSide === 'new' ? '+' : '−'
    return `${prefix}${annotation.startLine} → ${endPrefix}${annotation.endLine}`
  }
  return `${prefix}${annotation.startLine}${annotation.startLine === annotation.endLine ? '' : `–${annotation.endLine}`}`
}

async function formatCommentsForAgent(
  sessionId: string,
  globalComment: string | null,
  annotations: SessionAnnotation[],
  files: FileDiffMetadata[],
): Promise<string> {
  const contents = new Map<string, Promise<string | null>>()
  const comments = await Promise.all(annotations.map(async (annotation) => {
    const file = files.find(
      (candidate) =>
        candidate.name === annotation.filePath || candidate.prevName === annotation.filePath,
    )
    const filePath = annotation.side === 'old'
      ? file?.prevName ?? annotation.filePath
      : file?.name ?? annotation.filePath
    const key = `${annotation.side}:${filePath}`
    let contentsRequest = contents.get(key)
    if (contentsRequest == null) {
      contentsRequest = getFileContents(sessionId, filePath, annotation.side)
      contents.set(key, contentsRequest)
    }
    const fileContents = await contentsRequest
    const code = truncateCodeLine(fileContents?.split('\n')[annotation.startLine - 1] ?? '')
    return `> ${annotation.filePath}:${annotationPosition(annotation)}: ${code}\n\n${annotation.comment!.trim()}`
  }))
  return [globalComment?.trim(), ...comments].filter(Boolean).join('\n\n')
}

function annotationPosition(annotation: SessionAnnotation): string {
  const start = `${annotation.side}:${annotation.startLine}`
  if (annotation.endSide != null && annotation.endSide !== annotation.side) {
    return `${start}->${annotation.endSide}:${annotation.endLine}`
  }
  return annotation.startLine === annotation.endLine ? start : `${start}-${annotation.endLine}`
}

function truncateCodeLine(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > 100 ? `${trimmed.slice(0, 99)}…` : trimmed
}

function annotationRangeFromSelection(selection: CodeViewLineSelection): {
  side: DiffSide
  startLine: number
  endSide?: DiffSide
  endLine: number
} {
  const side = selectionSideToDiffSide(selection.range.side)
  const endSide = selectionSideToDiffSide(selection.range.endSide ?? selection.range.side)
  if (side !== endSide) {
    return {
      side,
      startLine: selection.range.start,
      endSide,
      endLine: selection.range.end,
    }
  }
  return {
    side,
    startLine: Math.min(selection.range.start, selection.range.end),
    endLine: Math.max(selection.range.start, selection.range.end),
  }
}

function selectionSideToDiffSide(side: 'deletions' | 'additions' | undefined): DiffSide {
  return side === 'deletions' ? 'old' : 'new'
}

function areCodeViewSelectionsEqual(
  left: CodeViewLineSelection,
  right: CodeViewLineSelection | null,
): boolean {
  return right != null &&
    left.id === right.id &&
    left.range.start === right.range.start &&
    left.range.end === right.range.end &&
    left.range.side === right.range.side &&
    left.range.endSide === right.range.endSide
}

function fileHeaderIdFromEvent(event: MouseEvent): string | null {
  const path = event.composedPath()
  const clickedHeader = path.some(
    (target) => target instanceof HTMLElement && target.hasAttribute('data-diffs-header'),
  )
  if (!clickedHeader) return null
  const container = path.find(
    (target) => target instanceof HTMLElement && target.tagName === 'DIFFS-CONTAINER',
  )
  if (!(container instanceof HTMLElement)) return null
  return container.querySelector<HTMLElement>('[data-file-id]')?.dataset.fileId ?? null
}

function fileChangeStats(file: FileDiffMetadata): FileChangeStats {
  const stats: FileChangeStats = { additions: 0, deletions: 0, modifications: 0 }
  for (const hunk of file.hunks) {
    for (const content of hunk.hunkContent) {
      if (content.type !== 'change') continue
      const modifications = Math.min(content.additions, content.deletions)
      stats.modifications += modifications
      stats.additions += content.additions - modifications
      stats.deletions += content.deletions - modifications
    }
  }
  return stats
}

function formatImportance(importance: number): string {
  return importance.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

function storedPanelWidth(
  side: 'left' | 'right',
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(window.localStorage.getItem(`diff-review-${side}-panel-width`))
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback
}

function storePanelWidth(side: 'left' | 'right', width: number): void {
  window.localStorage.setItem(`diff-review-${side}-panel-width`, String(width))
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

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

function repositoryNameFromPath(repositoryPath: string): string {
  return repositoryPath.replace(/\/$/, '').split('/').at(-1) || repositoryPath
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function checkStatusLabel(status: PullRequestSummary['checkStatus']): string {
  switch (status) {
    case 'none':
      return 'No checks'
    case 'pending':
      return 'Pending'
    case 'pass':
      return 'Passing'
    case 'fail':
      return 'Failing'
  }
}

function activityLabel(activity: PullRequestActivity): string {
  if (activity.kind === 'comment') return 'Commented'
  if (activity.kind === 'review-comment') return 'Review comment'
  return titleCase(activity.state.replaceAll('_', ' '))
}

function piReviewButtonLabel(status: PiReviewStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Review with Pi'
    case 'running':
      return 'Pi reviewing…'
    case 'completed':
      return 'Run Pi again'
    case 'failed':
      return 'Retry Pi review'
  }
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function useThemePreference(): {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference(theme: ThemePreference): void
} {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const stored = window.localStorage.getItem('diff-review-theme')
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  })
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const resolved = preference === 'system' ? systemTheme : preference

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = () => setSystemTheme(media.matches ? 'dark' : 'light')
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.documentElement.style.colorScheme = resolved
    if (preference === 'system') window.localStorage.removeItem('diff-review-theme')
    else window.localStorage.setItem('diff-review-theme', preference)
  }, [preference, resolved])

  return { preference, resolved, setPreference }
}
