import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  extractIssueReferenceTargets,
  remarkIssueReferences,
} from '../src/shared/markdown.js'
import { pullRequestAllowsReviewEvent } from '../src/shared/pull-request.js'
import { parseReviewCommentDiff } from '../src/shared/reviewCommentDiff.js'

import { parseGitHubAttachmentUrl } from '../src/server/api.js'
import {
  aggregateCheckStatus,
  addPullRequestComment,
  expirePullRequestListCache,
  invalidatePullRequestListCache,
  listPullRequests,
  resetPullRequestListCache,
  parseCheckRollupState,
  parsePullRequestChecks,
  parsePullRequestMergeable,
  parsePullRequestReviewers,
  parsePullRequestReviewStatus,
  pendingReviewComments,
  parsePullRequestTimelineEvents,
  parseMinimizedComments,
  parseReview,
  parseReviewComment,
  squashMergePullRequest,
  submitPullRequestReview,
  toGitHubReviewComment,
} from '../src/server/github.js'

describe('GitHub pull request actions', () => {
  test('sends comments, reviews, and squash merges through the expected REST endpoints', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-github-actions-'))
    const bin = path.join(directory, 'bin')
    const calls = path.join(directory, 'calls.txt')
    const input = path.join(directory, 'input.json')
    mkdirSync(bin)
    const gh = path.join(bin, 'gh')
    const replyInput = path.join(directory, 'reply.json')
    writeFileSync(gh, `#!/bin/sh
printf '%s\\n' '---' >> "$GH_TEST_OUTPUT"
printf '<%s>\\n' "$@" >> "$GH_TEST_OUTPUT"
if [ "$GH_TEST_INPUT" != '' ]; then
  cat >> "$GH_TEST_INPUT"
fi
printf '%s\\n' '{\"merged\":true,\"message\":\"Pull Request successfully merged\"}'
`)
    chmodSync(gh, 0o755)
    const originalPath = process.env.PATH
    const originalOutput = process.env.GH_TEST_OUTPUT
    const originalInput = process.env.GH_TEST_INPUT
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.GH_TEST_OUTPUT = calls
    try {
      process.env.GH_TEST_INPUT = ''
      await addPullRequestComment(directory, 42, 'A conversation comment')
      process.env.GH_TEST_INPUT = replyInput
      await addPullRequestComment(directory, 42, 'A review reply', '88')
      process.env.GH_TEST_INPUT = input
      await submitPullRequestReview(
        directory,
        42,
        'REQUEST_CHANGES',
        '   ',
        'def456',
        [{
          path: 'src/example.ts',
          body: 'Use the shared helper.',
          line: 18,
          side: 'RIGHT',
        }],
      )
      await squashMergePullRequest(directory, 42, 'abc123')
      const output = readFileSync(calls, 'utf8')
      expect(output).toContain('<repos/{owner}/{repo}/issues/42/comments>')
      expect(output).toContain('<body=A conversation comment>')
      expect(output).toContain('<repos/{owner}/{repo}/pulls/42/comments>')
      expect(output).toContain('<repos/{owner}/{repo}/pulls/42/reviews>')
      expect(output).toContain('<--input>')
      expect(JSON.parse(readFileSync(replyInput, 'utf8'))).toEqual({
        body: 'A review reply',
        in_reply_to: 88,
      })
      expect(JSON.parse(readFileSync(input, 'utf8'))).toEqual({
        event: 'REQUEST_CHANGES',
        body: '',
        commit_id: 'def456',
        comments: [{
          path: 'src/example.ts',
          body: 'Use the shared helper.',
          line: 18,
          side: 'RIGHT',
        }],
      })
      expect(output).toContain('<repos/{owner}/{repo}/pulls/42/merge>')
      expect(output).toContain('<merge_method=squash>')
      expect(output).toContain('<sha=abc123>')
    } finally {
      process.env.PATH = originalPath
      if (originalOutput == null) delete process.env.GH_TEST_OUTPUT
      else process.env.GH_TEST_OUTPUT = originalOutput
      if (originalInput == null) delete process.env.GH_TEST_INPUT
      else process.env.GH_TEST_INPUT = originalInput
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('rejects an empty comment review with no summary or comments', async () => {
    await expect(submitPullRequestReview('.', 42, 'COMMENT', '   ', 'def456', [])).rejects.toThrow(
      'Review must include a summary or comments',
    )
  })

  test('maps a user annotation to a multi-line GitHub review comment', () => {
    expect(toGitHubReviewComment({
      id: 'ann_1',
      sessionId: 'session_1',
      filePath: 'src/example.ts',
      side: 'new',
      startLine: 12,
      endSide: null,
      endLine: 14,
      comment: 'Keep this range together.',
      importance: null,
      source: 'user',
      intent: 'review-comment',
      replyToId: null,
      archivedAt: null,
      submittedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })).toEqual({
      path: 'src/example.ts',
      body: 'Keep this range together.',
      line: 14,
      side: 'RIGHT',
      start_line: 12,
      start_side: 'RIGHT',
    })
  })

  test('excludes agent annotations from pending review comments', () => {
    const userComment = {
      id: 'ann_user',
      sessionId: 'session_1',
      filePath: 'src/example.ts',
      side: 'new' as const,
      startLine: 12,
      endSide: null,
      endLine: 12,
      comment: 'Publish this.',
      importance: null,
      source: 'user' as const,
      intent: 'review-comment' as const,
      replyToId: null,
      archivedAt: null,
      submittedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }
    expect(pendingReviewComments([
      userComment,
      { ...userComment, id: 'ann_agent', source: 'agent' },
      { ...userComment, id: 'ann_local', intent: 'annotation' },
    ])).toEqual([userComment])
  })
})


describe('closed and merged pull request reviews', () => {
  test.each(['CLOSED', 'MERGED'] as const)(
    'lets %s pull requests post a comment review but not a decision',
    (state) => {
      expect(pullRequestAllowsReviewEvent(state, 'COMMENT')).toBe(true)
      expect(pullRequestAllowsReviewEvent(state, 'APPROVE')).toBe(false)
      expect(pullRequestAllowsReviewEvent(state, 'REQUEST_CHANGES')).toBe(false)
    },
  )

  test('lets open pull requests approve or request changes', () => {
    expect(pullRequestAllowsReviewEvent('OPEN', 'COMMENT')).toBe(true)
    expect(pullRequestAllowsReviewEvent('OPEN', 'APPROVE')).toBe(true)
    expect(pullRequestAllowsReviewEvent('OPEN', 'REQUEST_CHANGES')).toBe(true)
  })
})

describe('GitHub issue attachments', () => {
  test.each([
    'https://github.com/user-attachments/assets/12345678-abcd',
    'https://github.com/user-attachments/files/12345678/image.png',
    'https://private-user-images.githubusercontent.com/1/attachment.png?jwt=signed',
    'https://user-images.githubusercontent.com/1/attachment.png',
  ])('accepts an uploaded attachment URL from GitHub: %s', (source) => {
    expect(parseGitHubAttachmentUrl(source).href).toBe(source)
  })

  test.each([
    'http://github.com/user-attachments/assets/1234',
    'https://github.com/owner/repository/image.png',
    'https://example.com/user-attachments/assets/1234',
    'not a URL',
  ])('rejects a URL outside GitHub attachment storage: %s', (source) => {
    expect(() => parseGitHubAttachmentUrl(source)).toThrow(/GitHub.*attachment/)
  })
})

describe('GitHub pull request review comments', () => {
  test('keeps the selected code diff for conversation rendering', () => {
    expect(parseReviewComment({
      id: 42,
      user: { login: 'reviewer', avatar_url: 'https://example.com/avatar.png' },
      body: 'Please keep this branch explicit.',
      path: 'src/example.ts',
      line: 18,
      side: 'RIGHT',
      pull_request_review_id: 80,
      in_reply_to_id: null,
      diff_hunk: '@@ -16,2 +16,3 @@\n context\n+selected code',
      created_at: '2026-03-01T10:00:00Z',
      updated_at: '2026-03-01T10:01:00Z',
      html_url: 'https://github.com/acme/repo/pull/1#discussion_r42',
    })).toMatchObject({
      kind: 'review-comment',
      path: 'src/example.ts',
      line: 18,
      side: 'new',
      reviewId: '80',
      replyToId: null,
      diffHunk: '@@ -16,2 +16,3 @@\n context\n+selected code',
      minimizedReason: null,
    })
  })


  test('parses a submitted REST review with a numeric id', () => {
    expect(parseReview({
      id: 80,
      user: { login: 'reviewer', avatar_url: 'https://example.com/avatar.png' },
      body: 'Looks good overall.',
      state: 'COMMENTED',
      submitted_at: '2026-03-01T10:05:00Z',
      html_url: 'https://github.com/acme/repo/pull/1#pullrequestreview-80',
    })).toMatchObject({
      kind: 'review',
      id: '80',
      body: 'Looks good overall.',
      state: 'COMMENTED',
      createdAt: '2026-03-01T10:05:00Z',
      url: 'https://github.com/acme/repo/pull/1#pullrequestreview-80',
    })
  })


  test('maps GraphQL minimized review comments onto numeric ids', () => {
    expect([...parseMinimizedComments({
      data: {
        repository: {
          pullRequest: {
            comments: {
              nodes: [{ databaseId: 11, isMinimized: true, minimizedReason: 'off-topic' }],
            },
            reviewThreads: {
              nodes: [{
                comments: {
                  nodes: [{ databaseId: 42, isMinimized: true, minimizedReason: 'resolved' }],
                },
              }],
            },
          },
        },
      },
    })]).toEqual([
      ['11', 'off-topic'],
      ['42', 'resolved'],
    ])
  })

  test('parses a truncated GitHub review hunk into a renderable file diff', () => {
    const fileDiff = parseReviewCommentDiff(
      'src/example.ts',
      '@@ -16,2 +16,3 @@\n context\n+selected code',
    )
    expect(fileDiff).toMatchObject({
      name: 'src/example.ts',
      type: 'change',
      isPartial: true,
      additionLines: ['context\n', 'selected code\n'],
      deletionLines: ['context\n'],
    })
    expect(fileDiff?.hunks).toHaveLength(1)
    expect(fileDiff?.hunks[0]).toMatchObject({
      additionStart: 16,
      additionCount: 2,
      deletionStart: 16,
      deletionCount: 1,
      collapsedBefore: 0,
      unifiedLineCount: 2,
    })
  })

  test('keeps a trailing whitespace-only context line from a truncated hunk', () => {
    const fileDiff = parseReviewCommentDiff(
      'src/example.ts',
      '@@ -1,1 +1,1 @@\n ',
    )
    expect(fileDiff).toMatchObject({
      name: 'src/example.ts',
      additionLines: ['\n'],
      deletionLines: ['\n'],
    })
    expect(fileDiff?.hunks[0]).toMatchObject({
      additionStart: 1,
      additionCount: 1,
      deletionStart: 1,
      deletionCount: 1,
    })
  })

  test('keeps only the last eight lines of a long review hunk', () => {
    const context = Array.from({ length: 12 }, (_, index) => ` line ${index + 1}`)
    const fileDiff = parseReviewCommentDiff(
      'src/example.ts',
      ['@@ -10,13 +10,13 @@', ...context, '+selected code'].join('\n'),
    )
    expect(fileDiff).toMatchObject({
      additionLines: [
        'line 6\n',
        'line 7\n',
        'line 8\n',
        'line 9\n',
        'line 10\n',
        'line 11\n',
        'line 12\n',
        'selected code\n',
      ],
      deletionLines: [
        'line 6\n',
        'line 7\n',
        'line 8\n',
        'line 9\n',
        'line 10\n',
        'line 11\n',
        'line 12\n',
      ],
    })
    expect(fileDiff?.hunks[0]).toMatchObject({
      additionStart: 15,
      additionCount: 8,
      deletionStart: 15,
      deletionCount: 7,
      unifiedLineCount: 8,
    })
  })
})


describe('GitHub issue references in Markdown', () => {
  test('extracts references from list and paragraph text without treating CommonMark code as content', () => {
    const markdown = [
      '    - #12',
      '- #13',
      '```md',
      '- #14',
      '```still-code',
      '- #15',
      '```',
      '- acme/other#16',
      '- close #17 and **acme/other#18**, but not `#19` or [#20](https://example.com)',
      '',
      'close #21 and acme/other#22',
    ].join('\n')

    expect(extractIssueReferenceTargets([markdown])).toEqual([
      { token: '#13', owner: null, repository: null, number: 13 },
      { token: 'acme/other#16', owner: 'acme', repository: 'other', number: 16 },
      { token: '#17', owner: null, repository: null, number: 17 },
      { token: 'acme/other#18', owner: 'acme', repository: 'other', number: 18 },
      { token: '#21', owner: null, repository: null, number: 21 },
      { token: 'acme/other#22', owner: 'acme', repository: 'other', number: 22 },
    ])
  })

  test('deduplicates references across Markdown bodies', () => {
    expect(extractIssueReferenceTargets(['- #12', '* #12', '1. #13', 'see #12'])).toEqual([
      { token: '#12', owner: null, repository: null, number: 12 },
      { token: '#13', owner: null, repository: null, number: 13 },
    ])
  })

  test('inserts issue titles as literal AST text in list items only', () => {
    const title = '<img src="https://example.com/tracker.png"> *bold* `code`'
    const references = [{
      token: '#11160',
      label: '#11160',
      kind: 'issue' as const,
      owner: 'acme',
      repository: 'repo',
      number: 11160,
      title,
      url: 'https://github.com/acme/repo/issues/11160',
    }]
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkIssueReferences, { references })

    expect(processor.runSync(processor.parse('- close #11160 after'))).toMatchObject({
      children: [{
        type: 'list',
        children: [{
          type: 'listItem',
          children: [{
            type: 'paragraph',
            children: [
              { type: 'text', value: 'close ' },
              {
                type: 'link',
                url: 'https://github.com/acme/repo/issues/11160',
                children: [{ type: 'text', value: `#11160 ${title}` }],
              },
              { type: 'text', value: ' after' },
            ],
          }],
        }],
      }],
    })

    expect(processor.runSync(processor.parse('close #11160 after'))).toMatchObject({
      children: [{
        type: 'paragraph',
        children: [
          { type: 'text', value: 'close ' },
          {
            type: 'link',
            url: 'https://github.com/acme/repo/issues/11160',
            children: [{ type: 'text', value: '#11160' }],
          },
          { type: 'text', value: ' after' },
        ],
      }],
    })
  })
})

describe('GitHub pull request sidebar data', () => {
  test('validates mergeability states', () => {
    expect(parsePullRequestMergeable('MERGEABLE')).toBe('MERGEABLE')
    expect(parsePullRequestMergeable('conflicting')).toBe('CONFLICTING')
    expect(() => parsePullRequestMergeable('blocked')).toThrow(/mergeable state/)
  })

  test('maps GitHub review states to reviewer statuses', () => {
    expect(parsePullRequestReviewStatus('APPROVED')).toBe('approved')
    expect(parsePullRequestReviewStatus('changes_requested')).toBe('rejected')
    expect(parsePullRequestReviewStatus('COMMENTED')).toBe('none')
    expect(parsePullRequestReviewStatus(null)).toBe('none')
  })

  test('preserves user and team review requests', () => {
    expect(parsePullRequestReviewers([
      { __typename: 'User', login: 'octocat' },
      { __typename: 'Team', name: 'Platform', slug: 'acme/platform' },
    ], [
      { state: 'APPROVED', author: { login: 'octocat' } },
      { state: 'CHANGES_REQUESTED', author: { login: 'completed-reviewer', name: 'Completed Reviewer' } },
    ])).toEqual([
      {
        kind: 'user',
        login: 'octocat',
        name: null,
        avatarUrl: 'https://github.com/octocat.png?size=64',
        reviewStatus: 'approved',
      },
      { kind: 'team', login: 'acme/platform', name: 'Platform', avatarUrl: null, reviewStatus: 'none' },
      {
        kind: 'user',
        login: 'completed-reviewer',
        name: 'Completed Reviewer',
        avatarUrl: 'https://github.com/completed-reviewer.png?size=64',
        reviewStatus: 'rejected',
      },
    ])
  })

  test('skips reviews whose author is missing', () => {
    expect(parsePullRequestReviewers(
      [{ __typename: 'User', login: 'octocat' }],
      [{ author: null }, { state: 'APPROVED', author: { login: 'hubot' } }],
    )).toEqual([
      {
        kind: 'user',
        login: 'octocat',
        name: null,
        avatarUrl: 'https://github.com/octocat.png?size=64',
        reviewStatus: 'none',
      },
      {
        kind: 'user',
        login: 'hubot',
        name: null,
        avatarUrl: 'https://github.com/hubot.png?size=64',
        reviewStatus: 'approved',
      },
    ])
  })
})

describe('GitHub pull request checks', () => {
  test('reports no checks for an empty rollup', () => {
    expect(aggregateCheckStatus([])).toBe('none')
    expect(aggregateCheckStatus(null)).toBe('none')
    expect(parsePullRequestChecks(null)).toEqual([])
  })

  test('aggregates completed check runs', () => {
    expect(aggregateCheckStatus([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'SKIPPED' },
      { status: 'COMPLETED', conclusion: 'NEUTRAL' },
    ])).toBe('pass')
    expect(aggregateCheckStatus([
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ])).toBe('fail')
    expect(aggregateCheckStatus([
      { status: 'IN_PROGRESS', conclusion: null },
    ])).toBe('pending')
  })

  test('handles legacy status contexts without treating success as pending', () => {
    expect(aggregateCheckStatus([{ state: 'SUCCESS' }])).toBe('pass')
    expect(aggregateCheckStatus([{ state: 'PENDING' }])).toBe('pending')
    expect(aggregateCheckStatus([{ state: 'ERROR' }])).toBe('fail')
  })

  test('lets any failure take precedence over pending checks', () => {
    expect(aggregateCheckStatus([
      { status: 'QUEUED', conclusion: null },
      { status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    ])).toBe('fail')
  })

  test('preserves check run details for grouped rendering', () => {
    expect(parsePullRequestChecks([
      {
        name: 'test / unit',
        workflowName: 'CI',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/acme/repo/actions/runs/1',
      },
      { name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { context: 'deploy', state: 'PENDING', targetUrl: 'https://example.com/deploy' },
      { context: 'security', state: 'ERROR' },
    ])).toEqual([
      {
        name: 'test / unit',
        workflowName: 'CI',
        status: 'pass',
        url: 'https://github.com/acme/repo/actions/runs/1',
      },
      { name: 'docs', workflowName: null, status: 'skipped', url: null },
      {
        name: 'deploy',
        workflowName: null,
        status: 'pending',
        url: 'https://example.com/deploy',
      },
      { name: 'security', workflowName: null, status: 'fail', url: null },
    ])
  })

  test('maps a GitHub rollup state to the list badge', () => {
    expect(parseCheckRollupState('SUCCESS')).toBe('pass')
    expect(parseCheckRollupState('FAILURE')).toBe('fail')
    expect(parseCheckRollupState('ERROR')).toBe('fail')
    expect(parseCheckRollupState('PENDING')).toBe('pending')
    expect(parseCheckRollupState('EXPECTED')).toBe('pending')
    expect(parseCheckRollupState(null)).toBe('none')
  })
})

describe('GitHub pull request timeline', () => {
  test('keeps status events and skips comments and reviews rendered from richer sources', () => {
    expect(parsePullRequestTimelineEvents([[
      {
        id: 1,
        event: 'labeled',
        actor: { login: 'octocat', avatar_url: 'https://example.com/avatar.png' },
        label: { name: 'additional-review-needed' },
        created_at: '2026-03-01T10:00:00Z',
      },
      {
        sha: '1234567890abcdef',
        event: 'committed',
        author: { name: 'Mona', date: '2026-03-01T11:00:00Z' },
        committer: { login: 'octocat', avatar_url: 'https://example.com/octocat.png' },
        message: 'Refine timeline\n\nDetails',
      },
      {
        id: 4,
        event: 'cross-referenced',
        actor: { login: 'hubot', avatar_url: 'https://example.com/hubot.png' },
        created_at: '2026-03-01T11:30:00Z',
        source: {
          type: 'issue',
          issue: {
            number: 88,
            title: 'Follow-up crash',
            html_url: 'https://github.com/acme/widgets/issues/88',
            repository: { name: 'widgets', owner: { login: 'acme' } },
          },
        },
      },
      { id: 2, event: 'commented', created_at: '2026-03-01T12:00:00Z' },
      { id: 3, event: 'reviewed', submitted_at: '2026-03-01T13:00:00Z' },
    ]])).toEqual([
      {
        kind: 'timeline',
        id: '1',
        event: 'labeled',
        author: {
          login: 'octocat',
          name: null,
          avatarUrl: 'https://example.com/avatar.png',
        },
        createdAt: '2026-03-01T10:00:00Z',
        label: 'additional-review-needed',
        subject: null,
        commitId: null,
        source: null,
        previousTitle: null,
        currentTitle: null,
      },
      {
        kind: 'timeline',
        id: '1234567890abcdef',
        event: 'committed',
        author: {
          login: 'octocat',
          name: null,
          avatarUrl: 'https://example.com/octocat.png',
        },
        createdAt: '2026-03-01T11:00:00Z',
        label: null,
        subject: 'Refine timeline',
        commitId: '1234567890abcdef',
        source: null,
        previousTitle: null,
        currentTitle: null,
      },
      {
        kind: 'timeline',
        id: '4',
        event: 'cross-referenced',
        author: {
          login: 'hubot',
          name: null,
          avatarUrl: 'https://example.com/hubot.png',
        },
        createdAt: '2026-03-01T11:30:00Z',
        label: null,
        subject: 'Follow-up crash',
        commitId: null,
        source: {
          kind: 'issue',
          number: 88,
          title: 'Follow-up crash',
          url: 'https://github.com/acme/widgets/issues/88',
          repository: 'acme/widgets',
        },
        previousTitle: null,
        currentTitle: null,
      },
    ])
  })
})


describe('GitHub pull request list', () => {
  beforeEach(() => {
    resetPullRequestListCache()
  })

  test('loads summaries and check badges from one GraphQL list query', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-github-list-'))
    const bin = path.join(directory, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2)',
      "if (args[0] === 'repo' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({ nameWithOwner: 'acme/repo' }))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  const query = args.find((arg) => arg.startsWith('query=')) ?? ''",
      "  if (!query.includes('pullRequests(first: 20,') || !query.includes('pageInfo { hasNextPage endCursor }') || !query.includes('orderBy: {field: UPDATED_AT, direction: DESC}') || !query.includes('latestReviews(first: 100) { nodes { state author') || !query.includes('comments(last: 20) { nodes { author { __typename login } } }') || !query.includes('reviews(last: 20)') || !query.includes('statusCheckRollup { state }')) {",
      "    process.stderr.write('expected combined list query')",
      '    process.exit(1)',
      '  }',
      "  process.stdout.write(process.env.GH_TEST_GRAPHQL_JSON)",
      '  process.exit(0)',
      '}',
      "process.stderr.write('unexpected gh ' + args.join(' '))",
      'process.exit(1)',
    ].join('\n'))
    chmodSync(path.join(bin, 'gh'), 0o755)
    const originalPath = process.env.PATH
    const originalGraphql = process.env.GH_TEST_GRAPHQL_JSON
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.GH_TEST_GRAPHQL_JSON = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-20' },
            nodes: [
              {
                number: 12,
                title: 'Fast list',
                url: 'https://github.com/acme/repo/pull/12',
                state: 'OPEN',
                isDraft: false,
                baseRefName: 'main',
                headRefName: 'feature',
                additions: 3,
                deletions: 1,
                createdAt: '2026-03-01T10:00:00Z',
                updatedAt: '2026-03-01T11:00:00Z',
                author: { login: 'octocat' },
                assignees: { nodes: [] },
                reviewRequests: {
                  nodes: [{ requestedReviewer: { __typename: 'User', login: 'hubot' } }],
                },
                latestReviews: { nodes: [{ state: 'CHANGES_REQUESTED', author: { login: 'reviewer' } }] },
                comments: { nodes: [
                  { author: { __typename: 'User', login: 'octocat' } },
                  { author: { __typename: 'Bot', login: 'github-actions' } },
                  { author: { __typename: 'User', login: 'dependabot[bot]' } },
                  { author: null },
                  { author: { __typename: 'User', login: 'reviewer' } },
                ] },
                reviews: { nodes: [
                  { author: { __typename: 'User', login: 'hubot' } },
                ] },
                labels: { nodes: [] },
                commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
              },
              {
                number: 13,
                title: 'No checks',
                url: 'https://github.com/acme/repo/pull/13',
                state: 'OPEN',
                isDraft: true,
                baseRefName: 'main',
                headRefName: 'other',
                additions: 0,
                deletions: 0,
                createdAt: '2026-03-01T10:00:00Z',
                updatedAt: '2026-03-01T11:00:00Z',
                author: { login: 'hubot' },
                assignees: { nodes: [] },
                reviewRequests: { nodes: [] },
                latestReviews: { nodes: [{ state: 'APPROVED', author: { login: 'reviewer-two' } }] },
                labels: { nodes: [] },
                commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
              },
            ],
          },
        },
      },
    })
    try {
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({
        stale: false,
        pageInfo: { hasNextPage: true, endCursor: 'cursor-20' },
        items: [
        {
          number: 12,
          title: 'Fast list',
          checkStatus: 'fail',
          reviewers: [
            { login: 'hubot', kind: 'user', reviewStatus: 'none' },
            { login: 'reviewer', kind: 'user', reviewStatus: 'rejected' },
          ],
          commentCount: 2,
        },
        {
          number: 13,
          title: 'No checks',
          checkStatus: 'none',
          reviewers: [{ login: 'reviewer-two', kind: 'user', reviewStatus: 'approved' }],
          commentCount: 0,
        },
        ],
      })
    } finally {
      process.env.PATH = originalPath
      if (originalGraphql == null) delete process.env.GH_TEST_GRAPHQL_JSON
      else process.env.GH_TEST_GRAPHQL_JSON = originalGraphql
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('loads the next page after a cursor without replacing the first-page cache', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-github-list-page-'))
    const bin = path.join(directory, 'bin')
    mkdirSync(bin)
    writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2)',
      "if (args[0] === 'repo' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({ nameWithOwner: 'acme/repo' }))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      "  const query = args.find((arg) => arg.startsWith('query=')) ?? ''",
      "  if (query.includes('after:') && query.includes('cursor-20')) {",
      "    process.stdout.write(process.env.GH_TEST_GRAPHQL_PAGE_JSON)",
      '    process.exit(0)',
      '  }',
      "  process.stdout.write(process.env.GH_TEST_GRAPHQL_JSON)",
      '  process.exit(0)',
      '}',
      'process.exit(1)',
    ].join('\n'))
    chmodSync(path.join(bin, 'gh'), 0o755)
    const originalPath = process.env.PATH
    const originalGraphql = process.env.GH_TEST_GRAPHQL_JSON
    const originalPage = process.env.GH_TEST_GRAPHQL_PAGE_JSON
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    const node = (number: number, title: string) => ({
      number,
      title,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefName: 'feature',
      additions: 1,
      deletions: 0,
      createdAt: '2026-03-01T10:00:00Z',
      updatedAt: '2026-03-01T11:00:00Z',
      author: { login: 'octocat' },
      assignees: { nodes: [] },
      reviewRequests: { nodes: [] },
      latestReviews: { nodes: [] },
      labels: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    })
    process.env.GH_TEST_GRAPHQL_JSON = JSON.stringify({
      data: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: 'cursor-20' }, nodes: [node(12, 'First')] } } },
    })
    process.env.GH_TEST_GRAPHQL_PAGE_JSON = JSON.stringify({
      data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: 'cursor-40' }, nodes: [node(11, 'Older')] } } },
    })
    try {
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({
        items: [{ number: 12 }],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-20' },
      })
      await expect(listPullRequests(directory, 'open', { after: 'cursor-20' })).resolves.toMatchObject({
        items: [{ number: 11, title: 'Older' }],
        pageInfo: { hasNextPage: false, endCursor: 'cursor-40' },
      })
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({
        items: [{ number: 12 }],
        pageInfo: { hasNextPage: true, endCursor: 'cursor-20' },
      })
    } finally {
      process.env.PATH = originalPath
      if (originalGraphql == null) delete process.env.GH_TEST_GRAPHQL_JSON
      else process.env.GH_TEST_GRAPHQL_JSON = originalGraphql
      if (originalPage == null) delete process.env.GH_TEST_GRAPHQL_PAGE_JSON
      else process.env.GH_TEST_GRAPHQL_PAGE_JSON = originalPage
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('reuses a cached list without calling GitHub again', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-github-list-cache-'))
    const bin = path.join(directory, 'bin')
    const countFile = path.join(directory, 'list-count')
    mkdirSync(bin)
    writeFileSync(countFile, '0')
    writeFileSync(path.join(bin, 'gh'), [
      '#!/usr/bin/env node',
      'const fs = require("node:fs")',
      'const args = process.argv.slice(2)',
      `const countFile = ${JSON.stringify(countFile)}`,
      "if (args[0] === 'repo' && args[1] === 'view') {",
      "  process.stdout.write(JSON.stringify({ nameWithOwner: 'acme/cache-repo' }))",
      '  process.exit(0)',
      '}',
      "if (args[0] === 'api' && args[1] === 'graphql') {",
      '  const delay = Number(process.env.GH_TEST_LIST_DELAY_MS || 0)',
      '  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)',
      '  fs.writeFileSync(countFile, String(Number(fs.readFileSync(countFile, "utf8")) + 1))',
      "  process.stdout.write(process.env.GH_TEST_GRAPHQL_JSON)",
      '  process.exit(0)',
      '}',
      'process.exit(1)',
    ].join('\n'))
    chmodSync(path.join(bin, 'gh'), 0o755)
    const originalPath = process.env.PATH
    const originalGraphql = process.env.GH_TEST_GRAPHQL_JSON
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.GH_TEST_GRAPHQL_JSON = JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: 'cursor-1' },
            nodes: [{
              number: 12,
              title: 'Cached list',
              url: 'https://github.com/acme/cache-repo/pull/12',
              state: 'OPEN',
              isDraft: false,
              baseRefName: 'main',
              headRefName: 'feature',
              additions: 1,
              deletions: 0,
              createdAt: '2026-03-01T10:00:00Z',
              updatedAt: '2026-03-01T11:00:00Z',
              author: { login: 'octocat' },
              assignees: { nodes: [] },
              reviewRequests: { nodes: [] },
              latestReviews: { nodes: [] },
              labels: { nodes: [] },
              commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
            }],
          },
        },
      },
    })
    try {
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({
        stale: false,
        items: [{ number: 12, checkStatus: 'pass' }],
      })
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({
        stale: false,
        items: [{ number: 12, checkStatus: 'pass' }],
      })
      expect(readFileSync(countFile, 'utf8')).toBe('1')

      expirePullRequestListCache()
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({
        stale: true,
        items: [{ number: 12, checkStatus: 'pass' }],
      })
      await expect(listPullRequests(directory, 'open', { fresh: true })).resolves.toMatchObject({
        stale: false,
        items: [{ number: 12, checkStatus: 'pass' }],
      })
      expect(Number(readFileSync(countFile, 'utf8'))).toBeGreaterThanOrEqual(2)

      const first = listPullRequests(directory, 'open', { fresh: true })
      const second = listPullRequests(directory, 'open', { fresh: true })
      await Promise.all([first, second])
      const afterDedupe = Number(readFileSync(countFile, 'utf8'))

      expirePullRequestListCache()
      const originalGraphqlJson = process.env.GH_TEST_GRAPHQL_JSON
      process.env.GH_TEST_GRAPHQL_JSON = 'not-json'
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({ stale: true })
      await new Promise((resolve) => setTimeout(resolve, 50))
      process.env.GH_TEST_GRAPHQL_JSON = originalGraphqlJson
      await expect(listPullRequests(directory, 'open')).resolves.toMatchObject({
        stale: true,
        items: [{ number: 12 }],
      })

      process.env.GH_TEST_LIST_DELAY_MS = '80'
      const overlapping = listPullRequests(directory, 'open', { fresh: true })
      await invalidatePullRequestListCache(directory)
      await overlapping
      delete process.env.GH_TEST_LIST_DELAY_MS
      await listPullRequests(directory, 'open')
      expect(Number(readFileSync(countFile, 'utf8'))).toBeGreaterThan(afterDedupe)
    } finally {
      delete process.env.GH_TEST_LIST_DELAY_MS
      process.env.PATH = originalPath
      if (originalGraphql == null) delete process.env.GH_TEST_GRAPHQL_JSON
      else process.env.GH_TEST_GRAPHQL_JSON = originalGraphql
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
