import { describe, expect, it } from 'vitest'

import { parseStoredPullRequestList } from '../src/client/pullRequestListCache'
import type { PullRequestListResponse, PullRequestSummary } from '../src/shared/types'

const summary: PullRequestSummary = {
  number: 1,
  title: 'Fix cache',
  url: 'https://example.test/pr/1',
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  headRefName: 'fix',
  additions: 1,
  deletions: 0,
  createdAt: '2026-03-22T00:00:00.000Z',
  updatedAt: '2026-03-22T00:00:00.000Z',
  author: { login: 'mhou', name: null, avatarUrl: null },
  assignees: [],
  reviewers: [],
  labels: [],
  checkStatus: 'pass',
  commentCount: 3,
}

const list: PullRequestListResponse = {
  items: [summary],
  fetchedAt: '2026-03-22T00:00:00.000Z',
  stale: false,
  pageInfo: { hasNextPage: false, endCursor: null },
}

function encode(payload: unknown): string {
  return JSON.stringify(payload)
}

describe('parseStoredPullRequestList', () => {
  it('returns undefined for empty, unversioned, or invalid payloads', () => {
    expect(parseStoredPullRequestList(null)).toBeUndefined()
    expect(parseStoredPullRequestList('')).toBeUndefined()
    expect(parseStoredPullRequestList('{')).toBeUndefined()
    expect(parseStoredPullRequestList(encode(list))).toBeUndefined()
    expect(parseStoredPullRequestList(encode({ version: 5, list: { fetchedAt: list.fetchedAt } }))).toBeUndefined()
    expect(parseStoredPullRequestList(encode({ version: 4, list }))).toBeUndefined()
    expect(parseStoredPullRequestList(encode({
      version: 5,
      list: { ...list, items: [{ ...summary, author: {} }] },
    }))).toBeUndefined()
  })

  it('reads a versioned list snapshot', () => {
    expect(parseStoredPullRequestList(encode({ version: 5, list }))).toEqual(list)
    expect(parseStoredPullRequestList(encode({ version: 5, list: { ...list, stale: true } }))).toEqual({
      ...list,
      stale: true,
    })
  })
})
