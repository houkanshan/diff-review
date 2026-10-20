import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { GitHubLabel } from '../src/shared/types'
import { labelOptions, PullRequestLabels } from '../src/client/PullRequestLabels'

const label = (name: string, color = 'aabbcc'): GitHubLabel => ({ name, color })

describe('pull request label options', () => {
  test('sorts selected labels first and alphabetizes each group', () => {
    const available = ['zebra', 'beta', 'alpha', 'delta'].map((name) => label(name))
    expect(labelOptions(available, [label('zebra'), label('delta')], '').map((item) => item.name))
      .toEqual(['delta', 'zebra', 'alpha', 'beta'])
    expect(available.map((item) => item.name)).toEqual(['zebra', 'beta', 'alpha', 'delta'])
  })

  test('keeps selected labels missing from a stale catalog and uses their latest metadata', () => {
    expect(labelOptions([label('bug', '000000'), label('alpha')], [label('missing'), label('bug')], ''))
      .toEqual([label('bug'), label('missing'), label('alpha')])
  })

  test('filters case-insensitively without losing selected-first order', () => {
    expect(labelOptions(
      [label('a review'), label('z review'), label('bug')],
      [label('z review')],
      'REVIEW',
    ).map((item) => item.name)).toEqual(['z review', 'a review'])
    expect(labelOptions([label('bug')], [], 'missing')).toEqual([])
  })

  test('reorders labels when selection changes', () => {
    const available = [label('alpha'), label('zebra')]
    expect(labelOptions(available, [label('zebra')], '').map((item) => item.name))
      .toEqual(['zebra', 'alpha'])
    expect(labelOptions(available, [], '').map((item) => item.name)).toEqual(['alpha', 'zebra'])
  })
})

describe('pull request Labels section', () => {
  test.each([
    { labels: [] },
    { labels: [label('bug')] },
    { labels: [label('additional-review-needed')] },
  ])('owns the edit button and assigned-label display for $labels', ({ labels }) => {
      const client = new QueryClient()
      try {
        const markup = renderToStaticMarkup(
          <QueryClientProvider client={client}>
            <PullRequestLabels repositoryPath="/test/repository" labels={labels} onSetLabel={async () => {}} />
          </QueryClientProvider>,
        )
        expect(markup).toContain('<section class="pr-sidebar-section pr-sidebar-labels-section" aria-label="Pull request labels">')
        expect(markup).toContain('<h2>Labels</h2>')
        expect(markup).toContain('aria-label="Edit labels"')
        if (labels.length === 0) expect(markup).toContain('No labels')
        else expect(markup).toContain(`>${labels[0].name}</span>`)
        if (labels.some((item) => item.name === 'additional-review-needed')) {
          expect(markup).toContain('Remove addi. label')
        }
      } finally {
        client.clear()
      }
    },
  )
})
