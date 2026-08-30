import { execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  daemonClientUrl,
  daemonPidPath,
  dataDirectory,
  DEFAULT_PORT,
} from './daemon.js'
import { AppError } from './errors.js'

export type ServiceCommand = 'status' | 'start' | 'stop' | 'restart'

export type ServiceStatus =
  | { state: 'stopped' }
  | { state: 'running'; pid: number | null; url: string }
  | { state: 'unhealthy'; pid: number; url: string }

export function parseServiceCommand(value: string | undefined): ServiceCommand | null {
  if (value === 'status' || value === 'start' || value === 'stop' || value === 'restart') {
    return value
  }
  return null
}

export async function runService(command: ServiceCommand, cliPath: string): Promise<ServiceStatus> {
  switch (command) {
    case 'status':
      return getServiceStatus()
    case 'start':
      return startService(cliPath)
    case 'stop':
      return stopService()
    case 'restart':
      return restartService(cliPath)
  }
}

export async function getServiceStatus(): Promise<ServiceStatus> {
  const url = daemonClientUrl()
  const ready = await daemonIsReady()
  const pid = resolveDaemonPid(ready)
  if (ready) return { state: 'running', pid, url }
  if (pid != null) return { state: 'unhealthy', pid, url }
  return { state: 'stopped' }
}

export async function startService(cliPath: string): Promise<ServiceStatus> {
  const current = await getServiceStatus()
  if (current.state === 'running') return current
  if (current.state === 'unhealthy') await stopService()

  const directory = dataDirectory()
  mkdirSync(directory, { recursive: true })
  const log = openSync(path.join(directory, 'daemon.log'), 'a')
  const child = spawn(process.execPath, [cliPath, 'daemon', 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  })
  child.unref()
  closeSync(log)

  if (child.pid == null) {
    throw new AppError(
      'DAEMON_START_FAILED',
      `Could not start the local daemon. See ${path.join(directory, 'daemon.log')}`,
    )
  }
  writePid(child.pid)

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100)
    if (await daemonIsReady()) return getServiceStatus()
  }
  throw new AppError(
    'DAEMON_START_FAILED',
    `Could not start the local daemon. See ${path.join(directory, 'daemon.log')}`,
  )
}

export async function stopService(): Promise<ServiceStatus> {
  const current = await getServiceStatus()
  if (current.state === 'stopped') return current
  const pid = current.pid
  if (pid == null) {
    throw new AppError('DAEMON_STOP_FAILED', 'The daemon is running but its process id could not be found')
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new AppError('DAEMON_STOP_FAILED', `Could not stop the local daemon (pid ${pid})`)
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100)
    if (!processAlive(pid)) {
      clearPidFile(pid)
      return { state: 'stopped' }
    }
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new AppError('DAEMON_STOP_FAILED', `Could not stop the local daemon (pid ${pid})`)
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(50)
    if (!processAlive(pid)) {
      clearPidFile(pid)
      return { state: 'stopped' }
    }
  }

  throw new AppError('DAEMON_STOP_FAILED', `Could not stop the local daemon (pid ${pid})`)
}

export async function restartService(cliPath: string): Promise<ServiceStatus> {
  await stopService()
  return startService(cliPath)
}

export function formatServiceStatus(status: ServiceStatus): string {
  if (status.state === 'stopped') return 'stopped'
  const pid = status.pid == null ? 'unknown' : String(status.pid)
  return `${status.state}\npid ${pid}\n${status.url}`
}

export async function daemonIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`${daemonClientUrl()}/api/health`)
    if (!response.ok) return false
    const body = (await response.json()) as { app?: string; ok?: boolean }
    return body.app === 'diff-review' && body.ok === true
  } catch {
    return false
  }
}

function resolveDaemonPid(ready: boolean): number | null {
  const stored = readPidFile()
  if (ready) {
    const listener = findListenerPid(daemonPort())
    if (listener != null && processAlive(listener)) return listener
    if (stored != null && processAlive(stored)) return stored
    return null
  }
  if (stored != null && processAlive(stored) && isDaemonProcess(stored)) return stored
  if (stored != null) clearPidFile(stored)
  return null
}

function daemonPort(): number {
  return Number(process.env.DIFF_REVIEW_PORT ?? DEFAULT_PORT)
}

function readPidFile(): number | null {
  try {
    const pid = Number(readFileSync(daemonPidPath(), 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function writePid(pid: number): void {
  mkdirSync(dataDirectory(), { recursive: true })
  writeFileSync(daemonPidPath(), `${pid}\n`)
}

function clearPidFile(pid: number): void {
  try {
    if (readPidFile() === pid) unlinkSync(daemonPidPath())
  } catch {
    // ignore
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function isDaemonProcess(pid: number): boolean {
  try {
    const args = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return args.includes('daemon serve')
  } catch {
    return false
  }
}

function findListenerPid(port: number): number | null {
  try {
    const stdout = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    for (const line of stdout.split('\n')) {
      const pid = Number(line.trim())
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    return null
  } catch {
    return null
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
