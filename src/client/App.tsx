import {
  CodeView,
  FileDiff,
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
import { parseReviewCommentDiff } from '../shared/reviewCommentDiff'
import { Checkbox } from '@base-ui/react/checkbox'
import { Menu } from '@base-ui/react/menu'
import { Popover } from '@base-ui/react/popover'
import { Toggle } from '@base-ui/react/toggle'
import { ToggleGroup } from '@base-ui/react/toggle-group'
import { Tooltip } from '@base-ui/react/tooltip'
import type { GitStatusEntry } from '@pierre/trees'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { Provider, createStore, useAtom, useAtomValue, useSetAtom, useStore } from 'jotai'
import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
  MessageSquarePlus as AddCommentIcon,
  Archive as ArchiveIcon,
  GitBranch as BranchIcon,
  Flag as FlagIcon,
  GitMerge as MergeIcon,
  GitPullRequest as PullRequestIcon,
  Check as CheckIcon,
  CheckCheck as ChecksPassedIcon,
  ChevronDown as ChevronIcon,
  CircleDot as IssueIcon,
  X as CloseIcon,
  MessageSquare as CommentIcon,
  GitCommitHorizontal as CommitIcon,
  Copy as CopyIcon,
  Pencil as EditIcon,
  RefreshCw as RefreshIcon,
  Lock as LockIcon,
  FolderGit2 as RepositoryIcon,
  RotateCcw as RestoreIcon,
  Rocket as DeployIcon,
  Tag as TagIcon,
  SunMoon as ThemeIcon,
  Unlock as UnlockIcon,
  UserMinus as UserMinusIcon,
  UserPlus as UserPlusIcon,
  TextWrap as WrapIcon,
  Spline as DifftasticIcon,
  CircleCheck,
} from 'lucide-react'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  isValidElement,
} from 'react'

import { remarkIssueReferences } from '../shared/markdown'
import { reviewTargetsEqual, targetSupportsStaging, type DiffRenderer } from '../shared/types'
import type {
  AnnotationIntent,
  DiffSide,
  GitHubIssueReference,
  GitHubUser,
  MinimizedCommentReason,
  PiReviewRun,
  PiReviewStatus,
  PullRequestActivity,
  PullRequestDetails,
  PullRequestReviewEvent,
  PullRequestCheckRun,
  PullRequestCheckRunStatus,
  PullRequestListView,
  PullRequestRevision,
  PullRequestSummary,
  PullRequestWorkspace,
  RepositoryInfo,
  ReviewSession,
  ReviewTarget,
  SessionAnnotation,
} from '../shared/types'
import { pullRequestAllowsReviewEvent } from '../shared/pull-request'
import { groupConversationActivities, type ReviewCommentThread } from '../shared/pullRequestActivity'
import {
  addAnnotation,
  addPullRequestComment,
  archiveAllAnnotations,
  createSession,
  getFileContents,
  getDifftasticAvailability,
  getPiReviewStatus,
  getPullRequestRevisions,
  getPullRequests,
  getRepositoryInfo,
  getSession,
  getSessions,
  openPullRequest,
  removePullRequestLabel,
  refreshSession,
  selectCommits,
  setAnnotationArchived,
  setFileViewed,
  setIgnoreWhitespace,
  stageFile,
  squashMergePullRequest,
  submitPullRequestReview,
  startPiReview,
  updateAnnotationComment,
  updateGlobalComment,
} from './api'
import { applyImportance } from './importance'
import { DifftasticView } from './DifftasticView'
import {
  EMPTY_COMPOSER_DRAFT,
  areCodeViewSelectionsEqual,
  buildCodeViewItems,
  composerDraftAtom,
  composerSelectionAtom,
  composerSessionIdAtom,
  fileCollapsedAtom,
  fileViewedAtom,
  reviewCommentAvailableAtom,
  type ReviewLineAnnotation,
} from './annotationComposer'

type DiffLayout = 'unified' | 'split'
type DiffOverflow = 'wrap' | 'scroll'
type PullRequestViewMode = 'overview' | 'diff'
type ThemePreference = 'system' | 'light' | 'dark'
type ResolvedTheme = 'light' | 'dark'

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
  onOpenCommit(commitId: string): Promise<void>
  onStartPiReview(additionalInstructions: string): Promise<void>
  onRemoveAdditionalReviewLabel(): Promise<void>
  onAddComment(body: string, replyToId?: string | null): Promise<void>
  onSubmitReview(event: PullRequestReviewEvent, body: string): Promise<void>
  onSquashMerge(): Promise<void>
}

interface FileChangeStats {
  additions: number
  deletions: number
  modifications: number
}

function pullRequestWorkspaceQueryKey(
  repositoryPath: string,
  number: number | null,
  revisionId: string | null,
) {
  return ['pull-request-workspace', repositoryPath, number, revisionId ?? 'current'] as const
}

function isAnnotationSubmitEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  return event.key === 'Enter' &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229
}

function queryErrorMessage(error: unknown): string | null {
  if (error == null) return null
  return error instanceof Error ? error.message : String(error)
}

function pullRequestRevisionHead(session: ReviewSession): string {
  if (session.target.kind !== 'pr' || session.revisionHeadOid == null) {
    throw new Error('The selected pull request revision has no head commit')
  }
  return session.revisionHeadOid
}

function pendingReviewComments(session: ReviewSession): SessionAnnotation[] {
  return session.annotations.filter((annotation) =>
    annotation.source === 'user' &&
    annotation.intent === 'review-comment' &&
    annotation.archivedAt == null &&
    annotation.submittedAt == null &&
    Boolean(annotation.comment?.trim()) &&
    annotation.endSide == null,
  )
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
    <ReviewWorkspaceStore key={session.id} sessionId={session.id}>
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
    </ReviewWorkspaceStore>
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
  const queryClient = useQueryClient()
  const number = route.pullRequestNumber
  const workspaceKey = useMemo(
    () => pullRequestWorkspaceQueryKey(route.repositoryPath, number, route.revisionId),
    [number, route.repositoryPath, route.revisionId],
  )
  const repositoryQuery = useQuery({
    queryKey: ['repository', route.repositoryPath],
    queryFn: () => getRepositoryInfo(route.repositoryPath),
  })
  const pullRequestsQuery = useQuery({
    queryKey: ['pull-requests', route.repositoryPath, view],
    queryFn: () => getPullRequests(route.repositoryPath, view),
  })
  const workspaceQuery = useQuery({
    queryKey: workspaceKey,
    queryFn: number == null
      ? skipToken
      : () => openPullRequest(number, {
          repositoryPath: route.repositoryPath,
          revisionId: route.revisionId,
        }),
  })
  const repository = repositoryQuery.data ?? null
  const pullRequests = pullRequestsQuery.data ?? []
  const workspace = workspaceQuery.data
  const details = workspace?.details ?? null
  const session = workspace?.selectedSession ?? null
  const currentSessionId = workspace?.currentSession.id ?? null
  const revisions = workspace?.revisions ?? []
  const piStatus = workspace?.piStatus ?? { state: 'idle' }
  const listLoading = pullRequestsQuery.isPending
  const listError = queryErrorMessage(pullRequestsQuery.error)
  const detailLoading = number != null && workspaceQuery.isPending
  const detailError = queryErrorMessage(workspaceQuery.error)

  const updateWorkspace = useCallback(
    (update: (current: PullRequestWorkspace) => PullRequestWorkspace) => {
      let updated: PullRequestWorkspace | undefined
      queryClient.setQueryData<PullRequestWorkspace>(workspaceKey, (current) => {
        updated = current == null ? undefined : update(current)
        return updated
      })
      if (
        number != null &&
        route.revisionId != null &&
        updated != null &&
        updated.selectedSession.id === updated.currentSession.id
      ) {
        queryClient.setQueryData(
          pullRequestWorkspaceQueryKey(route.repositoryPath, number, null),
          updated,
        )
      }
    },
    [number, queryClient, route.repositoryPath, route.revisionId, workspaceKey],
  )

  const refreshPullRequestData = useCallback((pullRequestNumber: number) => {
    void Promise.all([
      queryClient.invalidateQueries({
        queryKey: ['pull-request-workspace', route.repositoryPath, pullRequestNumber],
      }),
      queryClient.invalidateQueries({ queryKey: ['pull-requests', route.repositoryPath] }),
    ])
  }, [queryClient, route.repositoryPath])

  useEffect(() => {
    if (number == null || route.revisionId != null || workspace == null) return
    const revisionId = workspace.currentSession.id
    queryClient.setQueryData(
      pullRequestWorkspaceQueryKey(route.repositoryPath, number, revisionId),
      workspace,
    )
    onOpenPullRequests(route.repositoryPath, number, revisionId, true)
  }, [
    number,
    onOpenPullRequests,
    queryClient,
    route.repositoryPath,
    route.revisionId,
    workspace,
  ])

  useEffect(() => {
    if (session == null || number == null) return
    const sessionId = session.id
    const events = new EventSource(`/api/events?session=${encodeURIComponent(sessionId)}`)
    events.onmessage = () => {
      void Promise.all([
        getSession(sessionId),
        getPullRequestRevisions(route.repositoryPath, number),
        getPiReviewStatus(sessionId),
      ]).then(([nextSession, nextRevisions, nextPiStatus]) => {
        updateWorkspace((current) => ({
          ...current,
          currentSession: current.currentSession.id === sessionId
            ? nextSession
            : current.currentSession,
          selectedSession: nextSession,
          revisions: nextRevisions,
          piStatus: nextPiStatus,
        }))
      })
    }
    return () => events.close()
  }, [number, route.repositoryPath, session?.id, updateWorkspace])

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
          <RepositoryPicker
            repositoryRoot={route.repositoryPath}
            repositoryName={repository?.name ?? repositoryNameFromPath(route.repositoryPath)}
            onSelect={onOpenPullRequests}
          />
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

  return (
    <ReviewWorkspaceStore key={session.id} sessionId={session.id}>
    <ReviewWorkspace
      session={session}
      error={detailError}
      onSessionChange={(nextSession) => updateWorkspace((current) => ({
        ...current,
        currentSession: current.currentSession.id === nextSession.id
          ? nextSession
          : current.currentSession,
        selectedSession: nextSession,
      }))}
      onOpenSession={onOpenSession}
      onOpenPullRequests={onOpenPullRequests}
      onReload={async () => {
        const nextSession = await getSession(session.id)
        updateWorkspace((current) => ({
          ...current,
          currentSession: current.currentSession.id === nextSession.id
            ? nextSession
            : current.currentSession,
          selectedSession: nextSession,
        }))
      }}
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
        onOpenCommit: async (commitId) => {
          const next = await createSession({
            repositoryPath: route.repositoryPath,
            target: { kind: 'range', expression: commitId },
          })
          onOpenSession(next.id)
        },
        onStartPiReview: async (additionalInstructions) => {
          const nextPiStatus = await startPiReview(session.id, { additionalInstructions })
          updateWorkspace((current) => ({ ...current, piStatus: nextPiStatus }))
        },
        onRemoveAdditionalReviewLabel: async () => {
          await removePullRequestLabel(
            details.number,
            'additional-review-needed',
            { repositoryPath: route.repositoryPath },
          )
          queryClient.setQueriesData<PullRequestWorkspace>(
            { queryKey: ['pull-request-workspace', route.repositoryPath, details.number] },
            (current) => current == null ? undefined : ({
              ...current,
              details: {
                ...current.details,
                labels: current.details.labels.filter(
                  (label) => label.name !== 'additional-review-needed',
                ),
              },
            }),
          )
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: ['pull-request-workspace', route.repositoryPath, details.number],
            }),
            queryClient.invalidateQueries({
              queryKey: ['pull-requests', route.repositoryPath],
            }),
          ])
        },
        onAddComment: async (body, replyToId) => {
          await addPullRequestComment(details.number, {
            repositoryPath: route.repositoryPath,
            body,
            replyToId,
          })
          refreshPullRequestData(details.number)
        },
        onSubmitReview: async (event, body) => {
          await submitPullRequestReview(details.number, {
            repositoryPath: route.repositoryPath,
            event,
            body,
            sessionId: session.id,
          })
          refreshPullRequestData(details.number)
        },
        onSquashMerge: async () => {
          await squashMergePullRequest(details.number, {
            repositoryPath: route.repositoryPath,
            expectedHeadOid: pullRequestRevisionHead(session),
          })
          refreshPullRequestData(details.number)
        },
      }}
    />
    </ReviewWorkspaceStore>
  )
}

