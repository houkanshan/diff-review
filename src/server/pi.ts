import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  readFileSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import { pagePiChatTurns, PI_INSTALL_HINT, projectPiChatModel, projectPiChatTurns } from '../shared/piChat.js'
import {
  applyPiOverlayEvent,
  createLiveOverlay,
  publicPiOverlay,
  type LivePiOverlay,
} from '../shared/piOverlay.js'
import {
  defaultPiChatModel,
  isAllowedPiChatModel,
  piChatCliArgs,
  piChatModelKey,
} from '../shared/piChatModel.js'
import type {
  PiChatModelChoice,
  PiChatModelOption,
  PiChatOverlay,
  PiChatPage,
  PiReviewRun,
  PiReviewStatus,
  ReviewSession,
} from '../shared/types.js'
import { AppError } from './errors.js'
import {
  type ChatModelSelection,
  cachedPiChatModels,
  listPiChatModels,
  readChatModelSelection,
  readPiChatModel,
  writeChatModelSelection,
} from './piChatModel.js'
import { ReviewStore } from './store.js'

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000
const RPC_COMMAND_TIMEOUT_MS = 30_000

interface RpcHandle {
  chatKey: string
  sessionId: string
  runId: string
  baseOid: string
  headOid: string
  modelKey: string
  child: ChildProcess
  pending: Map<string, { resolve(value: RpcResponse): void; reject(error: unknown): void; timer: NodeJS.Timeout }>
  buffer: string
  stderr: string
  watcher: FSWatcher | null
  dirWatcher: FSWatcher | null
  watchPath: string | null
  overlay: LivePiOverlay | null
  closed: boolean
}

interface RpcResponse {
  type: 'response'
  id?: string
  command?: string
  success: boolean
  error?: string
}

