import { EventEmitter } from 'node:events'
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import type {
  AddAnnotationInput,
  AddPullRequestCommentInput,
  ApiErrorShape,
  CreateSessionInput,
  OpenPullRequestInput,
  SquashMergePullRequestInput,
  SubmitPullRequestReviewInput,
  UpdatePullRequestLabelInput,
  PullRequestListView,
  PullRequestWorkspace,
  ReviewSession,
  ReviewTarget,
  StartPiReviewInput,
} from '../shared/types.js'
import { AppError, errorMessage } from './errors.js'
import {
  getRepositoryInfo,
  readSnapshotFile,
  resolveCommitSpan,
  resolvePullRequestRevision,
  resolveRepository,
  resolveTarget,
  stageReviewFile,
  validateAnnotationTarget,
  validateReviewCommentTarget,
  validateReviewFilePath,
} from './git.js'
import {
  getGitHubToken,
  getPullRequestDetails,
  getPullRequestRevisionDetails,
  addPullRequestComment,
  listPullRequests,
  removePullRequestLabel,
  squashMergePullRequest,
  submitPullRequestReview,
  pendingReviewComments,
  toGitHubReviewComment,
} from './github.js'
import { PiReviewRunner } from './pi.js'
import { ReviewStore } from './store.js'

const JSON_BODY_LIMIT = 2 * 1024 * 1024
const AVATAR_BODY_LIMIT = 5 * 1024 * 1024
const GITHUB_ATTACHMENT_BODY_LIMIT = 100 * 1024 * 1024

interface CachedMedia {
  body: Uint8Array
  contentType: string
}

export class ApiHandler {
  private readonly events = new EventEmitter()
  private readonly avatars = new Map<string, Promise<CachedMedia>>()
  private readonly githubAttachments = new Map<string, Promise<CachedMedia>>()
  private readonly piReviews: PiReviewRunner

  constructor(
    private readonly store: ReviewStore,
    private readonly clientDirectory: string | null,
  ) {
    this.events.setMaxListeners(100)
    this.piReviews = new PiReviewRunner(store, (sessionId) => this.emitSessionUpdate(sessionId))
    this.piReviews.initialize()
  }

  close(): void {
    this.piReviews.close()
  }

  handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      setCommonHeaders(response)
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end()
        return
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname.startsWith('/api/')) {
        await this.handleApi(request, response, url)
        return
      }
      this.serveClient(response, url.pathname)
    } catch (error) {
      this.sendError(response, error)
    }
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const { method = 'GET' } = request
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
    const refreshMatch = /^\/api\/sessions\/([^/]+)\/refresh$/.exec(url.pathname)
    const selectionMatch = /^\/api\/sessions\/([^/]+)\/selection$/.exec(url.pathname)
    const whitespaceMatch = /^\/api\/sessions\/([^/]+)\/whitespace$/.exec(url.pathname)
    const globalCommentMatch = /^\/api\/sessions\/([^/]+)\/global-comment$/.exec(url.pathname)
    const annotationsMatch = /^\/api\/sessions\/([^/]+)\/annotations$/.exec(url.pathname)
    const annotationMatch = /^\/api\/sessions\/([^/]+)\/annotations\/([^/]+)$/.exec(
      url.pathname,
    )
    const annotationArchiveMatch =
      /^\/api\/sessions\/([^/]+)\/annotations\/([^/]+)\/archive$/.exec(url.pathname)
    const annotationsArchiveMatch =
      /^\/api\/sessions\/([^/]+)\/annotations\/archive$/.exec(url.pathname)
    const fileStageMatch = /^\/api\/sessions\/([^/]+)\/files\/stage$/.exec(url.pathname)
    const fileViewedMatch = /^\/api\/sessions\/([^/]+)\/files\/viewed$/.exec(url.pathname)
    const fileMatch = /^\/api\/sessions\/([^/]+)\/file$/.exec(url.pathname)
    const piReviewMatch = /^\/api\/sessions\/([^/]+)\/pi-review$/.exec(url.pathname)
    const piRunLeaseMatch = /^\/api\/pi-runs\/([^/]+)\/lease$/.exec(url.pathname)
    const pullRequestOpenMatch = /^\/api\/pull-requests\/(\d+)\/open$/.exec(url.pathname)
    const pullRequestRevisionsMatch = /^\/api\/pull-requests\/(\d+)\/revisions$/.exec(
      url.pathname,
    )
    const pullRequestLabelMatch = /^\/api\/pull-requests\/(\d+)\/labels\/([^/]+)$/.exec(
      url.pathname,
    )
    const pullRequestCommentMatch = /^\/api\/pull-requests\/(\d+)\/comments$/.exec(url.pathname)
    const pullRequestReviewMatch = /^\/api\/pull-requests\/(\d+)\/reviews$/.exec(url.pathname)
    const pullRequestMergeMatch = /^\/api\/pull-requests\/(\d+)\/merge$/.exec(url.pathname)

    if (method === 'GET' && url.pathname === '/api/avatar') {
      await this.serveAvatar(response, requiredQuery(url, 'url'))
      return
    }

    if (method === 'GET' && url.pathname === '/api/github-attachment') {
      await this.serveGitHubAttachment(response, requiredQuery(url, 'url'))
      return
    }

    if (method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { app: 'diff-review', ok: true })
      return
    }

    if (method === 'GET' && url.pathname === '/api/repository') {
      const repositoryPath = requiredQuery(url, 'path')
      sendJson(response, 200, await getRepositoryInfo(repositoryPath))
      return
    }

    if (method === 'GET' && url.pathname === '/api/pull-requests') {
      const root = await resolveRepository(requiredQuery(url, 'repositoryPath'))
      const view = parsePullRequestListView(requiredQuery(url, 'view'))
      sendJson(response, 200, await listPullRequests(root, view))
      return
    }

    if (method === 'POST' && pullRequestOpenMatch != null) {
      const number = Number(pullRequestOpenMatch[1])
      const input = parseOpenPullRequestInput(await readJson(request))
      const root = await resolveRepository(input.repositoryPath)
      const details = await getPullRequestDetails(root, number)
      const resolved = await resolvePullRequestRevision(root, details, false)
      const target: ReviewTarget = { kind: 'pr', number }
      const currentSession = this.createOrReuseSession(root, target, resolved)
      const selectedSession = input.revisionId == null
        ? currentSession
        : this.store.getSession(input.revisionId)
      if (
        selectedSession.repositoryRoot !== root ||
        selectedSession.target.kind !== 'pr' ||
        selectedSession.target.number !== number
      ) {
        throw new AppError(
          'INVALID_PULL_REQUEST_REVISION',
          'The selected revision does not belong to this pull request',
        )
      }
      const workspace: PullRequestWorkspace = {
        details,
        currentSession,
        selectedSession,
        revisions: this.store.listPullRequestRevisions(root, number),
        piStatus: this.piReviews.getStatus(selectedSession.id),
      }
      this.emitSessionUpdate(currentSession.id)
      sendJson(response, 200, workspace)
      return
    }

    if (method === 'DELETE' && pullRequestLabelMatch != null) {
      const number = Number(pullRequestLabelMatch[1])
      const label = decodeURIComponent(pullRequestLabelMatch[2])
      const input = parseUpdatePullRequestLabelInput(await readJson(request))
      const root = await resolveRepository(input.repositoryPath)
      await removePullRequestLabel(root, number, label)
      response.writeHead(204).end()
      return
    }

    if (method === 'POST' && pullRequestCommentMatch != null) {
      const number = Number(pullRequestCommentMatch[1])
      const input = parseAddPullRequestCommentInput(await readJson(request))
      const root = await resolveRepository(input.repositoryPath)
      await addPullRequestComment(root, number, input.body)
      response.writeHead(204).end()
      return
    }

    if (method === 'POST' && pullRequestReviewMatch != null) {
      const number = Number(pullRequestReviewMatch[1])
      const input = parseSubmitPullRequestReviewInput(await readJson(request))
      const root = await resolveRepository(input.repositoryPath)
      const session = this.store.getSession(input.sessionId)
      if (
        session.repositoryRoot !== root ||
        session.target.kind !== 'pr' ||
        session.target.number !== number ||
        session.revisionHeadOid == null
      ) {
        throw new AppError(
          'INVALID_PULL_REQUEST_REVISION',
          'The review session does not belong to this pull request',
        )
      }
      const currentRevision = await getPullRequestRevisionDetails(root, number)
      if (currentRevision.headRefOid !== session.revisionHeadOid) {
        throw new AppError(
          'PULL_REQUEST_REVISION_CHANGED',
          'The pull request changed. Refresh before submitting the review.',
          409,
        )
      }
      const pendingComments = pendingReviewComments(session.annotations)
      await submitPullRequestReview(
        root,
        number,
        input.event,
        input.body,
        session.revisionHeadOid,
        pendingComments.map(toGitHubReviewComment),
      )
      this.store.markAnnotationsSubmitted(
        session.id,
        pendingComments.map((annotation) => annotation.id),
      )
      this.emitSessionUpdate(session.id)
      response.writeHead(204).end()
      return
    }

    if (method === 'POST' && pullRequestMergeMatch != null) {
      const number = Number(pullRequestMergeMatch[1])
      const input = parseSquashMergePullRequestInput(await readJson(request))
      const root = await resolveRepository(input.repositoryPath)
      await squashMergePullRequest(root, number, input.expectedHeadOid)
      response.writeHead(204).end()
      return
    }

    if (method === 'GET' && pullRequestRevisionsMatch != null) {
      const root = await resolveRepository(requiredQuery(url, 'repositoryPath'))
      sendJson(
        response,
        200,
        this.store.listPullRequestRevisions(root, Number(pullRequestRevisionsMatch[1])),
      )
      return
    }

    if (method === 'GET' && url.pathname === '/api/sessions') {
      const repositoryPath = url.searchParams.get('repositoryPath')
      const root = repositoryPath == null ? undefined : await resolveRepository(repositoryPath)
      sendJson(response, 200, this.store.listSessions(root))
      return
    }

    if (method === 'POST' && url.pathname === '/api/sessions') {
      const input = parseCreateSessionInput(await readJson(request))
      const root = await resolveRepository(input.repositoryPath)
      const resolved = await resolveTarget(root, input.target)
      const session = this.createOrReuseSession(root, input.target, resolved)
      this.emitSessionUpdate(session.id)
      sendJson(response, 201, session)
      return
    }

    if (method === 'GET' && sessionMatch != null) {
      sendJson(response, 200, this.store.getSession(sessionMatch[1] ?? ''))
      return
    }

    if (method === 'GET' && piReviewMatch != null) {
      sendJson(response, 200, this.piReviews.getStatus(piReviewMatch[1] ?? ''))
      return
    }

    if (method === 'POST' && piReviewMatch != null) {
      const input = parseStartPiReviewInput(await readJson(request))
      sendJson(
        response,
        202,
        this.piReviews.start(piReviewMatch[1] ?? '', input.additionalInstructions),
      )
      return
    }

    if (piRunLeaseMatch != null && method === 'POST') {
      const { pid } = parsePiLeaseInput(await readJson(request))
      sendJson(response, 200, this.piReviews.acquireLease(piRunLeaseMatch[1] ?? '', pid))
      return
    }

    if (piRunLeaseMatch != null && method === 'DELETE') {
      const { pid } = parsePiLeaseInput(await readJson(request))
      sendJson(response, 200, this.piReviews.releaseLease(piRunLeaseMatch[1] ?? '', pid))
      return
    }

    if (method === 'POST' && refreshMatch != null) {
      const id = refreshMatch[1] ?? ''
      const session = this.store.getSession(id)
      const resolved = await resolveTarget(
        session.repositoryRoot,
        session.target,
        session.ignoreWhitespace,
      )
      if (session.target.kind === 'pr') {
        const updated = this.createOrReuseSession(
          session.repositoryRoot,
          session.target,
          resolved,
        )
        this.emitSessionUpdate(updated.id)
        sendJson(response, 200, updated)
        return
      }
      const updated = this.store.updateResolvedReview(
        id,
        resolved,
        resolved.commits.at(0)?.oid ?? null,
        resolved.commits.at(-1)?.oid ?? null,
        resolved.commits,
      )
      this.emitSessionUpdate(id)
      sendJson(response, 200, updated)
      return
    }

    if (method === 'POST' && selectionMatch != null) {
      const id = selectionMatch[1] ?? ''
      const session = this.store.getSession(id)
      if (session.target.kind === 'pr') {
        throw new AppError(
          'IMMUTABLE_PULL_REQUEST_REVISION',
          'Commit selection cannot change an immutable pull request revision',
        )
      }
      const input = parseSelectionInput(await readJson(request))
      const startIndex = session.commits.findIndex((commit) => commit.oid === input.start)
      const endIndex = session.commits.findIndex((commit) => commit.oid === input.end)
      if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
        throw new AppError(
          'INVALID_COMMIT_SELECTION',
          'Commit selection must be a contiguous oldest-to-newest range from this session',
        )
      }

      const isFullRange = startIndex === 0 && endIndex === session.commits.length - 1
      const resolved = isFullRange
        ? await resolveTarget(session.repositoryRoot, session.target, session.ignoreWhitespace)
        : await resolveCommitSpan(
            session.repositoryRoot,
            input.start,
            input.end,
            session.ignoreWhitespace,
          )
      const updated = this.store.updateResolvedReview(id, resolved, input.start, input.end)
      this.emitSessionUpdate(id)
      sendJson(response, 200, updated)
      return
    }

    if (method === 'POST' && whitespaceMatch != null) {
      const id = whitespaceMatch[1] ?? ''
      const { ignoreWhitespace } = parseWhitespaceInput(await readJson(request))
      const session = this.store.getSession(id)
      if (session.target.kind === 'pr') {
        throw new AppError(
          'IMMUTABLE_PULL_REQUEST_REVISION',
          'Whitespace settings cannot change an immutable pull request revision',
        )
      }
      if (session.ignoreWhitespace === ignoreWhitespace) {
        sendJson(response, 200, session)
        return
      }

      const isFullRange =
        session.selectedCommitStart === session.commits.at(0)?.oid &&
        session.selectedCommitEnd === session.commits.at(-1)?.oid
      const resolved = isFullRange || session.selectedCommitStart == null || session.selectedCommitEnd == null
        ? await resolveTarget(session.repositoryRoot, session.target, ignoreWhitespace)
        : await resolveCommitSpan(
            session.repositoryRoot,
            session.selectedCommitStart,
            session.selectedCommitEnd,
            ignoreWhitespace,
          )
      const updated = this.store.updateResolvedReview(
        id,
        resolved,
        session.selectedCommitStart,
        session.selectedCommitEnd,
        undefined,
        ignoreWhitespace,
      )
      this.emitSessionUpdate(id)
      sendJson(response, 200, updated)
      return
    }

    if (method === 'PATCH' && globalCommentMatch != null) {
      const id = globalCommentMatch[1] ?? ''
      const { comment } = parseCommentInput(await readJson(request))
      const session = this.store.setGlobalComment(id, comment)
      this.emitSessionUpdate(id)
      sendJson(response, 200, session)
      return
    }

    if (method === 'POST' && annotationsMatch != null) {
      const id = annotationsMatch[1] ?? ''
      const input = parseAnnotationInput(await readJson(request))
      const session = this.store.getSession(id)
      if (
        input.intent === 'review-comment' &&
        (input.source !== 'user' || session.target.kind !== 'pr' || input.endSide != null)
      ) {
        throw new AppError(
          'INVALID_REVIEW_COMMENT',
          'Review comments must be user comments on one side of a pull request diff',
        )
      }
      const resolved = this.store.getResolvedReview(id)
      await validateAnnotationTarget(
        session.repositoryRoot,
        resolved,
        input.filePath,
        input.side,
        input.startLine,
        input.endSide == null ? input.endLine : input.startLine,
      )
      if (input.endSide != null) {
        await validateAnnotationTarget(
          session.repositoryRoot,
          resolved,
          input.filePath,
          input.endSide,
          input.endLine,
          input.endLine,
        )
      }
      if (input.intent === 'review-comment') {
        validateReviewCommentTarget(
          resolved.patch,
          input.filePath,
          input.side,
          input.startLine,
          input.endLine,
        )
      }
      const annotation = this.store.addAnnotation(id, input)
      this.emitSessionUpdate(id)
      sendJson(response, 201, annotation)
      return
    }

    if (method === 'POST' && annotationsArchiveMatch != null) {
      const sessionId = annotationsArchiveMatch[1] ?? ''
      const session = this.store.archiveAllAnnotations(sessionId)
      this.emitSessionUpdate(sessionId)
      sendJson(response, 200, session)
      return
    }

    if (method === 'POST' && annotationArchiveMatch != null) {
      const sessionId = annotationArchiveMatch[1] ?? ''
      const { archived } = parseArchiveInput(await readJson(request))
      const annotation = this.store.setAnnotationArchived(
        sessionId,
        annotationArchiveMatch[2] ?? '',
        archived,
      )
      this.emitSessionUpdate(sessionId)
      sendJson(response, 200, annotation)
      return
    }

    if (method === 'PATCH' && annotationMatch != null) {
      const sessionId = annotationMatch[1] ?? ''
      const { comment } = parseCommentInput(await readJson(request))
      const annotation = this.store.updateAnnotationComment(
        sessionId,
        annotationMatch[2] ?? '',
        comment,
      )
      this.emitSessionUpdate(sessionId)
      sendJson(response, 200, annotation)
      return
    }

    if (method === 'POST' && fileStageMatch != null) {
      const sessionId = fileStageMatch[1] ?? ''
      const session = this.store.getSession(sessionId)
      if (session.target.kind !== 'worktree' && session.target.kind !== 'unstaged') {
        throw new AppError(
          'INVALID_REVIEW_TARGET',
          'Files can only be added from working tree or unstaged reviews',
        )
      }
      const { filePath } = parseFileInput(await readJson(request))
      await stageReviewFile(session.repositoryRoot, session.patch, filePath)
      const resolved = await resolveTarget(
        session.repositoryRoot,
        session.target,
        session.ignoreWhitespace,
      )
      const updated = this.store.updateResolvedReview(
        sessionId,
        resolved,
        resolved.commits.at(0)?.oid ?? null,
        resolved.commits.at(-1)?.oid ?? null,
        resolved.commits,
      )
      this.emitSessionUpdate(sessionId)
      sendJson(response, 200, updated)
      return
    }

    if (method === 'POST' && fileViewedMatch != null) {
      const sessionId = fileViewedMatch[1] ?? ''
      const input = parseViewedFileInput(await readJson(request))
      const session = this.store.getSession(sessionId)
      const filePath = validateReviewFilePath(session.patch, input.filePath)
      const updated = this.store.setFileViewed(sessionId, filePath, input.viewed)
      this.emitSessionUpdate(sessionId)
      sendJson(response, 200, updated)
      return
    }

    if (method === 'DELETE' && annotationMatch != null) {
      const sessionId = annotationMatch[1] ?? ''
      this.store.deleteAnnotation(sessionId, annotationMatch[2] ?? '')
      this.emitSessionUpdate(sessionId)
      response.writeHead(204).end()
      return
    }

    if (method === 'GET' && fileMatch != null) {
      const id = fileMatch[1] ?? ''
      const filePath = requiredQuery(url, 'path')
      const side = requiredQuery(url, 'side')
      if (side !== 'old' && side !== 'new') {
        throw new AppError('INVALID_SIDE', 'File side must be old or new')
      }
      const session = this.store.getSession(id)
      const resolved = this.store.getResolvedReview(id)
      const contents = await readSnapshotFile(
        session.repositoryRoot,
        side === 'old' ? resolved.oldSnapshot : resolved.newSnapshot,
        filePath,
      )
      sendJson(response, 200, { path: filePath, side, contents })
      return
    }

    if (method === 'GET' && url.pathname === '/api/events') {
      const sessionId = requiredQuery(url, 'session')
      this.openEventStream(request, response, sessionId)
      return
    }

    throw new AppError('NOT_FOUND', `Route not found: ${method} ${url.pathname}`, 404)
  }

  private openEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string,
  ): void {
    this.store.getSession(sessionId)
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    response.write(': connected\n\n')
    const eventName = `session:${sessionId}`
    const listener = () => {
      response.write(`data: ${JSON.stringify({ type: 'session-updated', sessionId })}\n\n`)
    }
    this.events.on(eventName, listener)
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20_000)
    request.on('close', () => {
      clearInterval(heartbeat)
      this.events.off(eventName, listener)
    })
  }

  private emitSessionUpdate(sessionId: string): void {
    this.events.emit(`session:${sessionId}`)
  }

  private async serveAvatar(response: ServerResponse, source: string): Promise<void> {
    let sourceUrl: URL
    try {
      sourceUrl = new URL(source)
    } catch {
      throw new AppError('INVALID_AVATAR_URL', 'Avatar URL is invalid')
    }
    if (sourceUrl.protocol !== 'https:') {
      throw new AppError('INVALID_AVATAR_URL', 'Avatar URL must use HTTPS')
    }

    let avatar = this.avatars.get(source)
    if (avatar == null) {
      avatar = fetchAvatar(sourceUrl)
      this.avatars.set(source, avatar)
      void avatar.catch(() => this.avatars.delete(source))
    }
    const cached = await avatar
    response.writeHead(200, {
      'Content-Type': cached.contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    })
    response.end(cached.body)
  }

  private async serveGitHubAttachment(response: ServerResponse, source: string): Promise<void> {
    const sourceUrl = parseGitHubAttachmentUrl(source)
    let attachment = this.githubAttachments.get(source)
    if (attachment == null) {
      attachment = fetchGitHubAttachment(sourceUrl)
      this.githubAttachments.set(source, attachment)
      void attachment.catch(() => this.githubAttachments.delete(source))
    }
    const cached = await attachment
    response.writeHead(200, {
      'Content-Type': cached.contentType,
      'Content-Length': cached.body.byteLength,
      'Cache-Control': 'private, max-age=604800, immutable',
    })
    response.end(cached.body)
  }

  private createOrReuseSession(
    root: string,
    target: ReviewTarget,
    resolved: Awaited<ReturnType<typeof resolveTarget>>,
  ): ReviewSession {
    if (
      target.kind === 'pr' &&
      resolved.oldSnapshot.kind === 'commit' &&
      resolved.newSnapshot.kind === 'commit'
    ) {
      const existing = this.store.findPullRequestRevision(
        root,
        target.number,
        resolved.oldSnapshot.id,
        resolved.newSnapshot.id,
      )
      if (existing != null) return existing
    }
    return this.store.createSession(root, path.basename(root), target, resolved)
  }

  private serveClient(response: ServerResponse, pathname: string): void {
    if (this.clientDirectory == null) {
      sendJson(response, 503, {
        error: {
          code: 'CLIENT_NOT_BUILT',
          message: 'Browser client is not built. Run npm run dev or npm run build.',
        },
      })
      return
    }

    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '')
    const candidate = path.resolve(this.clientDirectory, requested)
    const safeCandidate = candidate.startsWith(`${this.clientDirectory}${path.sep}`)
      ? candidate
      : path.join(this.clientDirectory, 'index.html')
    const filePath =
      existsSync(safeCandidate) && statSync(safeCandidate).isFile()
        ? safeCandidate
        : path.join(this.clientDirectory, 'index.html')
    response.writeHead(200, { 'Content-Type': mimeType(filePath) })
    createReadStream(filePath).pipe(response)
  }

  private sendError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) {
      response.end()
      return
    }
    const appError =
      error instanceof AppError
        ? error
        : new AppError('INTERNAL_ERROR', errorMessage(error), 500)
    const body: ApiErrorShape = {
      error: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      },
    }
    sendJson(response, appError.status, body)
  }
}

