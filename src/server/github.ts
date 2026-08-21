import { spawn } from 'node:child_process'

import type {
  DiffSide,
  GitHubLabel,
  GitHubIssueReference,
  GitHubReviewer,
  GitHubUser,
  PullRequestActivity,
  PullRequestCheckRun,
  PullRequestCheckStatus,
  PullRequestDetails,
  PullRequestMergeable,
  PullRequestReviewEvent,
  PullRequestListResponse,
  PullRequestListView,
  PullRequestState,
  PullRequestSummary,
  MinimizedCommentReason,
  SessionAnnotation,
} from '../shared/types.js'
import {
  extractIssueReferenceTargets,
  type GitHubIssueReferenceTarget,
} from '../shared/markdown.js'
import { AppError, errorMessage } from './errors.js'

export interface PullRequestRevisionDetails {
  number: number
  title: string
  url: string
  state: PullRequestState
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
  'reviewRequests',
  'latestReviews',
  'labels',
].join(',')

const DETAILS_FIELDS = [
  SUMMARY_FIELDS,
  'statusCheckRollup',
  'body',
  'baseRefOid',
  'headRefOid',
  'comments',
  'reviews',
  'mergeable',
  'mergedBy',
].join(',')


const MINIMIZED_COMMENTS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        comments(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { databaseId isMinimized minimizedReason }
        }
        reviewThreads(first: 100) {
          nodes {
            comments(first: 100) {
              nodes { databaseId isMinimized minimizedReason }
            }
          }
        }
      }
    }
  }
`.trim()
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024
type GitHubCommandKind = 'read' | 'page' | 'mutate'
const GITHUB_COMMAND_TIMEOUT_MS = {
  read: 15_000,
  page: 45_000,
  mutate: 90_000,
} as const
type ResolvedIssueReference = Omit<GitHubIssueReference, 'token' | 'label'>
type ResolvedIssueReferenceTarget = GitHubIssueReferenceTarget & { owner: string; repository: string }

const issueReferenceCache = new Map<string, Promise<ResolvedIssueReference | null>>()
const PULL_REQUEST_LIST_TTL_MS = 60_000
const repositoryKeyByRoot = new Map<string, string>()
let pullRequestListEpoch = 0
const pullRequestListInflight = new Map<string, Promise<PullRequestSummary[]>>()
const pullRequestListCache = new Map<string, {
  items: PullRequestSummary[]
  fetchedAt: number
}>()

function issueReferenceKey(reference: { owner: string; repository: string; number: number }): string {
  return `${reference.owner.toLowerCase()}/${reference.repository.toLowerCase()}#${reference.number}`
}

function listCacheKey(repositoryKey: string, view: PullRequestListView): string {
  return `${repositoryKey}:${view}`
}

function listResponse(
  items: PullRequestSummary[],
  fetchedAt: number,
  stale: boolean,
): PullRequestListResponse {
  return { items, fetchedAt: new Date(fetchedAt).toISOString(), stale }
}

function rememberRepositoryKey(root: string, repositoryKey: string): void {
  repositoryKeyByRoot.set(root, repositoryKey)
}

function repositoryKeyFromSummaries(summaries: PullRequestSummary[]): string | null {
  if (summaries[0] == null) return null
  try {
    const repository = parseGitHubRepositoryUrl(summaries[0].url)
    return `${repository.owner}/${repository.name}`.toLowerCase()
  } catch {
    return null
  }
}

async function githubRepositoryKey(root: string): Promise<string | null> {
  const cached = repositoryKeyByRoot.get(root)
  if (cached != null) return cached
  try {
    const output = await runGitHub(['repo', 'view', '--json', 'nameWithOwner'], root)
    const nameWithOwner = expectString(
      expectObject(parseJson(output, 'GitHub repository')).nameWithOwner,
      'nameWithOwner',
    )
    const key = nameWithOwner.toLowerCase()
    rememberRepositoryKey(root, key)
    return key
  } catch {
    return null
  }
}

function deletePullRequestListCache(repositoryKey: string): void {
  for (const view of ['open', 'additional-review', 'merged'] as const) {
    pullRequestListCache.delete(listCacheKey(repositoryKey, view))
    pullRequestListInflight.delete(listCacheKey(repositoryKey, view))
  }
}

export async function invalidatePullRequestListCache(root: string): Promise<void> {
  pullRequestListEpoch += 1
  const repositoryKey = await githubRepositoryKey(root)
  if (repositoryKey == null) return
  deletePullRequestListCache(repositoryKey)
}