export class PiReviewRunner {
  private readonly activeRuns = new Set<string>()
  private cleanupTimer: NodeJS.Timeout | null = null
  private readonly rpcs = new Map<string, RpcHandle>()
  private readonly startingChats = new Set<string>()
  private readonly chatEmitTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly store: ReviewStore,
    private readonly onUpdate: (sessionId: string) => void,
    private readonly onChat: (
      sessionId: string,
      overlay: PiChatOverlay | null,
      transcriptRevision: string,
    ) => void = () => undefined,
  ) {}

  initialize(): void {
    void this.reconcileAndCleanup()
    void listPiChatModels()
    this.cleanupTimer = setInterval(() => void this.reconcileAndCleanup(), CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref()
  }

  close(): void {
    if (this.cleanupTimer != null) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
    for (const timer of this.chatEmitTimers.values()) clearTimeout(timer)
    this.chatEmitTimers.clear()
    for (const handle of [...this.rpcs.values()]) this.stopRpc(handle)
  }

  getStatus(sessionId: string): PiReviewStatus {
    this.store.getSession(sessionId)
    const run = this.store.latestPiReviewRunForChat(sessionId)
    if (run == null) return { state: 'idle' }
    if (
      (run.state === 'creating' || run.state === 'running') &&
      this.rpcFor(sessionId)?.runId !== run.id &&
      !this.activeRuns.has(run.id) &&
      !isProcessAlive(run.activePid)
    ) {
      return this.store.updatePiReviewRun(run.id, {
        state: 'interrupted',
        activePid: null,
        completedAt: new Date().toISOString(),
        error: 'The Pi process stopped before the run completed.',
        piSessionPath: findPiSessionPath(run),
      })
    }
    return run
  }

  getChat(sessionId: string, before: string | null = null, limit?: number): PiChatPage {
    const status = this.getStatus(sessionId)
    const run = status.state === 'idle' ? null : status
    const file = run?.piSessionPath ?? (run == null ? null : findPiSessionPath(run))
    const revision = transcriptRevision(file)
    const turns = projectPiChatTurns(readSessionEntries(file))
    const page = pagePiChatTurns(turns, before, limit)
    const handle = this.rpcFor(sessionId)
    const overlay = handle?.overlay == null ? null : publicPiOverlay(handle.overlay)
    return {
      ...page,
      transcriptRevision: revision,
      overlay,
      busy: this.isBusy(sessionId),
      error: run?.error ?? (isPiInstalled() ? null : PI_INSTALL_HINT),
      piInstalled: isPiInstalled(),
      model: this.chatModel(sessionId),
      models: cachedPiChatModels(),
    }
  }

  setChatModel(sessionId: string, choice: PiChatModelChoice | null): PiChatModelChoice | null {
    const session = this.store.getSession(sessionId)
    return writeChatModelSelection(
      this.store.dataDirectory,
      chatModelKey(session),
      choice ?? defaultPiChatModel(cachedPiChatModels()),
    )
  }

  private chatModel(sessionId: string): PiChatModelChoice {
    const selection = this.chatModelSelection(sessionId)
    return selection.status === 'set' && selection.model != null
      ? selection.model
      : defaultPiChatModel(cachedPiChatModels())
  }

  private chatModelSelection(sessionId: string) {
    const session = this.store.getSession(sessionId)
    const stored = allowedChatModelSelection(
      readChatModelSelection(this.store.dataDirectory, chatModelKey(session)),
    )
    if (stored.status === 'set') return stored
    const run = this.store.latestPiReviewRunForChat(sessionId)
    if (run == null) return stored
    const sidecar = readPiChatModel(run.piSessionDir)
    if (isAllowedPiChatModel(sidecar)) return { status: 'set' as const, model: sidecar }
    const file = run.piSessionPath ?? findPiSessionPath(run)
    const transcript = projectPiChatModel(readSessionEntries(file))
    if (isAllowedPiChatModel(transcript)) return { status: 'set' as const, model: transcript }
    return stored
  }

  async send(
    sessionId: string,
    message: string,
    explain = false,
    model?: PiChatModelChoice | null,
  ): Promise<PiChatPage> {
    const additional = message.trim()
    if (!explain && !additional) throw new AppError('INVALID_INPUT', 'Message is required')
    if (!isPiInstalled()) {
      throw new AppError('COMMAND_NOT_FOUND', PI_INSTALL_HINT, 503)
    }
    if (this.isBusy(sessionId)) {
      throw new AppError('PI_CHAT_BUSY', 'Pi is already working', 409)
    }

    const session = this.store.getSession(sessionId)
    if (
      session.target.kind !== 'pr' ||
      session.revisionBaseOid == null ||
      session.revisionHeadOid == null
    ) {
      throw new AppError('INVALID_REVIEW_TARGET', 'Pi chat requires a pull request revision')
    }

    const chatKey = chatModelKey(session)
    this.startingChats.add(chatKey)
    this.emitChat(sessionId)
    try {
      const run = await this.ensureRun(
        sessionId,
        session.repositoryRoot,
        session.revisionHeadOid,
      )
      if (model !== undefined) this.setChatModel(sessionId, model)
      const existing = this.rpcs.get(chatKey)
      if (existing != null && existing.runId !== run.id) this.stopRpc(existing)
      const afterTurnId = this.getChat(sessionId).turns.at(-1)?.id ?? null
      const handle = await this.ensureRpc(
        run,
        sessionId,
        session.revisionBaseOid,
        session.revisionHeadOid,
      )
      const prompt = explain
        ? buildExplainPrompt(
            sessionId,
            session.target.number,
            session.revisionBaseOid,
            session.revisionHeadOid,
            additional,
          )
        : additional
      const overlay = createLiveOverlay({
        overlayId: randomUUID(),
        requestId: randomUUID(),
        afterTurnId,
        baseRevision: transcriptRevision(handle.watchPath ?? findPiSessionPath(run)),
        userText: prompt,
      })
      handle.overlay = overlay
      this.emitChat(sessionId, true)
      await this.applyChatModel(handle, this.chatModel(sessionId))
      const response = await this.sendCommand(handle, {
        id: overlay.requestId,
        type: 'prompt',
        message: prompt,
      })
      if (!response.success) {
        handle.overlay = {
          ...overlay,
          working: false,
        }
        this.store.updatePiReviewRun(run.id, {
          state: 'failed',
          error: response.error ?? 'Pi rejected the prompt',
        })
        this.onUpdate(sessionId)
        this.emitChat(sessionId, true)
        throw new AppError('PI_CHAT_REJECTED', response.error ?? 'Pi rejected the prompt')
      }
    } catch (error) {
      const handle = this.rpcs.get(chatKey)
      if (handle?.overlay?.working) {
        handle.overlay.working = false
        handle.overlay.seq += 1
      }
      throw error
    } finally {
      this.startingChats.delete(chatKey)
      this.emitChat(sessionId, true)
    }
    return this.getChat(sessionId)
  }

  async reconcileAndCleanup(): Promise<void> {
    for (const run of this.store.listActivePiReviewRuns()) {
      if (this.rpcFor(run.sessionId)?.runId === run.id || this.activeRuns.has(run.id) || isProcessAlive(run.activePid)) {
        continue
      }
      this.store.updatePiReviewRun(run.id, {
        state: 'interrupted',
        activePid: null,
        completedAt: run.completedAt ?? new Date().toISOString(),
        error: 'The Pi process stopped before the run completed.',
        piSessionPath: findPiSessionPath(run),
      })
      this.onUpdate(run.sessionId)
    }
    for (const run of this.store.listPiReviewRunsEligibleForCleanup(new Date().toISOString())) {
      await this.cleanup(run)
    }
  }

  private isBusy(sessionId: string): boolean {
    const chatKey = this.chatKey(sessionId)
    return this.startingChats.has(chatKey) || this.rpcs.get(chatKey)?.overlay?.working === true
  }

  private chatKey(sessionId: string): string {
    return chatModelKey(this.store.getSession(sessionId))
  }

  private rpcFor(sessionId: string): RpcHandle | null {
    return this.rpcs.get(this.chatKey(sessionId)) ?? null
  }

  private async ensureRun(
    sessionId: string,
    repositoryRoot: string,
    headOid: string,
  ): Promise<PiReviewRun> {
    const current = this.getStatus(sessionId)
    if (
      current.state !== 'idle' &&
      current.state !== 'cleaned' &&
      current.state !== 'cleaning'
    ) {
      if (!pathExists(current.worktreePath)) {
        await mkdir(path.dirname(current.worktreePath), { recursive: true })
        await runProcess('git', ['worktree', 'add', '--detach', '--force', current.worktreePath, headOid], {
          cwd: repositoryRoot,
        })
      } else {
        const handle = this.rpcFor(sessionId)
        if (handle?.runId !== current.id || handle.overlay?.working !== true) {
          await syncWorktreeHead(current.worktreePath, headOid)
        }
      }
      return current
    }

    const piSessionId = `diff-review-${randomUUID()}`
    const worktreePath = path.join(this.store.dataDirectory, 'worktrees', piSessionId)
    const piSessionDir = path.join(this.store.dataDirectory, 'pi-sessions', piSessionId)
    const run = this.store.createPiReviewRun(
      sessionId,
      worktreePath,
      piSessionDir,
      piSessionId,
      retentionDeadline(),
    )
    this.activeRuns.add(run.id)
    this.onUpdate(sessionId)
    try {
      await mkdir(path.dirname(run.worktreePath), { recursive: true })
      await mkdir(run.piSessionDir, { recursive: true })
      await runProcess('git', ['worktree', 'add', '--detach', '--force', run.worktreePath, headOid], {
        cwd: repositoryRoot,
      })
      return this.store.updatePiReviewRun(run.id, { state: 'running' })
    } catch (error) {
      this.activeRuns.delete(run.id)
      this.store.updatePiReviewRun(run.id, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      })
      this.onUpdate(sessionId)
      throw error
    }
  }

  private async ensureRpc(
    run: PiReviewRun,
    sessionId: string,
    baseOid: string,
    headOid: string,
  ): Promise<RpcHandle> {
    const sessionPath = run.piSessionPath ?? findPiSessionPath(run)
    const chatKey = this.chatKey(sessionId)
    const model = spawnPiChatModel(this.chatModelSelection(sessionId), await listPiChatModels())
    const modelKey = model.key
    const existing = this.rpcs.get(chatKey)
    if (
      existing != null
      && existing.runId === run.id
      && existing.baseOid === baseOid
      && existing.headOid === headOid
      && existing.modelKey === modelKey
      && existing.child.exitCode == null
      && !existing.closed
    ) {
      existing.sessionId = sessionId
      return existing
    }
    if (existing != null) this.stopRpc(existing)

    const args = [
      '--mode',
      'rpc',
      '--approve',
      '--tools',
      'read,bash,grep,find,ls',
      ...model.args,
    ]
    if (sessionPath != null && pathExists(sessionPath)) {
      args.push('--session', sessionPath)
    } else {
      args.push('--session-dir', run.piSessionDir, '--session-id', run.piSessionId)
    }

    const child = spawn('pi', args, {
      cwd: run.worktreePath,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    if (child.pid == null) {
      throw new AppError('COMMAND_FAILED', 'Failed to start Pi')
    }

    const handle: RpcHandle = {
      chatKey,
      sessionId,
      runId: run.id,
      baseOid,
      headOid,
      modelKey,
      child,
      pending: new Map(),
      buffer: '',
      stderr: '',
      watcher: null,
      dirWatcher: null,
      watchPath: sessionPath,
      overlay: null,
      closed: false,
    }
    this.rpcs.set(chatKey, handle)
    this.activeRuns.add(run.id)
    this.store.updatePiReviewRun(run.id, {
      state: 'running',
      activePid: child.pid,
      error: null,
      lastUsedAt: new Date().toISOString(),
      piSessionPath: sessionPath,
    })
    this.onUpdate(run.sessionId)

    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(handle, chunk))
    child.stderr?.on('data', (chunk: Buffer) => {
      if (handle.stderr.length >= 1024 * 1024) return
      handle.stderr += chunk.toString('utf8')
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.failRpc(handle, new AppError('COMMAND_NOT_FOUND', PI_INSTALL_HINT, 503))
        return
      }
      this.failRpc(handle, error)
    })
    child.on('close', (code) => {
      if (this.rpcs.get(handle.chatKey) !== handle) return
      const failure = code === 0 ? null : handle.stderr.trim() || `pi exited with ${code ?? 1}`
      this.settleRpc(handle, failure)
    })

    this.watchSession(handle, run)
    try {
      handle.dirWatcher = watch(run.piSessionDir, () => {
        this.watchSession(handle, this.store.getPiReviewRun(run.id))
        this.emitChat(handle.sessionId, true)
      })
      handle.dirWatcher.unref()
    } catch {
      handle.dirWatcher = null
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    if (child.exitCode != null) {
      throw new AppError(
        'COMMAND_FAILED',
        handle.stderr.trim() || 'Pi exited before it was ready',
      )
    }
    return handle
  }

  private onStdout(handle: RpcHandle, chunk: Buffer): void {
    handle.buffer += chunk.toString('utf8')
    for (;;) {
      const index = handle.buffer.indexOf('\n')
      if (index < 0) break
      let line = handle.buffer.slice(0, index)
      handle.buffer = handle.buffer.slice(index + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) continue
      this.onRpcLine(handle, line)
    }
  }

  private onRpcLine(handle: RpcHandle, line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed == null) return
    const event = parsed as Record<string, unknown>
    if (event.type === 'response') {
      const id = typeof event.id === 'string' ? event.id : ''
      const pending = handle.pending.get(id)
      if (pending != null) {
        clearTimeout(pending.timer)
        handle.pending.delete(id)
        pending.resolve({
          type: 'response',
          id,
          command: typeof event.command === 'string' ? event.command : undefined,
          success: event.success === true,
          error: typeof event.error === 'string' ? event.error : undefined,
        })
      }
      return
    }
    if (event.type === 'extension_ui_request') {
      const method = event.method
      if (
        method === 'select'
        || method === 'confirm'
        || method === 'input'
        || method === 'editor'
      ) {
        handle.child.stdin?.write(`${JSON.stringify({
          type: 'extension_ui_response',
          id: event.id,
          cancelled: true,
        })}\n`)
      }
      return
    }
    if (handle.overlay == null) return
    const changed = applyPiOverlayEvent(handle.overlay, event)
    if (event.type === 'agent_settled') {
      const current = this.store.getPiReviewRun(handle.runId)
      if (current != null) {
        const piSessionPath = findPiSessionPath(current)
        this.store.updatePiReviewRun(handle.runId, {
          lastUsedAt: new Date().toISOString(),
          cleanupEligibleAt: retentionDeadline(),
          piSessionPath,
        })
        this.watchSession(handle, this.store.getPiReviewRun(handle.runId))
      }
    }
    if (changed) this.emitChat(handle.sessionId)
  }

  private async applyChatModel(handle: RpcHandle, choice: PiChatModelChoice): Promise<void> {
    const model = await this.sendCommand(handle, {
      type: 'set_model',
      provider: choice.provider,
      modelId: choice.modelId,
    })
    if (!model.success) {
      throw new AppError('PI_CHAT_REJECTED', model.error ?? 'Pi rejected the model')
    }
    if (choice.thinkingLevel == null) return
    const thinking = await this.sendCommand(handle, {
      type: 'set_thinking_level',
      level: choice.thinkingLevel,
    })
    if (!thinking.success) {
      throw new AppError('PI_CHAT_REJECTED', thinking.error ?? 'Pi rejected the thinking level')
    }
  }

  private sendCommand(handle: RpcHandle, command: Record<string, unknown>): Promise<RpcResponse> {
    const id = typeof command.id === 'string' ? command.id : randomUUID()
    const payload = { ...command, id }
    return new Promise((resolve, reject) => {
      if (handle.child.stdin == null || handle.closed) {
        reject(new AppError('PI_CHAT_UNAVAILABLE', 'Pi is not running'))
        return
      }
      const timer = setTimeout(() => {
        handle.pending.delete(id)
        reject(new AppError('PI_CHAT_TIMEOUT', 'Timed out waiting for Pi'))
      }, RPC_COMMAND_TIMEOUT_MS)
      handle.pending.set(id, { resolve, reject, timer })
      handle.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error == null) return
        clearTimeout(timer)
        handle.pending.delete(id)
        reject(error)
      })
    })
  }

  private watchSession(handle: RpcHandle, run: PiReviewRun | null | undefined): void {
    const file = run == null ? null : run.piSessionPath ?? findPiSessionPath(run)
    if (file == null || file === handle.watchPath && handle.watcher != null) return
    handle.watcher?.close()
    handle.watcher = null
    handle.watchPath = file
    if (file == null || !pathExists(file)) return
    try {
      const watcher = watch(file, () => {
        if (run != null) {
          this.store.updatePiReviewRun(run.id, { piSessionPath: file })
        }
        this.emitChat(handle.sessionId, true)
      })
      watcher.unref()
      handle.watcher = watcher
    } catch {
      handle.watcher = null
    }
  }

  private emitChat(sessionId: string, immediate = false): void {
    const chatKey = this.chatKey(sessionId)
    const emit = () => {
      this.chatEmitTimers.delete(chatKey)
      const handle = this.rpcs.get(chatKey) ?? null
      const run = handle == null ? this.store.latestPiReviewRunForChat(sessionId) : this.store.getPiReviewRun(handle.runId)
      const file = handle?.watchPath
        ?? run?.piSessionPath
        ?? (run == null ? null : findPiSessionPath(run))
      const overlay = handle?.overlay == null ? null : publicPiOverlay(handle.overlay)
      const revision = transcriptRevision(file)
      for (const id of this.store.chatSessionIds(sessionId)) {
        this.onChat(id, overlay, revision)
      }
    }
    if (immediate) {
      const timer = this.chatEmitTimers.get(chatKey)
      if (timer != null) clearTimeout(timer)
      this.chatEmitTimers.delete(chatKey)
      emit()
      return
    }
    if (this.chatEmitTimers.has(chatKey)) return
    const timer = setTimeout(emit, 16)
    timer.unref()
    this.chatEmitTimers.set(chatKey, timer)
  }

  private failRpc(handle: RpcHandle, error: unknown): void {
    this.settleRpc(handle, error instanceof Error ? error.message : String(error))
  }

  private settleRpc(handle: RpcHandle, failure: string | null): void {
    if (handle.closed) return
    handle.closed = true
    handle.watcher?.close()
    handle.watcher = null
    handle.dirWatcher?.close()
    handle.dirWatcher = null
    for (const pending of handle.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new AppError('PI_CHAT_UNAVAILABLE', failure ?? 'Pi exited'))
    }
    handle.pending.clear()
    const wasWorking = handle.overlay?.working === true
    if (handle.overlay != null) handle.overlay.working = false
    this.activeRuns.delete(handle.runId)
    const completedAt = new Date().toISOString()
    const run = this.store.getPiReviewRun(handle.runId)
    if (run != null) {
      this.store.updatePiReviewRun(handle.runId, {
        state: failure == null ? (wasWorking ? 'interrupted' : 'completed') : 'failed',
        activePid: null,
        piSessionPath: findPiSessionPath(run),
        error: failure,
        completedAt,
        lastUsedAt: completedAt,
        cleanupEligibleAt: retentionDeadline(),
      })
      this.onUpdate(run.sessionId)
      this.emitChat(run.sessionId, true)
    }
    if (this.rpcs.get(handle.chatKey) === handle) this.rpcs.delete(handle.chatKey)
  }

  private stopRpc(handle: RpcHandle): void {
    if (this.rpcs.get(handle.chatKey) === handle) this.rpcs.delete(handle.chatKey)
    handle.watcher?.close()
    handle.watcher = null
    handle.dirWatcher?.close()
    handle.dirWatcher = null
    handle.closed = true
    for (const pending of handle.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new AppError('PI_CHAT_UNAVAILABLE', 'Pi was stopped'))
    }
    handle.pending.clear()
    if (handle.child.exitCode == null && handle.child.pid != null) {
      handle.child.kill('SIGTERM')
    }
    this.activeRuns.delete(handle.runId)
    const run = this.store.getPiReviewRun(handle.runId)
    if (run != null && (run.state === 'creating' || run.state === 'running')) {
      this.store.updatePiReviewRun(handle.runId, {
        state: 'completed',
        activePid: null,
        piSessionPath: findPiSessionPath(run),
        lastUsedAt: new Date().toISOString(),
        cleanupEligibleAt: retentionDeadline(),
      })
      this.onUpdate(run.sessionId)
    }
  }

  private async cleanup(run: PiReviewRun): Promise<void> {
    if ([...this.rpcs.values()].some((handle) => handle.runId === run.id)) return
    let current = this.store.getPiReviewRun(run.id)
    if (current == null || current.keep) return
    if (current.activePid != null) {
      if (isProcessAlive(current.activePid)) return
      current = this.store.updatePiReviewRun(current.id, { activePid: null })
    }
    const claimed = this.store.claimPiReviewRunForCleanup(current.id)
    if (claimed == null) return
    current = claimed
    try {
      if (pathExists(current.worktreePath)) {
        const session = this.store.getSession(current.sessionId)
        const status = await runProcess(
          'git',
          ['status', '--porcelain', '--untracked-files=all'],
          { cwd: current.worktreePath },
        )
        if (status.stdout.trim() !== '') {
          this.store.updatePiReviewRun(current.id, {
            state: 'cleanup-blocked',
            error: 'Automatic cleanup is blocked because the worktree contains local or untracked files.',
          })
          this.onUpdate(current.sessionId)
          return
        }
        await runProcess('git', ['worktree', 'remove', current.worktreePath], {
          cwd: session.repositoryRoot,
        })
        await rm(current.worktreePath, { recursive: true, force: true })
      }
      await rm(current.piSessionDir, { recursive: true, force: true })
      this.store.updatePiReviewRun(current.id, {
        state: 'cleaned',
        activePid: null,
        piSessionPath: null,
        error: null,
        cleanedAt: new Date().toISOString(),
      })
    } catch (error) {
      this.store.updatePiReviewRun(current.id, {
        state: 'cleanup-blocked',
        error: error instanceof Error ? error.message : String(error),
      })
    }
    this.onUpdate(current.sessionId)
  }
}

