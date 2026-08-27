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
import { compareReviewFilePaths, compareReviewPathEntries } from './reviewFileOrder'
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
import {
  readStoredPullRequestList,
  storePullRequestList,
} from './pullRequestListCache'
import { useHotkey } from '@tanstack/react-hotkeys'
import {
  MessageSquarePlus as AddCommentIcon,
  Archive as ArchiveIcon,
  GitBranch as BranchIcon,
  Flag as FlagIcon,
  GitMerge as MergeIcon,
  GitPullRequest as PullRequestIcon,
  GitPullRequestClosed as PullRequestClosedIcon,
  GitPullRequestDraft as PullRequestDraftIcon,
  Check as CheckIcon,
  LoaderCircle as CheckRunningIcon,
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
  Unlock as UnlockIcon,
  UserMinus as UserMinusIcon,
  UserPlus as UserPlusIcon,
  History as HistoryIcon,
  Reply as ReplyIcon,
  FoldVertical as CollapseFilesIcon,
  UnfoldVertical as ExpandFilesIcon,
  Rows3 as StackIcon,
  Columns2 as SplitIcon,
  AlignJustify as LineDiffIcon,
  Braces as StructuralDiffIcon,
  Settings2 as SettingsIcon,
  CircleCheck,
  CircleX as RequestChangesIcon,
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
import {
  reviewTargetsEqual,
  sessionUsesFullCommitRange,
  targetSupportsStaging,
  type DiffRenderer,
} from '../shared/types'
import type {
  AnnotationIntent,
  DiffSide,
  GitHubIssueReference,
  GitHubReviewer,
  GitHubUser,
  MinimizedCommentReason,
  PiReviewRun,
  PiReviewStatus,
  PullRequestActivity,
  PullRequestDetails,
  PullRequestReviewEvent,
  PullRequestReviewStatus,
  PullRequestCheckRun,
  PullRequestCheckRunStatus,
  PullRequestListResponse,
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
import { repairedPullRequestRevisionId } from '../shared/pullRequestRevision'
import { annotationThreads } from '../shared/annotationThreads'
import { groupConversationActivities, type ReviewCommentThread } from '../shared/pullRequestActivity'
import {
  addAnnotation,
  addGlobalComment,
  addPullRequestComment,
  archiveAllAnnotations,
  createSession,
  getFileContents,
  getFilePair,
  getDifftasticAvailability,
  getPiReviewStatus,
  getPullRequest,
  getPullRequestRevisions,
  getPullRequests,
  getRepositoryInfo,
  getSession,
  getSessionFreshness,
  getSessions,
  openPullRequest,
  removePullRequestLabel,
  refreshSession,
  selectCommits,
  setAnnotationArchived,
  setGlobalCommentArchived,
  setFileViewed,
  setIgnoreWhitespace,
  stageFile,
  squashMergePullRequest,
  submitPullRequestReview,
  startPiReview,
  updateAnnotationComment,
  updateGlobalComment,
} from './api'
import { applyHoveredRange, applyImportance } from './importance'
import { formatTimestamp, relativeTime, relativeTimeAgo } from './time'
import { DifftasticView, scrollDifftasticTarget } from './DifftasticView'
import { ShortcutTooltip } from './ShortcutTooltip'
import { subscribeSessionEvents } from './sessionEvents'
import {
  EMPTY_COMPOSER_DRAFT,
  areCodeViewSelectionsEqual,
  buildCodeViewItems,
  fileIdForAnnotation,
  composerDraftAtom,
  composerSelectionAtom,
  composerSessionIdAtom,
  fileCollapsedAtom,
  fileViewedAtom,
  inlineAnnotationUiAtom,
  reviewCommentAvailableAtom,
  stickyOverlayIdsAtom,
  type ReviewLineAnnotation,
} from './annotationComposer'
import { PIERRE_COLLAPSED_CONTEXT_THRESHOLD } from './annotationPlacement'
import { AnnotationStickyOverlay } from './AnnotationStickyOverlay'

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

function isTextareaSubmitEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  return event.key === 'Enter' &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229
}

function hasDocumentSelection(): boolean {
  const selection = window.getSelection()
  if (selection != null && !selection.isCollapsed) return true

  const activeElement = document.activeElement
  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    return activeElement.selectionStart !== activeElement.selectionEnd
  }
  return false
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
    return subscribeSessionEvents(sessionId, () => void loadSession(sessionId, true))
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
        const latest = sessions.find((session) => session.target.kind !== 'pr') ?? sessions.at(0)
        if (latest == null) setEmpty(true)
        else onOpenSession(latest.id, true)
      })
      .catch(() => setEmpty(true))
  }, [onOpenSession])
  useDocumentChrome(APP_TITLE, 'default')
  if (!empty) return <LoadingScreen />

  return (
    <main className="root-empty">
      <span className="welcome-mark">Δ</span>
      <h1>No local reviews yet</h1>
      <p>Run <code>diff-review</code> from a Git repository to open the review desk.</p>
    </main>
  )
}

const PULL_REQUEST_FOCUS_REFRESH_THRESHOLD_MS = 10 * 60_000

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
  const [pendingPullRequestView, setPendingPullRequestView] = useState<PullRequestViewMode>('overview')
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
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
    staleTime: 0,
    refetchOnWindowFocus: (query) =>
      Date.now() - query.state.dataUpdatedAt >= PULL_REQUEST_FOCUS_REFRESH_THRESHOLD_MS,
    initialData: () => readStoredPullRequestList(route.repositoryPath, view),
    initialDataUpdatedAt: () => {
      const stored = readStoredPullRequestList(route.repositoryPath, view)
      const updatedAt = stored == null ? Number.NaN : Date.parse(stored.fetchedAt)
      return Number.isFinite(updatedAt) ? updatedAt : undefined
    },
    queryFn: async () => {
      const list = await getPullRequests(route.repositoryPath, view, { fresh: true })
      storePullRequestList(route.repositoryPath, view, list)
      return list
    },
  })
  const detailsQuery = useQuery({
    queryKey: ['pull-request-details', route.repositoryPath, number],
    queryFn: number == null
      ? skipToken
      : () => getPullRequest(number, route.repositoryPath),
  })
  const workspaceQuery = useQuery({
    queryKey: workspaceKey,
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey
      if (
        previousData == null ||
        previousKey?.[1] !== route.repositoryPath ||
        previousKey?.[2] !== number
      ) {
        return undefined
      }
      return previousData
    },
    queryFn: number == null
      ? skipToken
      : () => openPullRequest(number, {
          repositoryPath: route.repositoryPath,
          revisionId: route.revisionId,
        }),
  })
  const repository = repositoryQuery.data ?? null
  const pullRequests = pullRequestsQuery.data?.items ?? []
  const workspace = workspaceQuery.data
  const details = workspace?.details ?? detailsQuery.data ?? null
  const session = workspace?.selectedSession ?? null
  const currentSessionId = workspace?.currentSession.id ?? null
  const revisions = workspace?.revisions ?? []
  const piStatus = workspace?.piStatus ?? { state: 'idle' }
  const listLoading = pullRequestsQuery.isFetching && !loadingMore
  const listError = queryErrorMessage(pullRequestsQuery.error)
  const hasNextPage = pullRequestsQuery.data?.pageInfo.hasNextPage === true
  const endCursor = pullRequestsQuery.data?.pageInfo.endCursor ?? null
  const detailLoading = number != null && detailsQuery.isPending && workspaceQuery.isPending
  const detailError = queryErrorMessage(detailsQuery.error)
    ?? queryErrorMessage(workspaceQuery.error)
  const revisionLoading = number != null && workspaceQuery.isPending

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
      queryClient.invalidateQueries({
        queryKey: ['pull-request-details', route.repositoryPath, pullRequestNumber],
      }),
      queryClient.invalidateQueries({ queryKey: ['pull-requests', route.repositoryPath] }),
    ])
  }, [queryClient, route.repositoryPath])

  useEffect(() => {
    setPendingPullRequestView('overview')
  }, [number])

  useEffect(() => {
    const revisionId = repairedPullRequestRevisionId({
      pullRequestNumber: number,
      requestedRevisionId: route.revisionId,
      isPlaceholderData: workspaceQuery.isPlaceholderData,
      workspace: workspace ?? null,
    })
    if (revisionId == null || workspace == null || number == null) return
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
    workspaceQuery.isPlaceholderData,
  ])

  useEffect(() => {
    if (session == null || number == null) return
    const sessionId = session.id
    return subscribeSessionEvents(sessionId, () => {
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
    })
  }, [number, route.repositoryPath, session?.id, updateWorkspace])

  const rail = (
    <PullRequestRail
      key={route.repositoryPath}
      view={view}
      items={pullRequests}
      selectedNumber={route.pullRequestNumber}
      loading={listLoading}
      loadingMore={loadingMore}
      hasNextPage={hasNextPage}
      error={listError ?? loadMoreError}
      onViewChange={(nextView) => {
        setLoadMoreError(null)
        setView(nextView)
      }}
      onSelect={(nextNumber) => {
        if (nextNumber === route.pullRequestNumber) return
        onOpenPullRequests(route.repositoryPath, nextNumber)
      }}
      onLoadMore={() => {
        if (loadingMore || endCursor == null) return
        setLoadingMore(true)
        setLoadMoreError(null)
        void getPullRequests(route.repositoryPath, view, { after: endCursor })
          .then((page) => {
            queryClient.setQueryData<PullRequestListResponse>(
              ['pull-requests', route.repositoryPath, view],
              (current) => {
                const seen = new Set((current?.items ?? []).map((item) => item.number))
                const items = [
                  ...(current?.items ?? []),
                  ...page.items.filter((item) => !seen.has(item.number)),
                ]
                return {
                  items,
                  fetchedAt: current?.fetchedAt ?? page.fetchedAt,
                  stale: current?.stale === true,
                  pageInfo: page.pageInfo,
                }
              },
            )
          })
          .catch((error: unknown) => {
            setLoadMoreError(queryErrorMessage(error) ?? 'Could not load more pull requests.')
          })
          .finally(() => {
            setLoadingMore(false)
          })
      }}
    />
  )

  useDocumentChrome(
    formatDocumentTitle(
      repository?.name ?? repositoryNameFromPath(route.repositoryPath),
      details != null ? `PR #${details.number} · ${details.title}` : 'Pull requests',
    ),
    details != null ? 'pr' : 'default',
  )


  if (session == null || details == null || currentSessionId == null) {
    return (
      <PullRequestPageShell rail={rail}>
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
          <ReviewSourcePicker
            repositoryRoot={route.repositoryPath}
            repositoryName={repository?.name ?? repositoryNameFromPath(route.repositoryPath)}
            currentSession={null}
            mode="pr"
            onOpenSession={onOpenSession}
            onOpenPullRequests={onOpenPullRequests}
          />
          <div className="topbar-spacer" />
        </header>
        {details == null ? (
          <section className="pr-selection-empty">
            {detailError != null ? (
              <><span>Pull request unavailable</span><p>{detailError}</p></>
            ) : detailLoading ? (
              <><span className="loading-ring" /><p>Loading pull request…</p></>
            ) : (
              <><span className="empty-glyph">↗</span><p>Select a pull request to begin.</p></>
            )}
          </section>
        ) : (
          <>
            <PullRequestViewHeader
              key={details.number}
              view={pendingPullRequestView}
              details={details}
              onViewChange={setPendingPullRequestView}
              onRemoveAdditionalReviewLabel={async () => {
                await removePullRequestLabel(
                  details.number,
                  'additional-review-needed',
                  { repositoryPath: route.repositoryPath },
                )
                queryClient.setQueryData(
                  ['pull-request-details', route.repositoryPath, details.number],
                  (current: PullRequestDetails | undefined) => current == null ? undefined : ({
                    ...current,
                    labels: current.labels.filter(
                      (label) => label.name !== 'additional-review-needed',
                    ),
                  }),
                )
                refreshPullRequestData(details.number)
              }}
              currentRevision={false}
              reviewComments={[]}
              reviewReady={false}
              onSubmitReview={async () => undefined}
              onSquashMerge={async () => undefined}
            />
            <section
              id="pull-request-overview"
              className={`pr-overview-stage${pendingPullRequestView === 'overview' ? '' : ' is-hidden'}`}
              role="tabpanel"
              aria-labelledby="pull-request-overview-tab"
              aria-hidden={pendingPullRequestView !== 'overview'}
            >
              {detailError != null && <div className="error-banner">{detailError}</div>}
              <PullRequestConversation
                details={details}
                oldRevision={false}
                resolvedTheme={resolvedTheme}
                onNavigate={() => undefined}
                onAddComment={async (body, replyToId) => {
                  await addPullRequestComment(details.number, {
                    repositoryPath: route.repositoryPath,
                    body,
                    replyToId,
                  })
                  refreshPullRequestData(details.number)
                }}
              />
            </section>
            <div
              id="pull-request-diff"
              className={`review-workspace-body${pendingPullRequestView !== 'diff' ? ' is-hidden' : ''}`}
              role="tabpanel"
              aria-labelledby="pull-request-diff-tab"
              aria-hidden={pendingPullRequestView !== 'diff'}
            >
              <section className="pr-selection-empty">
                {queryErrorMessage(workspaceQuery.error) != null ? (
                  <><span>Diff unavailable</span><p>{queryErrorMessage(workspaceQuery.error)}</p></>
                ) : revisionLoading ? (
                  <><span className="loading-ring" /><p>Resolving pull request revision…</p></>
                ) : (
                  <><span className="empty-glyph">Δ</span><p>Diff is not ready yet.</p></>
                )}
              </section>
            </div>
          </>
        )}
      </PullRequestPageShell>
    )
  }

  return (
    <PullRequestPageShell rail={rail}>
      <ReviewWorkspaceStore sessionId={session.id}>
        <ReviewWorkspace
          embedded
          session={session}
          initialPullRequestView={pendingPullRequestView}
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
    </PullRequestPageShell>
  )
}

