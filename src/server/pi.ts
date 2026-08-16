import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { accessSync, readdirSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'

import type { PiReviewRun, PiReviewStatus } from '../shared/types.js'
import { AppError } from './errors.js'
import { ReviewStore } from './store.js'

const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000

export class PiReviewRunner {
  private readonly activeRuns = new Set<string>()
  private cleanupTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: ReviewStore,
    private readonly onUpdate: (sessionId: string) => void,
  ) {}

  initialize(): void {
    void this.reconcileAndCleanup()
    this.cleanupTimer = setInterval(() => void this.reconcileAndCleanup(), CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref()
  }

  close(): void {
    if (this.cleanupTimer != null) clearInterval(this.cleanupTimer)
    this.cleanupTimer = null
  }

  getStatus(sessionId: string): PiReviewStatus {
    this.store.getSession(sessionId)
    const run = this.store.latestPiReviewRun(sessionId)
    if (run == null) return { state: 'idle' }
    if (
      (run.state === 'creating' || run.state === 'running') &&
      !this.activeRuns.has(run.id) &&
      !isProcessAlive(run.activePid)
    ) {
      return this.store.updatePiReviewRun(run.id, {
        state: 'interrupted',
        activePid: null,
        completedAt: new Date().toISOString(),
        error: 'The Pi process stopped before the run completed. The saved session can be resumed.',
        piSessionPath: findPiSessionPath(run),
      })
    }
    return run
  }

  start(sessionId: string, additionalInstructions = ''): PiReviewStatus {
    const session = this.store.getSession(sessionId)
    if (
      session.target.kind !== 'pr' ||
      session.revisionBaseOid == null ||
      session.revisionHeadOid == null
    ) {
      throw new AppError('INVALID_REVIEW_TARGET', 'Pi review requires a pull request revision')
    }
    const current = this.getStatus(sessionId)
    if (
      current.state === 'creating' ||
      current.state === 'running' ||
      (current.state !== 'idle' && isProcessAlive(current.activePid))
    ) return current

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
    void this.run(
      run,
      session.repositoryRoot,
      session.target.number,
      session.revisionBaseOid,
      session.revisionHeadOid,
      additionalInstructions,
    )
    return run
  }

  acquireLease(runId: string, pid: number): PiReviewRun {
    if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
      throw new AppError('INVALID_PI_LEASE', 'Resume requires a live local process ID')
    }
    const run = this.requiredRun(runId)
    if (run.state === 'cleaned' || run.state === 'cleaning') {
      throw new AppError('PI_REVIEW_NOT_RESUMABLE', 'This Pi review run has been cleaned up')
    }
    if (run.activePid != null && run.activePid !== pid && isProcessAlive(run.activePid)) {
      throw new AppError('PI_REVIEW_IN_USE', `Pi review run is already active in process ${run.activePid}`, 409)
    }
    if (!pathExists(run.worktreePath)) {
      throw new AppError('PI_WORKTREE_MISSING', `Pi worktree is missing: ${run.worktreePath}`)
    }
    const piSessionPath = run.piSessionPath ?? findPiSessionPath(run)
    if (piSessionPath == null || !pathExists(piSessionPath)) {
      throw new AppError('PI_SESSION_MISSING', 'The saved Pi session could not be found')
    }
    const leased = this.store.updatePiReviewRun(run.id, {
      activePid: pid,
      piSessionPath,
      lastUsedAt: new Date().toISOString(),
      cleanupEligibleAt: retentionDeadline(),
    })
    this.onUpdate(run.sessionId)
    return leased
  }

  releaseLease(runId: string, pid: number): PiReviewRun {
    const run = this.requiredRun(runId)
    if (run.activePid !== pid) return run
    const released = this.store.updatePiReviewRun(run.id, {
      activePid: null,
      lastUsedAt: new Date().toISOString(),
      cleanupEligibleAt: retentionDeadline(),
    })
    this.onUpdate(run.sessionId)
    return released
  }

  async reconcileAndCleanup(): Promise<void> {
    for (const run of this.store.listActivePiReviewRuns()) {
      if (this.activeRuns.has(run.id) || isProcessAlive(run.activePid)) continue
      this.store.updatePiReviewRun(run.id, {
        state: 'interrupted',
        activePid: null,
        completedAt: run.completedAt ?? new Date().toISOString(),
        error: 'The Pi process stopped before the run completed. The saved session can be resumed.',
        piSessionPath: findPiSessionPath(run),
      })
      this.onUpdate(run.sessionId)
    }
    for (const run of this.store.listPiReviewRunsEligibleForCleanup(new Date().toISOString())) {
      await this.cleanup(run)
    }
  }

  private async run(
    run: PiReviewRun,
    repositoryRoot: string,
    pullRequestNumber: number,
    baseOid: string,
    headOid: string,
    additionalInstructions: string,
  ): Promise<void> {
    let failure: string | null = null
    try {
      await mkdir(path.dirname(run.worktreePath), { recursive: true })
      await mkdir(run.piSessionDir, { recursive: true })
      await runProcess('git', ['worktree', 'add', '--detach', '--force', run.worktreePath, headOid], {
        cwd: repositoryRoot,
      })
      await runProcess(
        'pi',
        [
          '--print',
          '--session-dir',
          run.piSessionDir,
          '--session-id',
          run.piSessionId,
          '--approve',
          '--tools',
          'read,bash,grep,find,ls',
          buildReviewPrompt(
            run.sessionId,
            pullRequestNumber,
            baseOid,
            headOid,
            additionalInstructions,
          ),
        ],
        {
          cwd: run.worktreePath,
          onSpawn: (pid) => {
            this.store.updatePiReviewRun(run.id, { state: 'running', activePid: pid })
            this.onUpdate(run.sessionId)
          },
        },
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      this.activeRuns.delete(run.id)
      const completedAt = new Date().toISOString()
      const piSessionPath = findPiSessionPath(run)
      this.store.updatePiReviewRun(run.id, {
        state: failure == null ? 'completed' : 'failed',
        activePid: null,
        piSessionPath,
        error: failure,
        completedAt,
        lastUsedAt: completedAt,
        cleanupEligibleAt: retentionDeadline(),
      })
      this.onUpdate(run.sessionId)
    }
  }

  private async cleanup(run: PiReviewRun): Promise<void> {
    let current = this.requiredRun(run.id)
    if (current.keep) return
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
          ['status', '--porcelain', '--untracked-files=all', '--ignored'],
          { cwd: current.worktreePath },
        )
        if (status.stdout.trim() !== '') {
          this.store.updatePiReviewRun(current.id, {
            state: 'cleanup-blocked',
            error: 'Automatic cleanup is blocked because the worktree contains local, untracked, or ignored files.',
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

  private requiredRun(runId: string): PiReviewRun {
    const run = this.store.getPiReviewRun(runId)
    if (run == null) throw new AppError('PI_REVIEW_RUN_NOT_FOUND', `Pi review run not found: ${runId}`, 404)
    return run
  }
}

function buildReviewPrompt(
  sessionId: string,
  pullRequestNumber: number,
  baseOid: string,
  headOid: string,
  additionalInstructions: string,
): string {
  const userInstructions = additionalInstructions
    ? `\n\nAdditional instructions from the user:\n${additionalInstructions}`
    : ''
  return `Explain PR #${pullRequestNumber} in plain language by annotating its diff. Focus on the purpose of the change, important behavior changes, risks, and tests. Do not perform a code review or limit annotations to defects.

This detached worktree is the exact PR head ${headOid}. Explain only the immutable change shown by:
  git diff ${baseOid} ${headOid} --

Do not edit files, commit, push, or publish anything to GitHub. Add concise findings directly to Diff Review with:
  diff-review annotate ${sessionId} --file <path> (--new-line <line[-end]> | --old-line <line[-end]>) --comment <explanation> [--importance <0..1>]

Annotate only changed lines. Use new-side line numbers for added/current code and old-side line numbers for deleted code. Add at least one annotation per changed file unless that file's change is obvious. Keep annotations in a reviewable order and do not produce a separate overall summary.${userInstructions}`
}

function retentionDeadline(from = Date.now()): string {
  return new Date(from + RETENTION_MS).toISOString()
}

function findPiSessionPath(run: Pick<PiReviewRun, 'piSessionDir' | 'piSessionId'>): string | null {
  try {
    const suffix = `_${run.piSessionId}.jsonl`
    const file = readdirSync(run.piSessionDir).find((candidate) => candidate.endsWith(suffix))
    return file == null ? null : path.join(run.piSessionDir, file)
  } catch {
    return null
  }
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
  options: { cwd: string; allowFailure?: boolean; onSpawn?: (pid: number) => void },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (child.pid != null) options.onSpawn?.(child.pid)
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= 1024 * 1024) return
      stdoutBytes += chunk.length
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
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
