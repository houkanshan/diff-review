import { createHash, randomUUID } from 'node:crypto'
import { runCommand } from './command.js'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  type CommitSummary,
  isLiveReviewTarget,
  type RepositoryInfo,
  type ReviewTarget,
  targetSupportsIndexChanges,
} from '../shared/types.js'
import { AppError } from './errors.js'
import {
  getPullRequestRevisionDetails,
  type PullRequestRevisionDetails,
} from './github.js'

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
  unstagedPaths?: string[]
  stagedPaths?: string[]
  fingerprint?: string
  liveHeadOid?: string
}


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

  return {
    root,
    name: path.basename(root),
    branch,
    defaultBranchRef,
    branchRange: defaultBranchRef == null ? null : `${defaultBranchRef}...HEAD`,
  }
}

export async function resolveTarget(
  repositoryPath: string,
  target: ReviewTarget,
  ignoreWhitespace = false,
): Promise<ResolvedReview> {
  const root = await resolveRepository(repositoryPath)
  if (!isLiveReviewTarget(target)) {
    return finalizeResolvedReview(root, target, await resolveTargetOnce(root, target, ignoreWhitespace))
  }

  let headOid = await resolveCommit(root, 'HEAD')
  let resolved = await resolveTargetOnce(root, target, ignoreWhitespace)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headAfter = await resolveCommit(root, 'HEAD')
    if (headAfter === headOid) {
      resolved.liveHeadOid = headOid
      return finalizeResolvedReview(root, target, resolved)
    }
    headOid = headAfter
    resolved = await resolveTargetOnce(root, target, ignoreWhitespace)
  }
  resolved.liveHeadOid = headOid
  return finalizeResolvedReview(root, target, resolved)
}

async function resolveTargetOnce(
  root: string,
  target: ReviewTarget,
  ignoreWhitespace: boolean,
): Promise<ResolvedReview> {
  switch (target.kind) {
    case 'worktree':
      return resolveWorktree(root, ignoreWhitespace)
    case 'branch-worktree':
      return resolveBranchWorktree(root, ignoreWhitespace)
    case 'unstaged':
      return resolveUnstaged(root, ignoreWhitespace)
    case 'staged':
      return resolveStaged(root, ignoreWhitespace)
    case 'range':
      return resolveRange(root, target.expression, ignoreWhitespace)
    case 'pr': {
      const details = await getPullRequestRevisionDetails(root, target.number)
      return resolvePullRequestRevision(root, details, ignoreWhitespace)
    }
  }
}

async function finalizeResolvedReview(
  root: string,
  target: ReviewTarget,
  resolved: ResolvedReview,
): Promise<ResolvedReview> {
  if (targetSupportsIndexChanges(target)) {
    const [unstagedPaths, stagedPaths] = await Promise.all([
      listUnstagedPaths(root),
      listStagedPaths(root),
    ])
    resolved.unstagedPaths = unstagedPaths
    resolved.stagedPaths = stagedPaths
  }
  resolved.fingerprint = await computeReviewFingerprint(root, target)
  return resolved
}

export function storedReviewFingerprint(resolved: ResolvedReview): string | null {
  if (resolved.fingerprint != null && resolved.fingerprint.length > 0) return resolved.fingerprint
  if (resolved.oldSnapshot.kind === 'commit' && resolved.newSnapshot.kind === 'commit') {
    return `range:${resolved.oldSnapshot.id}:${resolved.newSnapshot.id}`
  }
  if (resolved.oldSnapshot.kind === 'commit' && resolved.newSnapshot.kind === 'index') {
    return `staged:${resolved.oldSnapshot.id}:${resolved.newSnapshot.id}`
  }
  return null
}

export async function computeReviewFingerprint(
  repositoryPath: string,
  target: ReviewTarget,
): Promise<string> {
  const root = await resolveRepository(repositoryPath)
  switch (target.kind) {
    case 'range':
      return rangeFingerprint(root, target.expression)
    case 'pr':
      return `pr:${target.number}`
    case 'staged': {
      const head = await resolveCommit(root, 'HEAD')
      return `staged:${head}:${await indexTreeId(root)}`
    }
    case 'unstaged':
      return `unstaged:${await indexTreeId(root)}:${await worktreeContentDigest(root)}`
    case 'worktree': {
      const head = await resolveCommit(root, 'HEAD')
      return `worktree:${head}:${await indexTreeId(root)}:${await worktreeContentDigest(root)}`
    }
    case 'branch-worktree': {
      const defaultBranch = await resolveDefaultBranch(root)
      const head = await resolveCommit(root, 'HEAD')
      const base =
        defaultBranch == null
          ? ''
          : (await runGit(root, ['merge-base', defaultBranch, head])).stdout.trim()
      return `branch-worktree:${base}:${head}:${await indexTreeId(root)}:${await worktreeContentDigest(root)}`
    }
  }
}

