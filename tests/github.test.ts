import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  extractIssueReferenceTargets,
  remarkIssueReferences,
} from '../src/shared/markdown.js'

import { parseGitHubAttachmentUrl } from '../src/server/api.js'
import {
  aggregateCheckStatus,
  addPullRequestComment,
  parsePullRequestChecks,
  parsePullRequestMergeable,
  parsePullRequestReviewers,
  pendingReviewComments,
  parsePullRequestTimelineEvents,
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
    writeFileSync(gh, `#!/bin/sh
printf '%s\\n' '---' >> "$GH_TEST_OUTPUT"
printf '<%s>\\n' "$@" >> "$GH_TEST_OUTPUT"
cat >> "$GH_TEST_INPUT"
printf '%s\\n' '{"merged":true,"message":"Pull Request successfully merged"}'
`)
    chmodSync(gh, 0o755)
    const originalPath = process.env.PATH
    const originalOutput = process.env.GH_TEST_OUTPUT
    const originalInput = process.env.GH_TEST_INPUT
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
    process.env.GH_TEST_OUTPUT = calls
    process.env.GH_TEST_INPUT = input
    try {
      await addPullRequestComment(directory, 42, 'A conversation comment')
      await submitPullRequestReview(
        directory,
        42,
        'REQUEST_CHANGES',
        'Please revise this',
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
      expect(output).toContain('<repos/{owner}/{repo}/pulls/42/reviews>')
      expect(output).toContain('<--input>')
      const review = JSON.parse(readFileSync(input, 'utf8'))
      expect(review).toEqual({
        event: 'REQUEST_CHANGES',
        body: 'Please revise this',
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
      diff_hunk: '@@ -16,2 +16,3 @@\n context\n+selected code',
      created_at: '2026-03-01T10:00:00Z',
      updated_at: '2026-03-01T10:01:00Z',
      html_url: 'https://github.com/acme/repo/pull/1#discussion_r42',
    })).toMatchObject({
      kind: 'review-comment',
      path: 'src/example.ts',
      line: 18,
      side: 'new',
      diffHunk: '@@ -16,2 +16,3 @@\n context\n+selected code',
    })
  })
})


describe('GitHub issue references in Markdown', () => {
  test('extracts references from list text without treating CommonMark code as content', () => {
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
      'close #21',
    ].join('\n')

    expect(extractIssueReferenceTargets([markdown])).toEqual([
      { token: '#13', owner: null, repository: null, number: 13 },
      { token: 'acme/other#16', owner: 'acme', repository: 'other', number: 16 },
      { token: '#17', owner: null, repository: null, number: 17 },
      { token: 'acme/other#18', owner: 'acme', repository: 'other', number: 18 },
    ])
  })

  test('deduplicates references across Markdown bodies', () => {
    expect(extractIssueReferenceTargets(['- #12', '* #12', '1. #13'])).toEqual([
      { token: '#12', owner: null, repository: null, number: 12 },
      { token: '#13', owner: null, repository: null, number: 13 },
    ])
  })

  test('inserts issue titles as literal AST text', () => {
    const title = '<img src="https://example.com/tracker.png"> *bold* `code`'
    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkIssueReferences, {
        references: [{
          token: '#11160',
          label: '#11160',
          kind: 'issue',
          owner: 'acme',
          repository: 'repo',
          number: 11160,
          title,
          url: 'https://github.com/acme/repo/issues/11160',
        }],
      })
    const tree = processor.runSync(processor.parse('- close #11160 after'))

    expect(tree).toMatchObject({
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
  })
})

describe('GitHub pull request sidebar data', () => {
  test('validates mergeability states', () => {
    expect(parsePullRequestMergeable('MERGEABLE')).toBe('MERGEABLE')
    expect(parsePullRequestMergeable('conflicting')).toBe('CONFLICTING')
    expect(() => parsePullRequestMergeable('blocked')).toThrow(/mergeable state/)
  })

  test('preserves user and team review requests', () => {
    expect(parsePullRequestReviewers([
      { __typename: 'User', login: 'octocat' },
      { __typename: 'Team', name: 'Platform', slug: 'acme/platform' },
    ], [
      { author: { login: 'octocat' } },
      { author: { login: 'completed-reviewer', name: 'Completed Reviewer' } },
    ])).toEqual([
      {
        kind: 'user',
        login: 'octocat',
        name: null,
        avatarUrl: 'https://github.com/octocat.png?size=64',
      },
      { kind: 'team', login: 'acme/platform', name: 'Platform', avatarUrl: null },
      {
        kind: 'user',
        login: 'completed-reviewer',
        name: 'Completed Reviewer',
        avatarUrl: 'https://github.com/completed-reviewer.png?size=64',
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
        author: { date: '2026-03-01T11:00:00Z' },
        message: 'Refine timeline\n\nDetails',
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
        previousTitle: null,
        currentTitle: null,
      },
      {
        kind: 'timeline',
        id: '1234567890abcdef',
        event: 'committed',
        author: null,
        createdAt: '2026-03-01T11:00:00Z',
        label: null,
        subject: 'Refine timeline',
        commitId: '1234567890abcdef',
        previousTitle: null,
        currentTitle: null,
      },
    ])
  })
})
