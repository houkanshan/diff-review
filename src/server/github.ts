import { spawn } from 'node:child_process'

import type {
  DiffSide,
  GitHubLabel,
  GitHubUser,
  PullRequestActivity,
  PullRequestCheckStatus,
  PullRequestDetails,
  PullRequestListView,
  PullRequestState,
  PullRequestSummary,
} from '../shared/types.js'
import { AppError, errorMessage } from './errors.js'

export interface PullRequestRevisionDetails {
  number: number
  title: string
  url: string
  baseRefName: string
  headRefName: string
  baseRefOid: string
  headRefOid: string
}

const SUMMARY_FIELDS = [
  'number',
  'title',
  'url',
  'state',
  'isDraft',
  'baseRefName',
  'headRefName',
  'additions',
  'deletions',
  'createdAt',
  'updatedAt',
  'author',
  'assignees',
  'labels',
  'statusCheckRollup',
].join(',')

const DETAILS_FIELDS = [
  SUMMARY_FIELDS,
  'body',
  'baseRefOid',
  'headRefOid',
  'comments',
  'reviews',
].join(',')

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024

export async function listPullRequests(
  root: string,
  view: PullRequestListView,
): Promise<PullRequestSummary[]> {
  const filter = pullRequestListFilter(view)
  const output = await runGitHub(
    [
      'pr',
      'list',
      '--state',
      filter.state,
      ...(filter.label == null ? [] : ['--label', filter.label]),
      '--limit',
      '50',
      '--json',
      SUMMARY_FIELDS,
    ],
    root,
  )
  return expectArray(parseJson(output, 'GitHub pull request list')).map(parsePullRequestSummary)
}

export async function getPullRequestDetails(
  root: string,
  number: number,
): Promise<PullRequestDetails> {
  validatePullRequestNumber(number)
  const [detailsOutput, reviewCommentsOutput] = await Promise.all([
    runGitHub(['pr', 'view', String(number), '--json', DETAILS_FIELDS], root),
    runGitHub(
      [
        'api',
        `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`,
        '--paginate',
        '--slurp',
      ],
      root,
    ),
  ])
  const raw = expectObject(parseJson(detailsOutput, `GitHub PR #${number}`))
  const summary = parsePullRequestSummary(raw)
  const activity = [
    ...expectArray(raw.comments).map(parseConversationComment),
    ...expectArray(raw.reviews).map(parseReview),
    ...parsePaginatedArray(
      parseJson(reviewCommentsOutput, `GitHub PR #${number} review comments`),
    ).map(parseReviewComment),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt))

  return {
    ...summary,
    body: optionalString(raw.body) ?? '',
    baseRefOid: expectString(raw.baseRefOid, 'baseRefOid'),
    headRefOid: expectString(raw.headRefOid, 'headRefOid'),
    activity,
  }
}

export async function getPullRequestRevisionDetails(
  root: string,
  number: number,
): Promise<PullRequestRevisionDetails> {
  validatePullRequestNumber(number)
  const output = await runGitHub(
    [
      'pr',
      'view',
      String(number),
      '--json',
      'number,title,url,baseRefName,headRefName,baseRefOid,headRefOid',
    ],
    root,
  )
  const raw = expectObject(parseJson(output, `GitHub PR #${number}`))
  return {
    number: expectPositiveInteger(raw.number, 'number'),
    title: expectString(raw.title, 'title'),
    url: expectString(raw.url, 'url'),
    baseRefName: expectString(raw.baseRefName, 'baseRefName'),
    headRefName: expectString(raw.headRefName, 'headRefName'),
    baseRefOid: expectString(raw.baseRefOid, 'baseRefOid'),
    headRefOid: expectString(raw.headRefOid, 'headRefOid'),
  }
}

