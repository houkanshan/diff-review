#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  ApiErrorShape,
  PiReviewRun,
  ReviewSession,
  ReviewTarget,
  SessionAnnotation,
  SessionGlobalComment,
} from '../shared/types.js'
import { DEFAULT_HOST, DEFAULT_PORT, serveDaemon } from './daemon.js'
import { AppError, errorMessage } from './errors.js'
import { findPackageRoot } from './packageRoot.js'

const BASE_URL = `http://${DEFAULT_HOST}:${process.env.DIFF_REVIEW_PORT ?? DEFAULT_PORT}`

void main().catch((error: unknown) => {
  console.error(`diff-review: ${errorMessage(error)}`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === 'daemon' && args[1] === 'serve') {
    await serveDaemon()
    return
  }

  if (args[0] === 'session' && args[1] === 'create') {
    await ensureDaemon()
    const result = await createSession(args.slice(2))
    printSession(result.session, result.json)
    return
  }

  if (args[0] === 'setup-skill') {
    setupSkill()
    return
  }

  if (args[0] === 'pi' && args[1] === 'resume') {
    await ensureDaemon()
    await resumePiReview(args[2])
    return
  }

  if (args[0] === 'annotate') {
    if (wantsHelp(args.slice(1))) {
      printHelp()
      return
    }
    await ensureDaemon()
    const result = await addAnnotation(args.slice(1))
    if (result.json) console.log(JSON.stringify(result.payload, null, 2))
    else if (result.kind === 'global') console.log(`Added global comment ${result.payload.id}`)
    else console.log(`Added annotation ${result.payload.id}`)
    return
  }

  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printHelp()
    return
  }

  await ensureDaemon()
  const result = await createSession(args)
  printSession(result.session, result.json)
  await openBrowser(`${BASE_URL}/s/${result.session.id}`)
}

function setupSkill(): void {
  const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)))
  const source = packageRoot == null
    ? null
    : path.join(packageRoot, 'skills', 'explain-diff', 'SKILL.md')
  if (source == null || !existsSync(source)) {
    throw new AppError('SKILL_NOT_FOUND', 'The bundled explain-diff skill could not be found')
  }

  const destinationDirectory = path.join(homedir(), '.agents', 'skills', 'explain-diff')
  const destination = path.join(destinationDirectory, 'SKILL.md')
  mkdirSync(destinationDirectory, { recursive: true })
  copyFileSync(source, destination)
  console.log(`Installed explain-diff skill to ${destination}`)
}

async function createSession(args: string[]): Promise<{ session: ReviewSession; json: boolean }> {
  const parsed = parseArgs(args)
  const repositoryPath = stringFlag(parsed, 'repo') ?? process.cwd()
  const target = await targetFromArguments(parsed, repositoryPath)
  const session = await requestJson<ReviewSession>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ repositoryPath, target }),
  })
  return { session, json: booleanFlag(parsed, 'json') }
}

async function addAnnotation(
  args: string[],
): Promise<
  | { kind: 'line'; payload: SessionAnnotation; json: boolean }
  | { kind: 'global'; payload: SessionGlobalComment; json: boolean }
