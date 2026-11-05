import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startService, spawn, readBodyFile } = vi.hoisted(() => ({
  readBodyFile: vi.fn(),
  startService: vi.fn().mockResolvedValue({}),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))
vi.mock('../src/server/service.js', () => ({ startService }))
vi.mock('../src/server/env.js', () => ({ loadEnvFiles: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  readFileSync: readBodyFile,
}))

const originalArgv = process.argv
const originalExitCode = process.exitCode
let output: ReturnType<typeof vi.spyOn>
let errors: ReturnType<typeof vi.spyOn>
let fetcher: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv('DIFF_REVIEW_PUBLIC_ORIGIN', '')
  vi.stubEnv('DIFF_REVIEW_TOKEN', '')
  vi.stubEnv('PI_MONITOR_TOKEN', '')
  vi.stubEnv('DIFF_REVIEW_PORT', '47658')
  output = vi.spyOn(console, 'log').mockImplementation(() => {})
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  fetcher = vi.fn().mockResolvedValue(Response.json({
    id: 'drs_test', repositoryRoot: '/repo', targetLabel: 'unstaged', gitCommand: 'git diff',
  }))
  vi.stubGlobal('fetch', fetcher)
})

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function run(args: string[]) {
  process.argv = ['node', 'diff-review', ...args]
  await import('../src/server/cli.js')
  await vi.waitFor(() => expect(output.mock.calls.length + errors.mock.calls.length).toBeGreaterThan(0))
}

