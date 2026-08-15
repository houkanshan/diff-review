import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

import type {
  CommitSummary,
  PullRequestSummary,
  RepositoryInfo,
  ReviewTarget,
} from '../shared/types.js'
import { AppError, errorMessage } from './errors.js'

export type SnapshotRef =
  | { kind: 'commit'; id: string }
  | { kind: 'index'; id: string }
  | { kind: 'worktree'; id: string }

export interface ResolvedReview {
  label: string
  gitCommand: string
  patch: string
  oldSnapshot: SnapshotRef
  newSnapshot: SnapshotRef
  commits: CommitSummary[]
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface PullRequestDetails extends PullRequestSummary {
  baseRefOid: string
  headRefOid: string
  url: string
}

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024
const DIFF_ARGS = [
  '-c',
  'core.quotePath=false',
  'diff',
  '--no-ext-diff',
  '--binary',
  '--full-index',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

export async function resolveRepository(repositoryPath: string): Promise<string> {
  const requestedPath = await realpath(path.resolve(repositoryPath)).catch(() => {
    throw new AppError('REPOSITORY_NOT_FOUND', `Repository path does not exist: ${repositoryPath}`)
  })
  const result = await runGit(requestedPath, ['rev-parse', '--show-toplevel'])
  return realpath(result.stdout.trim())
}

export async function getRepositoryInfo(repositoryPath: string): Promise<RepositoryInfo> {
  const root = await resolveRepository(repositoryPath)
  const branchResult = await runGit(root, ['branch', '--show-current'], true)
  const branch = branchResult.stdout.trim() || null
  const defaultBranchRef = await resolveDefaultBranch(root)
  const pullRequests = await listPullRequests(root)

  return {
    root,
    name: path.basename(root),
    branch,
    defaultBranchRef,
    branchRange: defaultBranchRef == null ? null : `${defaultBranchRef}...HEAD`,
    pullRequests,
  }
}

export async function resolveTarget(
  repositoryPath: string,
  target: ReviewTarget,
  ignoreWhitespace = false,
): Promise<ResolvedReview> {
  const root = await resolveRepository(repositoryPath)

  switch (target.kind) {
    case 'worktree':
      return resolveWorktree(root, ignoreWhitespace)
    case 'unstaged':
      return resolveUnstaged(root, ignoreWhitespace)
    case 'staged':
      return resolveStaged(root, ignoreWhitespace)
    case 'range':
      return resolveRange(root, target.expression, ignoreWhitespace)
    case 'pr':
      return resolvePullRequest(root, target.number, ignoreWhitespace)
  }
}

export async function resolveCommitSpan(
  repositoryPath: string,
  oldestCommit: string,
  newestCommit: string,
  ignoreWhitespace = false,
): Promise<ResolvedReview> {
  const root = await resolveRepository(repositoryPath)
  const oldCommit = await firstParentOrEmptyTree(root, oldestCommit)
  const newCommit = await resolveCommit(root, newestCommit)
  const patch = await gitDiff(root, [oldCommit, newCommit], ignoreWhitespace)
  const commits = await listCommits(root, oldCommit, newCommit)

  return {
    label:
      oldestCommit === newestCommit
        ? shortOid(newCommit)
        : `${shortOid(oldestCommit)}…${shortOid(newCommit)}`,
    gitCommand:
      oldestCommit === newestCommit
        ? `git show${ignoreWhitespace ? ' --ignore-all-space' : ''} ${shellQuote(newCommit)}`
        : `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} ${shellQuote(oldCommit)} ${shellQuote(newCommit)}`,
    patch,
    oldSnapshot: { kind: 'commit', id: oldCommit },
    newSnapshot: { kind: 'commit', id: newCommit },
    commits,
  }
}

export async function readSnapshotFile(
  repositoryPath: string,
  snapshot: SnapshotRef,
  filePath: string,
): Promise<string | null> {
  const root = await resolveRepository(repositoryPath)
  const normalizedPath = normalizeRepositoryFilePath(root, filePath)

  if (snapshot.kind === 'worktree') {
    return readFile(path.join(root, normalizedPath), 'utf8').catch(() => null)
  }

  const objectName = snapshot.kind === 'index' ? `:${normalizedPath}` : `${snapshot.id}:${normalizedPath}`
  const result = await runGit(root, ['show', objectName], true)
  return result.exitCode === 0 ? result.stdout : null
}

export async function validateAnnotationTarget(
  repositoryPath: string,
  review: ResolvedReview,
  filePath: string,
  side: 'old' | 'new',
  startLine: number,
  endLine: number,
): Promise<void> {
  const normalizedPath = validateReviewFilePath(review.patch, filePath)
  const file = filePathsFromPatch(review.patch).get(normalizedPath)!

  const snapshotPath = file[side]
  const contents = snapshotPath == null
    ? null
    : await readSnapshotFile(
        repositoryPath,
        side === 'old' ? review.oldSnapshot : review.newSnapshot,
        snapshotPath,
      )
  const lineCount = contents == null || contents === ''
    ? 0
    : contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0)
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine <= 0 ||
    endLine < startLine ||
    endLine > lineCount
  ) {
    throw new AppError(
      'ANNOTATION_LINE_NOT_FOUND',
      `${filePath}:${startLine}${endLine === startLine ? '' : `-${endLine}`} does not exist on the ${side} side of this diff`,
    )
  }
}