> {
  const parsed = parseArgs(args)
  const sessionId = parsed.positionals[0]
  if (!sessionId) throw new AppError('INVALID_ARGUMENTS', 'annotate requires a session ID')
  const filePath = stringFlag(parsed, 'file')
  const oldLine = stringFlag(parsed, 'old-line')
  const newLine = stringFlag(parsed, 'new-line')
  const comment = stringFlag(parsed, 'comment')
  const importanceValue = stringFlag(parsed, 'importance')
  const importance = importanceValue == null ? undefined : Number(importanceValue)
  if (importance != null && (!Number.isFinite(importance) || importance < 0 || importance > 1)) {
    throw new AppError('INVALID_ARGUMENTS', '--importance must be a number between 0 and 1')
  }

  const hasFile = filePath != null
  const hasLine = oldLine != null || newLine != null
  if (!hasFile && !hasLine) {
    if (comment == null || comment.trim() === '') {
      throw new AppError('INVALID_ARGUMENTS', 'global annotate requires --comment <text>')
    }
    if (importance != null) {
      throw new AppError('INVALID_ARGUMENTS', 'global annotate does not accept --importance')
    }
    const globalComment = await requestJson<SessionGlobalComment>(
      `/api/sessions/${encodeURIComponent(sessionId)}/global-comments`,
      {
        method: 'POST',
        body: JSON.stringify({ comment, source: 'agent' }),
      },
    )
    return { kind: 'global', payload: globalComment, json: booleanFlag(parsed, 'json') }
  }

  if (!filePath) throw new AppError('INVALID_ARGUMENTS', 'annotate requires --file <path>')
  if ((oldLine == null) === (newLine == null)) {
    throw new AppError('INVALID_ARGUMENTS', 'Use exactly one of --old-line or --new-line')
  }
  const range = parseLineRange(oldLine ?? newLine ?? '')
  if (comment == null && importance == null) {
    throw new AppError('INVALID_ARGUMENTS', 'Use at least one of --comment or --importance')
  }

  const annotation = await requestJson<SessionAnnotation>(
    `/api/sessions/${encodeURIComponent(sessionId)}/annotations`,
    {
      method: 'POST',
      body: JSON.stringify({
        filePath,
        side: oldLine == null ? 'new' : 'old',
        startLine: range.start,
        endLine: range.end,
        comment,
        importance,
        source: 'agent',
      }),
    },
  )
  return { kind: 'line', payload: annotation, json: booleanFlag(parsed, 'json') }
}

async function resumePiReview(runId: string | undefined): Promise<void> {
  if (!runId) throw new AppError('INVALID_ARGUMENTS', 'pi resume requires a run ID')
  const leasePath = `/api/pi-runs/${encodeURIComponent(runId)}/lease`
  const run = await requestJson<PiReviewRun>(leasePath, {
    method: 'POST',
    body: JSON.stringify({ pid: process.pid }),
  })
  try {
    if (run.piSessionPath == null) {
      throw new AppError('PI_SESSION_MISSING', 'The saved Pi session could not be found')
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'pi',
        [
          '--session',
          run.piSessionPath!,
          '--approve',
          '--tools',
          'read,bash,grep,find,ls',
        ],
        { cwd: run.worktreePath, stdio: 'inherit', env: process.env },
      )
      child.on('error', reject)
      child.on('close', (exitCode) => {
        if (exitCode === 0) resolve()
        else reject(new AppError('PI_RESUME_FAILED', `Pi exited with ${exitCode ?? 1}`))
      })
    })
  } finally {
    await requestJson<PiReviewRun>(leasePath, {
      method: 'DELETE',
      body: JSON.stringify({ pid: process.pid }),
    }).catch(() => undefined)
  }
}

async function targetFromArguments(args: ParsedArgs, repositoryPath: string): Promise<ReviewTarget> {
  if (booleanFlag(args, 'staged')) return { kind: 'staged' }
  if (booleanFlag(args, 'unstaged')) return { kind: 'unstaged' }
  const pullRequest = stringFlag(args, 'pr')
  if (pullRequest != null) {
    const number = Number(pullRequest)
    if (!Number.isInteger(number) || number <= 0) {
      throw new AppError('INVALID_ARGUMENTS', '--pr requires a positive pull request number')
    }
    return { kind: 'pr', number }
  }
  const expression = args.positionals[0]
  if (expression != null) return { kind: 'range', expression }
  return (await hasUnstagedChanges(repositoryPath))
    ? { kind: 'unstaged' }
    : { kind: 'range', expression: 'origin/master...HEAD' }
}

function hasUnstagedChanges(repositoryPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repositoryPath, 'diff', '--quiet'], {
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('close', (status) => resolve(status === 1))
  })
}