function PullRequestPageShell({
  rail,
  children,
}: {
  rail: ReactNode
  children: ReactNode
}) {
  return (
    <main className="review-shell pr-review-shell">
      {rail}
      {children}
    </main>
  )
}

function ReviewWorkspaceStore({
  sessionId,
  children,
}: {
  sessionId: string
  children: ReactNode
}) {
  const [store] = useState(() => createStore())
  useLayoutEffect(() => {
    store.set(composerSessionIdAtom, sessionId)
    store.set(composerSelectionAtom, null)
    store.set(composerDraftAtom, EMPTY_COMPOSER_DRAFT)
  }, [sessionId, store])
  return <Provider store={store}>{children}</Provider>
}

function ReviewWorkspace({
  session,
  initialPullRequestView = 'overview',
  error,
  onSessionChange,
  onOpenSession,
  onOpenPullRequests,
  onReload,
  themePreference,
  resolvedTheme,
  onThemeChange,
  pullRequest,
  embedded = false,
}: {
  session: ReviewSession
  initialPullRequestView?: PullRequestViewMode
  error: string | null
  onSessionChange(session: ReviewSession): void
  onOpenSession(id: string): void
  onOpenPullRequests(repositoryPath: string, pullRequestNumber?: number | null): void
  onReload(): Promise<void>
  themePreference: ThemePreference
  resolvedTheme: ResolvedTheme
  onThemeChange(theme: ThemePreference): void
  pullRequest?: PullRequestWorkspaceContext
  embedded?: boolean
}) {
  const viewerRef = useRef<CodeViewHandle<ReviewLineAnnotation>>(null)
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [renderer, setRenderer] = useState<DiffRenderer>(() => storedDiffRenderer())
  const [overflow, setOverflow] = useState<DiffOverflow>('wrap')
  const [pullRequestView, setPullRequestView] = useState<PullRequestViewMode>(initialPullRequestView)
  const previousSessionIdRef = useRef(session.id)
  const overviewScrollRef = useRef<HTMLElement>(null)
  const diffWorkspaceRef = useRef<HTMLDivElement>(null)
  const [diffScroller, setDiffScroller] = useState<HTMLElement | null>(null)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const pullRequestScrollPositions = useRef<Record<PullRequestViewMode, number>>({
    overview: 0,
    diff: 0,
  })
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [hoveredAnnotationId, setHoveredAnnotationId] = useState<string | null>(null)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)
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
  const [commentsCopied, setCommentsCopied] = useState(false)
  const viewedFiles = useMemo(() => new Set(session.viewedFiles), [session.viewedFiles])
  const [collapsedFiles, setCollapsedFiles] = useState(() => new Set(session.viewedFiles))
  const previousItemsRef = useRef<CodeViewItem<ReviewLineAnnotation>[]>([])
  const store = useStore()
  const composerSelectionRef = useRef(composerSelection)
  const onReloadRef = useRef(onReload)
  const annotationsRef = useRef(session.annotations)
  const hoveredAnnotationRef = useRef<SessionAnnotation | null>(null)
  const sessionContentsRef = useRef({ id: session.id, contentKey: patchContentKey(session.patch) })
  composerSelectionRef.current = composerSelection
  onReloadRef.current = onReload
  annotationsRef.current = session.annotations
  hoveredAnnotationRef.current =
    hoveredAnnotationId == null
      ? null
      : session.annotations.find((annotation) => annotation.id === hoveredAnnotationId) ?? null
  sessionContentsRef.current = { id: session.id, contentKey: patchContentKey(session.patch) }

  useDocumentChrome(
    formatDocumentTitle(
      session.repositoryName,
      pullRequest != null
        ? `PR #${pullRequest.details.number} · ${pullRequest.details.title}`
        : session.targetLabel,
    ),
    pullRequest != null ? 'pr' : 'local',
  )


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
    setActiveFilePath(null)
  }, [session.patch, setComposerDraft, setComposerSelection])

  useEffect(() => {
    setReviewCommentAvailable(pullRequest != null && sessionUsesFullCommitRange(session))
  }, [pullRequest, setReviewCommentAvailable])

  useEffect(() => {
    setCollapsedFiles(new Set(session.viewedFiles))
  }, [session.id])

  useEffect(() => {
    if (previousSessionIdRef.current === session.id) return
    previousSessionIdRef.current = session.id
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
      const contentKey = patchContentKey(session.patch)
      const files = parsePatchFiles(session.patch, `${session.id}:${contentKey}`, true).flatMap(
        (patch) => patch.files,
      )
      for (const file of files) {
        file.cacheKey = `${session.id}:${contentKey}:${file.name}`
      }
      return files.sort((left, right) => compareReviewFilePaths(left.name, right.name))
    } catch (caught) {
      console.error('Could not parse diff', caught)
      return []
    }
  }, [session.id, session.patch])

  useLayoutEffect(() => {
    for (const file of parsedFiles) {
      store.set(fileCollapsedAtom(file.name), collapsedFiles.has(file.name))
      store.set(fileViewedAtom(file.name), viewedFiles.has(file.name))
    }
  }, [collapsedFiles, parsedFiles, store, viewedFiles])

  const filePaths = useMemo(
    () => parsedFiles.map((file) => file.name),
    [parsedFiles],
  )
  const viewedFilePaths = useMemo(
    () => filePaths.filter((name) => viewedFiles.has(name)),
    [filePaths, viewedFiles],
  )
  const testFilePaths = useMemo(
    () => filePaths.filter(isTestFilePath),
    [filePaths],
  )
  const anyFileExpanded = filePaths.some((name) => !collapsedFiles.has(name))
  const anyViewedExpanded = viewedFilePaths.some((name) => !collapsedFiles.has(name))
  const anyTestExpanded = testFilePaths.some((name) => !collapsedFiles.has(name))
  const setFilesCollapsed = useCallback((paths: readonly string[], collapsed: boolean) => {
    for (const filePath of paths) {
      store.set(fileCollapsedAtom(filePath), collapsed)
    }
    setCollapsedFiles((current) => {
      const next = new Set(current)
      for (const filePath of paths) {
        if (collapsed) next.add(filePath)
        else next.delete(filePath)
      }
      return next
    })
  }, [store])

  const items = useMemo<CodeViewItem<ReviewLineAnnotation>[]>(() => {
    const nextItems = buildCodeViewItems(
      parsedFiles,
      session.annotations,
      composerSelection,
      collapsedFiles,
      previousItemsRef.current,
    )
    previousItemsRef.current = nextItems
    return nextItems
  }, [collapsedFiles, composerSelection, parsedFiles, session.annotations])

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
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      collapsedContextThreshold: PIERRE_COLLAPSED_CONTEXT_THRESHOLD,
      expansionLineCount: 20,
      lineDiffType: 'word-alt',
      itemMetrics: { lineHeight: 16 },
      onLineSelectionEnd(range, context) {
        if (range == null) return
        openComposer({ id: context.item.id, range })
      },
      async loadDiffFiles(fileDiff) {
        const { id, contentKey } = sessionContentsRef.current
        const oldPath = fileDiff.prevName ?? fileDiff.name
        const newPath = fileDiff.name
        if (fileDiff.type === 'rename-pure') {
          const pair = await getFilePair(id, null, newPath)
          if (pair.new == null) throw new Error(`Could not load ${newPath}`)
          return {
            oldFile: null,
            newFile: {
              name: newPath,
              contents: pair.new,
              cacheKey: `${id}:${contentKey}:new:${newPath}`,
            },
          }
        }
        const pair = await getFilePair(id, oldPath, newPath)
        if (pair.old == null || pair.new == null) {
          throw new Error(`Could not load both versions of ${newPath}`)
        }
        return {
          oldFile: {
            name: oldPath,
            contents: pair.old,
            cacheKey: `${id}:${contentKey}:old:${oldPath}`,
          },
          newFile: {
            name: newPath,
            contents: pair.new,
            cacheKey: `${id}:${contentKey}:new:${newPath}`,
          },
        }
      },
      onPostRender(node, _instance, phase, context) {
        applyImportance(node, phase, context, annotationsRef.current)
        if (phase !== 'unmount') {
          applyHoveredRange(node, context, hoveredAnnotationRef.current)
        }
      },
      unsafeCSS: [
        '[data-diffs-header="default"] { cursor: pointer; }',
        '[data-code] { scrollbar-gutter: auto; }',
        '[data-review-hover] { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent) 50%, transparent); background-image: linear-gradient(color-mix(in srgb, var(--accent) 8%, transparent), color-mix(in srgb, var(--accent) 8%, transparent)); }',
      ].join(' '),
    }),
    [layout, openComposer, overflow, resolvedTheme],
  )

  const handleSelection = useCallback((next: CodeViewLineSelection | null) => {
    if (next == null && composerSelectionRef.current != null) {
      setComposerSelection(null)
      setComposerDraft(EMPTY_COMPOSER_DRAFT)
    }
    setSelection(next)
  }, [setComposerDraft, setComposerSelection])

  useEffect(() => {
    const root = diffWorkspaceRef.current
    if (root == null) return
    const hovered = hoveredAnnotationRef.current
    for (const node of root.querySelectorAll<HTMLElement>('diffs-container')) {
      const fileId = node.querySelector('[data-file-id]')?.getAttribute('data-file-id')
      if (fileId == null) continue
      applyHoveredRange(node, { item: { id: fileId } }, hovered)
    }
  }, [hoveredAnnotationId, session.annotations])

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

  const addUserGlobalComment = useCallback(async (nextComment: string) => {
    await addGlobalComment(session.id, nextComment)
    await onReload()
  }, [onReload, session.id])

  const editGlobalComment = useCallback(async (commentId: string, nextComment: string) => {
    await updateGlobalComment(session.id, commentId, nextComment)
    await onReload()
  }, [onReload, session.id])

  const archiveGlobalComment = useCallback(async (commentId: string, archived: boolean) => {
    await setGlobalCommentArchived(session.id, commentId, archived)
    await onReload()
  }, [onReload, session.id])

  const archiveAll = useCallback(async () => {
    onSessionChange(await archiveAllAnnotations(session.id))
  }, [onSessionChange, session.id])

  const setViewed = useCallback(async (filePath: string, viewed: boolean) => {
    const updated = await setFileViewed(session.id, filePath, viewed)
    store.set(fileViewedAtom(filePath), viewed)
    setFileCollapsed(filePath, viewed)
    onSessionChange(updated)
    const afterCollapseLayout = () => {
      if (viewed) revealFileHeaderInViewport(filePath)
      const pointer = lastPointerRef.current
      const next = pointer != null ? fileIdAtClientPoint(pointer.x, pointer.y) : null
      if (next != null) {
        setActiveFilePath((current) => current === next ? current : next)
      }
    }
    // Collapse height updates after paint; one extra frame lets hit-test see the new file.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(afterCollapseLayout)
    })
  }, [onSessionChange, session.id, setFileCollapsed, store])
  const addFile = useCallback(async (filePath: string) => {
    onSessionChange(await stageFile(session.id, filePath))
  }, [onSessionChange, session.id])

  const stagingEnabled = targetSupportsStaging(session.target)
  const unstagedPathSet = useMemo(
    () => session.unstagedPaths == null ? null : new Set(session.unstagedPaths),
    [session.unstagedPaths],
  )
  const renderHeaderFilenameSuffix = useCallback((item: CodeViewItem<ReviewLineAnnotation>) => (
    <FileCopyButton filePath={item.id} />
  ), [])

  const renderHeaderMetadata = useCallback((item: CodeViewItem<ReviewLineAnnotation>) => (
    <FileHeaderControls
      filePath={item.id}
      stagingEnabled={stagingEnabled && (unstagedPathSet == null || unstagedPathSet.has(item.id))}
      onToggleCollapsed={setFileCollapsed}
      onAdd={addFile}
      onSetViewed={setViewed}
    />
  ), [addFile, setFileCollapsed, setViewed, stagingEnabled, unstagedPathSet])

  const handleComposerSubmitted = useCallback(async () => {
    closeComposer()
    await onReloadRef.current()
  }, [closeComposer])

  const renderInlineAnnotation = useCallback((
    annotation: SessionAnnotation,
    replies: SessionAnnotation[],
    interactive: boolean,
  ) => (
    <InlineAnnotation
      interactive={interactive}
      annotation={annotation}
      onHover={setHoveredAnnotationId}
      replies={replies}
      onArchive={(annotationId) => setArchived(annotationId, true)}
      onUpdateComment={editAnnotation}
      onReply={annotation.source === 'agent' && annotation.replyToId == null
        ? (comment) => addAnnotation(session.id, {
            filePath: annotation.filePath,
            side: annotation.side,
            startLine: annotation.startLine,
            endSide: annotation.endSide ?? undefined,
            endLine: annotation.endLine,
            comment,
            source: 'user',
            replyToId: annotation.id,
          }).then(() => onReloadRef.current())
        : undefined}
    />
  ), [editAnnotation, session.id, setArchived])

  const renderAnnotation = useCallback((annotation: DiffLineAnnotation<ReviewLineAnnotation>) => {
    const metadata = annotation.metadata
    if (metadata == null) return null
    return metadata.kind === 'composer' ? (
      <InlineComposer
        selection={metadata.selection}
        onCancel={closeComposer}
        onSubmitted={handleComposerSubmitted}
      />
    ) : renderInlineAnnotation(
      metadata.annotation,
      session.annotations.filter((item) =>
        item.replyToId === metadata.annotation.id &&
        item.archivedAt == null &&
        item.comment != null
      ),
      false,
    )
  }, [handleComposerSubmitted, renderInlineAnnotation, session.annotations])

  useLayoutEffect(() => {
    setDiffScroller(diffWorkspaceRef.current?.querySelector<HTMLElement>('.diff-view') ?? null)
  }, [items.length, layout, renderer, resolvedTheme, session.id, session.patch])

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
    }
    const clearPointer = () => {
      lastPointerRef.current = null
    }
    window.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerleave', clearPointer)
    window.addEventListener('blur', clearPointer)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', clearPointer)
      window.removeEventListener('blur', clearPointer)
    }
  }, [])

  useHotkey('V', () => {
    const pointer = lastPointerRef.current
    const viewer = viewerRef.current?.getInstance()
    const filePath =
      (pointer != null ? fileIdAtClientPoint(pointer.x, pointer.y) : null)
      ?? activeFilePath
      ?? (viewer != null ? fileIdAtCodeViewScroll(viewer, items, viewer.getScrollTop()) : null)
      ?? items.at(0)?.id

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

  const [refreshAvailable, setRefreshAvailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const { stale } = await getSessionFreshness(session.id)
        if (!cancelled) setRefreshAvailable(stale)
      } catch {
        if (!cancelled) setRefreshAvailable(false)
      }
    }
    void check()
    const timer = window.setInterval(check, 10_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [session.id])

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const updated = await refreshSession(session.id)
      setRefreshAvailable(false)
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

  const humanAnnotations = useMemo(() => session.annotations.filter(
    (annotation) =>
      annotation.archivedAt == null &&
      annotation.source === 'user' &&
      Boolean(annotation.comment?.trim()),
  ), [session.annotations])
  const humanGlobalComments = useMemo(() => session.globalComments.filter(
    (comment) => comment.archivedAt == null && comment.source === 'user',
  ), [session.globalComments])
  const hasHumanComments = humanAnnotations.length > 0 || humanGlobalComments.length > 0
  const copyHumanComments = useCallback(async () => {
    await navigator.clipboard.writeText(
      await formatCommentsForAgent(
        session.id,
        humanGlobalComments.map((comment) => comment.comment).join('\n\n') || null,
        humanAnnotations,
        session.annotations,
        parsedFiles,
      ),
    )
    setCommentsCopied(true)
    window.setTimeout(() => setCommentsCopied(false), 1600)
  }, [humanAnnotations, humanGlobalComments, parsedFiles, session.annotations, session.id])

  useEffect(() => {
    const onCopy = (event: globalThis.KeyboardEvent) => {
      const isCommandC =
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'c'
      if (!isCommandC) return
      if (!hasHumanComments || hasDocumentSelection()) return
      event.preventDefault()
      void copyHumanComments()
    }
    document.addEventListener('keydown', onCopy)
    return () => document.removeEventListener('keydown', onCopy)
  }, [copyHumanComments, hasHumanComments])

  const difftasticQuery = useQuery({
    queryKey: ['difftastic-availability'],
    queryFn: getDifftasticAvailability,
    staleTime: 30_000,
  })
  const difftastic = difftasticQuery.data
  const difftasticReady = difftastic?.available === true
  const selectFile = useCallback((id: string) => {
    setActiveFilePath(id)
    setFileCollapsed(id, false)
    if (renderer === 'difftastic') {
      scheduleDifftasticScroll(diffWorkspaceRef.current, id)
      return
    }
    window.requestAnimationFrame(() => {
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
    const fileId = activity.path
    if (fileId == null) return
    setActiveFilePath(fileId)
    setFileCollapsed(fileId, false)
    const side = activity.side === 'old' ? 'old' : 'new'
    if (renderer === 'difftastic') {
      scheduleDifftasticScroll(diffWorkspaceRef.current, fileId, { line: lineNumber, side })
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        viewerRef.current?.scrollTo({
          type: 'line',
          id: fileId,
          lineNumber,
          side: side === 'old' ? 'deletions' : 'additions',
          align: 'start',
          behavior: 'smooth-auto',
        })
      })
    })
  }, [pullRequest, renderer, setFileCollapsed, switchPullRequestView])

  const workspaceStyle = {
    '--left-panel-width': `${leftPanelWidth}px`,
    '--right-panel-width': `${rightPanelWidth}px`,
  } as CSSProperties

  const content = (
    <>
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
        <ReviewSourcePicker
          repositoryRoot={session.repositoryRoot}
          repositoryName={session.repositoryName}
          currentSession={session}
          mode={pullRequest == null ? 'local' : 'pr'}
          onOpenSession={onOpenSession}
          onOpenPullRequests={onOpenPullRequests}
        />
        {pullRequest != null && (
          <RevisionPicker
            revisions={pullRequest.revisions}
            selectedSessionId={session.id}
            currentSessionId={pullRequest.currentSessionId}
            onSelect={pullRequest.onSelectRevision}
          />
        )}
        <CommitPicker session={session} onSessionChange={onSessionChange} />
        <div className="topbar-spacer" />
        {(pullRequest == null || pullRequestView === 'diff') && (
          <>
            <FoldFilesMenu
              anyFileExpanded={anyFileExpanded}
              anyViewedExpanded={anyViewedExpanded}
              anyTestExpanded={anyTestExpanded}
              fileCount={filePaths.length}
              viewedCount={viewedFilePaths.length}
              onToggleAll={() => setFilesCollapsed(filePaths, anyFileExpanded)}
              onToggleViewed={() => setFilesCollapsed(viewedFilePaths, anyViewedExpanded)}
              onCollapseTests={() => setFilesCollapsed(testFilePaths, true)}
            />
            <ToggleGroup
              className="layout-switch"
              aria-label="Diff layout"
              value={[layout]}
              onValueChange={(value) => {
                const next = value.at(0)
                if (next === 'unified' || next === 'split') setLayout(next)
              }}
            >
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Toggle value="unified" aria-label="Stacked layout">
                      <StackIcon />
                    </Toggle>
                  }
                />
                <Tooltip.Portal>
                  <Tooltip.Positioner className="tooltip-positioner" sideOffset={6}>
                    <Tooltip.Popup className="tooltip-popup">Stacked layout</Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </Tooltip.Root>
              <Tooltip.Root>
                <Tooltip.Trigger
                  render={
                    <Toggle value="split" aria-label="Split layout">
                      <SplitIcon />
                    </Toggle>
                  }
                />
                <Tooltip.Portal>
                  <Tooltip.Positioner className="tooltip-positioner" sideOffset={6}>
                    <Tooltip.Popup className="tooltip-popup">Split layout</Tooltip.Popup>
                  </Tooltip.Positioner>
                </Tooltip.Portal>
              </Tooltip.Root>
            </ToggleGroup>
            <RendererSwitch
              value={renderer === 'difftastic' && difftasticReady ? 'difftastic' : 'pierre'}
              structuralDisabled={!difftasticReady}
              hint={difftastic?.installHint ?? 'Install difftastic and make sure `difft` is on PATH.'}
              onChange={(next) => {
                setRenderer(next)
                storeDiffRenderer(next)
              }}
            />
            <DiffOptionsMenu
              wrap={overflow === 'wrap'}
              ignoreWhitespace={session.ignoreWhitespace}
              theme={themePreference}
              busy={busy}
              onWrapChange={(wrap) => setOverflow(wrap ? 'wrap' : 'scroll')}
              onIgnoreWhitespaceChange={updateIgnoreWhitespace}
              onThemeChange={onThemeChange}
            />
          </>
        )}
        <button
          className="icon-button"
          onClick={refresh}
          aria-label={refreshAvailable ? 'Refresh diff, updates available' : 'Refresh diff'}
          disabled={busy}
        >
          <RefreshIcon className={busy ? 'spinning' : ''} />
          {refreshAvailable ? <span className="icon-button-badge" aria-hidden="true" /> : null}
        </button>
        <ShortcutTooltip
          label={commentsCopied ? 'Copied' : 'Copy my comments'}
          shortcut="⌘C"
        >
          <button
            className="icon-button"
            onClick={() => void copyHumanComments()}
            aria-label={commentsCopied ? 'Copied' : 'Copy my comments'}
            disabled={!hasHumanComments}
          >
            {commentsCopied ? <CheckIcon /> : <CopyIcon />}
          </button>
        </ShortcutTooltip>
        {pullRequest != null && (
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
            viewedFiles={viewedFiles}
            resolvedTheme={resolvedTheme}
            activeFilePath={activeFilePath}
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
            ) : renderer === 'difftastic' && difftasticReady ? (
              <DifftasticView
                session={session}
                files={parsedFiles}
                layout={layout}
                resolvedTheme={resolvedTheme}
                hoveredAnnotationId={hoveredAnnotationId}
                onHoverAnnotation={setHoveredAnnotationId}
                collapsedFiles={collapsedFiles}
                viewedFiles={viewedFiles}
                onToggleCollapsed={(filePath) => {
                  setFileCollapsed(filePath, !collapsedFiles.has(filePath))
                }}
                onSetViewed={setViewed}
                onVisibleFileChange={setActiveFilePath}
                renderAnnotation={(annotation, replies) => renderInlineAnnotation(annotation, replies, true)}
              />
            ) : (
              <div className="diff-view-host">
                <CodeView<ReviewLineAnnotation>
                  ref={viewerRef}
                  key={`${session.id}:${layout}:${resolvedTheme}:${patchContentKey(session.patch)}`}
                  className="diff-view"
                  items={items}
                  options={diffOptions}
                  selectedLines={selection}
                  onSelectedLinesChange={handleSelection}
                  onScroll={(scrollTop, viewer) => {
                    const next = fileIdAtCodeViewScroll(viewer, items, scrollTop)
                    if (next != null) {
                      setActiveFilePath((current) => current === next ? current : next)
                    }
                  }}
                  renderHeaderFilenameSuffix={renderHeaderFilenameSuffix}
                  renderHeaderMetadata={renderHeaderMetadata}
                  renderAnnotation={renderAnnotation}
                />
                <AnnotationStickyOverlay
                  scroller={diffScroller}
                  annotations={session.annotations}
                  files={parsedFiles}
                  collapsedFiles={collapsedFiles}
                  renderCard={(annotation, replies) => renderInlineAnnotation(annotation, replies, true)}
                />
              </div>
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
            activeFilePath={activeFilePath}
            piStatus={pullRequest?.piStatus}
            commentsCopied={commentsCopied}
            hasHumanComments={hasHumanComments}
            onCopyComments={copyHumanComments}
            onSetArchived={setArchived}
            onUpdateComment={editAnnotation}
            onReload={onReload}
            onAddGlobalComment={addUserGlobalComment}
            onUpdateGlobalComment={editGlobalComment}
            onSetGlobalArchived={archiveGlobalComment}
            onArchiveAll={archiveAll}
            onOpenSession={onOpenSession}
            onHoverAnnotation={setHoveredAnnotationId}
            onNavigate={(annotation) => {
              const fileId = fileIdForAnnotation(annotation, parsedFiles)
              setActiveFilePath(fileId)
              setFileCollapsed(fileId, false)
              if (renderer === 'difftastic') {
                scheduleDifftasticScroll(diffWorkspaceRef.current, fileId, {
                  line: annotation.endLine,
                  side: annotation.endSide ?? annotation.side,
                  annotationId: annotation.id,
                })
                return
              }
              viewerRef.current?.scrollTo({
                type: 'line',
                id: fileId,
                lineNumber: annotation.endLine,
                side: annotation.side === 'new' ? 'additions' : 'deletions',
                align: 'center',
                behavior: 'smooth-auto',
              })
            }}
          />
        </div>
      </div>
    </>
  )
  if (embedded) return content
  return <main className="review-shell">{content}</main>
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

function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/')
  if (normalized.includes('/__tests__/') || normalized.startsWith('__tests__/')) return true
  return /(?:\.test\.tsx?|\.spec\.ts|\.spec\.js)$/.test(normalized)
}

