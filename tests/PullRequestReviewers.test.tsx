import { describe, expect, test } from 'vitest'
import type { GitHubReviewer } from '../src/shared/types'
import { reviewerIdentity, reviewerOptions } from '../src/client/PullRequestReviewers'

const user = (login: string, extra: Partial<GitHubReviewer> = {}): GitHubReviewer => ({
  login, name: null, avatarUrl: null, kind: 'user', reviewStatus: 'none', requested: false, ...extra,
})

describe('pull request reviewer options', () => {
  test('lists requested reviewers first, then past reviewers, then candidates', () => {
    const current = [user('zed', { reviewStatus: 'approved' }), user('yan', { requested: true })]
    expect(reviewerOptions([user('amy'), user('zed')], current, '').map((item) => item.login))
      .toEqual(['yan', 'zed', 'amy'])
  })

  test('keeps current state over candidate duplicates and matches team slugs', () => {
    const team = { ...user('acme/platform', { requested: true }), kind: 'team' as const }
    const options = reviewerOptions([{ ...user('platform'), kind: 'team' }], [team], '')
    expect(options).toEqual([team])
    expect(reviewerIdentity(team)).toBe('team:platform')
  })

  test('filters by login or name case-insensitively', () => {
    expect(reviewerOptions([user('octocat', { name: 'Mona' }), user('hubot')], [], 'MON').map((item) => item.login))
      .toEqual(['octocat'])
  })
})