describe('CLI review URLs', () => {
  for (const [origin, expected, tokenName] of [
    ['', 'http://127.0.0.1:47658', ''],
    ['http://ec2-dev:47659/', 'http://ec2-dev:47659', 'DIFF_REVIEW_TOKEN'],
    ['https://review.example.test/', 'https://review.example.test', 'PI_MONITOR_TOKEN'],
  ]) {
    for (const json of [false, true]) {
      for (const open of [false, true]) {
        it(`${origin || 'local fallback'}: ${json ? 'JSON' : 'text'}, ${open ? 'open' : 'session create'}`, async () => {
          vi.stubEnv('DIFF_REVIEW_PUBLIC_ORIGIN', origin!)
          if (tokenName) vi.stubEnv(tokenName, 'private-test-token')
          await run([...(open ? [] : ['session', 'create']), '--unstaged', ...(json ? ['--json'] : [])])
          const url = `${expected}/s/drs_test`
          if (json) expect(JSON.parse(output.mock.calls[0]![0]).url).toBe(url)
          else expect(output).toHaveBeenCalledWith(`Open: ${url}`)
          expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:47658/api/sessions', expect.objectContaining({
            method: 'POST',
            headers: tokenName
              ? { 'Content-Type': 'application/json', Authorization: 'Bearer private-test-token' }
              : { 'Content-Type': 'application/json' },
          }))
          if (open) expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([url]), expect.any(Object))
          else expect(spawn).not.toHaveBeenCalled()
          expect(JSON.stringify(output.mock.calls)).not.toContain('private-test-token')
          expect(errors).not.toHaveBeenCalled()
        })
      }
    }
  }

  it('preserves the configured local port', async () => {
    vi.stubEnv('DIFF_REVIEW_PORT', '47670')
    await run(['session', 'create', '--unstaged', '--json'])
    expect(JSON.parse(output.mock.calls[0]![0]).url).toBe('http://127.0.0.1:47670/s/drs_test')
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:47670/api/sessions', expect.any(Object))
  })

  it.each([
    'not-a-url', 'ftp://review.test', 'https://review.test/path',
    'https://user:secret@review.test', 'https://review.test?token=secret', 'https://review.test/#secret',
  ])('rejects malformed public origin %s before side effects', async (origin) => {
    vi.stubEnv('DIFF_REVIEW_PUBLIC_ORIGIN', origin)
    vi.stubEnv('DIFF_REVIEW_TOKEN', 'private-test-token')
    await run(['session', 'create', '--unstaged'])
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('DIFF_REVIEW_PUBLIC_ORIGIN must be an HTTP(S) origin'))
    expect(process.exitCode).toBe(1)
    expect(startService).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(output).not.toHaveBeenCalled()
  })

  it('requires the same configured token as daemon auth for a public URL', async () => {
    vi.stubEnv('DIFF_REVIEW_PUBLIC_ORIGIN', 'https://review.test')
    await run(['--unstaged'])
    expect(errors).toHaveBeenCalledWith('diff-review: DIFF_REVIEW_PUBLIC_ORIGIN requires a token')
    expect(process.exitCode).toBe(1)
    expect(startService).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('CLI narrative commands', () => {
  it.each([
    [['section', 'set', 'drs_test', 'RETRY', '--body', 'Overview', '--order', '9.5', '--json'], '/sections/RETRY', 'PUT', { body: 'Overview', order: 9.5 }],
    [['section', 'set', 'drs_test', 'RETRY', '--order', '-2', '--json'], '/sections/RETRY', 'PUT', { order: -2 }],
    [['section', 'set', 'drs_test', 'RETRY', '--body-file', '/tmp/overview', '--json'], '/sections/RETRY', 'PUT', { body: 'File content' }],
    [['annotation', 'add', 'drs_test', 'RETRY', '--file', 'a', '--new-line', '2-5', '--body', 'Note', '--json'], '/annotations', 'POST', { sectionPrefix: 'RETRY', filePath: 'a', side: 'new', startLine: 2, endLine: 5, comment: 'Note', source: 'agent' }],
    [['annotation', 'add', 'drs_test', 'RETRY', '--file', 'a', '--old-line', '3', '--body-file', '-', '--json'], '/annotations', 'POST', { sectionPrefix: 'RETRY', filePath: 'a', side: 'old', startLine: 3, endLine: 3, comment: 'File content', source: 'agent' }],
    [['annotation', 'update', 'drs_test', 'RETRY-1', '--body-file', '-', '--json'], '/annotations/RETRY-1/body', 'PATCH', { body: 'File content' }],
  ] as const)('sends explicit-session command %j', async (args, route, method, body) => {
    readBodyFile.mockReturnValue('File content')
    await run([...args])
    expect(errors).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:47658/api/sessions/drs_test' + route,
      expect.objectContaining({ method, body: JSON.stringify(body) }))
    if ((args as readonly string[]).includes('-')) expect(readBodyFile).toHaveBeenCalledWith(0, 'utf8')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('lists sections as unwrapped JSON', async () => {
    const sections = [{ prefix: 'RETRY', body: 'Overview', order: 10 }]
    fetcher.mockResolvedValue(Response.json(sections))
    await run(['section', 'list', 'drs_test', '--json'])
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:47658/api/sessions/drs_test/sections', expect.objectContaining({ method: 'GET' }))
    expect(JSON.parse(output.mock.calls[0]![0])).toEqual(sections)
  })

  it.each([
    ['section', 'set', 'drs_test', 'RETRY', '--body', 'Text', '--body-file', '-'],
    ['section', 'set', 'drs_test', 'RETRY', '--order', 'Infinity'],
    ['section', 'set', 'drs_test', 'RETRY', '--order', 'NaN'],
    ['annotation', 'add', 'drs_test', 'RETRY', '--file', 'a', '--new-line', '1'],
    ['annotation', 'update', 'drs_test', 'RETRY-1', '--body', ''],
    ['annotation', 'update', 'drs_test', 'RETRY-1', '--body', 'Text', '--importance', '0'],
  ])('rejects invalid input before requests: %j', async (...args) => {
    await run(args)
    expect(errors).toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['annotate', 'drs_test', '--importance', '0'],
    ['annotate', 'drs_test', '--file', 'a', '--new-line', '1', '--comment', 'Text', '--importance', '0.5'],
    ['annotate', 'drs_test', '--comment', 'Text', '--importance', '1'],
  ])('rejects importance even on legacy annotate: %j', async (...args) => {
    await run(args)
    expect(errors).toHaveBeenCalledWith('diff-review: --importance is no longer writable')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('retains legacy ungrouped annotate without importance', async () => {
    await run(['annotate', 'drs_test', '--file', 'a', '--new-line', '1', '--comment', 'Legacy', '--json'])
    expect(errors).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:47658/api/sessions/drs_test/annotations',
      expect.objectContaining({ body: JSON.stringify({ filePath: 'a', side: 'new', startLine: 1, endLine: 1, comment: 'Legacy', source: 'agent' }) }))
  })
})