function FoldFilesMenu({
  anyFileExpanded,
  anyViewedExpanded,
  anyTestExpanded,
  fileCount,
  viewedCount,
  onToggleAll,
  onToggleViewed,
  onCollapseTests,
}: {
  anyFileExpanded: boolean
  anyViewedExpanded: boolean
  anyTestExpanded: boolean
  fileCount: number
  viewedCount: number
  onToggleAll(): void
  onToggleViewed(): void
  onCollapseTests(): void
}) {
  const [open, setOpen] = useState(false)
  const [focusOnOpen, setFocusOnOpen] = useState(false)
  const closeTimerRef = useRef(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const defaultLabel = anyFileExpanded ? 'Collapse all' : 'Expand all'
  const viewedLabel = anyViewedExpanded ? 'Collapse viewed' : 'Expand viewed'

  const clearHoverTimers = useCallback(() => {
    window.clearTimeout(closeTimerRef.current)
  }, [])

  const focusMenuItem = useCallback((index: number) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (items.length === 0) return
    items[(index + items.length) % items.length]?.focus()
  }, [])

  const openMenuFromKeyboard = useCallback(() => {
    clearHoverTimers()
    setFocusOnOpen(true)
    setOpen(true)
  }, [clearHoverTimers])

  useLayoutEffect(() => {
    if (!open || !focusOnOpen) return
    setFocusOnOpen(false)
    focusMenuItem(0)
  }, [focusMenuItem, focusOnOpen, open])

  const closeMenuToTrigger = useCallback(() => {
    clearHoverTimers()
    setOpen(false)
    triggerRef.current?.focus()
  }, [clearHoverTimers])

  useEffect(() => clearHoverTimers, [clearHoverTimers])

  return (
    <div
      className="fold-files-control"
      onMouseEnter={() => {
        clearHoverTimers()
        setOpen(true)
      }}
      onMouseLeave={() => {
        clearHoverTimers()
        closeTimerRef.current = window.setTimeout(() => setOpen(false), 160)
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        clearHoverTimers()
        setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label={defaultLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={fileCount === 0}
        onClick={onToggleAll}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openMenuFromKeyboard()
        }}
      >
        {anyFileExpanded ? <CollapseFilesIcon /> : <ExpandFilesIcon />}
      </button>
      {open && (
        <div
          ref={menuRef}
          className="fold-files-menu"
          role="menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              closeMenuToTrigger()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
            const current = items.indexOf(event.target as HTMLButtonElement)
            focusMenuItem(current + (event.key === 'ArrowDown' ? 1 : -1))
          }}
        >
          <button type="button" className="fold-files-option" role="menuitem" onClick={onToggleAll}>
            {defaultLabel}
          </button>
          <button
            type="button"
            className="fold-files-option"
            role="menuitem"
            disabled={viewedCount === 0}
            onClick={onToggleViewed}
          >
            {viewedLabel}
          </button>
          <button
            type="button"
            className="fold-files-option"
            role="menuitem"
            disabled={!anyTestExpanded}
            onClick={onCollapseTests}
          >
            Collapse test files
          </button>
        </div>
      )}
    </div>
  )
}

