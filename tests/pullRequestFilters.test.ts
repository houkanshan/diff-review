import { afterEach, describe, expect, test, vi } from 'vitest'
import { matchesPullRequestFilters, readPullRequestFilters } from '../src/client/pullRequestFilters'
import { writeStoredValue } from '../src/client/browserStorage'

const defaults = { excludeUserGuides: true, excludeE2e: true }
const item = (title: string, viewerDidAuthor = false) => ({
  title,
  viewerDidAuthor,
  author: { login: viewerDidAuthor ? 'me' : 'someone', name: null, avatarUrl: null },
})

afterEach(() => vi.unstubAllGlobals())

describe('pull request title exclusions', () => {
  test.each(['[User Guide] Update', '[User Guides] Update', '[E2E] Update', '[user guides] Update', '[e2e] Update'])(
    'excludes %s by default but preserves own PRs', (title) => {
      expect(matchesPullRequestFilters(item(title), defaults, '')).toBe(false)
      expect(matchesPullRequestFilters(item(title, true), defaults, '')).toBe(true)
    },
  )

  test.each(['Regular change', 'Fix [E2E] tests', '[User Guidance] Update', '[E2E tests] Update', 'User Guides update'])(
    'keeps nonmatching title %s', (title) => {
      expect(matchesPullRequestFilters(item(title), defaults, '')).toBe(true)
    },
  )

  test('toggles each exclusion independently and can disable both', () => {
    const cases = [
      { filters: defaults, guide: false, e2e: false },
      { filters: { ...defaults, excludeUserGuides: false }, guide: true, e2e: false },
      { filters: { ...defaults, excludeE2e: false }, guide: false, e2e: true },
      { filters: { excludeUserGuides: false, excludeE2e: false }, guide: true, e2e: true },
    ]
    for (const { filters, guide, e2e } of cases) {
      expect(matchesPullRequestFilters(item('[User Guide] Update'), filters, '')).toBe(guide)
      expect(matchesPullRequestFilters(item('[E2E] Update'), filters, '')).toBe(e2e)
    }
  })

  test('keeps the author filter independent, including for own PRs', () => {
    expect(matchesPullRequestFilters(item('[E2E] Mine', true), defaults, 'me')).toBe(true)
    expect(matchesPullRequestFilters(item('[E2E] Mine', true), defaults, 'someone')).toBe(false)
    expect(matchesPullRequestFilters(item('[E2E] Other'), defaults, 'someone')).toBe(false)
    expect(matchesPullRequestFilters(item('Regular'), defaults, 'someone')).toBe(true)
  })
})

describe('pull request filter preferences', () => {
  test('defaults both exclusions on and restores independent saved choices', () => {
    const values = new Map<string, string>()
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    } })
    expect(readPullRequestFilters()).toEqual(defaults)
    writeStoredValue('diff-review-exclude-user-guides', 'false')
    expect(readPullRequestFilters()).toEqual({ ...defaults, excludeUserGuides: false })
    writeStoredValue('diff-review-exclude-e2e', 'false')
    expect(readPullRequestFilters()).toEqual({ excludeUserGuides: false, excludeE2e: false })
    writeStoredValue('diff-review-exclude-user-guides', 'true')
    expect(readPullRequestFilters()).toEqual({ ...defaults, excludeE2e: false })
  })

  test('keeps default exclusions when browser storage is unavailable', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('Storage blocked') } })
    expect(readPullRequestFilters()).toEqual(defaults)
  })
})
