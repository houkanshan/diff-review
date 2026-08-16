import { describe, expect, test } from 'vitest'

import { parseGitHubAttachmentUrl } from '../src/server/api.js'
import { aggregateCheckStatus, parsePullRequestChecks } from '../src/server/github.js'

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

describe('GitHub pull request checks', () => {
  test('reports no checks for an empty rollup', () => {
    expect(aggregateCheckStatus([])).toBe('none')
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