function ThemeOptions({
  value,
  onChange,
}: {
  value: ThemePreference
  onChange(theme: ThemePreference): void
}) {
  return (
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
            <Menu.RadioItemIndicator keepMounted className="theme-check">
              <CheckIcon />
            </Menu.RadioItemIndicator>
            <span>{theme === 'system' ? 'System' : capitalize(theme)}</span>
            <small>{theme === 'system' ? 'Follow device' : `${capitalize(theme)} colors`}</small>
          </Menu.RadioItem>
        ))}
      </Menu.RadioGroup>
    </Menu.Group>
  )
}

function RendererSwitch({
  value,
  structuralDisabled,
  hint,
  onChange,
}: {
  value: 'pierre' | 'difftastic'
  structuralDisabled: boolean
  hint: string
  onChange(next: 'pierre' | 'difftastic'): void
}) {
  const structuralDescription = 'Structural diff powered by difftastic. Easier to read, but fewer features.'

  return (
    <ToggleGroup
      className="layout-switch"
      aria-label="Diff renderer"
      value={[value]}
      onValueChange={(nextValue) => {
        const next = nextValue.at(0)
        if (next === 'pierre' || next === 'difftastic') onChange(next)
      }}
    >
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Toggle value="pierre" aria-label="Line diff">
              <LineDiffIcon />
            </Toggle>
          }
        />
        <Tooltip.Portal>
          <Tooltip.Positioner className="tooltip-positioner" sideOffset={6}>
            <Tooltip.Popup className="tooltip-popup">Line diff</Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Toggle value="difftastic" aria-label="Structural diff" disabled={structuralDisabled}>
              <StructuralDiffIcon />
            </Toggle>
          }
        />
        <Tooltip.Portal>
          <Tooltip.Positioner className="tooltip-positioner" sideOffset={6}>
            <Tooltip.Popup className="tooltip-popup">
              {structuralDisabled ? `${structuralDescription} ${hint}` : structuralDescription}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </ToggleGroup>
  )
}

