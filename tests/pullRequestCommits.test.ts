import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi, afterEach } from 'vitest'

import { PullRequestCommits } from '../src/client/PullRequestCommits'
import type { CommitSummary } from '../src/shared/types'

const pullRequestUrl = 'https://github.com/example/repo/pull/42'
function commits(count: number): CommitSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    oid: String(index + 1).padStart(40, '0'),
    shortOid: `sha${index + 1}`,
    subject: `Message ${index + 1}`,
    author: 'Ada Lovelace',
    authoredAt: '2026-01-01T10:00:00Z',
  }))
}
function render(items: CommitSummary[]): string {
  return renderToStaticMarkup(createElement(PullRequestCommits, { commits: items, pullRequestUrl }))
}
function messages(markup: string): string[] {
  return [...markup.matchAll(/title="(Message \d+)"/g)].map((match) => match[1])
}

afterEach(() => vi.useRealTimers())

describe('Pull request sidebar commits', () => {
  test('omits the section when commits are unavailable', () => {
    expect(render([])).toBe('')
  })

  test('shows up to ten commits newest first without a collapse control', () => {
    const items = commits(10)
    const markup = render(items)
    expect(messages(markup)).toEqual([
      'Message 10', 'Message 9', 'Message 8', 'Message 7', 'Message 6',
      'Message 5', 'Message 4', 'Message 3', 'Message 2', 'Message 1',
    ])
    expect(markup).not.toContain('<details')
    expect(items[0].subject).toBe('Message 1')
  })

  test.each([11, 25])('keeps five commits at each end and collapses the middle of %i commits', (count) => {
    const markup = render(commits(count))
    const [before, remainder] = markup.split('<details')
    const [middle, after] = remainder.split('</details>')
    expect(messages(before)).toEqual(Array.from({ length: 5 }, (_, index) => `Message ${count - index}`))
    expect(messages(after)).toEqual(['Message 5', 'Message 4', 'Message 3', 'Message 2', 'Message 1'])
    expect(messages(middle)).toHaveLength(count - 10)
    expect(middle).not.toMatch(/\bopen(?:=|>)/)
    expect(middle).toContain(`Show ${count - 10} more ${count === 11 ? 'commit' : 'commits'}`)
    expect(middle).toContain('Hide middle commits')
    expect(messages(markup)).toEqual(Array.from({ length: count }, (_, index) => `Message ${count - index}`))
  })

  test('displays the SHA, message, author and compact time with a full timestamp tooltip', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'))
    const markup = render(commits(1))
    expect(markup).toContain('<code>sha1</code>')
    expect(markup).toContain('Message 1')
    expect(markup).toContain('Ada Lovelace')
    expect(markup).toContain('dateTime="2026-01-01T10:00:00Z"')
    expect(markup).toMatch(/<time[^>]+title="[^"]+">2h<\/time>/)
    expect(markup).toContain(`${pullRequestUrl}/commits/${'1'.padStart(40, '0')}`)
  })

  test('does not render an invalid time when a commit has no timestamp', () => {
    expect(render([{ ...commits(1)[0], authoredAt: '' }])).not.toContain('<time')
  })
})
