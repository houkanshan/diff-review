#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ApiErrorShape, ReviewSession, ReviewTarget, SessionAnnotation } from '../shared/types.js'
import { DEFAULT_HOST, DEFAULT_PORT, serveDaemon } from './daemon.js'
import { AppError, errorMessage } from './errors.js'

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

  if (args[0] === 'annotate') {
    await ensureDaemon()
    const result = await addAnnotation(args.slice(1))
    if (result.json) console.log(JSON.stringify(result.annotation, null, 2))
    else console.log(`Added annotation ${result.annotation.id}`)
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

async function createSession(args: string[]): Promise<{ session: ReviewSession; json: boolean }> {
  const parsed = parseArgs(args)
  const repositoryPath = stringFlag(parsed, 'repo') ?? process.cwd()
  const target = targetFromArguments(parsed)
  const session = await requestJson<ReviewSession>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ repositoryPath, target }),
  })
  return { session, json: booleanFlag(parsed, 'json') }
}

async function addAnnotation(
  args: string[],
): Promise<{ annotation: SessionAnnotation; json: boolean }> {
  const parsed = parseArgs(args)
  const sessionId = parsed.positionals[0]
  if (!sessionId) throw new AppError('INVALID_ARGUMENTS', 'annotate requires a session ID')
  const filePath = stringFlag(parsed, 'file')
  if (!filePath) throw new AppError('INVALID_ARGUMENTS', 'annotate requires --file <path>')

  const oldLine = stringFlag(parsed, 'old-line')
  const newLine = stringFlag(parsed, 'new-line')
  if ((oldLine == null) === (newLine == null)) {
    throw new AppError('INVALID_ARGUMENTS', 'Use exactly one of --old-line or --new-line')
  }
  const range = parseLineRange(oldLine ?? newLine ?? '')
  const comment = stringFlag(parsed, 'comment')
  const importanceValue = stringFlag(parsed, 'importance')
  const importance = importanceValue == null ? undefined : Number(importanceValue)
  if (importance != null && (!Number.isFinite(importance) || importance < 0 || importance > 1)) {
    throw new AppError('INVALID_ARGUMENTS', '--importance must be a number between 0 and 1')
  }
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
  return { annotation, json: booleanFlag(parsed, 'json') }
}

function targetFromArguments(args: ParsedArgs): ReviewTarget {
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
  return expression == null ? { kind: 'worktree' } : { kind: 'range', expression }
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
  const booleanFlags = new Set(['json', 'staged', 'unstaged'])
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

function printHelp(): void {
  console.log(`Usage:
  diff-review [revision-range] [--repo <path>]
  diff-review --staged | --unstaged | --pr <number>
  diff-review session create [revision-range] [--repo <path>] [--json]
  diff-review annotate <session-id> --file <path> \\
    (--old-line <line[-end]> | --new-line <line[-end]>) \\
    [--comment <text>] [--importance <0..1>] [--json]

Examples:
  diff-review origin/master...HEAD
  diff-review session create --pr 42 --json
  diff-review annotate drs_abc123 --file src/retry.ts --new-line 42-48 \\
    --comment "Generated code; safe to skim" --importance 0
`)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