function parseCreateSessionInput(value: unknown): CreateSessionInput {
  const object = expectObject(value)
  const repositoryPath = expectString(object.repositoryPath, 'repositoryPath')
  return { repositoryPath, target: parseTarget(object.target) }
}

function parsePullRequestListView(value: string): PullRequestListView {
  if (value === 'open' || value === 'additional-review' || value === 'merged') return value
  throw new AppError('INVALID_INPUT', `Unknown pull request list view: ${value}`)
}

function parseOpenPullRequestInput(value: unknown): OpenPullRequestInput {
  const object = expectObject(value)
  const revisionId = object.revisionId
  if (revisionId != null && typeof revisionId !== 'string') {
    throw new AppError('INVALID_INPUT', 'revisionId must be a string or null')
  }
  return {
    repositoryPath: expectString(object.repositoryPath, 'repositoryPath'),
    revisionId: revisionId as string | null | undefined,
  }
}

function parseUpdatePullRequestLabelInput(value: unknown): UpdatePullRequestLabelInput {
  const object = expectObject(value)
  return { repositoryPath: expectString(object.repositoryPath, 'repositoryPath') }
}

function parseAddPullRequestCommentInput(value: unknown): AddPullRequestCommentInput {
  const object = expectObject(value)
  return {
    repositoryPath: expectString(object.repositoryPath, 'repositoryPath'),
    body: expectTrimmedString(object.body, 'body'),
  }
}