export async function rerenderCommitReview(
  repositoryPath: string,
  resolved: ResolvedReview,
  ignoreWhitespace: boolean,
): Promise<ResolvedReview> {
  if (resolved.oldSnapshot.kind !== 'commit' || resolved.newSnapshot.kind !== 'commit') {
    throw new AppError(
      'INVALID_REVIEW_TARGET',
      'Only reviews pinned to commit snapshots can be re-rendered',
    )
  }
  const root = await resolveRepository(repositoryPath)
  const oldCommit = await resolveCommit(root, resolved.oldSnapshot.id)
  const newCommit = await resolveCommit(root, resolved.newSnapshot.id)
  return {
    ...resolved,
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} ${shellQuote(oldCommit)} ${shellQuote(newCommit)}`,
    patch: await gitDiff(root, [oldCommit, newCommit], ignoreWhitespace),
    oldSnapshot: { kind: 'commit', id: oldCommit },
    newSnapshot: { kind: 'commit', id: newCommit },
  }
}

export async function resolvePinnedCommitDiff(
  repositoryPath: string,
  oldRevision: string,
  newRevision: string,
  ignoreWhitespace = false,
): Promise<ResolvedReview> {
  const root = await resolveRepository(repositoryPath)
  const oldCommit = await resolveCommit(root, oldRevision)
  const newCommit = await resolveCommit(root, newRevision)
  const patch = await gitDiff(root, [oldCommit, newCommit], ignoreWhitespace)
  return {
    label: `${shortOid(oldCommit)}…${shortOid(newCommit)}`,
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} ${shellQuote(oldCommit)} ${shellQuote(newCommit)}`,
    patch,
    oldSnapshot: { kind: 'commit', id: oldCommit },
    newSnapshot: { kind: 'commit', id: newCommit },
    commits: await listCommits(root, oldCommit, newCommit),
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
export function reviewFileSides(
  patch: string,
  filePath: string,
): { old: string | null; new: string | null } {
  const normalizedPath = validateReviewFilePath(patch, filePath)
  return filePathsFromPatch(patch).get(normalizedPath)!
}


export async function setReviewFilesStaged(
  repositoryPath: string,
  patch: string,
  filePaths: string[],
  staged: boolean,
): Promise<void> {
  const root = await resolveRepository(repositoryPath)
  const patchFiles = filePathsFromPatch(patch)
  const paths = [...new Set(filePaths.flatMap((filePath) => {
    const normalizedPath = validateReviewFilePath(patch, filePath)
    const file = patchFiles.get(normalizedPath)!
    return [file.old, file.new]
  }))]
    .filter((candidate): candidate is string => candidate != null)
    .map((candidate) => normalizeRepositoryFilePath(root, candidate))
  if (paths.length === 0) return

  if (staged) {
    await runGit(root, ['add', '--', ...paths])
    return
  }

  const hasHead = (await runGit(root, ['rev-parse', '--verify', 'HEAD'], true)).exitCode === 0
  await runGit(root, hasHead
    ? ['reset', '-q', 'HEAD', '--', ...paths]
    : ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...paths])
}

const worktreeFileWriteQueues = new Map<string, Promise<void>>()