function ReviewWorkspaceStore({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  const [store] = useState(() => {
    const next = createStore()
    next.set(composerSessionIdAtom, sessionId)
    next.set(composerSelectionAtom, null)
    next.set(composerDraftAtom, EMPTY_COMPOSER_DRAFT)
    return next
  })
  return <Provider store={store}>{children}</Provider>
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
  const [renderer, setRenderer] = useState<DiffRenderer>(() => storedDiffRenderer())
  const [overflow, setOverflow] = useState<DiffOverflow>('wrap')
  const [pullRequestView, setPullRequestView] = useState<PullRequestViewMode>('overview')
  const overviewScrollRef = useRef<HTMLElement>(null)
  const diffWorkspaceRef = useRef<HTMLDivElement>(null)
  const hoveredFileRef = useRef<string | null>(null)
  const pullRequestScrollPositions = useRef<Record<PullRequestViewMode, number>>({
    overview: 0,
    diff: 0,
  })
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [composerSelection, setComposerSelection] = useAtom(composerSelectionAtom)
  const setComposerDraft = useSetAtom(composerDraftAtom)
  const setReviewCommentAvailable = useSetAtom(reviewCommentAvailableAtom)
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
  const previousItemsRef = useRef<CodeViewItem<ReviewLineAnnotation>[]>([])
  const store = useStore()
  const composerSelectionRef = useRef(composerSelection)
  const onReloadRef = useRef(onReload)
  composerSelectionRef.current = composerSelection
  onReloadRef.current = onReload

  const setFileCollapsed = useCallback((filePath: string, collapsed: boolean) => {
    store.set(fileCollapsedAtom(filePath), collapsed)
    setCollapsedFiles((current) => {
      if (current.has(filePath) === collapsed) return current
      const next = new Set(current)
      if (collapsed) next.add(filePath)
      else next.delete(filePath)
      return next
    })
  }, [store])

  useEffect(() => {
    setSelection(null)
    setComposerSelection(null)
    setComposerDraft(EMPTY_COMPOSER_DRAFT)
  }, [session.patch, setComposerDraft, setComposerSelection])

  useEffect(() => {
    setReviewCommentAvailable(
      pullRequest != null && session.id === pullRequest.currentSessionId,
    )
  }, [pullRequest, session.id, setReviewCommentAvailable])

  useEffect(() => {
    setCollapsedFiles(new Set(session.viewedFiles))
  }, [session.id])

  useEffect(() => {
    setPullRequestView('overview')
    pullRequestScrollPositions.current = { overview: 0, diff: 0 }
    window.requestAnimationFrame(() => {
      if (overviewScrollRef.current != null) overviewScrollRef.current.scrollTop = 0
      const diffScroller = diffWorkspaceRef.current?.querySelector<HTMLElement>('.diff-view')
      if (diffScroller != null) diffScroller.scrollTop = 0
    })
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

  useLayoutEffect(() => {
    for (const file of parsedFiles) {
      store.set(fileCollapsedAtom(file.name), collapsedFiles.has(file.name))
      store.set(fileViewedAtom(file.name), viewedFiles.has(file.name))
    }
  }, [collapsedFiles, parsedFiles, store, viewedFiles])

  const items = useMemo<CodeViewItem<ReviewLineAnnotation>[]>(() => {
    const nextItems = buildCodeViewItems(
      parsedFiles,
      session.annotations,
      composerSelection,
      collapsedFiles,
      session.id,
      session.updatedAt,
      previousItemsRef.current,
    )
    previousItemsRef.current = nextItems
    return nextItems
  }, [collapsedFiles, composerSelection, parsedFiles, session.annotations, session.id, session.updatedAt])

  const openComposer = useCallback((next: CodeViewLineSelection) => {
    setSelection(next)
    const current = composerSelectionRef.current
    if (current != null && areCodeViewSelectionsEqual(current, next)) return
    setComposerSelection(next)
    setComposerDraft(EMPTY_COMPOSER_DRAFT)
  }, [setComposerDraft, setComposerSelection])

  const closeComposer = useCallback(() => {
    setSelection(null)
    setComposerSelection(null)
    setComposerDraft(EMPTY_COMPOSER_DRAFT)
  }, [setComposerDraft, setComposerSelection])

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
        openComposer({ id: context.item.id, range })
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
    [layout, openComposer, overflow, resolvedTheme, session.annotations, session.id, session.updatedAt],
  )

  const handleSelection = useCallback((next: CodeViewLineSelection | null) => {
    if (next == null && composerSelectionRef.current != null) {
      setComposerSelection(null)
      setComposerDraft(EMPTY_COMPOSER_DRAFT)
    }
    setSelection(next)
  }, [setComposerDraft, setComposerSelection])

  const setArchived = useCallback(async (annotationId: string, archived: boolean) => {
    await setAnnotationArchived(session.id, annotationId, archived)
    await onReload()
  }, [onReload, session.id])

  const editAnnotation = useCallback(async (
    annotationId: string,
    nextComment: string,
    intent?: AnnotationIntent,
  ) => {
    await updateAnnotationComment(session.id, annotationId, {
      comment: nextComment,
      intent,
    })
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
    store.set(fileViewedAtom(filePath), viewed)
    setFileCollapsed(filePath, viewed)
    onSessionChange(updated)
  }, [onSessionChange, session.id, setFileCollapsed, store])

  const addFile = useCallback(async (filePath: string) => {
    onSessionChange(await stageFile(session.id, filePath))
  }, [onSessionChange, session.id])

  const stagingEnabled = targetSupportsStaging(session.target)
  const renderHeaderFilenameSuffix = useCallback((item: CodeViewItem<ReviewLineAnnotation>) => (
    <FileCopyButton filePath={item.id} />
  ), [])

  const renderHeaderMetadata = useCallback((item: CodeViewItem<ReviewLineAnnotation>) => (
    <FileHeaderControls
      filePath={item.id}
      stagingEnabled={stagingEnabled}
      onToggleCollapsed={setFileCollapsed}
      onAdd={addFile}
      onSetViewed={setViewed}
    />
  ), [addFile, setFileCollapsed, setViewed, stagingEnabled])

  const handleComposerSubmitted = useCallback(async () => {
    closeComposer()
    await onReloadRef.current()
  }, [closeComposer])

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<ReviewLineAnnotation>) => {
    const metadata = annotation.metadata
    if (metadata == null) return null
    return metadata.kind === 'composer' ? (
      <InlineComposer
        selection={metadata.selection}
        onCancel={closeComposer}
        onSubmitted={handleComposerSubmitted}
      />
    ) : (
      <InlineAnnotation
        annotation={metadata.annotation}
        onArchive={() => setArchived(metadata.annotation.id, true)}
        onUpdateComment={(comment, intent) => editAnnotation(metadata.annotation.id, comment, intent)}
      />
    )
  }, [closeComposer, editAnnotation, handleComposerSubmitted, setArchived])

  useHotkey('V', () => {
    const viewer = viewerRef.current?.getInstance()
    let filePath = hoveredFileRef.current ?? selection?.id ?? items.at(0)?.id

    if (hoveredFileRef.current == null && selection == null && viewer != null) {
      const scrollTop = viewer.getScrollTop()
      for (const item of items) {
        const itemTop = viewer.getTopForItem(item.id)
        if (itemTop == null) continue
        if (itemTop > scrollTop) break
        filePath = item.id
      }
    }

    if (filePath == null) return
    void setViewed(filePath, !viewedFiles.has(filePath)).catch((caught) => {
      console.error(`Could not toggle viewed state for ${filePath}`, caught)
    })
  }, {
    enabled: (pullRequest == null || pullRequestView === 'diff') && items.length > 0,
    ignoreInputs: true,
    requireReset: true,
    meta: {
      name: 'Toggle viewed file',
      description: 'Toggle the current file as viewed',
    },
  })

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


  const difftasticQuery = useQuery({
    queryKey: ['difftastic-availability'],
    queryFn: getDifftasticAvailability,
    staleTime: 30_000,
  })
  const difftastic = difftasticQuery.data
  const difftasticReady = difftastic?.available === true
  const selectFile = useCallback((id: string) => {
    setFileCollapsed(id, false)
    window.requestAnimationFrame(() => {
      if (renderer === 'difftastic') {
        const scroller = diffWorkspaceRef.current?.querySelector<HTMLElement>('.diff-view')
        const node = scroller?.querySelector<HTMLElement>(
          `[data-file-id="${cssEscape(id)}"]`,
        )
        if (scroller != null && node != null) scroller.scrollTop = node.offsetTop - 8
        return
      }
      viewerRef.current?.scrollTo({ type: 'item', id, align: 'start', offset: 8 })
    })
  }, [renderer, setFileCollapsed])

  const switchPullRequestView = useCallback((next: PullRequestViewMode) => {
    if (next === pullRequestView) return
    const currentScroller = pullRequestView === 'overview'
      ? overviewScrollRef.current
      : diffWorkspaceRef.current?.querySelector<HTMLElement>('.diff-view')
    pullRequestScrollPositions.current[pullRequestView] = currentScroller?.scrollTop ?? 0
    setPullRequestView(next)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const nextScroller = next === 'overview'
          ? overviewScrollRef.current
          : diffWorkspaceRef.current?.querySelector<HTMLElement>('.diff-view')
        if (nextScroller != null) {
          nextScroller.scrollTop = pullRequestScrollPositions.current[next]
        }
      })
    })
  }, [pullRequestView])

  const navigateToPullRequestActivity = useCallback((activity: PullRequestActivity) => {
    if (activity.kind === 'timeline' && activity.event === 'committed' && activity.commitId != null) {
      void pullRequest?.onOpenCommit(activity.commitId)
      return
    }
    if (activity.kind !== 'review-comment' || activity.line == null) return
    const lineNumber = activity.line
    switchPullRequestView('diff')
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        viewerRef.current?.scrollTo({
          type: 'line',
          id: activity.path,
          lineNumber,
          side: activity.side === 'old' ? 'deletions' : 'additions',
          align: 'start',
          behavior: 'smooth-auto',
        })
      })
    })
  }, [pullRequest, switchPullRequestView])

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
        <RepositoryPicker
          repositoryRoot={session.repositoryRoot}
          repositoryName={session.repositoryName}
          onSelect={onOpenPullRequests}
        />
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
        {(pullRequest == null || pullRequestView === 'diff') && (
          <>
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
            <DifftasticToggle
              active={renderer === 'difftastic' && difftasticReady}
              available={difftasticReady}
              hint={difftastic?.installHint ?? 'Install difftastic and make sure `difft` is on PATH.'}
              loading={difftasticQuery.isPending}
              onToggle={() => {
                const next = renderer === 'difftastic' ? 'pierre' : 'difftastic'
                setRenderer(next)
                storeDiffRenderer(next)
              }}
            />
            <DiffOptionsMenu
              wrap={overflow === 'wrap'}
              ignoreWhitespace={session.ignoreWhitespace}
              busy={busy}
              onWrapChange={(wrap) => setOverflow(wrap ? 'wrap' : 'scroll')}
              onIgnoreWhitespaceChange={updateIgnoreWhitespace}
            />
          </>
        )}
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
          <PiExplanationControl
            status={pullRequest.piStatus}
            onStart={pullRequest.onStartPiReview}
          />
        )}
      </header>

      <div
        className={`workspace${pullRequest == null
          ? ''
          : ` pr-workspace pr-${pullRequestView}-mode`}`}
        style={workspaceStyle}
      >
        {pullRequest?.list}
        {pullRequest != null && (
          <>
            <PullRequestViewHeader
              key={pullRequest.details.number}
              view={pullRequestView}
              details={pullRequest.details}
              onViewChange={switchPullRequestView}
              onRemoveAdditionalReviewLabel={pullRequest.onRemoveAdditionalReviewLabel}
              currentRevision={session.id === pullRequest.currentSessionId}
              reviewComments={pendingReviewComments(session)}
              onSubmitReview={pullRequest.onSubmitReview}
              onSquashMerge={pullRequest.onSquashMerge}
            />
            <section
              ref={overviewScrollRef}
              id="pull-request-overview"
              className={`pr-overview-stage${pullRequestView === 'overview' ? '' : ' is-hidden'}`}
              role="tabpanel"
              aria-labelledby="pull-request-overview-tab"
              aria-hidden={pullRequestView !== 'overview'}
            >
              {error != null && <div className="error-banner">{error}</div>}
              <PullRequestConversation
                details={pullRequest.details}
                oldRevision={session.id !== pullRequest.currentSessionId}
                resolvedTheme={resolvedTheme}
                onNavigate={navigateToPullRequestActivity}
                onAddComment={pullRequest.onAddComment}
              />
            </section>
          </>
        )}
        <div
          ref={diffWorkspaceRef}
          id={pullRequest == null ? undefined : 'pull-request-diff'}
          className={`review-workspace-body${
            pullRequest != null && pullRequestView !== 'diff' ? ' is-hidden' : ''
          }`}
          role={pullRequest == null ? undefined : 'tabpanel'}
          aria-labelledby={pullRequest == null ? undefined : 'pull-request-diff-tab'}
          aria-hidden={pullRequest == null ? undefined : pullRequestView !== 'diff'}
        >
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
            onPointerMove={(event) => {
              hoveredFileRef.current = fileIdFromEvent(event.nativeEvent)
            }}
            onPointerLeave={() => {
              hoveredFileRef.current = null
            }}
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
            ) : renderer === 'difftastic' && difftasticReady ? (
              <DifftasticView
                session={session}
                files={parsedFiles}
                layout={layout}
                resolvedTheme={resolvedTheme}
                collapsedFiles={collapsedFiles}
                viewedFiles={viewedFiles}
                onToggleCollapsed={(filePath) => {
                  setFileCollapsed(filePath, !collapsedFiles.has(filePath))
                }}
                onSetViewed={setViewed}
              />
            ) : (
              <CodeView<ReviewLineAnnotation>
                ref={viewerRef}
                key={`${session.id}:${layout}:${resolvedTheme}`}
                className="diff-view"
                items={items}
                options={diffOptions}
                selectedLines={selection}
                onSelectedLinesChange={handleSelection}
                renderHeaderFilenameSuffix={renderHeaderFilenameSuffix}
                renderHeaderMetadata={renderHeaderMetadata}
                renderAnnotation={renderAnnotation}
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
            piStatus={pullRequest?.piStatus}
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

function DifftasticToggle({
  active,
  available,
  hint,
  loading,
  onToggle,
}: {
  active: boolean
  available: boolean
  hint: string
  loading: boolean
  onToggle(): void
}) {
  const disabled = loading || !available
  const label = disabled
    ? hint
    : active
      ? 'Use line diff'
      : 'Use structural diff'
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        render={
          <button
            type="button"
            className={`icon-button${active ? ' is-active' : ''}`}
            aria-label={label}
            aria-pressed={active}
            disabled={disabled}
            onClick={onToggle}
          >
            <DifftasticIcon />
          </button>
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner className="tooltip-positioner" sideOffset={6}>
          <Tooltip.Popup className="tooltip-popup">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

function DiffOptionsMenu({
  wrap,
  ignoreWhitespace,
  busy,
  onWrapChange,
  onIgnoreWhitespaceChange,
}: {
  wrap: boolean
  ignoreWhitespace: boolean
  busy: boolean
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
                <Menu.CheckboxItemIndicator keepMounted className="diff-option-check">
                  <CheckIcon />
                </Menu.CheckboxItemIndicator>
                <span>Wrap lines</span>
              </Menu.CheckboxItem>
              <Menu.CheckboxItem
                checked={ignoreWhitespace}
                disabled={busy}
                onCheckedChange={onIgnoreWhitespaceChange}
                className="diff-option"
              >
                <Menu.CheckboxItemIndicator keepMounted className="diff-option-check">
                  <CheckIcon />
                </Menu.CheckboxItemIndicator>
                <span>Ignore whitespace</span>
              </Menu.CheckboxItem>
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
              <UserAvatar user={pullRequest.author} />
              <span>{pullRequest.author.login}</span>
              {pullRequest.assignees.length > 0 && (
                <span>→ {pullRequest.assignees.map((assignee) => assignee.login).join(', ')}</span>
              )}
              {pullRequest.reviewers.length > 0 && (
                <span className="pr-item-reviewers" title={pullRequest.reviewers.map((reviewer) => reviewer.login).join(', ')}>
                  {pullRequest.reviewers.map((reviewer) => (
                    <UserAvatar key={reviewer.login} user={reviewer} />
                  ))}
                </span>
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

function PiExplanationControl({
  status,
  onStart,
}: {
  status: PiReviewStatus
  onStart(additionalInstructions: string): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [additionalInstructions, setAdditionalInstructions] = useState('')
  const [error, setError] = useState<string | null>(null)
  const running =
    status.state === 'creating' ||
    status.state === 'running' ||
    (status.state !== 'idle' && status.activePid != null)

  const start = async () => {
    setError(null)
    try {
      await onStart(additionalInstructions.trim())
      setAdditionalInstructions('')
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen)
      if (!nextOpen) setError(null)
    }}>
      <Popover.Trigger
        className="agent-button"
        disabled={running}
        title={status.state !== 'idle' ? status.error ?? undefined : undefined}
      >
        <span className={running ? 'pi-pulse' : ''}>π</span>
        {piExplanationButtonLabel(status)}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="popup-positioner" sideOffset={8} align="end">
          <Popover.Popup className="pi-explanation-menu">
            <Popover.Title>Explain this PR with Pi</Popover.Title>
            <Popover.Description>
              Pi will add plain-language annotations for the purpose, behavior, risks, and tests.
            </Popover.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void start()
              }}
            >
              <label htmlFor="pi-additional-instructions">Additional instructions</label>
              <textarea
                id="pi-additional-instructions"
                autoFocus
                value={additionalInstructions}
                onChange={(event) => setAdditionalInstructions(event.target.value)}
                placeholder="Optional focus, context, or audience…"
                rows={4}
              />
              {error != null && <div className="menu-error">{error}</div>}
              <div className="pi-explanation-actions">
                <button type="button" onClick={() => setOpen(false)}>Cancel</button>
                <button type="submit">Start</button>
              </div>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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

function PullRequestViewHeader({
  view,
  details,
  currentRevision,
  reviewComments,
  onViewChange,
  onRemoveAdditionalReviewLabel,
  onSubmitReview,
  onSquashMerge,
}: {
  view: PullRequestViewMode
  details: PullRequestDetails
  currentRevision: boolean
  reviewComments: SessionAnnotation[]
  onViewChange(view: PullRequestViewMode): void
  onRemoveAdditionalReviewLabel(): Promise<void>
  onSubmitReview(event: PullRequestReviewEvent, body: string): Promise<void>
  onSquashMerge(): Promise<void>
}) {
  const [labelBusy, setLabelBusy] = useState(false)
  const [labelError, setLabelError] = useState<string | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const hasAdditionalReviewLabel = details.labels.some(
    (label) => label.name === 'additional-review-needed',
  )
  const removeAdditionalReviewLabel = async () => {
    setLabelBusy(true)
    setLabelError(null)
    try {
      await onRemoveAdditionalReviewLabel()
    } catch (caught) {
      setLabelError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLabelBusy(false)
    }
  }
  const squashMerge = async () => {
    if (!window.confirm(`Squash and merge #${details.number}? This cannot be undone.`)) return
    setMergeBusy(true)
    setMergeError(null)
    try {
      await onSquashMerge()
    } catch (caught) {
      setMergeError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setMergeBusy(false)
    }
  }
  return (
    <header className="pr-workspace-header">
      <div className="pr-workspace-tabs" role="tablist" aria-label="Pull request content">
        <button
          id="pull-request-overview-tab"
          role="tab"
          aria-controls="pull-request-overview"
          aria-selected={view === 'overview'}
          className={view === 'overview' ? 'active' : ''}
          onClick={() => onViewChange('overview')}
        >
          Overview
        </button>
        <button
          id="pull-request-diff-tab"
          role="tab"
          aria-controls="pull-request-diff"
          aria-selected={view === 'diff'}
          className={view === 'diff' ? 'active' : ''}
          onClick={() => onViewChange('diff')}
        >
          Diff
        </button>
      </div>
      <div className="pr-header-actions">
        {details.state === 'OPEN' && details.mergeable === 'CONFLICTING' && (
          <span className="merge-conflict-badge" role="status">Merge conflicts</span>
        )}
        {labelError != null && <span role="alert">{labelError}</span>}
        {mergeError != null && <span role="alert">{mergeError}</span>}
        {hasAdditionalReviewLabel && (
          <button
            className="remove-additional-label-button"
            disabled={labelBusy}
            onClick={() => void removeAdditionalReviewLabel()}
          >
            {labelBusy ? 'Removing…' : 'Remove addi. label'}
          </button>
        )}
        <SubmitReviewPopover
          key={`${details.number}:${details.state}`}
          disabled={!currentRevision}
          comments={reviewComments}
          allowedEvents={reviewEventsForPullRequest(details.state)}
          onSubmit={onSubmitReview}
        />
        {details.state === 'OPEN' && (
          <button
            className="squash-merge-button"
            disabled={!currentRevision || mergeBusy || details.isDraft || details.mergeable === 'CONFLICTING'}
            title={!currentRevision
              ? 'Switch to the current revision before merging'
              : details.isDraft
                ? 'Draft pull requests cannot be merged'
                : details.mergeable === 'CONFLICTING'
                  ? 'Resolve merge conflicts before merging'
                  : undefined}
            onClick={() => void squashMerge()}
          >
            <MergeIcon />
            {mergeBusy ? 'Merging…' : 'Squash & merge'}
          </button>
        )}
        {details.state === 'MERGED' && (
          <span className="pr-header-merged" role="status">
            <MergeIcon />
            Merged
          </span>
        )}
      </div>
    </header>
  )
}

function reviewEventsForPullRequest(state: PullRequestDetails['state']): PullRequestReviewEvent[] {
  return (['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const).filter((event) =>
    pullRequestAllowsReviewEvent(state, event),
  )
}

function SubmitReviewPopover({
  disabled,
  comments,
  allowedEvents,
  onSubmit,
}: {
  disabled: boolean
  comments: SessionAnnotation[]
  allowedEvents: PullRequestReviewEvent[]
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [event, setEvent] = useState<PullRequestReviewEvent>('COMMENT')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSubmit = Boolean(body.trim()) || comments.length > 0
  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(event, body.trim())
      setBody('')
      setOpen(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="submit-review-button"
        disabled={disabled}
        title={disabled ? 'Switch to the current revision before submitting a review' : undefined}
      >
        Submit review
        <span className="review-comment-count" aria-label={`${comments.length} review comments`}>
          {comments.length}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="popup-positioner" sideOffset={8} align="end">
          <Popover.Popup className="submit-review-popover">
            <Popover.Title>Submit review</Popover.Title>
            {allowedEvents.length > 1 && (
              <label className="review-type-field">
                Review type
                <select
                  value={event}
                  disabled={busy}
                  onChange={(input) => {
                    const next = input.target.value
                    if (next === 'APPROVE' || next === 'COMMENT' || next === 'REQUEST_CHANGES') {
                      if (allowedEvents.includes(next)) setEvent(next)
                    }
                  }}
                >
                  {allowedEvents.includes('COMMENT') && <option value="COMMENT">Comment</option>}
                  {allowedEvents.includes('APPROVE') && <option value="APPROVE">Approve</option>}
                  {allowedEvents.includes('REQUEST_CHANGES') && (
                    <option value="REQUEST_CHANGES">Request changes</option>
                  )}
                </select>
              </label>
            )}
            <label className="review-summary-field">
              Review summary
              <textarea
                rows={4}
                value={body}
                disabled={busy}
                placeholder="Add a review summary…"
                onChange={(input) => setBody(input.target.value)}
              />
            </label>
            <section className="review-comments-preview" aria-label="Review comments to submit">
              <header>
                <strong>Review comments</strong>
                <span>{comments.length}</span>
              </header>
              {comments.length === 0 ? (
                <p>No pending review comments.</p>
              ) : (
                <ul>
                  {comments.map((comment) => (
                    <li key={comment.id}>
                      <code>{comment.filePath}:{lineLabel(comment)}</code>
                      <p>{comment.comment}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            {error != null && <p className="submit-review-error" role="alert">{error}</p>}
            <footer>
              <button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
              <button
                type="button"
                disabled={busy || !canSubmit}
                onClick={() => void submit()}
              >
                {busy ? 'Submitting…' : 'Submit review'}
              </button>
            </footer>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PullRequestConversation({
  details,
  oldRevision,
  resolvedTheme,
  onNavigate,
  onAddComment,
}: {
  details: PullRequestDetails
  oldRevision: boolean
  resolvedTheme: ResolvedTheme
  onNavigate(activity: PullRequestActivity): void
  onAddComment(body: string, replyToId?: string | null): Promise<void>
} ) {
  return (
    <section className="pr-conversation">
      {oldRevision && (
        <div className="old-revision-banner">
          You are viewing an older code revision. The GitHub conversation below is current.
        </div>
      )}
      <div className="pr-overview-grid">
        <div className="pr-overview-main">
          <header className="pr-conversation-header">
            <h1>{details.title}</h1>
            <div className="pr-conversation-meta">
              <span className="pr-author">
                <UserAvatar user={details.author} />
                <strong>{details.author.name ?? details.author.login}</strong>
              </span>
              <CopyableMetaText value={`#${details.number}`}>#{details.number}</CopyableMetaText>
              <code className="pr-branch-range">
                <CopyableMetaText value={details.baseRefName}>{details.baseRefName}</CopyableMetaText>
                {' ← '}
                <CopyableMetaText value={details.headRefName}>{details.headRefName}</CopyableMetaText>
              </code>
              <a href={details.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
            </div>
          </header>
          <section className="pr-description" aria-label="Pull request description">
            <MarkdownBody
              body={details.body || 'No description provided.'}
              issueReferences={details.issueReferences}
            />
          </section>
          <section className="pr-activity-section" aria-labelledby="pr-activity-heading">
            <h2 id="pr-activity-heading">Activity</h2>
            <div className="pr-activity" aria-label="Pull request timeline">
              <TimelineItem
                text={<>Opened by <strong>{details.author.login}</strong></>}
                timestamp={details.createdAt}
              />
              {groupConversationActivities(details.activity).map((group) => {
                if (group.kind === 'item') {
                  return (
                    <ActivityItem
                      key={`${group.activity.kind}:${group.activity.id}`}
                      activity={group.activity}
                      count={group.count}
                      issueReferences={details.issueReferences}
                      resolvedTheme={resolvedTheme}
                      onNavigate={onNavigate}
                    />
                  )
                }
                if (group.kind === 'review-group') {
                  return (
                    <ReviewActivityGroup
                      key={`review:${group.review.id}`}
                      review={group.review}
                      comments={group.comments}
                      issueReferences={details.issueReferences}
                      resolvedTheme={resolvedTheme}
                      onNavigate={onNavigate}
                      onReply={oldRevision ? undefined : onAddComment}
                    />
                  )
                }
                return (
                  <ReviewCommentThreadList
                    key={`orphan-comments:${group.comments[0]?.comment.id ?? 'empty'}`}
                    comments={group.comments}
                    issueReferences={details.issueReferences}
                    resolvedTheme={resolvedTheme}
                    onNavigate={onNavigate}
                    onReply={oldRevision ? undefined : onAddComment}
                  />
                )
              })}
            </div>
          </section>
          {!oldRevision && (
            <PullRequestCommentComposer
              key={details.number}
              onAddComment={onAddComment}
            />
          )}
        </div>
        <PullRequestSidebar
          key={`${details.number}:${details.checkStatus}`}
          details={details}
        />
      </div>
    </section>
  )
}

function PullRequestCommentComposer({
  onAddComment,
  compact = false,
  heading = 'Add comment',
  placeholder = 'Add to the conversation…',
  submitLabel = 'Add comment',
  ariaLabel = 'Add comment',
}: {
  onAddComment(body: string, replyToId?: string | null): Promise<void>
  compact?: boolean
  heading?: string
  placeholder?: string
  submitLabel?: string
  ariaLabel?: string
} ) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    const comment = body.trim()
    if (!comment) return
    setBusy(true)
    setError(null)
    try {
      await onAddComment(comment)
      setBody('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className={`pr-action-composer${compact ? ' is-compact' : ''}`}
      aria-label={ariaLabel}
    >
      <header className="pr-comment-heading">{heading}</header>
      <textarea
        value={body}
        onChange={(input) => setBody(input.target.value)}
        placeholder={placeholder}
        rows={compact ? 3 : 5}
        disabled={busy}
      />
      {error != null && <p className="pr-action-error" role="alert">{error}</p>}
      <footer>
        <span />
        <button
          type="button"
          disabled={busy || !body.trim()}
          onClick={() => void submit()}
        >
          {busy ? 'Submitting…' : submitLabel}
        </button>
      </footer>
    </section>
  )
}

function PullRequestSidebar({ details }: { details: PullRequestDetails }) {
  const checksShouldOpen = details.checkStatus === 'fail' || details.checkStatus === 'pending'
  const [checksOpen, setChecksOpen] = useState(checksShouldOpen)
  const visibleChecks = details.checkStatus === 'fail'
    ? details.checks.filter((check) => check.status === 'fail' || check.status === 'pending')
    : details.checkStatus === 'pending'
      ? details.checks.filter((check) => check.status === 'pending')
      : details.checks
  return (
    <aside className="pr-overview-sidebar" aria-label="Pull request details">
      <section className="pr-sidebar-section">
        <h2>Status</h2>
        <div className={`pr-sidebar-status state-${details.state.toLowerCase()}`}>
          <BranchIcon />
          <strong>{details.isDraft ? 'Draft' : titleCase(details.state)}</strong>
        </div>
        {details.mergedBy != null && (
          <div className="pr-sidebar-person pr-sidebar-status-person">
            <UserAvatar user={details.mergedBy} />
            <span><strong>{details.mergedBy.name ?? details.mergedBy.login}</strong> merged</span>
          </div>
        )}
        {details.state === 'OPEN' && details.mergeable === 'CONFLICTING' && (
          <p className="pr-sidebar-conflict">Conflicts must be resolved before merging.</p>
        )}
        <div className="pr-sidebar-changes" aria-label="Pull request changes">
          <span className="addition">+{details.additions}</span>
          <span className="deletion">−{details.deletions}</span>
        </div>
      </section>

      <details
        className={`pr-sidebar-section pr-sidebar-checks checks-${details.checkStatus}`}
        open={checksOpen}
        onToggle={(event) => setChecksOpen(event.currentTarget.open)}
      >
        <summary>
          <span>Checks</span>
          <strong>
            {details.checkStatus === 'pass' && <ChecksPassedIcon aria-hidden="true" />}
            {checkStatusSummary(details)}
          </strong>
          <ChevronIcon />
        </summary>
        {visibleChecks.length === 0
          ? <p className="pr-sidebar-empty">No checks reported.</p>
          : (
              <div className="pr-check-list">
                {groupChecks(visibleChecks).map((group) => (
                  <PullRequestCheckGroup
                    key={`${group.name}:${group.status}`}
                    name={group.name}
                    status={group.status}
                    checks={group.checks}
                  />
                ))}
              </div>
            )}
      </details>

      <SidebarPeople title="Reviewers" people={details.reviewers} emptyLabel="No reviewers" />
      <SidebarPeople title="Assignees" people={details.assignees} emptyLabel="No assignees" />

      <section className="pr-sidebar-section">
        <h2>Labels</h2>
        {details.labels.length === 0
          ? <p className="pr-sidebar-empty">No labels</p>
          : (
              <div className="pr-sidebar-labels">
                {details.labels.map((label) => (
                  <span key={label.name} style={{ '--label-color': `#${label.color}` } as CSSProperties}>
                    {label.name}
                  </span>
                ))}
              </div>
            )}
      </section>
    </aside>
  )
}

function PullRequestCheckGroup({
  name,
  status,
  checks,
}: {
  name: string
  status: PullRequestCheckRunStatus
  checks: PullRequestCheckRun[]
}) {
  const [open, setOpen] = useState(status === 'fail' || status === 'pending')
  return (
    <details
      className={`pr-check-group checks-${status}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className={`pr-check-dot ${status}`} aria-hidden="true" />
        <strong>{name}</strong>
        <span>{checkRunStatusSummary(checks)}</span>
        <ChevronIcon />
      </summary>
      <div className="pr-check-group-items">
        {checks.map((check, index) => {
          const content = (
            <>
              <span className={`pr-check-dot ${check.status}`} aria-hidden="true" />
              <strong>{check.name}</strong>
            </>
          )
          return check.url == null
            ? <div className="pr-check-item" key={`${check.name}:${index}`}>{content}</div>
            : (
                <a
                  className="pr-check-item"
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  key={`${check.name}:${index}`}
                >
                  {content}
                </a>
              )
        })}
      </div>
    </details>
  )
}

function groupChecks(checks: PullRequestCheckRun[]): Array<{
  name: string
  status: PullRequestCheckRunStatus
  checks: PullRequestCheckRun[]
}> {
  const groups = new Map<string, PullRequestCheckRun[]>()
  for (const check of checks) {
    const name = check.workflowName ?? 'Other checks'
    const group = groups.get(name) ?? []
    group.push(check)
    groups.set(name, group)
  }
  return Array.from(groups, ([name, groupedChecks]) => ({
    name,
    status: aggregateCheckRunStatus(groupedChecks),
    checks: groupedChecks,
  }))
}

function aggregateCheckRunStatus(checks: PullRequestCheckRun[]): PullRequestCheckRunStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail'
  if (checks.some((check) => check.status === 'pending')) return 'pending'
  if (checks.some((check) => check.status === 'pass')) return 'pass'
  return 'skipped'
}

function checkRunStatusSummary(checks: PullRequestCheckRun[]): string {
  const status = aggregateCheckRunStatus(checks)
  const label = status === 'fail' ? 'Failed' : status === 'pass' ? 'Passed' : titleCase(status)
  return `${label} · ${checks.length}`
}

function SidebarPeople({
  title,
  people,
  emptyLabel,
}: {
  title: string
  people: GitHubUser[]
  emptyLabel: string
}) {
  return (
    <section className="pr-sidebar-section">
      <h2>{title}</h2>
      {people.length === 0
        ? <p className="pr-sidebar-empty">{emptyLabel}</p>
        : (
            <div className="pr-sidebar-people">
              {people.map((person) => (
                <div className="pr-sidebar-person" key={person.login}>
                  <UserAvatar user={person} />
                  <span>
                    <strong>{person.name ?? person.login}</strong>
                    {person.name != null && <small>{person.login}</small>}
                  </span>
                </div>
              ))}
            </div>
          )}
    </section>
  )
}

function checkStatusSummary(details: PullRequestDetails): string {
  if (details.checkStatus === 'fail') {
    const failed = details.checks.filter((check) => check.status === 'fail').length
    const pending = details.checks.filter((check) => check.status === 'pending').length
    return pending === 0 ? `${failed} failed` : `${failed} failed · ${pending} pending`
  }
  if (details.checkStatus === 'pending') {
    const pending = details.checks.filter((check) => check.status === 'pending').length
    return `${pending} pending`
  }
  if (details.checkStatus === 'pass') return 'All passed'
  if (details.checkStatus === 'unknown') return 'Unknown'
  return 'None'
}

function ReviewActivityGroup({
  review,
  comments,
  issueReferences,
  resolvedTheme,
  onNavigate,
  onReply,
}: {
  review: Extract<PullRequestActivity, { kind: 'review' }>
  comments: ReviewCommentThread[]
  issueReferences: GitHubIssueReference[]
  resolvedTheme: ResolvedTheme
  onNavigate(activity: PullRequestActivity): void
  onReply?(body: string, replyToId?: string | null): Promise<void>
} ) {
  return (
    <div className="pr-review-group">
      <ActivityItem
        activity={review}
        count={1}
        issueReferences={issueReferences}
        resolvedTheme={resolvedTheme}
        onNavigate={onNavigate}
      />
      <ReviewCommentThreadList
        comments={comments}
        issueReferences={issueReferences}
        resolvedTheme={resolvedTheme}
        onNavigate={onNavigate}
        onReply={onReply}
      />
    </div>
  )
}

function ReviewCommentThreadList({
  comments,
  issueReferences,
  resolvedTheme,
  onNavigate,
  onReply,
}: {
  comments: ReviewCommentThread[]
  issueReferences: GitHubIssueReference[]
  resolvedTheme: ResolvedTheme
  onNavigate(activity: PullRequestActivity): void
  onReply?(body: string, replyToId?: string | null): Promise<void>
} ) {
  if (comments.length === 0) return null
  return (
    <div className="pr-review-comments">
      {comments.map((thread) => (
        <ReviewCommentThreadItem
          key={thread.comment.id}
          thread={thread}
          issueReferences={issueReferences}
          resolvedTheme={resolvedTheme}
          onNavigate={onNavigate}
          onReply={onReply}
        />
      ))}
    </div>
  )
}

function ReviewCommentThreadItem({
  thread,
  issueReferences,
  resolvedTheme,
  onNavigate,
  onReply,
}: {
  thread: ReviewCommentThread
  issueReferences: GitHubIssueReference[]
  resolvedTheme: ResolvedTheme
  onNavigate(activity: PullRequestActivity): void
  onReply?(body: string, replyToId?: string | null): Promise<void>
}) {
  return (
    <div className="pr-review-thread">
      <ActivityItem
        activity={thread.comment}
        count={1}
        issueReferences={issueReferences}
        resolvedTheme={resolvedTheme}
        onNavigate={onNavigate}
      />
      {thread.replies.length > 0 && (
        <div className="pr-review-replies">
          {thread.replies.map((reply) => (
            <ActivityItem
              key={reply.id}
              activity={reply}
              count={1}
              issueReferences={issueReferences}
              resolvedTheme={resolvedTheme}
              onNavigate={onNavigate}
              showTarget={false}
            />
          ))}
        </div>
      )}
      {onReply != null && (
        <ReviewCommentReplyComposer
          onReply={(body) => onReply(body, thread.comment.id)}
        />
      )}
    </div>
  )
}

function ReviewCommentReplyComposer({
  onReply,
}: {
  onReply(body: string): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <button
        className="conversation-reply-button"
        type="button"
        onClick={() => setOpen(true)}
      >
        Reply
      </button>
    )
  }
  return (
    <PullRequestCommentComposer
      compact
      heading="Reply"
      placeholder="Reply to this comment…"
      submitLabel="Reply"
      ariaLabel="Reply to review comment"
      onAddComment={async (comment) => {
        await onReply(comment)
        setOpen(false)
      }}
    />
  )
}

function ActivityItem({
  activity,
  count,
  issueReferences,
  resolvedTheme,
  onNavigate,
  showTarget = true,
}: {
  activity: PullRequestActivity
  count: number
  issueReferences: GitHubIssueReference[]
  resolvedTheme: ResolvedTheme
  onNavigate(activity: PullRequestActivity): void
  showTarget?: boolean
}) {
  if (activity.kind === 'timeline') {
    return (
      <TimelineItem
        text={timelineActivityText(activity, onNavigate)}
        timestamp={activity.createdAt}
        icon={timelineActivityIcon(activity)}
        count={count}
        author={activity.event === 'committed' ? activity.author : null}
      />
    )
  }
  if (activity.kind === 'review' && !activity.body.trim()) {
    return (
      <TimelineItem
        text={<><strong>{activity.author.login}</strong> {reviewTimelineText(activity.state)}</>}
        timestamp={activity.createdAt}
        icon={<CommentIcon />}
      />
    )
  }
  const reviewComment = activity.kind === 'review-comment' && showTarget ? activity : null
  return (
    <ConversationItem
      eyebrow={activityLabel(activity)}
      author={activity.author}
      body={activity.body}
      timestamp={activity.createdAt}
      target={reviewComment == null
        ? undefined
        : `${reviewComment.path}${reviewComment.line == null ? '' : `:${reviewComment.line}`}`}
      diffHunk={reviewComment?.diffHunk}
      diffPath={reviewComment?.path}
      resolvedTheme={resolvedTheme}
      onTarget={reviewComment != null && reviewComment.line != null
        ? () => onNavigate(reviewComment)
        : undefined}
      url={activity.url}
      issueReferences={issueReferences}
      minimizedReason={'minimizedReason' in activity ? activity.minimizedReason : null}
    />
  )
}

function TimelineItem({
  text,
  timestamp,
  count = 1,
  icon = <BranchIcon />,
  author = null,
}: {
  text: ReactNode
  timestamp: string
  count?: number
  icon?: ReactNode
  author?: GitHubUser | null
}) {
  return (
    <div className={`pr-timeline-item${author == null ? '' : ' has-avatar'}`}>
      {author == null ? icon : <UserAvatar user={author} />}
      <span className="pr-timeline-copy">
        {text}
        {count > 1 && ` × ${count}`}
        <time title={formatTimestamp(timestamp)}>{relativeTime(timestamp)}</time>
      </span>
    </div>
  )
}

function CopyableMetaText({ value, children }: { value: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false)

  return (
    <button
      className="pr-copyable-meta"
      type="button"
      title={copied ? 'Copied' : `Copy ${value}`}
      onClick={async () => {
        await navigator.clipboard.writeText(value)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
    >
      {children}
    </button>
  )
}

function ConversationItem({
  eyebrow,
  author,
  body,
  timestamp,
  target,
  onTarget,
  diffHunk,
  diffPath,
  resolvedTheme,
  url,
  issueReferences,
  minimizedReason,
}: {
  eyebrow: string
  author: GitHubUser
  body: string
  timestamp: string
  target?: string
  onTarget?: () => void
  diffHunk?: string
  diffPath?: string
  resolvedTheme: ResolvedTheme
  url?: string | null
  issueReferences: GitHubIssueReference[]
  minimizedReason?: MinimizedCommentReason | null
} ) {
  const [expanded, setExpanded] = useState(false)
  const minimized = minimizedReason != null && !expanded
  return (
    <article className={`conversation-item${minimized ? ' is-minimized' : ''}`}>
      <header className="conversation-item-header">
        <UserAvatar user={author} />
        <div className="conversation-item-heading">
          <div>
            <strong>{author.login}</strong>
            <span>{minimized ? minimizedCommentLabel(minimizedReason) : eyebrow}</span>
          </div>
          <div className="conversation-item-meta">
            <time title={formatTimestamp(timestamp)}>{relativeTime(timestamp)}</time>
            {url != null && <a href={url} target="_blank" rel="noreferrer">GitHub ↗</a>}
          </div>
        </div>
      </header>
      {minimized
        ? (
            <button
              className="conversation-hidden-toggle"
              type="button"
              onClick={() => setExpanded(true)}
            >
              Show comment
            </button>
          )
        : (
            <>
              {target != null && (
                <div className="conversation-target">
                  <ReviewCommentDiff
                    target={target}
                    filePath={diffPath}
                    diffHunk={diffHunk}
                    resolvedTheme={resolvedTheme}
                    onTarget={onTarget}
                  />
                </div>
              )}
              <MarkdownBody body={body} issueReferences={issueReferences} />
            </>
          )}
    </article>
  )
}

function ReviewCommentDiff({
  target,
  filePath,
  diffHunk,
  resolvedTheme,
  onTarget,
}: {
  target: string
  filePath?: string
  diffHunk?: string
  resolvedTheme: ResolvedTheme
  onTarget?: () => void
}) {
  const fileDiff = useMemo(
    () => filePath == null || diffHunk == null ? null : parseReviewCommentDiff(filePath, diffHunk),
    [diffHunk, filePath],
  )
  return (
    <>
      {onTarget == null
        ? <code className="conversation-diff-path">{target}</code>
        : (
            <button
              className="conversation-diff-path conversation-diff-link"
              type="button"
              onClick={onTarget}
              aria-label={`Open ${target} in the Diff tab`}
            >
              {target}
            </button>
          )}
      {fileDiff != null && (
        <FileDiff
          className="conversation-file-diff"
          fileDiff={fileDiff}
          disableWorkerPool
          options={{
            theme: { dark: 'pierre-dark', light: 'pierre-light' },
            themeType: resolvedTheme,
            diffStyle: 'unified',
            diffIndicators: 'bars',
            overflow: 'scroll',
            disableFileHeader: true,
            hunkSeparators: 'line-info-basic',
            lineDiffType: 'word-alt',
          }}
        />
      )}
    </>
  )
}

function MarkdownBody({
  body,
  issueReferences,
}: {
  body: string
  issueReferences: GitHubIssueReference[]
}) {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm, remarkBreaks, [remarkIssueReferences, { references: issueReferences }]]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: (props) => <MarkdownLink {...props} issueReferences={issueReferences} />,
          img: MarkdownImage,
          pre: MarkdownPre,
        }}
      >
        {body}
      </Markdown>
    </div>
  )
}

type MermaidRender =
  | { source: string; svg: string }
  | { source: string; error: string }

function MarkdownImage({ src, ...props }: ComponentPropsWithoutRef<'img'> & { node?: unknown }) {
  return (
    <img
      {...props}
      src={src == null ? undefined : githubAttachmentUrl(src)}
      loading="lazy"
    />
  )
}

function MarkdownLink({
  href,
  children,
  node: _node,
  issueReferences = [],
  ...props
}: ComponentPropsWithoutRef<'a'> & {
  node?: unknown
  issueReferences?: GitHubIssueReference[]
}) {
  if (href != null && children === href && isGitHubAttachmentUrl(href)) {
    return <video src={githubAttachmentUrl(href)} controls preload="metadata" />
  }
  const reference = issueReferences.find((item) => item.url === href)
  if (reference != null) {
    return (
      <a
        {...props}
        className="markdown-issue-reference"
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        {reference.kind === 'pull-request' ? <PullRequestIcon /> : <IssueIcon />}
        {children}
      </a>
    )
  }
  return <a {...props} href={href}>{children}</a>
}

function githubAttachmentUrl(source: string): string {
  return isGitHubAttachmentUrl(source)
    ? `/api/github-attachment?url=${encodeURIComponent(source)}`
    : source
}

function isGitHubAttachmentUrl(source: string): boolean {
  return source.startsWith('https://github.com/user-attachments/') ||
    source.startsWith('https://private-user-images.githubusercontent.com/') ||
    source.startsWith('https://user-images.githubusercontent.com/')
}

let mermaidPromise: Promise<typeof import('mermaid').default> | undefined

function loadMermaid() {
  mermaidPromise ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' })
    return mermaid
  })
  return mermaidPromise
}

type SyntaxHighlight =
  | { source: string; language: string; html: string }
  | { source: string; language: string; failed: true }

let shikiPromise: Promise<typeof import('shiki')> | undefined

function loadShiki() {
  shikiPromise ??= import('shiki')
  return shikiPromise
}

function SyntaxHighlightedCode({ source, language }: { source: string; language: string }) {
  const [highlight, setHighlight] = useState<SyntaxHighlight | null>(null)

  useEffect(() => {
    let cancelled = false
    setHighlight(null)
    loadShiki()
      .then(({ codeToHtml }) => codeToHtml(source, {
        lang: language,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
      }))
      .then((html) => {
        if (!cancelled) setHighlight({ source, language, html })
      })
      .catch(() => {
        if (!cancelled) setHighlight({ source, language, failed: true })
      })
    return () => { cancelled = true }
  }, [language, source])

  if (
    highlight == null ||
    highlight.source !== source ||
    highlight.language !== language ||
    'failed' in highlight
  ) {
    return <pre><code className={`language-${language}`}>{source}</code></pre>
  }
  return <div className="markdown-highlighted-code" dangerouslySetInnerHTML={{ __html: highlight.html }} />
}

function MarkdownPre({
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children)
    ? children
    : null
  const languages = child?.props.className?.split(' ') ?? []
  const language = languages.find((value) => value.startsWith('language-'))?.slice('language-'.length)

  if (child != null && language === 'mermaid') {
    return <MermaidDiagram source={String(child.props.children).replace(/\n$/, '')} />
  }
  if (child != null && language != null) {
    return (
      <SyntaxHighlightedCode
        source={String(child.props.children).replace(/\n$/, '')}
        language={language}
      />
    )
  }

  return <pre {...props}>{children}</pre>
}

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId()
  const [render, setRender] = useState<MermaidRender | null>(null)

  useEffect(() => {
    let cancelled = false

    void loadMermaid()
      .then((mermaid) => mermaid.render(`mermaid-${reactId.replace(/:/g, '')}`, source))
      .then(({ svg }) => {
        if (!cancelled) setRender({ source, svg })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRender({ source, error: error instanceof Error ? error.message : String(error) })
        }
      })

    return () => { cancelled = true }
  }, [reactId, source])

  if (render?.source === source && 'svg' in render) {
    return (
      <div
        className="mermaid-diagram"
        role="img"
        aria-label="Mermaid diagram"
        dangerouslySetInnerHTML={{ __html: render.svg }}
      />
    )
  }

  return (
    <div className="mermaid-source">
      <pre><code className="language-mermaid">{source}</code></pre>
      {render?.source === source && 'error' in render && (
        <small title={render.error}>Mermaid diagram could not be rendered.</small>
      )}
    </div>
  )
}

function UserAvatar({ user }: { user: GitHubUser }) {
  const [failed, setFailed] = useState(false)
  if (user.avatarUrl == null || failed || isGitHubActionsLogin(user.login)) {
    return <span className="user-avatar fallback">{avatarFallback(user.login)}</span>
  }
  return (
    <img
      className="user-avatar"
      src={`/api/avatar?url=${encodeURIComponent(user.avatarUrl)}`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function isGitHubActionsLogin(login: string): boolean {
  return login === 'github-actions' || login.startsWith('github-actions[')
}

function avatarFallback(login: string): ReactNode {
  if (isGitHubActionsLogin(login)) return <GitHubMarkIcon />
  return login.slice(0, 2).toUpperCase()
}

function GitHubMarkIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8"
      />
    </svg>
  )
}

interface RecentRepository {
  root: string
  name: string
}

function RepositoryPicker({
  repositoryRoot,
  repositoryName,
  onSelect,
}: {
  repositoryRoot: string
  repositoryName: string
  onSelect(repositoryPath: string): void
}) {
  const [open, setOpen] = useState(false)
  const [repositories, setRepositories] = useState<RecentRepository[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void getSessions()
      .then((sessions) => {
        const recent = new Map<string, RecentRepository>()
        recent.set(repositoryRoot, { root: repositoryRoot, name: repositoryName })
        for (const session of sessions) {
          if (!recent.has(session.repositoryRoot)) {
            recent.set(session.repositoryRoot, {
              root: session.repositoryRoot,
              name: session.repositoryName,
            })
          }
        }
        setRepositories([...recent.values()])
      })
      .catch(() => {
        setRepositories([{ root: repositoryRoot, name: repositoryName }])
      })
      .finally(() => setLoading(false))
  }, [open, repositoryName, repositoryRoot])

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger className="repository-trigger">
        <RepositoryIcon />
        <span>{repositoryName}</span>
        <ChevronIcon />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="popup-positioner" sideOffset={8} align="start">
          <Menu.Popup className="repository-menu">
            <Menu.Group>
              <Menu.GroupLabel className="menu-kicker">Recent repositories</Menu.GroupLabel>
              {repositories.map((repository) => (
                <Menu.Item
                  key={repository.root}
                  className="repository-option"
                  onClick={() => onSelect(repository.root)}
                >
                  <RepositoryIcon />
                  <span>
                    <strong>{repository.name}</strong>
                    <small>{repository.root}</small>
                  </span>
                  {repository.root === repositoryRoot && <CheckIcon />}
                </Menu.Item>
              ))}
              {loading && repositories.length === 0 && (
                <div className="repository-menu-status">Loading repositories…</div>
              )}
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
            {repository?.defaultBranchRef != null && (
              <TargetOption
                selected={currentSession?.target.kind === 'branch-worktree'}
                label="Current branch + working tree"
                detail={`git diff --merge-base ${repository.defaultBranchRef}`}
                onClick={() => void choose({ kind: 'branch-worktree' })}
              />
            )}
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
                        {commit.authoredAt !== '' && (
                          <time dateTime={commit.authoredAt}>{formatTimestamp(commit.authoredAt)}</time>
                        )}
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
      [data-icon-name="file-tree-icon-chevron"] { width: 11px; height: 11px; }
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

function FileCopyButton({ filePath }: { filePath: string }) {
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
function FileHeaderControls({
  filePath,
  stagingEnabled,
  onToggleCollapsed,
  onAdd,
  onSetViewed,
}: {
  filePath: string
  stagingEnabled: boolean
  onToggleCollapsed(filePath: string, collapsed: boolean): void
  onAdd(filePath: string): Promise<void>
  onSetViewed(filePath: string, viewed: boolean): Promise<void>
}) {
  const collapsed = useAtomValue(fileCollapsedAtom(filePath))
  const viewed = useAtomValue(fileViewedAtom(filePath))
  return (
    <div
      className="file-header-controls"
      data-file-id={filePath}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        className="file-collapse-button"
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${filePath}`}
        aria-expanded={!collapsed}
        onClick={(event) => {
          event.stopPropagation()
          onToggleCollapsed(filePath, !collapsed)
        }}
      >
        <ChevronIcon />
      </button>
      {stagingEnabled && (
        <FileStageButton filePath={filePath} onAdd={() => onAdd(filePath)} />
      )}
      <FileViewedToggle
        viewed={viewed}
        onChange={(nextViewed) => onSetViewed(filePath, nextViewed)}
      />
    </div>
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
  piStatus,
  onSetArchived,
  onUpdateComment,
  onUpdateGlobalComment,
  allowGlobalComment,
  onArchiveAll,
  onNavigate,
}: {
  session: ReviewSession
  files: FileDiffMetadata[]
  piStatus?: PiReviewStatus
  onSetArchived(annotationId: string, archived: boolean): Promise<void>
  onUpdateComment(annotationId: string, comment: string, intent?: AnnotationIntent): Promise<void>
  onUpdateGlobalComment(comment: string): Promise<void>
  allowGlobalComment: boolean
  onArchiveAll(): Promise<void>
  onNavigate(annotation: SessionAnnotation): void
}) {
  const reviewCommentAvailable = useAtomValue(reviewCommentAvailableAtom)
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
  const piRun = piStatus == null || piStatus.state === 'idle' ? null : piStatus
  const showPiReviewDetails = view === 'active' && piRun != null

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
        {visible.length === 0 && !showGlobalComment && !showPiReviewDetails ? (
          <p className="notes-empty">
            {view === 'active'
              ? 'Comments and importance highlights will collect here.'
              : 'Archived annotations will remain available here.'}
          </p>
        ) : (
          <div className="notes-list">
            {showPiReviewDetails && piRun != null && <PiRunCard run={piRun} />}
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
                      intent={annotation.intent}
                      reviewCommentAvailable={
                        reviewCommentAvailable &&
                        annotation.source === 'user' &&
                        annotation.submittedAt == null &&
                        annotation.endSide == null
                      }
                      onCancel={() => setEditingId(null)}
                      onSave={async (comment, intent) => {
                        await onUpdateComment(annotation.id, comment, intent)
                        setEditingId(null)
                      }}
                    />
                  ) : annotation.comment != null ? (
                    <p>{annotation.comment}</p>
                  ) : null}
                  <footer>
                    <div className="note-source">
                      <span className={`source ${annotation.source}`}>{annotation.source}</span>
                      {annotation.intent === 'review-comment' && annotation.submittedAt == null && annotation.archivedAt == null && (
                        <span className="review-comment-source">pending review</span>
                      )}
                      {annotation.importance != null && (
                        <span className="importance-inline">
                          importance {formatImportance(annotation.importance)}
                        </span>
                      )}
                    </div>
                    <div className="note-actions">
                      {annotation.source === 'user' && annotation.submittedAt == null && annotation.comment != null && !editing && (
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
                        label={annotation.submittedAt != null
                          ? 'Submitted review comment'
                          : view === 'active' ? 'Archive' : 'Restore'}
                        disabled={busyId === annotation.id || (
                          view === 'archived' && annotation.submittedAt != null
                        )}
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

function PiRunCard({ run }: { run: PiReviewRun }) {
  const [copied, setCopied] = useState(false)
  const resumeCommand = `diff-review pi resume ${run.id}`
  const resumable =
    run.piSessionPath != null && run.state !== 'cleaned' && run.state !== 'cleaning'
  return (
    <article className="note-card pi-run-card">
      <div className="global-comment-heading">
        <strong>Explain PR run</strong>
        <span className={`pi-run-state ${run.state}`}>{piReviewStateLabel(run.state)}</span>
      </div>
      <dl>
        <div>
          <dt>Worktree</dt>
          <dd>
            {run.state === 'cleaned' ? 'Removed' : (
              <code className="pi-worktree-path" title={run.worktreePath}>{run.worktreePath}</code>
            )}
          </dd>
        </div>
        <div>
          <dt>Cleanup</dt>
          <dd title={`Eligible ${formatTimestamp(run.cleanupEligibleAt)}`}>
            {piCleanupLabel(run)}
          </dd>
        </div>
        <div>
          <dt>Pi session</dt>
          <dd>
            {run.activePid != null ? (
              `Active in process ${run.activePid}`
            ) : resumable ? (
              <span className="pi-resume-command">
                <code>{resumeCommand}</code>
                <AnnotationIconButton
                  label={copied ? 'Copied' : 'Copy resume command'}
                  onClick={async () => {
                    await navigator.clipboard.writeText(resumeCommand)
                    setCopied(true)
                    window.setTimeout(() => setCopied(false), 1600)
                  }}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </AnnotationIconButton>
              </span>
            ) : run.state === 'creating' || run.state === 'running' ? (
              'Saving…'
            ) : run.state === 'cleaned' ? (
              'Removed'
            ) : (
              'Unavailable'
            )}
          </dd>
        </div>
      </dl>
      {run.error != null && <p className="pi-run-error">{run.error}</p>}
    </article>
  )
}

function piReviewStateLabel(state: PiReviewRun['state']): string {
  if (state === 'cleanup-blocked') return 'Cleanup blocked'
  return state.charAt(0).toUpperCase() + state.slice(1)
}

function piCleanupLabel(run: PiReviewRun): string {
  if (run.state === 'cleaned') return 'Removed'
  if (run.state === 'cleaning') return 'Cleaning…'
  if (run.state === 'cleanup-blocked') return 'Blocked; worktree was kept'
  if (run.keep) return 'Kept until manually cleaned'
  if (run.activePid != null) return 'Paused while Pi is active'
  if (run.state === 'creating' || run.state === 'running') return 'Kept while Pi is running'
  return `Automatic cleanup ${relativeTime(run.cleanupEligibleAt)}`
}

function CommentEditor({
  comment,
  intent,
  reviewCommentAvailable = false,
  onCancel,
  onSave,
}: {
  comment: string
  intent?: AnnotationIntent
  reviewCommentAvailable?: boolean
  onCancel(): void
  onSave(comment: string, intent?: AnnotationIntent): Promise<void>
}) {
  const [value, setValue] = useState(comment)
  const [draftIntent, setDraftIntent] = useState<AnnotationIntent>(intent ?? 'annotation')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (busy || !value.trim()) return
    setBusy(true)
    try {
      await onSave(
        value.trim(),
        reviewCommentAvailable ? draftIntent : undefined,
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="note-editor">
      <textarea
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (!isAnnotationSubmitEnter(event)) return
          event.preventDefault()
          void save()
        }}
      />
      <div>
        {reviewCommentAvailable && (
          <ReviewCommentToggle
            checked={draftIntent === 'review-comment'}
            disabled={busy}
            onCheckedChange={(checked) => {
              setDraftIntent(checked ? 'review-comment' : 'annotation')
            }}
          />
        )}
        <button disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          disabled={busy || !value.trim()}
          onClick={() => void save()}
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

function ReviewCommentToggle({
  checked,
  disabled,
  onCheckedChange,
}: {
  checked: boolean
  disabled: boolean
  onCheckedChange(checked: boolean): void
}) {
  return (
    <Checkbox.Root
      className="review-comment-toggle"
      checked={checked}
      disabled={disabled}
      title="Include this comment when submitting the review"
      onCheckedChange={(next) => onCheckedChange(next === true)}
    >
      <span className="review-comment-checkbox">
        <Checkbox.Indicator><CheckIcon /></Checkbox.Indicator>
      </span>
      <span>Review comment</span>
    </Checkbox.Root>
  )
}

function InlineComposer({
  selection,
  onCancel,
  onSubmitted,
}: {
  selection: CodeViewLineSelection
  onCancel(): void
  onSubmitted(): Promise<void>
}) {
  const [draft, setDraft] = useAtom(composerDraftAtom)
  const sessionId = useAtomValue(composerSessionIdAtom)
  const reviewCommentAvailable = useAtomValue(reviewCommentAvailableAtom) &&
    annotationRangeFromSelection(selection).endSide == null

  const submit = async () => {
    if (sessionId == null || !draft.comment.trim()) return
    const range = annotationRangeFromSelection(selection)
    const effectiveIntent: AnnotationIntent =
      draft.intent === 'review-comment' &&
      reviewCommentAvailable &&
      range.endSide == null
        ? 'review-comment'
        : 'annotation'
    setDraft((current) => ({ ...current, busy: true, error: null }))
    try {
      await addAnnotation(sessionId, {
        filePath: selection.id,
        ...range,
        comment: draft.comment.trim(),
        source: 'user',
        intent: effectiveIntent,
      })
      await onSubmitted()
    } catch (caught) {
      setDraft((current) => ({
        ...current,
        error: caught instanceof Error ? caught.message : String(caught),
      }))
    } finally {
      setDraft((current) => ({ ...current, busy: false }))
    }
  }

  return (
    <section className="inline-composer">
      <div className="composer-heading">
        <span><CommentIcon /> {draft.intent === 'review-comment' && reviewCommentAvailable ? 'Add review comment' : 'Add annotation'}</span>
        <button onClick={onCancel} aria-label="Cancel selection">
          <CloseIcon />
        </button>
      </div>
      <textarea
        autoFocus
        value={draft.comment}
        onChange={(event) => setDraft((current) => ({ ...current, comment: event.target.value }))}
        placeholder="What should the reviewer know?"
        onKeyDown={(event) => {
          if (!isAnnotationSubmitEnter(event)) return
          event.preventDefault()
          void submit()
        }}
      />
      {draft.error != null && <div className="composer-error">{draft.error}</div>}
      <div className="composer-actions">
        {reviewCommentAvailable ? (
          <ReviewCommentToggle
            checked={draft.intent === 'review-comment'}
            disabled={draft.busy}
            onCheckedChange={(checked) => setDraft((current) => ({
              ...current,
              intent: checked ? 'review-comment' : 'annotation',
            }))}
          />
        ) : <span />}
        <div>
          <small>Enter · Shift Enter</small>
          <button disabled={!draft.comment.trim() || draft.busy} onClick={() => void submit()}>
            {draft.intent === 'review-comment' && reviewCommentAvailable ? 'Add review comment' : 'Add annotation'}
          </button>
        </div>
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
  onUpdateComment(comment: string, intent?: AnnotationIntent): Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const reviewCommentAvailable = useAtomValue(reviewCommentAvailableAtom) &&
    annotation.endSide == null &&
    annotation.source === 'user' &&
    annotation.submittedAt == null
  return (
    <div className={`inline-annotation ${annotation.source}`}>
      <div className="inline-source">
        <div>
          <span>{annotation.source === 'agent'
            ? 'Agent note'
            : annotation.submittedAt != null
              ? 'Submitted review comment'
              : annotation.intent === 'review-comment'
                ? 'Pending review comment'
                : 'Annotation'}</span>
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
          intent={annotation.intent}
          reviewCommentAvailable={reviewCommentAvailable}
          onCancel={() => setEditing(false)}
          onSave={async (comment, intent) => {
            await onUpdateComment(comment, intent)
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


function fileHeaderIdFromEvent(event: MouseEvent): string | null {
  const path = event.composedPath()
  const clickedHeader = path.some(
    (target) => target instanceof HTMLElement && target.hasAttribute('data-diffs-header'),
  )
  if (!clickedHeader) return null
  return fileIdFromEvent(event)
}

function fileIdFromEvent(event: MouseEvent): string | null {
  const path = event.composedPath()
  const container = path.find(
    (target) => target instanceof HTMLElement && target.tagName === 'DIFFS-CONTAINER',
  )
  if (container instanceof HTMLElement) {
    return container.querySelector<HTMLElement>('[data-file-id]')?.dataset.fileId ?? null
  }
  const file = path.find(
    (target) => target instanceof HTMLElement && target.dataset.fileId != null,
  )
  return file instanceof HTMLElement ? file.dataset.fileId ?? null : null
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

function storedDiffRenderer(): DiffRenderer {
  return window.localStorage.getItem('diff-review-renderer') === 'difftastic'
    ? 'difftastic'
    : 'pierre'
}

function storeDiffRenderer(renderer: DiffRenderer): void {
  if (renderer === 'pierre') window.localStorage.removeItem('diff-review-renderer')
  else window.localStorage.setItem('diff-review-renderer', renderer)
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
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
    case 'unknown':
      return 'Unknown'
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
  if (activity.kind === 'review') return titleCase(activity.state.replaceAll('_', ' '))
  return titleCase(activity.event.replaceAll('_', ' '))
}


function minimizedCommentLabel(reason: MinimizedCommentReason): string {
  return `Hidden as ${reason.replaceAll('-', ' ')}`
}

type TimelineActivity = Extract<PullRequestActivity, { kind: 'timeline' }>

function timelineActivityIcon(activity: TimelineActivity): ReactNode {
  switch (activity.event) {
    case 'labeled':
    case 'unlabeled':
      return <TagIcon />
    case 'committed':
      return <CommitIcon />
    case 'cross-referenced':
    case 'cross_referenced':
      return activity.source?.kind === 'issue' ? <IssueIcon /> : <PullRequestIcon />
    case 'merged':
      return <MergeIcon />
    case 'closed':
      return <CloseIcon />
    case 'reopened':
    case 'head_ref_restored':
      return <RestoreIcon />
    case 'ready_for_review':
      return <CircleCheck />
    case 'convert_to_draft':
    case 'renamed':
      return <EditIcon />
    case 'review_requested':
    case 'assigned':
      return <UserPlusIcon />
    case 'review_request_removed':
    case 'unassigned':
      return <UserMinusIcon />
    case 'deployed':
    case 'deployment_environment_changed':
      return <DeployIcon />
    case 'milestoned':
    case 'demilestoned':
      return <FlagIcon />
    case 'locked':
      return <LockIcon />
    case 'unlocked':
      return <UnlockIcon />
    case 'head_ref_deleted':
      return <ArchiveIcon />
    case 'head_ref_force_pushed':
      return <RefreshIcon />
    default:
      return <PullRequestIcon />
  }
}

function timelineActivityText(
  activity: TimelineActivity,
  onNavigate: (activity: PullRequestActivity) => void,
): ReactNode {
  const actor = activity.author?.login
  const prefix = actor == null ? null : <strong>{actor}</strong>
  switch (activity.event) {
    case 'labeled':
      return <>{prefix} added label <code>{activity.label ?? 'unknown'}</code></>
    case 'unlabeled':
      return <>{prefix} removed label <code>{activity.label ?? 'unknown'}</code></>
    case 'committed': {
      const shortOid = activity.commitId?.slice(0, 7) ?? 'changes'
      const commitLabel = activity.commitId == null
        ? <code>{shortOid}</code>
        : (
            <button
              className="pr-timeline-commit"
              type="button"
              onClick={() => onNavigate(activity)}
            >
              <code>{shortOid}</code>
            </button>
          )
      return <>{prefix} committed {commitLabel}{activity.subject == null ? null : ` · ${activity.subject}`}</>
    }
    case 'cross-referenced':
    case 'cross_referenced':
      return <>{prefix} referenced {timelineSourceText(activity.source)}</>
    case 'merged':
      return <>{prefix} merged this pull request</>
    case 'closed':
      return <>{prefix} closed this pull request</>
    case 'reopened':
      return <>{prefix} reopened this pull request</>
    case 'ready_for_review':
      return <>{prefix} marked this pull request ready for review</>
    case 'convert_to_draft':
      return <>{prefix} converted this pull request to draft</>
    case 'review_requested':
      return <>{prefix} requested a review from <strong>{activity.subject ?? 'a reviewer'}</strong></>
    case 'review_request_removed':
      return <>{prefix} removed the review request for <strong>{activity.subject ?? 'a reviewer'}</strong></>
    case 'assigned':
      return <>{prefix} assigned <strong>{activity.subject ?? 'a contributor'}</strong></>
    case 'unassigned':
      return <>{prefix} unassigned <strong>{activity.subject ?? 'a contributor'}</strong></>
    case 'renamed':
      return <>{prefix} renamed <code>{activity.previousTitle ?? 'the pull request'}</code> to <code>{activity.currentTitle ?? 'a new title'}</code></>
    default:
      return <>{prefix} {activity.event.replaceAll('_', ' ')}</>
  }
}

function timelineSourceText(source: Extract<PullRequestActivity, { kind: 'timeline' }>['source']): ReactNode {
  if (source == null) return 'another issue'
  const kind = source.kind === 'pull-request' ? 'pull request' : 'issue'
  const label = source.repository == null ? `#${source.number}` : `${source.repository}#${source.number}`
  const copy = (
    <>
      {kind} <code>{label}</code>
      {source.title === '' ? null : ` · ${source.title}`}
    </>
  )
  return source.url == null
    ? copy
    : <a href={source.url} target="_blank" rel="noreferrer">{copy}</a>
}

function reviewTimelineText(state: string): string {
  switch (state.toUpperCase()) {
    case 'APPROVED':
      return 'approved these changes'
    case 'CHANGES_REQUESTED':
      return 'requested changes'
    case 'DISMISSED':
      return 'had a review dismissed'
    default:
      return 'reviewed these changes'
  }
}

function piExplanationButtonLabel(status: PiReviewStatus): string {
  if (status.state === 'idle') return 'Explain with Pi'
  if (status.state === 'creating' || status.state === 'running') return 'Pi explaining…'
  if (status.state === 'failed' || status.state === 'interrupted') return 'Retry explanation'
  return 'Explain again'
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