function parseSubmitPullRequestReviewInput(value: unknown): SubmitPullRequestReviewInput {
  const object = expectObject(value)
  const event = expectString(object.event, 'event')
  if (event !== 'APPROVE' && event !== 'COMMENT' && event !== 'REQUEST_CHANGES') {
    throw new AppError('INVALID_INPUT', 'event must be APPROVE, COMMENT, or REQUEST_CHANGES')
  }
  return {
    repositoryPath: expectString(object.repositoryPath, 'repositoryPath'),
    event,
    sessionId: expectTrimmedString(object.sessionId, 'sessionId'),
    body: expectTrimmedString(object.body, 'body'),
  }
}

function parseSquashMergePullRequestInput(value: unknown): SquashMergePullRequestInput {
  const object = expectObject(value)
  return {
    repositoryPath: expectString(object.repositoryPath, 'repositoryPath'),
    expectedHeadOid: expectTrimmedString(object.expectedHeadOid, 'expectedHeadOid'),
  }
}

function parseStartPiReviewInput(value: unknown): StartPiReviewInput {
  const object = expectObject(value)
  if (typeof object.additionalInstructions !== 'string') {
    throw new AppError('INVALID_INPUT', 'additionalInstructions must be a string')
  }
  return { additionalInstructions: object.additionalInstructions.trim() }
}