export async function writeReviewWorktreeFile(
  repositoryPath: string,
  patch: string,
  filePath: string,
  contents: string,
  expectedContents: string,
): Promise<void> {
  const root = await resolveRepository(repositoryPath)
  const normalizedPath = validateReviewFilePath(patch, filePath)
  const newPath = filePathsFromPatch(patch).get(normalizedPath)!.new
  if (newPath == null) {
    throw new AppError('INVALID_FILE_PATH', `Deleted files cannot be edited: ${filePath}`)
  }

  const worktreePath = path.join(root, normalizeRepositoryFilePath(root, newPath))
  const pathMetadata = await lstat(worktreePath).catch(() => null)
  if (pathMetadata == null || pathMetadata.isSymbolicLink()) {
    throw new AppError('INVALID_FILE_PATH', `Only regular worktree files can be edited: ${filePath}`)
  }
  const canonicalPath = await realpath(worktreePath).catch(() => null)
  if (
    canonicalPath == null ||
    (canonicalPath !== root && !canonicalPath.startsWith(`${root}${path.sep}`))
  ) {
    throw new AppError('INVALID_FILE_PATH', `File resolves outside the repository: ${filePath}`)
  }

  const previousWrite = worktreeFileWriteQueues.get(canonicalPath) ?? Promise.resolve()
  const currentWrite = previousWrite.catch(() => undefined).then(async () => {
    const metadata = await lstat(canonicalPath).catch(() => null)
    if (metadata == null || !metadata.isFile()) {
      throw new AppError('INVALID_FILE_PATH', `Only regular worktree files can be edited: ${filePath}`)
    }

    const currentBytes = await readFile(canonicalPath)
    const currentContents = currentBytes.toString('utf8')
    if (!Buffer.from(currentContents, 'utf8').equals(currentBytes)) {
      throw new AppError('INVALID_FILE_CONTENT', `Only UTF-8 text files can be edited: ${filePath}`)
    }
    if (currentContents !== expectedContents) {
      throw new AppError(
        'FILE_CHANGED',
        `File changed outside Diff Review: ${filePath}`,
        409,
      )
    }

    const temporaryPath = path.join(
      path.dirname(canonicalPath),
      `.${path.basename(canonicalPath)}.diff-review-${randomUUID()}`,
    )
    try {
      await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: metadata.mode })
      await rename(temporaryPath, canonicalPath)
    } finally {
      await rm(temporaryPath, { force: true })
    }
  })
  worktreeFileWriteQueues.set(canonicalPath, currentWrite)
  try {
    await currentWrite
  } finally {
    if (worktreeFileWriteQueues.get(canonicalPath) === currentWrite) {
      worktreeFileWriteQueues.delete(canonicalPath)
    }
  }
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