function DiffOptionsMenu({
  wrap,
  ignoreWhitespace,
  theme,
  busy,
  onWrapChange,
  onIgnoreWhitespaceChange,
  onThemeChange,
}: {
  wrap: boolean
  ignoreWhitespace: boolean
  theme: ThemePreference
  busy: boolean
  onWrapChange(wrap: boolean): void
  onIgnoreWhitespaceChange(ignoreWhitespace: boolean): void
  onThemeChange(theme: ThemePreference): void
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="diff-options-trigger" aria-label="Review settings">
        <SettingsIcon />
        <span>Settings</span>
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
            <ThemeOptions value={theme} onChange={onThemeChange} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

function PullRequestStateIcon({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const props = { size: 12, strokeWidth: 2.2, 'aria-hidden': true as const }
  if (pullRequest.isDraft) return <PullRequestDraftIcon {...props} />
  if (pullRequest.state === 'MERGED') return <MergeIcon {...props} />
  if (pullRequest.state === 'CLOSED') return <PullRequestClosedIcon {...props} />
  return <PullRequestIcon {...props} />
}

function CheckStatusIcon({ status }: { status: PullRequestSummary['checkStatus'] }) {
  const props = { size: 12, strokeWidth: 2.8, 'aria-hidden': true as const }
  if (status === 'pass') return <CheckIcon {...props} />
  if (status === 'fail') return <CloseIcon {...props} />
  if (status === 'pending') return <CheckRunningIcon {...props} />
  return null
}

function PullRequestRail({
  view,
  items,
  selectedNumber,
  loading,
  loadingMore,
  hasNextPage,
  error,
  onViewChange,
  onSelect,
  onLoadMore,
}: {
  view: PullRequestListView
  items: PullRequestSummary[]
  selectedNumber: number | null
  loading: boolean
  loadingMore: boolean
  hasNextPage: boolean
  error: string | null
  onViewChange(view: PullRequestListView): void
  onSelect(number: number): void
  onLoadMore(): void
}) {
  const views: { id: PullRequestListView; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'additional-review', label: 'Additional' },
    { id: 'merged', label: 'Merged' },
  ]
  const [width, setWidth] = useState(() => storedPanelWidth('pr', 292, 220, 520))
  return (
    <>
    <aside className="pr-rail" style={{ width }}>
      <div className="pr-rail-heading">
        <div><span>Pull requests</span><strong>{loading ? '…' : items.length}</strong></div>
        <div className="pr-view-tabs" role="tablist" aria-label="Pull request view">
          {views.map((item) => {
            const selected = view === item.id
            return (
              <button
                key={item.id}
                role="tab"
                aria-selected={selected}
                aria-busy={selected && loading}
                className={selected ? 'active' : ''}
                title={selected && error != null ? error : undefined}
                onClick={() => onViewChange(item.id)}
              >
                <span>{item.label}</span>
                {selected && loading ? <span className="loading-ring" /> : null}
                {selected && !loading && error != null ? <span className="pr-tab-error">Error</span> : null}
              </button>
            )
          })}
        </div>
      </div>
      <div className="pr-list">
        {items.length === 0 && error != null ? (
          <div className="pr-list-message error">{error}</div>
        ) : items.length === 0 && loading ? (
          <div className="pr-list-message"><span className="loading-ring" /> Loading pull requests…</div>
        ) : items.length === 0 ? (
          <div className="pr-list-message">No pull requests in this view.</div>
        ) : items.map((pullRequest) => (
          <button
            key={pullRequest.number}
            className={`pr-list-item${selectedNumber === pullRequest.number ? ' selected' : ''}`}
            onClick={() => onSelect(pullRequest.number)}
          >
            <span
              className={`pr-state-icon ${pullRequest.isDraft ? 'draft' : pullRequest.state.toLowerCase()}`}
              title={pullRequest.isDraft ? 'Draft' : titleCase(pullRequest.state)}
              aria-label={pullRequest.isDraft ? 'Draft' : titleCase(pullRequest.state)}
            >
              <PullRequestStateIcon pullRequest={pullRequest} />
            </span>
            <span
              className={`check-state-icon ${pullRequest.checkStatus}`}
              title={checkStatusLabel(pullRequest.checkStatus)}
              aria-label={checkStatusLabel(pullRequest.checkStatus)}
            >
              <CheckStatusIcon status={pullRequest.checkStatus} />
            </span>
            <span className="pr-item-title">
              <code>#{pullRequest.number}</code>
              {pullRequest.title}
            </span>
            <div className="pr-item-meta">
              <span className="pr-item-people" title={pullRequest.author.login} aria-label={pullRequest.author.login}>
                <UserAvatar user={pullRequest.author} />
              </span>
              {pullRequest.reviewers.length > 0 && (
                <span
                  className="pr-item-reviewers"
                  title={pullRequest.reviewers.map((reviewer) => reviewer.login).join(', ')}
                  aria-label={pullRequest.reviewers.map((reviewer) => reviewer.login).join(', ')}
                >
                  {pullRequest.reviewers.map((reviewer) => (
                    <span className="pr-item-reviewer" key={reviewer.login}>
                      <UserAvatar user={reviewer} />
                    </span>
                  ))}
                </span>
              )}
              {pullRequest.commentCount > 0 && (
                <span className="pr-item-comments" title={`${pullRequest.commentCount} comments and reviews`} aria-label={`${pullRequest.commentCount} comments and reviews`}>
                  <CommentIcon size={12} strokeWidth={2} />
                  {pullRequest.commentCount}
                </span>
              )}
              <ReviewStatus status={aggregateReviewStatus(pullRequest.reviewers)} showLabel />
              <span className="pr-item-stats">
                <span className="addition">+{pullRequest.additions}</span>
                <span className="deletion">−{pullRequest.deletions}</span>
                <time
                  title={pullRequest.updatedAt === pullRequest.createdAt
                    ? `Created ${formatTimestamp(pullRequest.createdAt)}`
                    : `Updated ${formatTimestamp(pullRequest.updatedAt)}`}
                >
                  {relativeTime(
                    pullRequest.updatedAt === pullRequest.createdAt
                      ? pullRequest.createdAt
                      : pullRequest.updatedAt,
                  )}
                </time>
              </span>
            </div>
          </button>
        ))}
        {items.length > 0 && hasNextPage ? (
          <button
            className="pr-load-more"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            {loadingMore ? <span className="loading-ring" /> : null}
            {loadingMore ? 'Loading more…' : 'Load more'}
          </button>
        ) : null}
        {items.length > 0 && error != null ? (
          <div className="pr-list-message error">{error}</div>
        ) : null}
      </div>
    </aside>
    <PanelResizeHandle
      label="Resize pull request list"
      side="left"
      size={width}
      min={220}
      max={520}
      onChange={(next) => {
        setWidth(next)
        storePanelWidth('pr', next)
      }}
    />
    </>
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
                onKeyDown={(event) => {
                  if (!isTextareaSubmitEnter(event)) return
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }}
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
  reviewReady = true,
  onViewChange,
  onRemoveAdditionalReviewLabel,
  onSubmitReview,
  onSquashMerge,
}: {
  view: PullRequestViewMode
  details: PullRequestDetails
  currentRevision: boolean
  reviewComments: SessionAnnotation[]
  reviewReady?: boolean
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
        {reviewReady && (
          <SubmitReviewPopover
            key={`${details.number}:${details.state}`}
            comments={reviewComments}
            allowedEvents={reviewEventsForPullRequest(details.state)}
            onSubmit={onSubmitReview}
          />
        )}
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
  comments,
  allowedEvents,
  onSubmit,
}: {
  comments: SessionAnnotation[]
  allowedEvents: PullRequestReviewEvent[]
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [event, setEvent] = useState<PullRequestReviewEvent>('COMMENT')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canSubmit = event !== 'COMMENT' || Boolean(body.trim()) || comments.length > 0
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
      <Popover.Trigger className="submit-review-button">
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
              <div className="review-type-field">
                <span>Review type</span>
                <ToggleGroup
                  className="layout-switch review-type-switch"
                  aria-label="Review type"
                  disabled={busy}
                  value={[event]}
                  onValueChange={(value) => {
                    const next = value.at(0)
                    if (next === 'APPROVE' || next === 'COMMENT' || next === 'REQUEST_CHANGES') {
                      if (allowedEvents.includes(next)) setEvent(next)
                    }
                  }}
                >
                  {allowedEvents.includes('COMMENT') && (
                    <Toggle value="COMMENT"><CommentIcon />Comment</Toggle>
                  )}
                  {allowedEvents.includes('APPROVE') && (
                    <Toggle value="APPROVE"><CheckIcon />Approve</Toggle>
                  )}
                  {allowedEvents.includes('REQUEST_CHANGES') && (
                    <Toggle value="REQUEST_CHANGES"><RequestChangesIcon />Request changes</Toggle>
                  )}
                </ToggleGroup>
              </div>
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
          <div className="pr-sidebar-conflict">
            <strong>Has conflicts</strong>
            {details.conflictFiles.length === 0
              ? <p>Conflicts must be resolved before merging.</p>
              : (
                  <>
                    <p>
                      {details.conflictFiles.length === 1
                        ? '1 file must be resolved before merging.'
                        : `${details.conflictFiles.length} files must be resolved before merging.`}
                    </p>
                    <ul className="pr-sidebar-conflict-files">
                      {details.conflictFiles.map((filePath) => (
                        <li key={filePath} title={filePath}>{filePath}</li>
                      ))}
                    </ul>
                  </>
                )}
          </div>
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

      <SidebarPeople
        title="Reviewers"
        people={details.reviewers}
        emptyLabel="No reviewers"
        renderTrailing={(reviewer) => <ReviewStatus status={reviewer.reviewStatus} />}
      />
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

function SidebarPeople<T extends GitHubUser>({
  title,
  people,
  emptyLabel,
  renderTrailing,
}: {
  title: string
  people: T[]
  emptyLabel: string
  renderTrailing?: (person: T) => ReactNode
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
                  {renderTrailing?.(person)}
                </div>
              ))}
            </div>
          )}
    </section>
  )
}

function aggregateReviewStatus(reviewers: GitHubReviewer[]): PullRequestReviewStatus {
  if (reviewers.some((reviewer) => reviewer.reviewStatus === 'rejected')) return 'rejected'
  if (reviewers.some((reviewer) => reviewer.reviewStatus === 'approved')) return 'approved'
  return 'none'
}