export function validateReviewFilePath(patch: string, filePath: string): string {
  const normalizedPath = filePath.replace(/^\.\//, '')
  if (!filePathsFromPatch(patch).has(normalizedPath)) {
    throw new AppError(
      'ANNOTATION_FILE_NOT_FOUND',
      `File is not part of this session's diff: ${filePath}`,
    )
  }
  return normalizedPath
}

export async function stageReviewFile(
  repositoryPath: string,
  patch: string,
  filePath: string,
): Promise<void> {
  const root = await resolveRepository(repositoryPath)
  const normalizedPath = validateReviewFilePath(patch, filePath)
  const file = filePathsFromPatch(patch).get(normalizedPath)!
  const paths = [...new Set([file.old, file.new])]
    .filter((candidate): candidate is string => candidate != null)
    .map((candidate) => normalizeRepositoryFilePath(root, candidate))
  await runGit(root, ['add', '--', ...paths])
}

async function resolveWorktree(root: string, ignoreWhitespace: boolean): Promise<ResolvedReview> {
  const head = await resolveCommit(root, 'HEAD')
  const trackedPatch = await gitDiff(root, ['HEAD'], ignoreWhitespace)
  const patch = trackedPatch + (await untrackedPatch(root, ignoreWhitespace))
  return {
    label: 'Working tree',
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} HEAD`,
    patch,
    oldSnapshot: { kind: 'commit', id: head },
    newSnapshot: { kind: 'worktree', id: contentId(patch) },
    commits: [],
  }
}

async function resolveUnstaged(root: string, ignoreWhitespace: boolean): Promise<ResolvedReview> {
  const patch = await gitDiff(root, [], ignoreWhitespace)
  const indexId = await indexTreeId(root)
  return {
    label: 'Unstaged changes',
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''}`,
    patch,
    oldSnapshot: { kind: 'index', id: indexId },
    newSnapshot: { kind: 'worktree', id: contentId(patch) },
    commits: [],
  }
}

async function resolveStaged(root: string, ignoreWhitespace: boolean): Promise<ResolvedReview> {
  const head = await resolveCommit(root, 'HEAD')
  const patch = await gitDiff(root, ['--cached'], ignoreWhitespace)
  return {
    label: 'Staged changes',
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} --cached`,
    patch,
    oldSnapshot: { kind: 'commit', id: head },
    newSnapshot: { kind: 'index', id: await indexTreeId(root) },
    commits: [],
  }
}

async function resolveRange(
  root: string,
  rawExpression: string,
  ignoreWhitespace: boolean,
): Promise<ResolvedReview> {
  const expression = rawExpression.trim()
  if (expression.length === 0 || /\s/.test(expression)) {
    throw new AppError('INVALID_RANGE', 'Revision range must be one Git revision expression without spaces')
  }

  let baseRevision: string
  let headRevision: string
  let label: string

  if (expression.includes('...')) {
    const [left, right, extra] = expression.split('...')
    if (extra != null || !left || !right) {
      throw new AppError('INVALID_RANGE', `Invalid merge-base range: ${expression}`)
    }
    const leftOid = await resolveCommit(root, left)
    headRevision = await resolveCommit(root, right)
    baseRevision = (await runGit(root, ['merge-base', leftOid, headRevision])).stdout.trim()
    label = expression
  } else if (expression.includes('..')) {
    const [left, right, extra] = expression.split('..')
    if (extra != null || !left || !right) {
      throw new AppError('INVALID_RANGE', `Invalid revision range: ${expression}`)
    }
    baseRevision = await resolveCommit(root, left)
    headRevision = await resolveCommit(root, right)
    label = expression
  } else {
    return resolveCommitSpan(root, expression, expression, ignoreWhitespace)
  }

  return {
    label,
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} ${shellQuote(label)}`,
    patch: await gitDiff(root, [baseRevision, headRevision], ignoreWhitespace),
    oldSnapshot: { kind: 'commit', id: baseRevision },
    newSnapshot: { kind: 'commit', id: headRevision },
    commits: await listCommits(root, baseRevision, headRevision),
  }
}