function parsePiLeaseInput(value: unknown): { pid: number } {
  const object = expectObject(value)
  const pid = Number(object.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new AppError('INVALID_INPUT', 'pid must be a positive integer')
  }
  return { pid }
}

function parseTarget(value: unknown): ReviewTarget {
  const object = expectObject(value)
  const kind = expectString(object.kind, 'target.kind')
  switch (kind) {
    case 'worktree':
    case 'unstaged':
    case 'staged':
      return { kind }
    case 'range':
      return { kind, expression: expectString(object.expression, 'target.expression') }
    case 'pr': {
      const number = Number(object.number)
      if (!Number.isInteger(number) || number <= 0) {
        throw new AppError('INVALID_INPUT', 'target.number must be a positive integer')
      }
      return { kind, number }
    }
    default:
      throw new AppError('INVALID_INPUT', `Unknown target kind: ${kind}`)
  }
}

function parseSelectionInput(value: unknown): { start: string; end: string } {
  const object = expectObject(value)
  return {
    start: expectString(object.start, 'start'),
    end: expectString(object.end, 'end'),
  }
}

function parseWhitespaceInput(value: unknown): { ignoreWhitespace: boolean } {
  const object = expectObject(value)
  if (typeof object.ignoreWhitespace !== 'boolean') {
    throw new AppError('INVALID_INPUT', 'ignoreWhitespace must be a boolean')
  }
  return { ignoreWhitespace: object.ignoreWhitespace }
}