function readSessionEntries(file: string | null): unknown[] {
  if (file == null || !pathExists(file)) return []
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (!line) return []
        try {
          return [JSON.parse(line) as unknown]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

function transcriptRevision(file: string | null): string {
  if (file == null || !pathExists(file)) return 'none'
  try {
    const stats = statSync(file)
    return `${stats.size}:${stats.mtimeMs}`
  } catch {
    return 'none'
  }
}

function chatModelKey(session: ReviewSession): string {
  if (session.target.kind === 'pr') return `pr:${session.repositoryRoot}:${session.target.number}`
  return `session:${session.id}`
}

function allowedChatModelSelection(selection: ChatModelSelection): ChatModelSelection {
  if (selection.status === 'set' && !isAllowedPiChatModel(selection.model))
    return { status: 'unset' }
  return selection
}

function spawnPiChatModel(
  selection: ChatModelSelection,
  models: readonly PiChatModelOption[],
): { args: string[]; key: string } {
  const stored = selection.status === 'set' && isAllowedPiChatModel(selection.model)
    ? selection.model
    : defaultPiChatModel(models)
  return { args: piChatCliArgs(stored), key: piChatModelKey(stored) }
}

function buildExplainPrompt(
  sessionId: string,
  pullRequestNumber: number,
  baseOid: string,
  headOid: string,
  additionalInstructions: string,
): string {
  const extra = additionalInstructions.trim()
  const userInstructions = extra
    ? `\n\nAdditional instructions from the user:\n${extra}`
    : ''
  return `${buildReviewPrompt(sessionId, pullRequestNumber, baseOid, headOid)}${userInstructions}`
}

function buildReviewPrompt(
  sessionId: string,
  pullRequestNumber: number,
  baseOid: string,
  headOid: string,
): string {
  return `Help someone review PR #${pullRequestNumber}. Explain the change in the context of what moved, appeared, or disappeared — purpose, behavior deltas, risks, and tests. A reviewer already has the new code; they need why this hunk is here and how it relates to the rest of the patch. Do not perform a code review or limit annotations to defects.

Example: retry() deleted from a.ts and added in b.ts → one note that this is a move into b.ts, and why that home makes sense.

This detached worktree is the exact PR head ${headOid}. Explain only the immutable change shown by:
  git diff ${baseOid} ${headOid} --

Do not edit files, commit, push, or publish anything to GitHub. Add concise findings directly to Diff Review.

Global comment — session-level text, no --file or line flags:
  diff-review annotate ${sessionId} --comment "[summary] …" --json

Line annotation — attaches to a file and a changed range. Exactly one of --new-line or --old-line (42 or 42-48, inclusive). Prefix --comment with action(domain): action is the edit verb (what happened to the code), domain is the feature or concern it belongs to, e.g. move(feature-A):. --comment and --importance (0–1) are independently optional; at least one is required. 0 drops the red/green line wash; 1 is the strongest wash.
  diff-review annotate ${sessionId} --file <path> (--new-line <line[-end]> | --old-line <line[-end]>) --comment "action(domain): …" [--importance <0..1>] --json

Use new-side line numbers for added/current code and old-side line numbers for deleted code. Add at least one annotation per changed file unless that file's change is obvious. Keep annotations in a reviewable order.`
}

function isPiInstalled(): boolean {
  return findExecutable('pi')
}

function findExecutable(name: string): boolean {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const suffix of suffixes) {
      if (pathExists(path.join(dir, `${name}${suffix}`))) return true
    }
  }
  return false
}