export function resetPullRequestListCache(): void {
  repositoryKeyByRoot.clear()
  pullRequestListEpoch = 0
  pullRequestListInflight.clear()
  pullRequestListCache.clear()
}

export function expirePullRequestListCache(): void {
  for (const [key, entry] of pullRequestListCache) {
    pullRequestListCache.set(key, { items: entry.items, fetchedAt: 1 })
  }
}

export async function listPullRequests(
  root: string,
  view: PullRequestListView,
  options?: { fresh?: boolean },
): Promise<PullRequestListResponse> {
  const repositoryKey = await githubRepositoryKey(root)
  const cacheKey = repositoryKey == null ? null : listCacheKey(repositoryKey, view)
  const entry = cacheKey == null ? undefined : pullRequestListCache.get(cacheKey)
  if (options?.fresh !== true && entry != null) {
    const stale = Date.now() - entry.fetchedAt >= PULL_REQUEST_LIST_TTL_MS
    if (stale) {
      void refreshPullRequestList(root, view, repositoryKey).catch((error: unknown) => {
        console.error(`diff-review: could not refresh pull request list: ${errorMessage(error)}`)
      })
    }
    return listResponse(entry.items, entry.fetchedAt, stale)
  }
  const items = await refreshPullRequestList(root, view, repositoryKey)
  const resolvedKey = repositoryKey ?? await githubRepositoryKey(root)
  const fetchedAt = resolvedKey == null
    ? Date.now()
    : pullRequestListCache.get(listCacheKey(resolvedKey, view))?.fetchedAt ?? Date.now()
  return listResponse(items, fetchedAt, false)
}

async function refreshPullRequestList(
  root: string,
  view: PullRequestListView,
  repositoryKey: string | null,
): Promise<PullRequestSummary[]> {
  const inflightKey = repositoryKey == null ? `pending:${root}:${view}` : listCacheKey(repositoryKey, view)
  const existing = pullRequestListInflight.get(inflightKey)
  if (existing != null) return existing
  const epoch = pullRequestListEpoch
  const inflight = loadPullRequestSummaries(root, view, repositoryKey).then((items) => {
    const resolvedKey = repositoryKeyFromSummaries(items) ?? repositoryKey
    if (resolvedKey != null) rememberRepositoryKey(root, resolvedKey)
    if (resolvedKey != null && epoch === pullRequestListEpoch) {
      pullRequestListCache.set(listCacheKey(resolvedKey, view), {
        items,
        fetchedAt: Date.now(),
      })
    }
    return items
  }).finally(() => {
    if (pullRequestListInflight.get(inflightKey) === inflight) {
      pullRequestListInflight.delete(inflightKey)
    }
  })
  pullRequestListInflight.set(inflightKey, inflight)
  return inflight
}

async function loadPullRequestSummaries(
  root: string,
  view: PullRequestListView,
  repositoryKey: string | null,
): Promise<PullRequestSummary[]> {
  const key = repositoryKey ?? await githubRepositoryKey(root)
  if (key == null) {
    throw new AppError('GITHUB_COMMAND_FAILED', 'Could not resolve GitHub repository', 400)
  }
  const separator = key.indexOf('/')
  const owner = key.slice(0, separator)
  const name = key.slice(separator + 1)
  const output = await runGitHub(['api', 'graphql', '-f', `query=${pullRequestListQuery(owner, name, view)}`], root)
  const response = expectObject(parseJson(output, 'GitHub pull request list'))
  const nodes = expectArray(
    optionalObject(optionalObject(optionalObject(response.data)?.repository)?.pullRequests)?.nodes,
  )
  return nodes.map(parseGraphQLPullRequestListNode)
}

function pullRequestListQuery(
  owner: string,
  name: string,
  view: PullRequestListView,
): string {
  const filter = pullRequestListFilter(view)
  const states = filter.state === 'open'
    ? '[OPEN]'
    : filter.state === 'merged'
      ? '[MERGED]'
      : '[OPEN, CLOSED, MERGED]'
  const labels = filter.label == null ? '' : `, labels: ${JSON.stringify([filter.label])}`
  return `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    pullRequests(first: 20, states: ${states}${labels}, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes {
        number title url state isDraft baseRefName headRefName additions deletions createdAt updatedAt
        author { login name }
        assignees(first: 100) { nodes { login name } }
        reviewRequests(first: 100) {
          nodes { requestedReviewer { __typename ... on User { login name } ... on Team { slug name } } }
        }
        latestReviews(first: 100) { nodes { author { login name } } }
        labels(first: 100) { nodes { name color } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  } }`
}