function parseAnnotationInput(value: unknown): AddAnnotationInput {
  const object = expectObject(value)
  const side = expectString(object.side, 'side')
  if (side !== 'old' && side !== 'new') {
    throw new AppError('INVALID_INPUT', 'side must be old or new')
  }
  const parsedEndSide = object.endSide == null
    ? undefined
    : expectString(object.endSide, 'endSide')
  if (parsedEndSide != null && parsedEndSide !== 'old' && parsedEndSide !== 'new') {
    throw new AppError('INVALID_INPUT', 'endSide must be old or new')
  }
  const endSide = parsedEndSide === side ? undefined : parsedEndSide
  const startLine = Number(object.startLine)
  const endLine = Number(object.endLine)
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine <= 0 ||
    endLine <= 0 ||
    (endSide == null && endLine < startLine)
  ) {
    throw new AppError(
      'INVALID_INPUT',
      'Line range must contain positive integers and same-side ranges must be ascending',
    )
  }
  const comment = object.comment == null ? undefined : expectString(object.comment, 'comment').trim()
  const importance = object.importance == null ? undefined : Number(object.importance)
  if (importance != null && (!Number.isFinite(importance) || importance < 0 || importance > 1)) {
    throw new AppError('INVALID_INPUT', 'importance must be between 0 and 1')
  }
  if (!comment && importance == null) {
    throw new AppError('INVALID_INPUT', 'At least one of comment or importance is required')
  }
  const source = object.source === 'agent' ? 'agent' : 'user'
  const intent = object.intent == null ? 'annotation' : expectString(object.intent, 'intent')
  if (intent !== 'annotation' && intent !== 'review-comment') {
    throw new AppError('INVALID_INPUT', 'intent must be annotation or review-comment')
  }
  return {
    filePath: expectString(object.filePath, 'filePath'),
    side,
    startLine,
    endSide,
    endLine,
    comment,
    importance,
    source,
    intent,
  }
}

