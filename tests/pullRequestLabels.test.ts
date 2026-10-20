import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  addPullRequestLabel,
  listRepositoryLabels,
  removePullRequestLabel,
} from '../src/server/github.js'

type GitHubCall = { args: string[]; cwd: string; input: string }

type FakeGitHub = {
  root: string
  otherRoot: string
  reply: (output: string, error?: string) => void
  calls: () => GitHubCall[]
}

async function withFakeGitHub(run: (github: FakeGitHub) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'diff-review-github-labels-')))
  const bin = path.join(root, 'bin')
  const otherRoot = path.join(root, 'other-repository')
  const callsFile = path.join(root, 'calls.jsonl')
  const replyFile = path.join(root, 'reply.json')
  mkdirSync(bin)
  mkdirSync(otherRoot)
  writeFileSync(callsFile, '')
  writeFileSync(replyFile, JSON.stringify({ output: '[]', error: '' }))
  const gh = path.join(bin, 'gh')
  writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const input = fs.readFileSync(0, 'utf8')
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args, cwd: process.cwd(), input }) + '\\n')
const reply = JSON.parse(fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8'))
if (reply.error) {
  process.stderr.write(reply.error)
  process.exit(1)
}
process.stdout.write(reply.output)
`)
  chmodSync(gh, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`
  try {
    await run({
      root,
      otherRoot,
      reply: (output, error = '') => writeFileSync(replyFile, JSON.stringify({ output, error })),
      calls: () => readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as GitHubCall),
    })
  } finally {
    if (originalPath == null) delete process.env.PATH
    else process.env.PATH = originalPath
  }
}

describe('GitHub repository labels', () => {
  test('loads all label pages through the paginated slurped API', async () => {
    await withFakeGitHub(async ({ root, reply, calls }) => {
      reply(JSON.stringify([
        [{ name: 'bug', color: 'd73a4a' }],
        [],
        [{ name: 'needs review', color: 'abc123' }, { name: 'no color', color: null }],
      ]))
      await expect(listRepositoryLabels(root)).resolves.toEqual([
        { name: 'bug', color: 'd73a4a' },
        { name: 'needs review', color: 'abc123' },
        { name: 'no color', color: '8b949e' },
      ])
      expect(calls()).toEqual([{
        args: ['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/labels?per_page=100'],
        cwd: root,
        input: '',
      }])
    })
  })

  test('deduplicates concurrent requests and caches each repository for five minutes', async () => {
    await withFakeGitHub(async ({ root, otherRoot, reply, calls }) => {
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
      const originalLabels = [{ name: 'original', color: '111111' }]
      const updatedLabels = [{ name: 'updated', color: '222222' }]
      try {
        reply(JSON.stringify([originalLabels]))
        await expect(Promise.all([
          listRepositoryLabels(root),
          listRepositoryLabels(root),
        ])).resolves.toEqual([originalLabels, originalLabels])
        expect(calls()).toHaveLength(1)

        reply(JSON.stringify([updatedLabels]))
        clock.mockReturnValue(now + 5 * 60_000 - 1)
        await expect(listRepositoryLabels(root)).resolves.toEqual(originalLabels)
        expect(calls()).toHaveLength(1)

        await expect(listRepositoryLabels(otherRoot)).resolves.toEqual(updatedLabels)
        expect(calls().map((call) => call.cwd)).toEqual([root, otherRoot])

        clock.mockReturnValue(now + 5 * 60_000 + 1)
        await expect(listRepositoryLabels(root)).resolves.toEqual(updatedLabels)
        expect(calls().map((call) => call.cwd)).toEqual([root, otherRoot, root])
      } finally {
        clock.mockRestore()
      }
    })
  })

  test('propagates a failed request without caching the failure', async () => {
    await withFakeGitHub(async ({ root, reply, calls }) => {
      reply('', 'gh: API rate limit exceeded (HTTP 403)')
      await expect(listRepositoryLabels(root)).rejects.toThrow('API rate limit exceeded')
      reply('[[{"name":"retry succeeded","color":"123456"}]]')
      await expect(listRepositoryLabels(root)).resolves.toEqual([
        { name: 'retry succeeded', color: '123456' },
      ])
      expect(calls()).toHaveLength(2)
    })
  })

  test.each(['not JSON', '{}', '[{}]', '[[{"color":"ffffff"}]]'])(
    'rejects malformed label pages and allows retry: %s',
    async (output) => {
      await withFakeGitHub(async ({ root, reply, calls }) => {
        reply(output)
        await expect(listRepositoryLabels(root)).rejects.toThrow()
        reply('[[]]')
        await expect(listRepositoryLabels(root)).resolves.toEqual([])
        expect(calls()).toHaveLength(2)
      })
    },
  )
})

describe('GitHub pull request label mutations', () => {
  test('adds exactly one label using JSON stdin without normalizing its name', async () => {
    await withFakeGitHub(async ({ root, calls }) => {
      const label = '  needs / "review" & 日本語?#  '
      await addPullRequestLabel(root, 42, label)
      expect(calls()).toHaveLength(1)
      expect(calls()[0]).toMatchObject({
        args: ['api', '--method', 'POST', 'repos/{owner}/{repo}/issues/42/labels', '--input', '-'],
        cwd: root,
      })
      expect(JSON.parse(calls()[0].input)).toEqual({ labels: [label] })
    })
  })

  test('removes an existing label using an encoded path without changing its name', async () => {
    await withFakeGitHub(async ({ root, calls }) => {
      await removePullRequestLabel(root, 42, ' needs/review?#% 🐛 ')
      expect(calls()).toEqual([{
        args: [
          'api', '--method', 'DELETE',
          'repos/{owner}/{repo}/issues/42/labels/%20needs%2Freview%3F%23%25%20%F0%9F%90%9B%20',
        ],
        cwd: root,
        input: '',
      }])
    })
  })

  test.each([
    ['add', addPullRequestLabel],
    ['remove', removePullRequestLabel],
  ] as const)('%s rejects invalid input before executing gh', async (_name, mutate) => {
    await withFakeGitHub(async ({ root, calls }) => {
      for (const number of [0, -1, 1.5, NaN, Infinity]) {
        await expect(mutate(root, number, 'bug')).rejects.toThrow('Invalid pull request number')
      }
      for (const label of ['', ' \t\n ']) {
        await expect(mutate(root, 42, label)).rejects.toThrow('Label must not be empty')
      }
      expect(calls()).toEqual([])
    })
  })

  test.each([
    ['add', addPullRequestLabel],
    ['remove', removePullRequestLabel],
  ] as const)('%s propagates mutation failures', async (_name, mutate) => {
    await withFakeGitHub(async ({ root, reply, calls }) => {
      reply('', 'gh: Resource not accessible by integration (HTTP 403)')
      await expect(mutate(root, 42, 'bug')).rejects.toMatchObject({
        code: 'GITHUB_COMMAND_FAILED',
        message: 'gh: Resource not accessible by integration (HTTP 403)',
      })
      expect(calls()).toHaveLength(1)
    })
  })
})
