import { describe, expect, test } from 'vitest'

import { groupConversationActivities } from '../src/shared/pullRequestActivity.js'
import type { GitHubUser, PullRequestActivity } from '../src/shared/types.js'

const author: GitHubUser = { login: 'reviewer', name: null, avatarUrl: null }

function review(
  id: string,
  body: string,
  createdAt: string,
  state = 'COMMENTED',
): PullRequestActivity {
  return {
    kind: 'review',
    id,
    author,
    body,
    state,
    createdAt,
    updatedAt: createdAt,
    url: null,
  }
}

function comment(
  id: string,
  body: string,
  createdAt: string,
  reviewId: string | null,
  replyToId: string | null = null,
): PullRequestActivity {
  return {
    kind: 'review-comment',
    id,
    author,
    body,
    path: 'src/example.ts',
    line: 12,
    side: 'new',
    reviewId,
    replyToId,
    createdAt,
    updatedAt: createdAt,
    url: null,
    diffHunk: '',
    minimizedReason: null,
  }
}

describe('groupConversationActivities', () => {
  test('keeps submitted review comments and later replies under the original review', () => {
    const groups = groupConversationActivities([
      comment('A', 'A', '2026-03-01T10:00:00Z', 'D'),
      comment('B', 'B', '2026-03-01T10:01:00Z', 'D'),
      comment('C', 'C', '2026-03-01T10:02:00Z', 'D'),
      review('D', 'D', '2026-03-01T10:03:00Z'),
      comment('E', 'E', '2026-03-01T11:00:00Z', 'later', 'B'),
      review('later', '', '2026-03-01T11:00:01Z'),
      comment('F', 'F', '2026-03-01T11:01:00Z', 'F-review', 'E'),
      review('F-review', '', '2026-03-01T11:01:01Z'),
    ])

    expect(groups).toMatchObject([
      {
        kind: 'review-group',
        review: { id: 'D', body: 'D' },
        comments: [
          { comment: { id: 'A' }, replies: [] },
          { comment: { id: 'B' }, replies: [{ id: 'E' }, { id: 'F' }] },
          { comment: { id: 'C' }, replies: [] },
        ],
      },
    ])
  })

  test('hides empty comment-only reviews that only exist to carry replies', () => {
    const groups = groupConversationActivities([
      review('empty', '', '2026-03-01T10:00:00Z'),
      review('approved', '', '2026-03-01T10:01:00Z', 'APPROVED'),
    ])

    expect(groups).toMatchObject([
      { kind: 'review-group', review: { id: 'approved' }, comments: [] },
    ])
  })

  test('still collapses adjacent matching timeline events', () => {
    const labeled = (id: string, createdAt: string): PullRequestActivity => ({
      kind: 'timeline',
      id,
      event: 'labeled',
      author,
      createdAt,
      label: 'bug',
      subject: null,
      commitId: null,
      source: null,
      previousTitle: null,
    })

    expect(groupConversationActivities([
      labeled('1', '2026-03-01T10:00:00Z'),
      labeled('2', '2026-03-01T10:01:00Z'),
    ])).toMatchObject([
      { kind: 'item', activity: { id: '1' }, count: 2 },
    ])
  })
})