function ReviewStatus({
  status,
  showLabel = false,
}: {
  status: PullRequestReviewStatus
  showLabel?: boolean
}) {
  if (status !== 'approved' && status !== 'rejected') return null
  const label = status === 'approved' ? 'Approved' : 'Rejected'
  return (
    <span className={`review-status ${status}`} title={label} aria-label={label}>
      {status === 'approved' ? <CheckIcon /> : <CloseIcon />}
      {showLabel && <span>{label}</span>}
    </span>
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

function ReviewSourcePicker({
  repositoryRoot,
  repositoryName,
  currentSession,
  mode,
  onOpenSession,
  onOpenPullRequests,
}: {
  repositoryRoot: string
  repositoryName: string
  currentSession: ReviewSession | null
  mode: 'pr' | 'local'
  onOpenSession(id: string): void
  onOpenPullRequests(repositoryPath: string, pullRequestNumber?: number | null): void
}) {
  const [open, setOpen] = useState(false)
  const [repository, setRepository] = useState<RepositoryInfo | null>(null)
  const [sessions, setSessions] = useState<ReviewSession[]>([])
  const [customRange, setCustomRange] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentRevision = localRevisionLabel(currentSession)
  const revisionSessions = localRevisionSessions(sessions)

  useEffect(() => {
    if (!open) return
    void Promise.all([
      getRepositoryInfo(repositoryRoot),
      getSessions(repositoryRoot),
    ])
      .then(([info, nextSessions]) => {
        setRepository(info)
        setSessions(nextSessions)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
  }, [open, repositoryRoot])

  const openExisting = (sessionId: string) => {
    setOpen(false)
    onOpenSession(sessionId)
  }

  const choose = async (target: ReviewTarget) => {
    setBusy(true)
    setError(null)
    try {
      const next = await createSession({ repositoryPath: repositoryRoot, target })
      setOpen(false)
      onOpenSession(next.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  const pullRequestNumber =
    currentSession?.target.kind === 'pr' ? currentSession.target.number : null

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="local-review-trigger">
        {mode === 'pr' ? <PullRequestIcon /> : <BranchIcon />}
        <span>{mode === 'pr' ? 'Pull requests' : 'Local diffs'}</span>
        {mode === 'pr' && pullRequestNumber != null && <code>#{pullRequestNumber}</code>}
        {mode === 'local' && currentRevision != null && <code>{currentRevision}</code>}
        <ChevronIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="popup-positioner" sideOffset={8} align="start">
          <Popover.Popup className="target-menu">
            <Popover.Title className="menu-kicker">{repositoryName}</Popover.Title>
            <TargetOption
              selected={mode === 'pr'}
              label="Pull requests"
              detail="Open GitHub pull request reviews"
              onClick={() => {
                setOpen(false)
                onOpenPullRequests(repositoryRoot, pullRequestNumber)
              }}
            />
            <div className="menu-section-label">Local diffs</div>
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

            {revisionSessions.length > 0 && (
              <>
                <div className="menu-section-label">Sessions</div>
                {revisionSessions.map((item) => {
                  const revision = localRevisionLabel(item)!
                  return (
                    <TargetOption
                      key={item.id}
                      selected={item.id === currentSession?.id}
                      label={item.targetLabel}
                      detail={revision}
                      onClick={() => openExisting(item.id)}
                    />
                  )
                })}
              </>
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


function localRevisionLabel(session: ReviewSession | null): string | null {
  if (session?.revisionBaseOid == null || session.revisionHeadOid == null) return null
  return `${session.revisionBaseOid.slice(0, 7)}…${session.revisionHeadOid.slice(0, 7)}`
}

function localRevisionSessions(sessions: ReviewSession[]): ReviewSession[] {
  const byRevision = new Map<string, ReviewSession>()
  for (const session of sessions) {
    if (session.target.kind === 'pr') continue
    if (session.revisionBaseOid == null || session.revisionHeadOid == null) continue
    const key = `${session.revisionBaseOid}:${session.revisionHeadOid}`
    const existing = byRevision.get(key)
    if (existing == null || session.annotations.length > existing.annotations.length) {
      byRevision.set(key, session)
    }
  }
  return [...byRevision.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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
        <span>Commits</span>
        <code>{selectionLabel}</code>
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
                          <time dateTime={commit.authoredAt} title={formatTimestamp(commit.authoredAt)}>
                            {relativeTimeAgo(commit.authoredAt)}
                          </time>
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
  viewedFiles,
  resolvedTheme,
  activeFilePath,
  onSelect,
}: {
  files: FileDiffMetadata[]
  viewedFiles: Set<string>
  resolvedTheme: ResolvedTheme
  activeFilePath: string | null
  onSelect(id: string): void
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filteredFiles =
    normalizedQuery === ''
      ? files
      : files.filter((file) => file.name.toLowerCase().includes(normalizedQuery))
  const stats = new Map<string, FileChangeStats>()
  const totalStats: FileChangeStats = { additions: 0, deletions: 0, modifications: 0 }
  for (const file of files) {
    const fileStats = fileChangeStats(file)
    stats.set(file.name, fileStats)
    totalStats.additions += fileStats.additions
    totalStats.deletions += fileStats.deletions
    totalStats.modifications += fileStats.modifications
  }
  const treeKey = filteredFiles
    .map((file) => {
      const fileStats = stats.get(file.name)!
      return `${file.name}:${file.type}:${fileStats.additions}:${fileStats.deletions}:${fileStats.modifications}:${viewedFiles.has(file.name) ? 'v' : 'u'}`
    })
    .join('|')

  return (
    <nav className="file-rail" aria-label="Changed files">
      <div className="rail-heading">
        <div className="rail-heading-title">
          <span>Files</span>
          <span
            title={`${totalStats.additions} added, ${totalStats.deletions} deleted, ${totalStats.modifications} modified`}
          >
            <span className="addition">+{totalStats.additions}</span>{' '}
            <span className="deletion">−{totalStats.deletions}</span>{' '}
            <span className="modification">~{totalStats.modifications}</span>
          </span>
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
          viewedFiles={viewedFiles}
          stats={stats}
          resolvedTheme={resolvedTheme}
          activeFilePath={activeFilePath}
          onSelect={onSelect}
        />
      )}
      {files.length > 0 && filteredFiles.length === 0 && (
        <p className="file-filter-empty">No matching files</p>
      )}
    </nav>
  )
}

function viewedFileGitCss(paths: Iterable<string>) {
  return [...paths]
    .map((path) => {
      const selector = `[data-item-path="${CSS.escape(path)}"][data-item-type="file"]`
      return `
        ${selector} > [data-item-section="git"] { position: relative; }
        ${selector} > [data-item-section="git"] > * { visibility: hidden; }
        ${selector} > [data-item-section="git"]::after {
          content: "✓";
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          color: var(--green);
          font-size: 11px;
          font-weight: 650;
        }
        ${selector}:hover > [data-item-section="git"] > * { visibility: visible; }
        ${selector}:hover > [data-item-section="git"]::after { content: none; }
      `
    })
    .join('')
}

function ChangedFileTree({
  files,
  viewedFiles,
  stats,
  resolvedTheme,
  activeFilePath,
  onSelect,
}: {
  files: FileDiffMetadata[]
  viewedFiles: Set<string>
  stats: Map<string, FileChangeStats>
  resolvedTheme: ResolvedTheme
  activeFilePath: string | null
  onSelect(id: string): void
}) {
  const syncingSelectionRef = useRef(false)
  const activeFilePathRef = useRef(activeFilePath)
  activeFilePathRef.current = activeFilePath
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
    sort: compareReviewPathEntries,
    initialSelectedPaths: activeFilePath != null ? [activeFilePath] : undefined,
    density: 'compact',
    icons: { set: 'standard', colored: false },
    unsafeCSS: `
      [data-item-type="file"] > [data-item-section="icon"] { display: none; }
      [data-item-type="folder"] > [data-item-section="git"] { display: none; }
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
      ${viewedFileGitCss(files.filter((file) => viewedFiles.has(file.name)).map((file) => file.name))}
    `,
    gitStatus,
    onSelectionChange(selectedPaths) {
      if (syncingSelectionRef.current) return
      const selectedFile = selectedPaths.find((path) => filePaths.has(path))
      if (selectedFile != null && selectedFile !== activeFilePathRef.current) onSelect(selectedFile)
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

  useEffect(() => {
    if (activeFilePath == null) return
    const item = model.getItem(activeFilePath)
    if (item == null) return
    syncingSelectionRef.current = true
    try {
      for (const path of model.getSelectedPaths()) {
        if (path !== activeFilePath) model.getItem(path)?.deselect()
      }
      if (!item.isSelected()) item.select()
      model.scrollToPath(activeFilePath, { offset: 'nearest' })
    } finally {
      syncingSelectionRef.current = false
    }
  }, [activeFilePath, model])

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
    <ShortcutTooltip label={viewed ? 'Mark as unread' : 'Mark as read'} shortcut="V">
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
    </ShortcutTooltip>
  )
}

function SessionHistoryMenu({
  repositoryRoot,
  currentSessionId,
  onOpenSession,
}: {
  repositoryRoot: string
  currentSessionId: string
  onOpenSession(id: string): void
}) {
  const [open, setOpen] = useState(false)
  const sessionsQuery = useQuery({
    queryKey: ['session-history', repositoryRoot],
    queryFn: () => getSessions(repositoryRoot),
    enabled: open,
  })
  const sessions = sessionsQuery.data ?? []

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="session-history-trigger" aria-label="Session history">
        <HistoryIcon />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="popup-positioner" sideOffset={6} align="start">
          <Popover.Popup className="revision-menu session-history-menu">
            <Popover.Title className="menu-kicker">Repository history</Popover.Title>
            {sessionsQuery.isPending && <p className="session-history-empty">Loading…</p>}
            {sessionsQuery.error != null && (
              <div className="menu-error">
                {sessionsQuery.error instanceof Error
                  ? sessionsQuery.error.message
                  : String(sessionsQuery.error)}
              </div>
            )}
            {sessionsQuery.isSuccess && sessions.length === 0 && (
              <p className="session-history-empty">No sessions for this repository</p>
            )}
            {sessions.map((item) => {
              const revision = localRevisionLabel(item)
              return (
                <button
                  key={item.id}
                  className={item.id === currentSessionId ? 'selected' : ''}
                  onClick={() => {
                    setOpen(false)
                    if (item.id !== currentSessionId) onOpenSession(item.id)
                  }}
                >
                  <span className="revision-status">
                    {item.target.kind === 'pr' ? `PR #${item.target.number}` : 'Local'}
                  </span>
                  <code>{revision ?? item.targetLabel}</code>
                  <time dateTime={item.updatedAt} title={formatTimestamp(item.updatedAt)}>
                    {relativeTimeAgo(item.updatedAt)}
                  </time>
                  <small>{item.targetLabel}</small>
                </button>
              )
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}


function Inspector({
  session,
  files,
  activeFilePath,
  piStatus,
  commentsCopied,
  hasHumanComments,
  onCopyComments,
  onSetArchived,
  onUpdateComment,
  onAddGlobalComment,
  onUpdateGlobalComment,
  onSetGlobalArchived,
  onArchiveAll,
  onOpenSession,
  onNavigate,
  onHoverAnnotation,
  onReload,
}: {
  session: ReviewSession
  files: FileDiffMetadata[]
  activeFilePath: string | null
  piStatus?: PiReviewStatus
  commentsCopied: boolean
  hasHumanComments: boolean
  onCopyComments(): Promise<void>
  onSetArchived(annotationId: string, archived: boolean): Promise<void>
  onUpdateComment(annotationId: string, comment: string, intent?: AnnotationIntent): Promise<void>
  onAddGlobalComment(comment: string): Promise<void>
  onUpdateGlobalComment(commentId: string, comment: string): Promise<void>
  onSetGlobalArchived(commentId: string, archived: boolean): Promise<void>
  onArchiveAll(): Promise<void>
  onOpenSession(id: string): void
  onNavigate(annotation: SessionAnnotation): void
  onHoverAnnotation(annotationId: string | null): void
  onReload(): Promise<void>
}) {
  const reviewCommentAvailable = useAtomValue(reviewCommentAvailableAtom)
  const [view, setView] = useState<'active' | 'archived'>('active')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [addingGlobal, setAddingGlobal] = useState(false)
  const notesListRef = useRef<HTMLDivElement>(null)
  const active = session.annotations.filter((annotation) => annotation.archivedAt == null)
  const archived = session.annotations.filter((annotation) => annotation.archivedAt != null)
  const visible = view === 'active' ? active : archived
  const activeGlobals = session.globalComments.filter((comment) => comment.archivedAt == null)
  const archivedGlobals = session.globalComments.filter((comment) => comment.archivedAt != null)
  const visibleGlobals = view === 'active' ? activeGlobals : archivedGlobals
  const showGlobalComment = visibleGlobals.length > 0 || addingGlobal
  const activeCount = active.length + activeGlobals.length
  const archivedCount = archived.length + archivedGlobals.length
  const piRun = piStatus == null || piStatus.state === 'idle' ? null : piStatus
  const showPiReviewDetails = view === 'active' && piRun != null

  useEffect(() => {
    if (activeFilePath == null) return
    const card = notesListRef.current?.querySelector<HTMLElement>(
      `[data-file-path="${cssEscape(activeFilePath)}"]`,
    )
    card?.scrollIntoView({ block: 'nearest' })
  }, [activeFilePath, view])

  return (
    <aside className="inspector">
      <section className="notes-panel">
        <div className="notes-heading">
          <div className="notes-heading-title">
            <span>Annotations</span>
            <SessionHistoryMenu
              repositoryRoot={session.repositoryRoot}
              currentSessionId={session.id}
              onOpenSession={onOpenSession}
            />
          </div>
          <div>
            {view === 'active' && !addingGlobal && (
              <AnnotationIconButton
                label="Add global comment"
                onClick={() => setAddingGlobal(true)}
              >
                <AddCommentIcon />
              </AnnotationIconButton>
            )}
            {hasHumanComments ? (
              <AnnotationIconButton
                label={commentsCopied ? 'Copied' : 'Copy my comments'}
                onClick={() => void onCopyComments()}
              >
                {commentsCopied ? <CheckIcon /> : <CopyIcon />}
              </AnnotationIconButton>
            ) : null}
            {view === 'active' && activeCount > 0 && (
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
            <em>{activeCount}</em>
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
          <Toggle value="active">Active {activeCount}</Toggle>
          <Toggle value="archived">Archived {archivedCount}</Toggle>
        </ToggleGroup>
        {visible.length === 0 && !showGlobalComment && !showPiReviewDetails ? (
          <p className="notes-empty">
            {view === 'active'
              ? 'Comments and importance highlights will collect here.'
              : 'Archived annotations will remain available here.'}
          </p>
        ) : (
          <div className="notes-list" ref={notesListRef}>
            {showPiReviewDetails && piRun != null && <PiRunCard run={piRun} />}
            {addingGlobal && (
              <article className="note-card global-comment-card user">
                <div className="global-comment-heading">
                  <strong>Global comment</strong>
                </div>
                <CommentEditor
                  comment=""
                  onCancel={() => setAddingGlobal(false)}
                  onSave={async (comment) => {
                    await onAddGlobalComment(comment)
                    setAddingGlobal(false)
                  }}
                />
              </article>
            )}
            {visibleGlobals.map((note) => {
              const editing = editingId === note.id
              return (
                <article key={note.id} className={`note-card global-comment-card ${note.source}`}>
                  <div className="global-comment-heading">
                    <strong>Global comment</strong>
                    <div className="note-actions">
                      {note.source === 'user' && note.archivedAt == null && !editing && (
                        <AnnotationIconButton
                          label="Edit global comment"
                          onClick={() => setEditingId(note.id)}
                        >
                          <EditIcon />
                        </AnnotationIconButton>
                      )}
                      {!editing && (
                        <AnnotationIconButton
                          label={view === 'active' ? 'Archive' : 'Restore'}
                          disabled={busyId === note.id}
                          onClick={async () => {
                            setBusyId(note.id)
                            try {
                              await onSetGlobalArchived(note.id, view === 'active')
                            } finally {
                              setBusyId(null)
                            }
                          }}
                        >
                          {view === 'active' ? <ArchiveIcon /> : <RestoreIcon />}
                        </AnnotationIconButton>
                      )}
                    </div>
                  </div>
                  {editing ? (
                    <CommentEditor
                      comment={note.comment}
                      onCancel={() => setEditingId(null)}
                      onSave={async (comment) => {
                        await onUpdateGlobalComment(note.id, comment)
                        setEditingId(null)
                      }}
                    />
                  ) : (
                    <p>{note.comment}</p>
                  )}
                  <footer>
                    <div className="note-source">
                      <span className={`source ${note.source}`}>{note.source}</span>
                    </div>
                  </footer>
                </article>
              )
            })}
            {annotationThreads(visible).map(({ root: annotation, replies }) => {
              const viewed = session.viewedFiles.includes(annotation.filePath)
              const editing = editingId === annotation.id
              const canReply =
                view === 'active' &&
                annotation.source === 'agent' &&
                annotation.replyToId == null
              return (
                <article
                  key={annotation.id}
                  className={`note-card ${annotation.source}${fileIdForAnnotation(annotation, files) === activeFilePath ? ' is-active' : ''}`}
                  data-file-path={fileIdForAnnotation(annotation, files)}
                  onPointerEnter={() => onHoverAnnotation(annotation.id)}
                  onPointerLeave={() => onHoverAnnotation(null)}
                >
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
                      <time className="note-time" title={formatTimestamp(annotation.createdAt)}>
                        {relativeTimeAgo(annotation.createdAt)}
                      </time>
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
                      {canReply && editingId !== `reply:${annotation.id}` && (
                        <AnnotationIconButton
                          label="Reply"
                          onClick={() => setEditingId(`reply:${annotation.id}`)}
                        >
                          <ReplyIcon />
                        </AnnotationIconButton>
                      )}
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
                  {editingId === `reply:${annotation.id}` && (
                    <CommentEditor
                      comment=""
                      onCancel={() => setEditingId(null)}
                      onSave={async (comment) => {
                        await addAnnotation(session.id, {
                          filePath: annotation.filePath,
                          side: annotation.side,
                          startLine: annotation.startLine,
                          endSide: annotation.endSide ?? undefined,
                          endLine: annotation.endLine,
                          comment,
                          source: 'user',
                          replyToId: annotation.id,
                        })
                        await onReload()
                        setEditingId(null)
                      }}
                    />
                  )}
                  {replies.map((reply) => {
                    const replyEditing = editingId === reply.id
                    return (
                      <div key={reply.id} className={`note-reply ${reply.source}`}>
                        {replyEditing ? (
                          <CommentEditor
                            comment={reply.comment ?? ''}
                            onCancel={() => setEditingId(null)}
                            onSave={async (comment) => {
                              await onUpdateComment(reply.id, comment)
                              setEditingId(null)
                            }}
                          />
                        ) : (
                          <p>{reply.comment}</p>
                        )}
                        <footer>
                          <div className="note-source">
                            <span className={`source ${reply.source}`}>{reply.source}</span>
                            <time className="note-time" title={formatTimestamp(reply.createdAt)}>
                              {relativeTimeAgo(reply.createdAt)}
                            </time>
                          </div>
                          <div className="note-actions">
                            {reply.source === 'user' && reply.submittedAt == null && !replyEditing && (
                              <AnnotationIconButton
                                label="Edit comment"
                                onClick={() => setEditingId(reply.id)}
                              >
                                <EditIcon />
                              </AnnotationIconButton>
                            )}
                            <AnnotationIconButton
                              label={view === 'active' ? 'Archive' : 'Restore'}
                              disabled={busyId === reply.id}
                              onClick={async () => {
                                setBusyId(reply.id)
                                try {
                                  await onSetArchived(reply.id, view === 'active')
                                } finally {
                                  setBusyId(null)
                                }
                              }}
                            >
                              {view === 'active' ? <ArchiveIcon /> : <RestoreIcon />}
                            </AnnotationIconButton>
                          </div>
                        </footer>
                      </div>
                    )
                  })}
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
  autoFocus = true,
  value: controlledValue,
  intentValue,
  onValueChange,
  onIntentChange,
  onCancel,
  onSave,
}: {
  comment: string
  intent?: AnnotationIntent
  reviewCommentAvailable?: boolean
  autoFocus?: boolean
  value?: string
  intentValue?: AnnotationIntent
  onValueChange?(value: string): void
  onIntentChange?(intent: AnnotationIntent): void
  onCancel(): void
  onSave(comment: string, intent?: AnnotationIntent): Promise<void>
}) {
  const [localValue, setLocalValue] = useState(comment)
  const [localIntent, setLocalIntent] = useState<AnnotationIntent>(intent ?? 'annotation')
  const value = controlledValue ?? localValue
  const draftIntent = intentValue ?? localIntent
  const setValue = onValueChange ?? setLocalValue
  const setDraftIntent = onIntentChange ?? setLocalIntent
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
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (!isTextareaSubmitEnter(event)) return
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
          if (!isTextareaSubmitEnter(event)) return
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
  replies,
  interactive = true,
  onHover,
  onArchive,
  onUpdateComment,
  onReply,
}: {
  annotation: SessionAnnotation
  replies: SessionAnnotation[]
  interactive?: boolean
  onHover?(annotationId: string | null): void
  onArchive(annotationId: string): Promise<void>
  onUpdateComment(annotationId: string, comment: string, intent?: AnnotationIntent): Promise<void>
  onReply?(comment: string): Promise<void>
}) {
  const [ui, setUi] = useAtom(inlineAnnotationUiAtom(annotation.id))
  const overlayIds = useAtomValue(stickyOverlayIdsAtom)
  const spacer = !interactive && overlayIds.has(annotation.id)
  const live = interactive || !spacer
  const busyId = ui.busyId
  const editingId = ui.editingId
  const setBusyId = (busyId: string | null) => setUi((current) => ({ ...current, busyId }))
  const openEditor = (editingId: string, draft: string, draftIntent: AnnotationIntent = 'annotation') => {
    setUi((current) => ({ ...current, editingId, draft, draftIntent }))
  }
  const closeEditor = () => setUi((current) => ({ ...current, editingId: null, draft: '' }))
  const reviewCommentAvailable = useAtomValue(reviewCommentAvailableAtom) &&
    annotation.endSide == null &&
    annotation.source === 'user' &&
    annotation.submittedAt == null
  const editing = editingId === annotation.id
  return (
    <div
      className={`inline-annotation ${annotation.source}${spacer ? ' is-spacer' : ''}`}
      data-annotation-id={annotation.id}
      inert={!live ? true : undefined}
      aria-hidden={!live ? true : undefined}
      onPointerEnter={() => live ? onHover?.(annotation.id) : undefined}
      onPointerLeave={() => live ? onHover?.(null) : undefined}
    >
      <div className="inline-source">
        <div>
          <span>{annotation.source === 'agent'
            ? 'Agent note'
            : annotation.submittedAt != null
              ? 'Submitted review comment'
              : annotation.intent === 'review-comment'
                ? 'Pending review comment'
                : 'Annotation'}</span>
          <time className="note-time" title={formatTimestamp(annotation.createdAt)}>
            {relativeTimeAgo(annotation.createdAt)}
          </time>
          <code>{lineLabel(annotation)}</code>
        </div>
        <div>
          {onReply != null && editingId !== 'reply' && (
            <AnnotationIconButton
              label="Reply"
              onClick={() => openEditor('reply', '')}
            >
              <ReplyIcon />
            </AnnotationIconButton>
          )}
          {annotation.source === 'user' && annotation.comment != null && !editing && (
            <AnnotationIconButton
              label="Edit comment"
              onClick={() => openEditor(annotation.id, annotation.comment ?? '', annotation.intent)}
            >
              <EditIcon />
            </AnnotationIconButton>
          )}
          <AnnotationIconButton
            label="Archive"
            disabled={busyId === annotation.id}
            onClick={async () => {
              setBusyId(annotation.id)
              try {
                await onArchive(annotation.id)
              } finally {
                setBusyId(null)
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
          autoFocus={live}
          value={ui.draft}
          intentValue={ui.draftIntent}
          onValueChange={(draft) => setUi((current) => ({ ...current, draft }))}
          onIntentChange={(draftIntent) => setUi((current) => ({ ...current, draftIntent }))}
          onCancel={closeEditor}
          onSave={async (comment, intent) => {
            await onUpdateComment(annotation.id, comment, intent)
            closeEditor()
          }}
        />
      ) : annotation.comment != null ? (
        <p>{annotation.comment}</p>
      ) : null}
      {editingId === 'reply' && onReply != null && (
        <CommentEditor
          comment=""
          autoFocus={live}
          value={ui.draft}
          onValueChange={(draft) => setUi((current) => ({ ...current, draft }))}
          onCancel={closeEditor}
          onSave={async (comment) => {
            await onReply(comment)
            closeEditor()
          }}
        />
      )}
      {replies.map((reply) => {
        const replyEditing = editingId === reply.id
        return (
          <div key={reply.id} className={`note-reply ${reply.source}`}>
            <div className="inline-source">
              <div>
                <span>Reply</span>
                <time className="note-time" title={formatTimestamp(reply.createdAt)}>
                  {relativeTimeAgo(reply.createdAt)}
                </time>
              </div>
              <div>
                {reply.source === 'user' && reply.comment != null && !replyEditing && (
                  <AnnotationIconButton
                    label="Edit comment"
                    onClick={() => openEditor(reply.id, reply.comment ?? '')}
                  >
                    <EditIcon />
                  </AnnotationIconButton>
                )}
                <AnnotationIconButton
                  label="Archive"
                  disabled={busyId === reply.id}
                  onClick={async () => {
                    setBusyId(reply.id)
                    try {
                      await onArchive(reply.id)
                    } finally {
                      setBusyId(null)
                    }
                  }}
                >
                  <ArchiveIcon />
                </AnnotationIconButton>
              </div>
            </div>
            {replyEditing ? (
              <CommentEditor
                comment={reply.comment ?? ''}
                autoFocus={live}
                value={ui.draft}
                onValueChange={(draft) => setUi((current) => ({ ...current, draft }))}
                onCancel={closeEditor}
                onSave={async (comment) => {
                  await onUpdateComment(reply.id, comment)
                  closeEditor()
                }}
              />
            ) : (
              <p>{reply.comment}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function LoadingScreen() {
  useDocumentChrome(APP_TITLE, 'default')
  return (
    <main className="loading-screen">
      <span>Δ</span>
      <div className="loading-line" />
      <p>Resolving change set</p>
    </main>
  )
}

function ErrorScreen({ message, onBack }: { message: string; onBack(): void }) {
  useDocumentChrome(formatDocumentTitle('Unavailable'), 'default')
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
  allAnnotations: SessionAnnotation[],
  files: FileDiffMetadata[],
): Promise<string> {
  const contents = new Map<string, Promise<string | null>>()
  const byId = new Map(allAnnotations.map((annotation) => [annotation.id, annotation]))
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
    const header = `> ${annotation.filePath}:${annotationPosition(annotation)}: ${code}`
    const parent = annotation.replyToId == null ? null : byId.get(annotation.replyToId)
    const quotedParent = parent?.comment?.trim()
    if (quotedParent) {
      const quoted = quotedParent.split('\n').map((line) => `> ${line}`).join('\n')
      return `${header}\n\n${quoted}\n\n${annotation.comment!.trim()}`
    }
    return `${header}\n\n${annotation.comment!.trim()}`
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

function fileIdAtCodeViewScroll(
  viewer: { getTopForItem(id: string): number | null | undefined },
  items: readonly { id: string; collapsed?: boolean }[],
  scrollTop: number,
): string | null {
  let current: string | null = null
  let firstExpanded: string | null = null
  for (const item of items) {
    if (item.collapsed) continue
    firstExpanded ??= item.id
    const top = viewer.getTopForItem(item.id)
    if (top == null) continue
    if (top > scrollTop + 24) break
    current = item.id
  }
  return current ?? firstExpanded
}
function fileHeaderIdFromEvent(event: MouseEvent): string | null {
  const path = event.composedPath()
  const clickedHeader = path.some(
    (target) => target instanceof HTMLElement && target.hasAttribute('data-diffs-header'),
  )
  if (!clickedHeader) return null
  return fileIdFromEvent(event) ?? fileIdFromDiffsContainer(path)
}

function fileIdFromDiffsContainer(path: readonly EventTarget[]): string | null {
  const container = path.find(
    (target) => target instanceof HTMLElement && target.tagName === 'DIFFS-CONTAINER',
  )
  if (!(container instanceof HTMLElement)) return null
  return container.querySelector('[data-file-id]')?.getAttribute('data-file-id') ?? null
}

function fileIdFromEvent(event: MouseEvent): string | null {
  return fileIdFromComposedPath(event.composedPath())
}

function fileIdAtClientPoint(x: number, y: number): string | null {
  for (const node of document.elementsFromPoint(x, y)) {
    const path = composedAncestors(node)
    const fileId = fileIdFromComposedPath(path) ?? fileIdFromDiffsContainer(path)
    if (fileId != null) return fileId
  }
  return null
}

function fileIdFromComposedPath(path: readonly EventTarget[]): string | null {
  const file = path.find(
    (target) => target instanceof HTMLElement && target.dataset.fileId != null,
  )
  return file instanceof HTMLElement ? file.dataset.fileId ?? null : null
}

function composedAncestors(start: Element): EventTarget[] {
  const path: EventTarget[] = []
  let node: EventTarget | null = start
  while (node instanceof Node) {
    path.push(node)
    if (node instanceof ShadowRoot) {
      node = node.host
      continue
    }
    const parent: Node | null = node.parentNode
    if (parent != null) {
      node = parent
      continue
    }
    break
  }
  return path
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
  side: 'left' | 'right' | 'pr',
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(window.localStorage.getItem(`diff-review-${side}-panel-width`))
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback
}

function storePanelWidth(side: 'left' | 'right' | 'pr', width: number): void {
  window.localStorage.setItem(`diff-review-${side}-panel-width`, String(width))
}

function patchContentKey(patch: string): string {
  let hash = 2166136261
  for (let index = 0; index < patch.length; index += 1) {
    hash ^= patch.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${patch.length.toString(36)}:${(hash >>> 0).toString(36)}`
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

function scheduleDifftasticScroll(
  root: HTMLElement | null,
  fileId: string,
  target?: { line: number; side: 'old' | 'new'; annotationId?: string },
): void {
  let frames = 0
  const tick = () => {
    if (scrollDifftasticTarget(root, fileId, target)) return
    if (++frames < 90) window.requestAnimationFrame(tick)
  }
  window.requestAnimationFrame(tick)
}

function revealFileHeaderInViewport(filePath: string): void {
  const scroller = document.querySelector('.diff-view')
  if (!(scroller instanceof HTMLElement)) return
  const header = fileHeaderInDiffView(scroller, filePath)
  if (header == null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const headerRect = header.getBoundingClientRect()
  const inViewport = headerRect.bottom > scrollerRect.top && headerRect.top < scrollerRect.bottom
  if (inViewport) return
  header.scrollIntoView({ block: 'nearest', behavior: 'instant' })
}

function fileHeaderInDiffView(root: Element, filePath: string): HTMLElement | null {
  const article = root.querySelector<HTMLElement>(`article[data-file-id="${cssEscape(filePath)}"]`)
  if (article != null) {
    return article.querySelector<HTMLElement>('[data-diffs-header]') ?? article
  }
  const marked = root.querySelector<HTMLElement>(`[data-file-id="${cssEscape(filePath)}"]`)
  if (marked == null) return null
  return marked.closest<HTMLElement>('[data-diffs-header], header, diffs-container') ?? marked
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const APP_TITLE = 'Diff Review'

function formatDocumentTitle(...parts: Array<string | null | undefined>): string {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const value = part?.trim()
    if (value == null || value === '' || seen.has(value) || value === APP_TITLE) continue
    seen.add(value)
    labels.push(value)
  }
  return labels.length === 0 ? APP_TITLE : `${labels.join(' · ')} · ${APP_TITLE}`
}

type FaviconVariant = 'default' | 'local' | 'pr'

const FAVICON_HREF: Record<FaviconVariant, string> = {
  default: '/favicon.svg',
  local: '/favicon.svg',
  pr: '/favicon-pr.svg',
}

function useDocumentChrome(title: string, variant: FaviconVariant) {
  useEffect(() => {
    const previousTitle = document.title
    document.title = title
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    const previousHref = icon?.getAttribute('href')
    if (icon != null) icon.href = FAVICON_HREF[variant]
    return () => {
      document.title = previousTitle
      if (icon != null && previousHref != null) icon.href = previousHref
    }
  }, [title, variant])
}

function compactPath(filePath: string): string {
  const parts = filePath.split('/')
  return parts.length <= 2 ? filePath : `…/${parts.slice(-2).join('/')}`
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