async function resolveBranchWorktree(
  root: string,
  ignoreWhitespace: boolean,
): Promise<ResolvedReview> {
  const defaultBranch = await resolveDefaultBranch(root)
  if (defaultBranch == null) {
    throw new AppError(
      'INVALID_REVIEW_TARGET',
      'Could not find an origin default branch for the current branch review',
    )
  }

  const head = await resolveCommit(root, 'HEAD')
  const base = (await runGit(root, ['merge-base', defaultBranch, head])).stdout.trim()
  const trackedPatch = await gitDiff(root, [base], ignoreWhitespace)
  const patch = trackedPatch + (await untrackedPatch(root, ignoreWhitespace))
  return {
    label: 'Current branch + working tree',
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} --merge-base ${shellQuote(defaultBranch)}`,
    patch,
    oldSnapshot: { kind: 'commit', id: base },
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

export async function listMergeConflictFiles(
  root: string,
  baseOid: string,
  headOid: string,
): Promise<string[]> {
  const result = await runGit(
    root,
    [
      '-c',
      'core.quotePath=false',
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      baseOid,
      headOid,
    ],
    true,
  )
  if (result.exitCode === 0) return []
  if (result.exitCode !== 1) return []
  const [treeOid, ...paths] = splitNullPaths(result.stdout)
  if (treeOid == null || treeOid.length === 0) return []
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right))
}

export async function resolvePullRequestRevision(
  root: string,
  details: PullRequestRevisionDetails,
  ignoreWhitespace: boolean,
): Promise<ResolvedReview> {
  const number = details.number
  if (!Number.isInteger(number) || number <= 0) {
    throw new AppError('INVALID_PULL_REQUEST', `Invalid pull request number: ${number}`)
  }

  await ensureCommitAvailable(root, details.baseRefOid, details.baseRefName)
  await ensurePullRequestHeadAvailable(root, number, details.headRefOid)
  const base = (
    await runGit(root, ['merge-base', details.baseRefOid, details.headRefOid])
  ).stdout.trim()
  await pinPullRequestRevision(root, number, base, details.headRefOid)

  return {
    label: `PR #${number} · ${details.title}`,
    gitCommand: `git diff${ignoreWhitespace ? ' --ignore-all-space' : ''} ${shellQuote(`${details.baseRefOid}...${details.headRefOid}`)}`,
    patch: await gitDiff(root, [base, details.headRefOid], ignoreWhitespace),
    oldSnapshot: { kind: 'commit', id: base },
    newSnapshot: { kind: 'commit', id: details.headRefOid },
    commits: await listCommits(root, base, details.headRefOid),
    fingerprint: `pr:${number}`,
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

async function pinPullRequestRevision(
  root: string,
  number: number,
  baseOid: string,
  headOid: string,
): Promise<void> {
  const key = contentId(`${baseOid}\0${headOid}`).slice(0, 16)
  const prefix = `refs/diff-review/pull-requests/${number}/${key}`
  await runGit(root, ['update-ref', `${prefix}/base`, baseOid])
  await runGit(root, ['update-ref', `${prefix}/head`, headOid])
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

export async function resolveCommit(root: string, revision: string): Promise<string> {
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
  const files = splitNullPaths(
    (await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout,
  )

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

async function rangeFingerprint(root: string, rawExpression: string): Promise<string> {
  const expression = rawExpression.trim()
  if (expression.length === 0 || /\s/.test(expression)) {
    throw new AppError('INVALID_RANGE', 'Revision range must be one Git revision expression without spaces')
  }

  if (expression.includes('...')) {
    const [left, right, extra] = expression.split('...')
    if (extra != null || !left || !right) {
      throw new AppError('INVALID_RANGE', `Invalid merge-base range: ${expression}`)
    }
    const leftOid = await resolveCommit(root, left)
    const headRevision = await resolveCommit(root, right)
    const baseRevision = (await runGit(root, ['merge-base', leftOid, headRevision])).stdout.trim()
    return `range:${baseRevision}:${headRevision}`
  }

  if (expression.includes('..')) {
    const [left, right, extra] = expression.split('..')
    if (extra != null || !left || !right) {
      throw new AppError('INVALID_RANGE', `Invalid revision range: ${expression}`)
    }
    return `range:${await resolveCommit(root, left)}:${await resolveCommit(root, right)}`
  }

  const headRevision = await resolveCommit(root, expression)
  const baseRevision = await firstParentOrEmptyTree(root, expression)
  return `range:${baseRevision}:${headRevision}`
}

async function worktreeContentDigest(root: string): Promise<string> {
  const paths = splitNullPaths(
    (
      await runGit(root, [
        '-c',
        'core.quotePath=false',
        'ls-files',
        '-z',
        '-m',
        '-d',
        '-o',
        '--exclude-standard',
      ])
    ).stdout,
  )
  const parts = await Promise.all(
    paths.map(async (file) => {
      const hashed = await runGit(root, ['hash-object', '--', file], true)
      const digest = hashed.exitCode === 0 ? hashed.stdout.trim() : 'missing'
      const mode = await worktreeFileMode(root, file)
      return `${file}:${mode}:${digest}`
    }),
  )
  parts.sort()
  return contentId(parts.join('\n'))
}

async function worktreeFileMode(root: string, file: string): Promise<string> {
  try {
    return ((await lstat(path.join(root, file))).mode & 0o777).toString(8)
  } catch {
    return 'missing'
  }
}

async function listUnstagedPaths(root: string): Promise<string[]> {
  const tracked = await runGit(root, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z'], true)
  const untracked = await runGit(
    root,
    ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'],
    true,
  )
  return [...new Set([...splitNullPaths(tracked.stdout), ...splitNullPaths(untracked.stdout)])]
}

async function listStagedPaths(root: string): Promise<string[]> {
  const staged = await runGit(
    root,
    ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '-z'],
    true,
  )
  return splitNullPaths(staged.stdout)
}

function splitNullPaths(value: string): string[] {
  return value.split('\0').filter((entry) => entry.length > 0)
}

async function indexTreeId(root: string): Promise<string> {
  const result = await runGit(root, ['write-tree'], true)
  return result.exitCode === 0 ? result.stdout.trim() : contentId('index')
}

function filePathsFromPatch(
  patch: string,
): Map<string, { old: string | null; new: string | null }> {
  const files = new Map<string, { old: string | null; new: string | null }>()
  let current: { old: string | null; new: string | null } | null = null
  const addCurrent = () => {
    if (current == null) return
    if (current.old != null) files.set(current.old, current)
    if (current.new != null) files.set(current.new, current)
  }

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      addCurrent()
      const match = line.match(
        /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+?))$/,
      )
      current = match == null
        ? { old: null, new: null }
        : { old: match[1] ?? match[2] ?? null, new: match[3] ?? match[4] ?? null }
      continue
    }
    if (line.startsWith('new file mode ')) {
      if (current != null) current.old = null
      continue
    }
    if (line.startsWith('deleted file mode ')) {
      if (current != null) current.new = null
      continue
    }
    if (line.startsWith('rename from ')) {
      if (current != null) current.old = line.slice('rename from '.length)
      continue
    }
    if (line.startsWith('rename to ')) {
      if (current != null) current.new = line.slice('rename to '.length)
      continue
    }
    if (line.startsWith('--- ')) {
      const rawPath = line.slice(4).split('\t')[0] ?? ''
      const parsedPath = stripPatchPrefix(rawPath)
      current ??= { old: null, new: null }
      current.old = parsedPath === '/dev/null' ? null : parsedPath
      continue
    }
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).split('\t')[0] ?? ''
      const parsedPath = stripPatchPrefix(rawPath)
      current ??= { old: null, new: null }
      current.new = parsedPath === '/dev/null' ? null : parsedPath
    }
  }
  addCurrent()
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runCommand('git', args, cwd, allowFailure)
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