async function ensureDaemon(): Promise<void> {
  if (await daemonIsReady()) return

  const dataDirectory = process.env.DIFF_REVIEW_DATA_DIR ?? path.join(homedir(), '.diff-review')
  mkdirSync(dataDirectory, { recursive: true })
  const log = openSync(path.join(dataDirectory, 'daemon.log'), 'a')
  const cliPath = fileURLToPath(import.meta.url)
  const child = spawn(process.execPath, [cliPath, 'daemon', 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  })
  child.unref()
  closeSync(log)

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100)
    if (await daemonIsReady()) return
  }
  throw new AppError(
    'DAEMON_START_FAILED',
    `Could not start the local daemon. See ${path.join(dataDirectory, 'daemon.log')}`,
  )
}

async function daemonIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/health`)
    if (!response.ok) return false
    const body = (await response.json()) as { app?: string; ok?: boolean }
    return body.app === 'diff-review' && body.ok === true
  } catch {
    return false
  }
}

async function requestJson<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  const body = (await response.json()) as T | ApiErrorShape
  if (!response.ok) {
    const apiError = body as ApiErrorShape
    throw new AppError(
      apiError.error?.code ?? 'REQUEST_FAILED',
      apiError.error?.message ?? `Request failed with ${response.status}`,
    )
  }
  return body as T
}

async function openBrowser(url: string): Promise<void> {
  const command: [executable: string, arguments: string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
  child.unref()
}

function parseLineRange(value: string): { start: number; end: number } {
  const match = /^(\d+)(?:-(\d+))?$/.exec(value)
  if (match == null) {
    throw new AppError('INVALID_ARGUMENTS', `Invalid line range: ${value}. Use 42 or 42-48.`)
  }
  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  if (start <= 0 || end < start) {
    throw new AppError('INVALID_ARGUMENTS', `Invalid line range: ${value}`)
  }
  return { start, end }
}

interface ParsedArgs {
  positionals: string[]
  flags: Map<string, string | true>
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { positionals: [], flags: new Map() }
  const booleanFlags = new Set(['json', 'staged', 'unstaged', 'help'])
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    if (!argument.startsWith('--')) {
      result.positionals.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (booleanFlags.has(name)) {
      result.flags.set(name, true)
      continue
    }
    const value = args[index + 1]
    if (value == null || value.startsWith('--')) {
      throw new AppError('INVALID_ARGUMENTS', `${argument} requires a value`)
    }
    result.flags.set(name, value)
    index += 1
  }
  return result
}

function stringFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

function booleanFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

function printSession(session: ReviewSession, json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        {
          sessionId: session.id,
          repository: session.repositoryRoot,
          target: session.targetLabel,
          gitCommand: session.gitCommand,
          url: `${BASE_URL}/s/${session.id}`,
        },
        null,
        2,
      ),
    )
    return
  }
  console.log(`Session: ${session.id}`)
  console.log(`Repository: ${session.repositoryRoot}`)
  console.log(`Review with: ${session.gitCommand}`)
  console.log(`Open: ${BASE_URL}/s/${session.id}`)
}

function wantsHelp(args: string[]): boolean {
  return args.some((argument) => argument === '--help' || argument === '-h' || argument === 'help')
}

function printHelp(): void {
  console.log(`Usage:
  diff-review [revision-range] [--repo <path>]
  diff-review --staged | --unstaged | --pr <number>
  diff-review session create [revision-range] [--repo <path>] [--json]
  diff-review setup-skill
  diff-review pi resume <run-id>
  diff-review annotate <session-id> --comment <text> [--json]
  diff-review annotate <session-id> --file <path> \\
    (--old-line <line[-end]> | --new-line <line[-end]>) \\
    [--comment <text>] [--importance <0..1>] [--json]

Examples:
  diff-review
  diff-review origin/master...HEAD
  diff-review session create --pr 42 --json
  diff-review setup-skill
  diff-review pi resume pir_abc123
  diff-review annotate drs_abc123 --comment "Summary of the change"
  diff-review annotate drs_abc123 --file src/retry.ts --new-line 42-48 \\
    --comment "Generated code; safe to skim" --importance 0
`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
