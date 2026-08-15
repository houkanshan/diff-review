import { EventEmitter } from 'node:events'
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import type {
  AddAnnotationInput,
  ApiErrorShape,
  CreateSessionInput,
  ReviewTarget,
} from '../shared/types.js'
import { AppError, errorMessage } from './errors.js'
import {
  getRepositoryInfo,
  readSnapshotFile,
  resolveCommitSpan,
  resolveRepository,
  resolveTarget,
  stageReviewFile,
  validateAnnotationTarget,
  validateReviewFilePath,
} from './git.js'
import { ReviewStore } from './store.js'

const JSON_BODY_LIMIT = 2 * 1024 * 1024

export class ApiHandler {
  private readonly events = new EventEmitter()

  constructor(
    private readonly store: ReviewStore,
    private readonly clientDirectory: string | null,
  ) {
    this.events.setMaxListeners(100)
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

    if (method === 'GET' && url.pathname === '/api/health') {
      sendJson(response, 200, { app: 'diff-review', ok: true })
      return
    }

    if (method === 'GET' && url.pathname === '/api/repository') {
      const repositoryPath = requiredQuery(url, 'path')
      sendJson(response, 200, await getRepositoryInfo(repositoryPath))
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
      const session = this.store.createSession(root, path.basename(root), input.target, resolved)
      this.emitSessionUpdate(session.id)
      sendJson(response, 201, session)
      return
    }

    if (method === 'GET' && sessionMatch != null) {
      sendJson(response, 200, this.store.getSession(sessionMatch[1] ?? ''))
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
  return {
    filePath: expectString(object.filePath, 'filePath'),
    side,
    startLine,
    endSide,
    endLine,
    comment,
    importance,
    source,
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