async function resolvePullRequest(
  root: string,
  number: number,
  ignoreWhitespace: boolean,
): Promise<ResolvedReview> {
  if (!Number.isInteger(number) || number <= 0) {
    throw new AppError('INVALID_PULL_REQUEST', `Invalid pull request number: ${number}`)
  }

  const details = await pullRequestDetails(root, number)
  await ensureCommitAvailable(root, details.baseRefOid, details.baseRefName)
  await ensurePullRequestHeadAvailable(root, number, details.headRefOid)
  const base = (
    await runGit(root, ['merge-base', details.baseRefOid, details.headRefOid])
  ).stdout.trim()

  return {
    label: `PR #${number} · ${details.title}`,
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} ${shellQuote(`${details.baseRefOid}...${details.headRefOid}`)}`,
    patch: await gitDiff(root, [base, details.headRefOid], ignoreWhitespace),
    oldSnapshot: { kind: 'commit', id: base },
    newSnapshot: { kind: 'commit', id: details.headRefOid },
    commits: await listCommits(root, base, details.headRefOid),
  }
}

async function resolveDefaultBranch(root: string): Promise<string | null> {
  const symbolic = await runGit(
    root,
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    true,
  )
  if (symbolic.exitCode === 0 && symbolic.stdout.trim()) return symbolic.stdout.trim()

  for (const candidate of ['origin/main', 'origin/master']) {
    const exists = await runGit(root, ['rev-parse', '--verify', '--quiet', candidate], true)
    if (exists.exitCode === 0) return candidate
  }
  return null
}

async function listPullRequests(root: string): Promise<PullRequestSummary[]> {
  const result = await runCommand(
    'gh',
    [
      'pr',
      'list',
      '--limit',
      '20',
      '--json',
      'number,title,baseRefName,headRefName',
    ],
    root,
    true,
  )
  if (result.exitCode !== 0) return []
  try {
    return JSON.parse(result.stdout) as PullRequestSummary[]
  } catch {
    return []
  }
}

async function pullRequestDetails(root: string, number: number): Promise<PullRequestDetails> {
  const result = await runCommand(
    'gh',
    [
      'pr',
      'view',
      String(number),
      '--json',
      'number,title,url,baseRefName,headRefName,baseRefOid,headRefOid',
    ],
    root,
  )
  try {
    return JSON.parse(result.stdout) as PullRequestDetails
  } catch (error) {
    throw new AppError(
      'GITHUB_RESPONSE_INVALID',
      `Could not parse GitHub PR #${number}: ${errorMessage(error)}`,
    )
  }
}

async function ensureCommitAvailable(root: string, oid: string, fallbackRef: string): Promise<void> {
  if (await hasCommit(root, oid)) return
  await runGit(root, ['fetch', '--no-tags', 'origin', fallbackRef])
  if (!(await hasCommit(root, oid))) {
    throw new AppError('GIT_OBJECT_MISSING', `Could not fetch commit ${oid}`)
  }
}

async function ensurePullRequestHeadAvailable(
  root: string,
  number: number,
  oid: string,
): Promise<void> {
  if (await hasCommit(root, oid)) return
  await runGit(root, ['fetch', '--no-tags', 'origin', `refs/pull/${number}/head`])
  if (!(await hasCommit(root, oid))) {
    throw new AppError('GIT_OBJECT_MISSING', `Could not fetch head for PR #${number}`)
  }
}

async function hasCommit(root: string, oid: string): Promise<boolean> {
  return (
    await runGit(root, ['cat-file', '-e', `${oid}^{commit}`], true)
  ).exitCode === 0
}

async function resolveCommit(root: string, revision: string): Promise<string> {
  const result = await runGit(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`],
    true,
  )
  if (result.exitCode !== 0) {
    throw new AppError('REVISION_NOT_FOUND', `Git revision not found: ${revision}`)
  }
  return result.stdout.trim()
}

async function firstParentOrEmptyTree(root: string, revision: string): Promise<string> {
  const parent = await runGit(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${revision}^`],
    true,
  )
  if (parent.exitCode === 0) return parent.stdout.trim()
  return (await runGit(root, ['hash-object', '-t', 'tree', '/dev/null'])).stdout.trim()
}