export function aggregateCheckStatus(value: unknown): PullRequestCheckStatus {
  const checks = expectArray(value)
  if (checks.length === 0) return 'none'

  let pending = false
  for (const checkValue of checks) {
    const check = expectObject(checkValue)
    const status = optionalString(check.status)?.toUpperCase()
    const state = optionalString(check.state)?.toUpperCase()
    const conclusion = optionalString(check.conclusion)?.toUpperCase()
    if (state != null) {
      if (state === 'FAILURE' || state === 'ERROR') return 'fail'
      if (state === 'PENDING' || state === 'EXPECTED') pending = true
      continue
    }
    if (status !== 'COMPLETED') {
      pending = true
      continue
    }
    if (conclusion == null) pending = true
    else if (!['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(conclusion)) return 'fail'
  }
  return pending ? 'pending' : 'pass'
}

function pullRequestListFilter(
  view: PullRequestListView,
): { state: 'open' | 'merged' | 'all'; label?: string } {
  switch (view) {
    case 'open':
      return { state: 'open' }
    case 'additional-review':
      return { state: 'all', label: 'additional-review-needed' }
    case 'merged':
      return { state: 'merged' }
  }
}

function parsePullRequestSummary(value: unknown): PullRequestSummary {
  const raw = expectObject(value)
  const state = expectString(raw.state, 'state').toUpperCase()
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') {
    throw invalidGitHubResponse(`Unknown pull request state: ${state}`)
  }
  return {
    number: expectPositiveInteger(raw.number, 'number'),
    title: expectString(raw.title, 'title'),
    url: expectString(raw.url, 'url'),
    state: state as PullRequestState,
    isDraft: expectBoolean(raw.isDraft, 'isDraft'),
    baseRefName: expectString(raw.baseRefName, 'baseRefName'),
    headRefName: expectString(raw.headRefName, 'headRefName'),
    additions: expectNonNegativeInteger(raw.additions, 'additions'),
    deletions: expectNonNegativeInteger(raw.deletions, 'deletions'),
    createdAt: expectString(raw.createdAt, 'createdAt'),
    updatedAt: expectString(raw.updatedAt, 'updatedAt'),
    author: parseUser(raw.author),
    assignees: expectArray(raw.assignees).map(parseUser),
    labels: expectArray(raw.labels).map(parseLabel),
    checkStatus: aggregateCheckStatus(raw.statusCheckRollup),
  }
}

function parseConversationComment(value: unknown): PullRequestActivity {
  const raw = expectObject(value)
  return {
    kind: 'comment',
    id: String(raw.id),
    author: parseUser(raw.author),
    body: optionalString(raw.body) ?? '',
    createdAt: expectString(raw.createdAt, 'comment.createdAt'),
    updatedAt: optionalString(raw.updatedAt) ?? expectString(raw.createdAt, 'comment.createdAt'),
    url: optionalString(raw.url),
  }
}

function parseReview(value: unknown): PullRequestActivity {
  const raw = expectObject(value)
  const submittedAt = expectString(raw.submittedAt, 'review.submittedAt')
  return {
    kind: 'review',
    id: String(raw.id),
    author: parseUser(raw.author),
    body: optionalString(raw.body) ?? '',
    state: optionalString(raw.state) ?? 'COMMENTED',
    createdAt: submittedAt,
    updatedAt: submittedAt,
    url: null,
  }
}

function parseReviewComment(value: unknown): PullRequestActivity {
  const raw = expectObject(value)
  const line = optionalPositiveInteger(raw.line) ?? optionalPositiveInteger(raw.original_line)
  const rawSide = optionalString(raw.side)?.toUpperCase()
  const side: DiffSide | null = rawSide === 'LEFT' ? 'old' : rawSide === 'RIGHT' ? 'new' : null
  return {
    kind: 'review-comment',
    id: String(raw.id),
    author: parseUser(raw.user),
    body: optionalString(raw.body) ?? '',
    path: expectString(raw.path, 'reviewComment.path'),
    line,
    side,
    replyToId: raw.in_reply_to_id == null ? null : String(raw.in_reply_to_id),
    createdAt: expectString(raw.created_at, 'reviewComment.created_at'),
    updatedAt: expectString(raw.updated_at, 'reviewComment.updated_at'),
    url: optionalString(raw.html_url),
  }
}

function parseUser(value: unknown): GitHubUser {
  const raw = expectObject(value)
  return {
    login: expectString(raw.login, 'user.login'),
    name: optionalString(raw.name),
    avatarUrl: optionalString(raw.avatarUrl) ?? optionalString(raw.avatar_url),
  }
}

function parseLabel(value: unknown): GitHubLabel {
  const raw = expectObject(value)
  return {
    name: expectString(raw.name, 'label.name'),
    color: optionalString(raw.color) ?? '8b949e',
  }
}

function validatePullRequestNumber(number: number): void {
  if (!Number.isInteger(number) || number <= 0) {
    throw new AppError('INVALID_PULL_REQUEST', `Invalid pull request number: ${number}`)
  }
}

function parseJson(output: string, description: string): unknown {
  try {
    return JSON.parse(output) as unknown
  } catch (error) {
    throw invalidGitHubResponse(`Could not parse ${description}: ${errorMessage(error)}`)
  }
}

function expectObject(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidGitHubResponse('Expected a JSON object')
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw invalidGitHubResponse('Expected a JSON array')
  return value
}

function parsePaginatedArray(value: unknown): unknown[] {
  return expectArray(value).flatMap((page) => expectArray(page))
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalidGitHubResponse(`${field} must be a string`)
  return value
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function expectBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw invalidGitHubResponse(`${field} must be a boolean`)
  return value
}

function expectPositiveInteger(value: unknown, field: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw invalidGitHubResponse(`${field} must be a positive integer`)
  }
  return number
}

function expectNonNegativeInteger(value: unknown, field: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 0) {
    throw invalidGitHubResponse(`${field} must be a non-negative integer`)
  }
  return number
}

function optionalPositiveInteger(value: unknown): number | null {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function invalidGitHubResponse(message: string): AppError {
  return new AppError('GITHUB_RESPONSE_INVALID', message)
}

async function runGitHub(args: string[], cwd: string): Promise<string> {
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn('gh', args, {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill()
          reject(new AppError('COMMAND_OUTPUT_TOO_LARGE', 'gh output exceeded 128 MiB'))
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.on('error', reject)
      child.on('close', (exitCode) => {
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: exitCode ?? 1,
        })
      })
    },
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('COMMAND_NOT_FOUND', 'Required command not found: gh')
    }
    throw error
  })
  if (result.exitCode !== 0) {
    throw new AppError(
      'GITHUB_COMMAND_FAILED',
      result.stderr.trim() || `gh exited with ${result.exitCode}`,
      400,
      { args, exitCode: result.exitCode },
    )
  }
  return result.stdout
}