function parseArchiveInput(value: unknown): { archived: boolean } {
  const object = expectObject(value)
  if (typeof object.archived !== 'boolean') {
    throw new AppError('INVALID_INPUT', 'archived must be a boolean')
  }
  return { archived: object.archived }
}

function parseCommentInput(value: unknown): { comment: string } {
  const object = expectObject(value)
  const comment = expectString(object.comment, 'comment').trim()
  if (!comment) throw new AppError('INVALID_INPUT', 'comment must not be empty')
  return { comment }
}

function parseViewedFileInput(value: unknown): { filePath: string; viewed: boolean } {
  const object = expectObject(value)
  if (typeof object.viewed !== 'boolean') {
    throw new AppError('INVALID_INPUT', 'viewed must be a boolean')
  }
  return { filePath: expectString(object.filePath, 'filePath'), viewed: object.viewed }
}

function parseFileInput(value: unknown): { filePath: string } {
  const object = expectObject(value)
  return { filePath: expectString(object.filePath, 'filePath') }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > JSON_BODY_LIMIT) throw new AppError('BODY_TOO_LARGE', 'JSON body exceeds 2 MiB', 413)
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new AppError('INVALID_JSON', 'Request body must be valid JSON')
  }
}


function expectObject(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_INPUT', 'Expected a JSON object')
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_INPUT', `${field} must be a non-empty string`)
  }
  return value
}