function parseGraphQLPullRequestListNode(value: unknown): PullRequestSummary {
  const raw = expectObject(value)
  return parsePullRequestSummary({
    ...raw,
    assignees: expectArray(optionalObject(raw.assignees)?.nodes),
    reviewRequests: expectArray(optionalObject(raw.reviewRequests)?.nodes).flatMap((request) => {
      const reviewer = optionalObject(request)?.requestedReviewer
      return reviewer == null ? [] : [reviewer]
    }),
    latestReviews: expectArray(optionalObject(raw.latestReviews)?.nodes),
    labels: expectArray(optionalObject(raw.labels)?.nodes),
  }, parseCheckRollupState(checkRollupState(raw)))
}

export async function getPullRequestDetails(
  root: string,
  number: number,
): Promise<PullRequestDetails> {
  validatePullRequestNumber(number)
  const [detailsOutput, reviewsOutput, reviewCommentsOutput, timelineOutput] = await Promise.all([
    runGitHub(['pr', 'view', String(number), '--json', DETAILS_FIELDS], root),
    runGitHub(
      [
        'api',
        `repos/{owner}/{repo}/pulls/${number}/reviews?per_page=100`,
        '--paginate',
        '--slurp',
      ],
      root,
      undefined,
      'page',
    ),
    runGitHub(
      [
        'api',
        `repos/{owner}/{repo}/pulls/${number}/comments?per_page=100`,
        '--paginate',
        '--slurp',
      ],
      root,
      undefined,
      'page',
    ),
    runGitHub(
      [
        'api',
        `repos/{owner}/{repo}/issues/${number}/timeline?per_page=100&exclude=commented%2Creviewed`,
        '--paginate',
        '--slurp',
      ],
      root,
      undefined,
      'page',
    ),
  ])
  const raw = expectObject(parseJson(detailsOutput, `GitHub PR #${number}`))
  const summary = parsePullRequestSummary(raw)
  const body = optionalString(raw.body) ?? ''
  const activity = [
    ...expectArray(raw.comments).map(parseConversationComment),
    ...parsePaginatedArray(
      parseJson(reviewsOutput, `GitHub PR #${number} reviews`),
    ).flatMap((value) => {
      const rawReview = expectObject(value)
      if ((optionalString(rawReview.state) ?? '').toUpperCase() === 'PENDING') return []
      return [parseReview(rawReview)]
    }),
    ...parsePaginatedArray(
      parseJson(reviewCommentsOutput, `GitHub PR #${number} review comments`),
    ).map(parseReviewComment),
    ...parsePullRequestTimelineEvents(
      parseJson(timelineOutput, `GitHub PR #${number} timeline`),
    ),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const minimizedComments = await listMinimizedComments(root, summary.url, number).catch(() => new Map())
  applyMinimizedComments(activity, minimizedComments)
  const issueReferences = await resolveIssueReferences(
    root,
    summary.url,
    extractIssueReferenceTargets([
      body,
      ...activity.flatMap((item) => item.kind === 'timeline' ? [] : [item.body]),
    ]),
  ).catch(() => [])

  return {
    ...summary,
    body,
    mergedBy: parseOptionalUser(raw.mergedBy),
    mergeable: parsePullRequestMergeable(raw.mergeable),
    conflictFiles: [],
    reviewers: parsePullRequestReviewers(raw.reviewRequests, raw.reviews),
    issueReferences,
    baseRefOid: expectString(raw.baseRefOid, 'baseRefOid'),
    headRefOid: expectString(raw.headRefOid, 'headRefOid'),
    checks: parsePullRequestChecks(raw.statusCheckRollup),
    activity,
  }
}

async function resolveIssueReferences(
  root: string,
  repositoryUrl: string,
  targets: GitHubIssueReferenceTarget[],
): Promise<GitHubIssueReference[]> {
  const currentRepository = parseGitHubRepositoryUrl(repositoryUrl)
  const resolvedTargets = targets.map((target): ResolvedIssueReferenceTarget => ({
    ...target,
    owner: target.owner ?? currentRepository.owner,
    repository: target.repository ?? currentRepository.name,
  }))
  const uniqueTargets = [...new Map(
    resolvedTargets.map((target) => [issueReferenceKey(target), target]),
  ).values()]
  const missing = uniqueTargets.filter((target) => !issueReferenceCache.has(issueReferenceKey(target)))
  if (missing.length > 0) {
    const batch = fetchIssueReferenceBatch(root, missing)
    const cachedBatch = new Map<string, Promise<ResolvedIssueReference | null>>()
    for (const target of missing) {
      const key = issueReferenceKey(target)
      const reference = batch.then((references) => references.get(key) ?? null)
      cachedBatch.set(key, reference)
      issueReferenceCache.set(key, reference)
    }
    void batch.catch(() => {
      for (const [key, reference] of cachedBatch) {
        if (issueReferenceCache.get(key) === reference) issueReferenceCache.delete(key)
      }
    })
  }
  const references = await Promise.all(resolvedTargets.map(async (target) => {
    const reference = await issueReferenceCache.get(issueReferenceKey(target))!
    if (reference == null) return null
    const isCurrentRepository =
      target.owner.toLowerCase() === currentRepository.owner.toLowerCase() &&
      target.repository.toLowerCase() === currentRepository.name.toLowerCase()
    return {
      ...reference,
      token: target.token,
      label: isCurrentRepository
        ? `#${target.number}`
        : `${target.owner}/${target.repository}#${target.number}`,
    }
  }))
  return references.filter((reference): reference is GitHubIssueReference => reference != null)
}

async function fetchIssueReferenceBatch(
  root: string,
  targets: ResolvedIssueReferenceTarget[],
): Promise<Map<string, ResolvedIssueReference>> {
  const selections = targets.map((target, index) =>
    `ref${index}: search(query: ${JSON.stringify(`repo:${target.owner}/${target.repository} ${target.number}`)}, type: ISSUE, first: 10) { ` +
    'nodes { ... on Issue { __typename number title url } ... on PullRequest { __typename number title url } } }',
  ).join('\n')
  const query = `query { ${selections} }`
  const output = await runGitHub(['api', 'graphql', '-f', `query=${query}`], root)
  const response = expectObject(parseJson(output, 'GitHub issue references'))
  const rawResults = expectObject(response.data)
  const references = new Map<string, ResolvedIssueReference>()
  for (const [index, target] of targets.entries()) {
    const rawSearch = expectObject(rawResults[`ref${index}`])
    const rawReference = expectArray(rawSearch.nodes)
      .map(optionalObject)
      .find((candidate) => optionalPositiveInteger(candidate?.number) === target.number)
    const title = optionalString(rawReference?.title)
    const url = optionalString(rawReference?.url)
    const typeName = optionalString(rawReference?.__typename)
    if (title == null || url == null || (typeName !== 'Issue' && typeName !== 'PullRequest')) continue
    references.set(
      issueReferenceKey(target),
      {
        owner: target.owner,
        repository: target.repository,
        number: target.number,
        kind: typeName === 'PullRequest' ? 'pull-request' : 'issue',
        title,
        url,
      },
    )
  }
  return references
}

function parseGitHubRepositoryUrl(value: string): { owner: string; name: string } {
  const segments = new URL(value).pathname.split('/').filter(Boolean)
  if (segments.length < 2) throw invalidGitHubResponse(`Invalid pull request URL: ${value}`)
  return { owner: segments[0], name: segments[1] }
}

export async function removePullRequestLabel(
  root: string,
  number: number,
  label: string,
): Promise<void> {
  validatePullRequestNumber(number)
  if (!label.trim()) throw new AppError('INVALID_PULL_REQUEST_LABEL', 'Label must not be empty')
  try {
    await runGitHub(
      [
        'api',
        '--method',
        'DELETE',
        `repos/{owner}/{repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
      ],
      root,
      undefined,
      'mutate',
    )
  } catch (error) {
    const labelWasAlreadyAbsent =
      error instanceof AppError &&
      error.code === 'GITHUB_COMMAND_FAILED' &&
      /label.*(?:does not exist|not found)|(?:does not exist|not found).*label/i.test(error.message)
    if (!labelWasAlreadyAbsent) throw error
  }
}

export async function addPullRequestComment(
  root: string,
  number: number,
  body: string,
  replyToId?: string | null,
): Promise<void> {
  validatePullRequestNumber(number)
  const comment = body.trim()
  if (!comment) throw new AppError('INVALID_PULL_REQUEST_COMMENT', 'Comment must not be empty')
  if (replyToId == null || replyToId === '') {
    await runGitHub(
      [
        'api',
        '--method',
        'POST',
        `repos/{owner}/{repo}/issues/${number}/comments`,
        '--raw-field',
        `body=${comment}`,
      ],
      root,
      undefined,
      'mutate',
    )
    return
  }
  if (!/^[1-9]\d*$/.test(replyToId)) {
    throw new AppError('INVALID_PULL_REQUEST_COMMENT', 'Reply target is invalid')
  }
  await runGitHub(
    [
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/pulls/${number}/comments`,
      '--input',
      '-',
    ],
    root,
    JSON.stringify({ body: comment, in_reply_to: Number(replyToId) }),
    'mutate',
  )
}

export function pendingReviewComments(annotations: SessionAnnotation[]): SessionAnnotation[] {
  return annotations.filter((annotation) =>
    annotation.source === 'user' &&
    annotation.intent === 'review-comment' &&
    annotation.archivedAt == null &&
    annotation.submittedAt == null &&
    Boolean(annotation.comment?.trim()) &&
    annotation.endSide == null,
  )
}

export interface GitHubReviewComment {
  path: string
  body: string
  line: number
  side: 'LEFT' | 'RIGHT'
  start_line?: number
  start_side?: 'LEFT' | 'RIGHT'
}

export function toGitHubReviewComment(annotation: SessionAnnotation): GitHubReviewComment {
  if (
    annotation.source !== 'user' ||
    annotation.intent !== 'review-comment' ||
    annotation.archivedAt != null ||
    annotation.submittedAt != null ||
    !annotation.comment?.trim() ||
    annotation.endSide != null
  ) {
    throw new AppError('INVALID_REVIEW_COMMENT', 'Annotation is not a pending review comment')
  }
  const side = annotation.side === 'old' ? 'LEFT' : 'RIGHT'
  return {
    path: annotation.filePath,
    body: annotation.comment.trim(),
    line: annotation.endLine,
    side,
    ...(annotation.startLine === annotation.endLine
      ? {}
      : { start_line: annotation.startLine, start_side: side }),
  }
}

export async function submitPullRequestReview(
  root: string,
  number: number,
  event: PullRequestReviewEvent,
  body: string,
  commitId: string,
  comments: GitHubReviewComment[],
): Promise<void> {
  validatePullRequestNumber(number)
  const comment = body.trim()
  if (!comment && comments.length === 0) {
    throw new AppError('INVALID_PULL_REQUEST_REVIEW', 'Review must include a summary or comments')
  }
  const revision = commitId.trim()
  if (!revision) throw new AppError('INVALID_PULL_REQUEST_REVIEW', 'Review commit must not be empty')
  await runGitHub(
    [
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/pulls/${number}/reviews`,
      '--input',
      '-',
    ],
    root,
    JSON.stringify({ event, body: comment, commit_id: revision, comments }),
    'mutate',
  )
}

export async function squashMergePullRequest(
  root: string,
  number: number,
  expectedHeadOid: string,
): Promise<void> {
  validatePullRequestNumber(number)
  const headOid = expectedHeadOid.trim()
  if (!headOid) throw new AppError('INVALID_PULL_REQUEST_HEAD', 'Expected head commit must not be empty')
  const output = await runGitHub(
    [
      'api',
      '--method',
      'PUT',
      `repos/{owner}/{repo}/pulls/${number}/merge`,
      '--raw-field',
      'merge_method=squash',
      '--raw-field',
      `sha=${headOid}`,
    ],
    root,
    undefined,
    'mutate',
  )
  const response = expectObject(parseJson(output, `GitHub PR #${number} squash merge`))
  if (response.merged !== true) {
    throw new AppError(
      'PULL_REQUEST_MERGE_FAILED',
      optionalString(response.message) ?? 'GitHub did not merge the pull request',
      409,
    )
  }
}

export async function getGitHubToken(): Promise<string> {
  return (await runGitHub(['auth', 'token', '--hostname', 'github.com'], process.cwd())).trim()
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
      'number,title,url,state,baseRefName,headRefName,baseRefOid,headRefOid',
    ],
    root,
  )
  const raw = expectObject(parseJson(output, `GitHub PR #${number}`))
  return {
    number: expectPositiveInteger(raw.number, 'number'),
    title: expectString(raw.title, 'title'),
    url: expectString(raw.url, 'url'),
    state: parsePullRequestState(raw.state),
    baseRefName: expectString(raw.baseRefName, 'baseRefName'),
    headRefName: expectString(raw.headRefName, 'headRefName'),
    baseRefOid: expectString(raw.baseRefOid, 'baseRefOid'),
    headRefOid: expectString(raw.headRefOid, 'headRefOid'),
  }
}

export function parsePullRequestMergeable(value: unknown): PullRequestMergeable {
  const mergeable = expectString(value, 'mergeable').toUpperCase()
  if (mergeable !== 'MERGEABLE' && mergeable !== 'CONFLICTING' && mergeable !== 'UNKNOWN') {
    throw invalidGitHubResponse(`Unknown pull request mergeable state: ${mergeable}`)
  }
  return mergeable
}

export function parsePullRequestReviewers(
  requestsValue: unknown,
  reviewsValue: unknown = [],
): GitHubReviewer[] {
  const requested = expectArray(requestsValue).map((reviewerValue): GitHubReviewer => {
    const reviewer = expectObject(reviewerValue)
    const kind = expectString(reviewer.__typename, 'reviewRequests.__typename')
    if (kind === 'User') return { ...parseUser(reviewer), kind: 'user' }
    if (kind === 'Team') {
      return {
        kind: 'team',
        login: expectString(reviewer.slug, 'reviewRequests.slug'),
        name: expectString(reviewer.name, 'reviewRequests.name'),
        avatarUrl: null,
      }
    }
    throw invalidGitHubResponse(`Unknown review request type: ${kind}`)
  })
  const completed = expectArray(reviewsValue).flatMap((reviewValue): GitHubReviewer[] => {
    const author = parseOptionalUser(expectObject(reviewValue).author)
    return author == null ? [] : [{ ...author, kind: 'user' }]
  })
  return [...new Map(
    [...requested, ...completed].map((reviewer) => [reviewer.login.toLowerCase(), reviewer]),
  ).values()]
}

export function aggregateCheckStatus(value: unknown): PullRequestCheckStatus {
  const checks = value == null ? [] : expectArray(value)
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

export function parsePullRequestChecks(value: unknown): PullRequestCheckRun[] {
  return (value == null ? [] : expectArray(value)).map((checkValue) => {
    const check = expectObject(checkValue)
    const state = optionalString(check.state)?.toUpperCase()
    const status = optionalString(check.status)?.toUpperCase()
    const conclusion = optionalString(check.conclusion)?.toUpperCase()
    const name = optionalString(check.name) ?? optionalString(check.context) ?? 'Unnamed check'

    return {
      name,
      workflowName: optionalString(check.workflowName),
      status:
        state != null
          ? state === 'SUCCESS'
            ? 'pass'
            : state === 'PENDING' || state === 'EXPECTED'
              ? 'pending'
              : 'fail'
          : status !== 'COMPLETED' || conclusion == null
            ? 'pending'
            : conclusion === 'SKIPPED'
              ? 'skipped'
              : conclusion === 'SUCCESS' || conclusion === 'NEUTRAL'
                ? 'pass'
                : 'fail',
      url: optionalString(check.detailsUrl) ?? optionalString(check.targetUrl),
    }
  })
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

function checkRollupState(value: unknown): string | null {
  const nodes = optionalObject(optionalObject(value)?.commits)?.nodes
  const commit = optionalObject(Array.isArray(nodes) ? nodes[0] : null)?.commit
  return optionalString(optionalObject(optionalObject(commit)?.statusCheckRollup)?.state)
}

export function parseCheckRollupState(state: string | null): PullRequestCheckStatus {
  switch (state?.toUpperCase()) {
    case 'SUCCESS':
      return 'pass'
    case 'FAILURE':
    case 'ERROR':
      return 'fail'
    case 'PENDING':
    case 'EXPECTED':
      return 'pending'
    default:
      return 'none'
  }
}


export function parsePullRequestState(value: unknown): PullRequestState {
  const state = expectString(value, 'state').toUpperCase()
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') {
    throw invalidGitHubResponse(`Unknown pull request state: ${state}`)
  }
  return state
}

function parsePullRequestSummary(
  value: unknown,
  checkStatus?: PullRequestCheckStatus,
): PullRequestSummary {
  const raw = expectObject(value)
  return {
    number: expectPositiveInteger(raw.number, 'number'),
    title: expectString(raw.title, 'title'),
    url: expectString(raw.url, 'url'),
    state: parsePullRequestState(raw.state),
    isDraft: expectBoolean(raw.isDraft, 'isDraft'),
    baseRefName: expectString(raw.baseRefName, 'baseRefName'),
    headRefName: expectString(raw.headRefName, 'headRefName'),
    additions: expectNonNegativeInteger(raw.additions, 'additions'),
    deletions: expectNonNegativeInteger(raw.deletions, 'deletions'),
    createdAt: expectString(raw.createdAt, 'createdAt'),
    updatedAt: expectString(raw.updatedAt, 'updatedAt'),
    author: parseUser(raw.author),
    assignees: expectArray(raw.assignees).map(parseUser),
    reviewers: parsePullRequestReviewers(raw.reviewRequests, raw.latestReviews ?? raw.reviews),
    labels: expectArray(raw.labels).map(parseLabel),
    checkStatus: checkStatus ?? aggregateCheckStatus(raw.statusCheckRollup),
  }
}

export function parseConversationComment(value: unknown): PullRequestActivity {
  const raw = expectObject(value)
  return {
    kind: 'comment',
    id: String(raw.id),
    author: parseUser(raw.author),
    body: optionalString(raw.body) ?? '',
    createdAt: expectString(raw.createdAt, 'comment.createdAt'),
    updatedAt: optionalString(raw.updatedAt) ?? expectString(raw.createdAt, 'comment.createdAt'),
    url: optionalString(raw.url),
    minimizedReason: parseMinimizedReason(raw.minimized),
  }
}

export function parseReview(value: unknown): PullRequestActivity {
  const raw = expectObject(value)
  const submittedAt = optionalString(raw.submitted_at)
    ?? optionalString(raw.submittedAt)
    ?? expectString(raw.created_at, 'review.submittedAt')
  return {
    kind: 'review',
    id: String(raw.id),
    author: parseUser(raw.user ?? raw.author),
    body: optionalString(raw.body) ?? '',
    state: optionalString(raw.state) ?? 'COMMENTED',
    createdAt: submittedAt,
    updatedAt: submittedAt,
    url: optionalString(raw.html_url),
  }
}

export function parseReviewComment(value: unknown): PullRequestActivity {
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
    reviewId: raw.pull_request_review_id == null ? null : String(raw.pull_request_review_id),
    replyToId: raw.in_reply_to_id == null ? null : String(raw.in_reply_to_id),
    createdAt: expectString(raw.created_at, 'reviewComment.created_at'),
    updatedAt: expectString(raw.updated_at, 'reviewComment.updated_at'),
    url: optionalString(raw.html_url),
    diffHunk: optionalString(raw.diff_hunk) ?? '',
    minimizedReason: parseMinimizedReason(raw.minimized),
  }
}

export function applyMinimizedComments(
  activities: PullRequestActivity[],
  minimizedComments: Map<string, MinimizedCommentReason>,
): void {
  for (const activity of activities) {
    if (activity.kind !== 'comment' && activity.kind !== 'review-comment') continue
    activity.minimizedReason = minimizedComments.get(activity.id) ?? activity.minimizedReason
  }
}

export function parseMinimizedReason(value: unknown): MinimizedCommentReason | null {
  const reason = typeof value === 'string'
    ? value
    : optionalString(optionalObject(value)?.reason)
  if (reason == null) return null
  switch (reason.toLowerCase().replaceAll('_', '-')) {
    case 'abuse':
    case 'off-topic':
    case 'outdated':
    case 'resolved':
    case 'duplicate':
    case 'spam':
    case 'low-quality':
      return reason.toLowerCase().replaceAll('_', '-') as MinimizedCommentReason
    default:
      return null
  }
}

async function listMinimizedComments(
  root: string,
  repositoryUrl: string,
  number: number,
): Promise<Map<string, MinimizedCommentReason>> {
  const repository = parseGitHubRepositoryUrl(repositoryUrl)
  const output = await runGitHub(
    [
      'api',
      'graphql',
      '--paginate',
      '--slurp',
      '-F',
      `owner=${repository.owner}`,
      '-F',
      `name=${repository.name}`,
      '-F',
      `number=${number}`,
      '-f',
      `query=${MINIMIZED_COMMENTS_QUERY}`,
    ],
    root,
    undefined,
    'page',
  )
  return parseMinimizedComments(parseJson(output, `GitHub PR #${number} minimized comments`))
}

export function parseMinimizedComments(value: unknown): Map<string, MinimizedCommentReason> {
  const minimized = new Map<string, MinimizedCommentReason>()
  for (const page of parseGraphqlPages(value)) {
    const pullRequest = optionalObject(optionalObject(optionalObject(page.data)?.repository)?.pullRequest)
    if (pullRequest == null) continue
    collectMinimizedComments(optionalObject(pullRequest.comments)?.nodes, minimized)
    for (const thread of expectArray(optionalObject(pullRequest.reviewThreads)?.nodes ?? [])) {
      collectMinimizedComments(optionalObject(expectObject(thread).comments)?.nodes, minimized)
    }
  }
  return minimized
}

function collectMinimizedComments(
  nodes: unknown,
  minimized: Map<string, MinimizedCommentReason>,
): void {
  for (const node of nodes == null ? [] : expectArray(nodes)) {
    const raw = expectObject(node)
    if (raw.isMinimized !== true) continue
    const reason = parseMinimizedReason(raw.minimizedReason) ?? 'resolved'
    const databaseId = raw.databaseId
    if (databaseId != null) minimized.set(String(databaseId), reason)
  }
}

function parseGraphqlPages(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(expectObject)
  return [expectObject(value)]
}

export function parsePullRequestTimelineEvents(value: unknown): PullRequestActivity[] {
  return parsePaginatedArray(value).flatMap((entry, index) => {
    const raw = expectObject(entry)
    const event = optionalString(raw.event)
    if (event == null || event === 'commented' || event === 'reviewed') return []
    const createdAt = optionalString(raw.created_at)
      ?? optionalString(raw.submitted_at)
      ?? optionalString(optionalObject(raw.author)?.date)
      ?? optionalString(optionalObject(raw.committer)?.date)
    if (createdAt == null) return []
    const label = optionalString(optionalObject(raw.label)?.name)
    const requestedReviewer = optionalObject(raw.requested_reviewer)
    const requestedTeam = optionalObject(raw.requested_team)
    const assignee = optionalObject(raw.assignee)
    const milestone = optionalObject(raw.milestone)
    const source = parseTimelineSource(raw.source)
    const rename = optionalObject(raw.rename)
    const subject = optionalString(requestedReviewer?.login)
      ?? optionalString(requestedTeam?.name)
      ?? optionalString(assignee?.login)
      ?? optionalString(milestone?.title)
      ?? source?.title
      ?? optionalString(raw.deployment_environment)
      ?? optionalString(raw.ref)
      ?? optionalString(raw.message)?.split('\n', 1)[0]
      ?? null
    const id = String(raw.id ?? raw.node_id ?? raw.sha ?? `${event}:${createdAt}:${index}`)
    return [{
      kind: 'timeline' as const,
      id,
      event,
      author: parseOptionalUser(raw.actor)
        ?? parseOptionalUser(raw.user)
        ?? parseOptionalUser(raw.author)
        ?? parseOptionalUser(raw.committer),
      createdAt,
      label,
      subject,
      commitId: optionalString(raw.sha) ?? optionalString(raw.commit_id),
      source,
      previousTitle: optionalString(rename?.from),
      currentTitle: optionalString(rename?.to),
    }]
  })
}

function parseTimelineSource(value: unknown): Extract<PullRequestActivity, { kind: 'timeline' }>['source'] {
  const issue = optionalObject(optionalObject(value)?.issue) ?? optionalObject(optionalObject(value)?.pull_request)
  if (issue == null) return null
  const number = optionalPositiveInteger(issue.number)
  const title = optionalString(issue.title)
  if (number == null || title == null) return null
  const repository = optionalObject(issue.repository)
  const owner = optionalString(optionalObject(repository?.owner)?.login) ?? optionalString(repository?.owner)
  const name = optionalString(repository?.name)
  return {
    kind: issue.pull_request != null || optionalString(issue.html_url)?.includes('/pull/') ? 'pull-request' : 'issue',
    number,
    title,
    url: optionalString(issue.html_url) ?? optionalString(issue.url),
    repository: owner != null && name != null ? `${owner}/${name}` : null,
  }
}

function parseUser(value: unknown): GitHubUser {
  const raw = expectObject(value)
  const login = expectString(raw.login, 'user.login')
  return {
    login,
    name: optionalString(raw.name),
    avatarUrl:
      optionalString(raw.avatarUrl) ??
      optionalString(raw.avatar_url) ??
      `https://github.com/${encodeURIComponent(login)}.png?size=64`,
  }
}

function parseOptionalUser(value: unknown): GitHubUser | null {
  const raw = optionalObject(value)
  return raw != null && optionalString(raw.login) != null ? parseUser(raw) : null
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

function optionalObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

async function runGitHub(
  args: string[],
  cwd: string,
  input?: string,
  kind: GitHubCommandKind = 'read',
): Promise<string> {
  const timeoutMs = GITHUB_COMMAND_TIMEOUT_MS[kind]
  const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
    (resolve, reject) => {
      const child = spawn('gh', args, {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let settled = false
      const finish = (error?: unknown, value?: { stdout: string; stderr: string; exitCode: number }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error != null) reject(error)
        else resolve(value!)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(new AppError(
          kind === 'mutate' ? 'GITHUB_TIMEOUT_INDETERMINATE' : 'GITHUB_TIMEOUT',
          kind === 'mutate'
            ? 'GitHub may have already applied this change. Refresh before retrying.'
            : 'GitHub request timed out',
          504,
          { args, kind },
        ))
      }, timeoutMs)
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill()
          finish(new AppError('COMMAND_OUTPUT_TOO_LARGE', 'gh output exceeded 128 MiB'))
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.on('error', (error) => finish(error))
      child.stdin.on('error', () => undefined)
      child.stdin.end(input)
      child.on('close', (exitCode) => {
        finish(undefined, {
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
