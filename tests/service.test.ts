import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, test } from 'vitest'

import { daemonPidPath } from '../src/server/daemon.js'
import {
  formatServiceStatus,
  getServiceStatus,
  parseServiceCommand,
  restartService,
  startService,
  stopService,
} from '../src/server/service.js'

const fakeDaemon = fileURLToPath(new URL('./fixtures/fake-daemon.mjs', import.meta.url))

const previousPort = process.env.DIFF_REVIEW_PORT
const previousDataDir = process.env.DIFF_REVIEW_DATA_DIR
const tempDirs: string[] = []
let isolated = false

afterEach(async () => {
  if (!isolated) return
  try {
    await stopService()
  } catch {
    // ignore leftover daemons that already exited
  }
  isolated = false
  if (previousPort == null) delete process.env.DIFF_REVIEW_PORT
  else process.env.DIFF_REVIEW_PORT = previousPort
  if (previousDataDir == null) delete process.env.DIFF_REVIEW_DATA_DIR
  else process.env.DIFF_REVIEW_DATA_DIR = previousDataDir
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('service commands', () => {
  test('parses status, start, restart, and stop', () => {
    expect(parseServiceCommand('status')).toBe('status')
    expect(parseServiceCommand('start')).toBe('start')
    expect(parseServiceCommand('restart')).toBe('restart')
    expect(parseServiceCommand('stop')).toBe('stop')
    expect(parseServiceCommand('serve')).toBeNull()
    expect(parseServiceCommand(undefined)).toBeNull()
  })

  test('formats stopped, running, and unhealthy snapshots', () => {
    expect(formatServiceStatus({ state: 'stopped' })).toBe('stopped')
    expect(
      formatServiceStatus({ state: 'running', pid: 12, url: 'http://127.0.0.1:47658' }),
    ).toBe('running\npid 12\nhttp://127.0.0.1:47658')
    expect(
      formatServiceStatus({ state: 'running', pid: null, url: 'http://127.0.0.1:47658' }),
    ).toBe('running\npid unknown\nhttp://127.0.0.1:47658')
    expect(
      formatServiceStatus({ state: 'unhealthy', pid: 9, url: 'http://127.0.0.1:47658' }),
    ).toBe('unhealthy\npid 9\nhttp://127.0.0.1:47658')
  })
})

describe('service lifecycle', () => {
  test('start, status, restart, and stop are idempotent', async () => {
    isolateService()

    expect(await getServiceStatus()).toEqual({ state: 'stopped' })
    expect(await stopService()).toEqual({ state: 'stopped' })

    const started = await startService(fakeDaemon)
    expect(started.state).toBe('running')
    expect(started).toMatchObject({ url: daemonUrl() })
    if (started.state !== 'running') throw new Error('expected running')
    expect(started.pid).toEqual(expect.any(Number))

    const again = await startService(fakeDaemon)
    expect(again).toEqual(started)

    const restarted = await restartService(fakeDaemon)
    expect(restarted.state).toBe('running')
    if (restarted.state !== 'running') throw new Error('expected running')
    expect(restarted.pid).not.toBe(started.pid)
    expect(restarted.url).toBe(started.url)

    expect(await stopService()).toEqual({ state: 'stopped' })
    expect(await stopService()).toEqual({ state: 'stopped' })
    expect(await getServiceStatus()).toEqual({ state: 'stopped' })
  }, 20_000)

  test('stop finds a healthy daemon even without a pid file', async () => {
    isolateService()
    const started = await startService(fakeDaemon)
    expect(started.state).toBe('running')
    unlinkSync(daemonPidPath())

    expect(await stopService()).toEqual({ state: 'stopped' })
    expect(await getServiceStatus()).toEqual({ state: 'stopped' })
  }, 20_000)

  test('clears a stale pid file when status is stopped', async () => {
    isolateService()
    writeFileSync(daemonPidPath(), '9999999\n')
    expect(await getServiceStatus()).toEqual({ state: 'stopped' })
  })
})

function isolateService(): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-service-'))
  tempDirs.push(directory)
  process.env.DIFF_REVIEW_DATA_DIR = directory
  process.env.DIFF_REVIEW_PORT = String(17_000 + Math.floor(Math.random() * 10_000))
  isolated = true
}

function daemonUrl(): string {
  return `http://127.0.0.1:${process.env.DIFF_REVIEW_PORT}`
}