async function listCommits(
  root: string,
  oldRevision: string,
  newRevision: string,
): Promise<CommitSummary[]> {
  const result = await runGit(root, [
    'log',
    '--first-parent',
    '--reverse',
    '--date=iso-strict',
    '--format=%H%x00%h%x00%s%x00%an%x00%aI%x1e',
    `${oldRevision}..${newRevision}`,
  ])

  return result.stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [oid, abbreviated, subject, author, authoredAt] = record.split('\x00')
      return {
        oid: oid ?? '',
        shortOid: abbreviated ?? '',
        subject: subject ?? '',
        author: author ?? '',
        authoredAt: authoredAt ?? '',
      }
    })
}

async function gitDiff(
  root: string,
  args: string[],
  ignoreWhitespace: boolean,
): Promise<string> {
  return (
    await runGit(root, [
      ...DIFF_ARGS,
      ...(ignoreWhitespace ? ['--ignore-all-space'] : []),
      ...args,
      '--',
    ])
  ).stdout
}

async function untrackedPatch(root: string, ignoreWhitespace: boolean): Promise<string> {
  const files = (
    await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ).stdout
    .split('\0')
    .filter(Boolean)

  let patch = ''
  for (const file of files) {
    const result = await runGit(
      root,
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-index',
        '--binary',
        '--full-index',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        ...(ignoreWhitespace ? ['--ignore-all-space'] : []),
        '--',
        '/dev/null',
        file,
      ],
      true,
    )
    if (result.exitCode > 1) {
      throw new AppError('GIT_DIFF_FAILED', result.stderr.trim() || `Could not diff ${file}`)
    }
    patch += result.stdout
  }
  return patch
}

async function indexTreeId(root: string): Promise<string> {
  const result = await runGit(root, ['write-tree'], true)
  return result.exitCode === 0 ? result.stdout.trim() : contentId('index')
}

function filePathsFromPatch(
  patch: string,
): Map<string, { old: string | null; new: string | null }> {
  const files = new Map<string, { old: string | null; new: string | null }>()
  let oldPath: string | null = null

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = null
      continue
    }
    if (line.startsWith('--- ')) {
      const rawPath = line.slice(4).split('\t')[0] ?? ''
      const parsedPath = stripPatchPrefix(rawPath)
      oldPath = parsedPath === '/dev/null' ? null : parsedPath
      continue
    }
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).split('\t')[0] ?? ''
      const parsedPath = stripPatchPrefix(rawPath)
      const newPath = parsedPath === '/dev/null' ? null : parsedPath
      const file = { old: oldPath, new: newPath }
      if (oldPath != null) files.set(oldPath, file)
      if (newPath != null) files.set(newPath, file)
    }
  }
  return files
}

function stripPatchPrefix(filePath: string): string {
  if (filePath === '/dev/null') return filePath
  return filePath.replace(/^[ab]\//, '')
}

function normalizeRepositoryFilePath(root: string, filePath: string): string {
  const normalizedPath = filePath.replace(/^\.\//, '')
  const absolutePath = path.resolve(root, normalizedPath)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new AppError('INVALID_FILE_PATH', `File is outside the repository: ${filePath}`)
  }
  return path.relative(root, absolutePath)
}

async function runGit(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<CommandResult> {
  return runCommand('git', args, cwd, allowFailure)
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowFailure = false,
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
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
        reject(new AppError('COMMAND_OUTPUT_TOO_LARGE', `${command} output exceeded 128 MiB`))
        return
      }
      target.push(chunk)
    }

    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.on('error', (error) => reject(error))
    child.on('close', (exitCode) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? 1,
      })
    })
  }).catch((error: unknown) => {
    if (error instanceof AppError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('COMMAND_NOT_FOUND', `Required command not found: ${command}`)
    }
    throw error
  })

  if (!allowFailure && result.exitCode !== 0) {
    throw new AppError(
      command === 'git' ? 'GIT_COMMAND_FAILED' : 'COMMAND_FAILED',
      result.stderr.trim() || `${command} exited with ${result.exitCode}`,
      400,
      { command, args, exitCode: result.exitCode },
    )
  }
  return result
}

function contentId(contents: string): string {
  return createHash('sha256').update(contents).digest('hex')
}

function shortOid(oid: string): string {
  return oid.slice(0, 8)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