function retentionDeadline(from = Date.now()): string {
  return new Date(from + RETENTION_MS).toISOString()
}

function findPiSessionPath(run: Pick<PiReviewRun, 'piSessionDir' | 'piSessionId'>): string | null {
  if (!run.piSessionDir || !run.piSessionId) return null
  try {
    const suffix = `_${run.piSessionId}.jsonl`
    const file = readdirSync(run.piSessionDir).find((candidate) => candidate.endsWith(suffix))
    return file == null ? null : path.join(run.piSessionDir, file)
  } catch {
    return null
  }
}

async function syncWorktreeHead(worktreePath: string, headOid: string): Promise<void> {
  const current = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
  if (current.stdout.trim() === headOid) return
  await runProcess('git', ['reset', '--hard', headOid], { cwd: worktreePath })
}

function pathExists(target: string): boolean {
  try {
    accessSync(target)
    return true
  } catch {
    return false
  }
}

function isProcessAlive(pid: number | null): boolean {
  if (pid == null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; allowFailure?: boolean },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= 1024 * 1024) return
      stdoutBytes += chunk.length
      stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 1024 * 1024) return
      stderrBytes += chunk.length
      stderr.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('COMMAND_NOT_FOUND', `Required command not found: ${command}`)
    }
    throw error
  })
  if (!options.allowFailure && result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      result.stderr.trim() || `${command} exited with ${result.exitCode}`,
    )
  }
  return result
}
