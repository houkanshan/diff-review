import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { PiReviewStatus } from '../shared/types.js'
import { AppError } from './errors.js'
import { ReviewStore } from './store.js'

export class PiReviewRunner {
  private readonly statuses = new Map<string, PiReviewStatus>()

  constructor(
    private readonly store: ReviewStore,
    private readonly onUpdate: (sessionId: string) => void,
  ) {}

  getStatus(sessionId: string): PiReviewStatus {
    this.store.getSession(sessionId)
    return this.statuses.get(sessionId) ?? { state: 'idle' }
  }

  start(sessionId: string): PiReviewStatus {
    const session = this.store.getSession(sessionId)
    if (
      session.target.kind !== 'pr' ||
      session.revisionBaseOid == null ||
      session.revisionHeadOid == null
    ) {
      throw new AppError('INVALID_REVIEW_TARGET', 'Pi review requires a pull request revision')
    }
    const current = this.statuses.get(sessionId)
    if (current?.state === 'running') return current

    const status: PiReviewStatus = { state: 'running', startedAt: new Date().toISOString() }
    this.statuses.set(sessionId, status)
    this.onUpdate(sessionId)
    void this.run(
      sessionId,
      session.repositoryRoot,
      session.target.number,
      session.revisionBaseOid,
      session.revisionHeadOid,
      status.startedAt,
    )
    return status
  }

  private async run(
    sessionId: string,
    repositoryRoot: string,
    pullRequestNumber: number,
    baseOid: string,
    headOid: string,
    startedAt: string,
  ): Promise<void> {
    let worktree: string | null = null
    try {
      worktree = await mkdtemp(path.join(tmpdir(), 'diff-review-pi-'))
      await runProcess('git', ['worktree', 'add', '--detach', '--force', worktree, headOid], {
        cwd: repositoryRoot,
      })
      await runProcess(
        'pi',
        [
          '--print',
          '--no-session',
          '--approve',
          '--tools',
          'read,bash,grep,find,ls',
          buildReviewPrompt(sessionId, pullRequestNumber, baseOid, headOid),
        ],
        { cwd: worktree },
      )
      this.statuses.set(sessionId, {
        state: 'completed',
        startedAt,
        completedAt: new Date().toISOString(),
      })
    } catch (error) {
      this.statuses.set(sessionId, {
        state: 'failed',
        startedAt,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (worktree != null) {
        await runProcess('git', ['worktree', 'remove', '--force', worktree], {
          cwd: repositoryRoot,
          allowFailure: true,
        }).catch(() => undefined)
        await rm(worktree, { recursive: true, force: true }).catch(() => undefined)
      }
      this.onUpdate(sessionId)
    }
  }
}

function buildReviewPrompt(
  sessionId: string,
  pullRequestNumber: number,
  baseOid: string,
  headOid: string,
): string {
  return `Review PR #${pullRequestNumber} for correctness, regressions, edge cases, and maintainability.

This detached worktree is the exact PR head ${headOid}. Review only the immutable change shown by:
  git diff ${baseOid} ${headOid} --

Do not edit files, commit, push, or publish anything to GitHub. Add concise findings directly to Diff Review with:
  diff-review annotate ${sessionId} --file <path> (--new-line <line[-end]> | --old-line <line[-end]>) --comment <finding> [--importance <0..1>]

Use new-side line numbers for added/current code and old-side line numbers for deleted code. Add annotations only for useful findings or rationale; do not produce a separate overall summary.`
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; allowFailure?: boolean },
): Promise<void> {
  const result = await new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const stderr: Buffer[] = []
    let stderrBytes = 0
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= 1024 * 1024) return
      stderrBytes += chunk.length
      stderr.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stderr: Buffer.concat(stderr).toString('utf8') })
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
}
