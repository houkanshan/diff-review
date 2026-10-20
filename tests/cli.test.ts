import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { startService, spawn } = vi.hoisted(() => ({
  startService: vi.fn().mockResolvedValue({}),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))
vi.mock('../src/server/service.js', () => ({ startService }))
vi.mock('../src/server/env.js', () => ({ loadEnvFiles: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))

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