function expectTrimmedString(value: unknown, field: string): string {
  const result = expectString(value, field).trim()
  if (!result) throw new AppError('INVALID_INPUT', `${field} must not be empty`)
  return result
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (!value) throw new AppError('INVALID_INPUT', `Missing query parameter: ${name}`)
  return value
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS')
  response.setHeader('X-Content-Type-Options', 'nosniff')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function fetchAvatar(url: URL): Promise<CachedMedia> {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) {
    throw new AppError('AVATAR_FETCH_FAILED', `Avatar request failed with ${response.status}`, 502)
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? ''
  if (!contentType.startsWith('image/')) {
    throw new AppError('AVATAR_FETCH_FAILED', 'Avatar response was not an image', 502)
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > AVATAR_BODY_LIMIT) {
    throw new AppError('AVATAR_TOO_LARGE', 'Avatar exceeds 5 MiB', 502)
  }
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > AVATAR_BODY_LIMIT) {
    throw new AppError('AVATAR_TOO_LARGE', 'Avatar exceeds 5 MiB', 502)
  }
  return { body, contentType }
}

export function parseGitHubAttachmentUrl(source: string): URL {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new AppError('INVALID_GITHUB_ATTACHMENT_URL', 'GitHub attachment URL is invalid')
  }
  const allowed =
    url.protocol === 'https:' &&
    ((url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/')) ||
      url.hostname === 'private-user-images.githubusercontent.com' ||
      url.hostname === 'user-images.githubusercontent.com')
  if (!allowed) {
    throw new AppError('INVALID_GITHUB_ATTACHMENT_URL', 'URL is not a GitHub issue attachment')
  }
  return url
}

async function fetchGitHubAttachment(url: URL): Promise<CachedMedia> {
  const token = url.hostname === 'github.com' ? await getGitHubToken() : null
  let currentUrl = url
  let response: Response | null = null
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    response = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        ...(redirect === 0 && token != null ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (location == null) {
      throw new AppError(
        'GITHUB_ATTACHMENT_FETCH_FAILED',
        'GitHub attachment redirect had no location',
        502,
      )
    }
    currentUrl = new URL(location, currentUrl)
    if (currentUrl.protocol !== 'https:') {
      throw new AppError(
        'GITHUB_ATTACHMENT_FETCH_FAILED',
        'GitHub attachment redirected to an unsafe URL',
        502,
      )
    }
    response = null
  }
  if (response == null) {
    throw new AppError(
      'GITHUB_ATTACHMENT_FETCH_FAILED',
      'GitHub attachment redirected too many times',
      502,
    )
  }
  if (!response.ok) {
    throw new AppError(
      'GITHUB_ATTACHMENT_FETCH_FAILED',
      `GitHub attachment request failed with ${response.status}`,
      502,
    )
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0] ?? ''
  if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
    throw new AppError(
      'GITHUB_ATTACHMENT_FETCH_FAILED',
      'GitHub attachment was not an image or video',
      502,
    )
  }
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > GITHUB_ATTACHMENT_BODY_LIMIT) {
    throw new AppError('GITHUB_ATTACHMENT_TOO_LARGE', 'GitHub attachment exceeds 100 MiB', 502)
  }
  const body = new Uint8Array(await response.arrayBuffer())
  if (body.byteLength > GITHUB_ATTACHMENT_BODY_LIMIT) {
    throw new AppError('GITHUB_ATTACHMENT_TOO_LARGE', 'GitHub attachment exceeds 100 MiB', 502)
  }
  return { body, contentType }
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.woff2':
      return 'font/woff2'
    default:
      return 'application/octet-stream'
  }
}
