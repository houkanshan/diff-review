import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ApiHandler } from './api.js'
import { browserOrigin, configuredToken } from './auth.js'
import { AppError } from './errors.js'
import { findPackageRoot } from './packageRoot.js'
import { ReviewStore } from './store.js'

export const DEFAULT_PORT = 47_658
export const DEFAULT_HOST = '127.0.0.1'

export function dataDirectory(): string {
  return process.env.DIFF_REVIEW_DATA_DIR ?? path.join(homedir(), '.diff-review')
}

export function daemonPidPath(): string {
  return path.join(dataDirectory(), 'daemon.pid')
}

export function daemonClientUrl(): string {
  return `http://${DEFAULT_HOST}:${process.env.DIFF_REVIEW_PORT ?? DEFAULT_PORT}`
}

/** An explicit HTTP entry is separate from the private, always-loopback API listener. */
export function publicListenerConfig(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } | null {
  const host = env.DIFF_REVIEW_PUBLIC_LISTEN_HOST
  if (!host) return null
  const family = isIP(host)
  const canonicalHost = family === 6 ? new URL(`http://[${host}]`).hostname : host
  if (!family || ['0.0.0.0', '[::]', '[::ffff:0:0]'].includes(canonicalHost)) {
    throw new AppError('UNSAFE_BIND_ADDRESS', 'DIFF_REVIEW_PUBLIC_LISTEN_HOST must be one explicit interface IP, not a wildcard')
  }
  if (!env.DIFF_REVIEW_PUBLIC_ORIGIN || !configuredToken(env)) {
    throw new AppError('UNSAFE_PUBLIC_ENTRY', 'The public listener requires DIFF_REVIEW_PUBLIC_ORIGIN and a token')
  }
  const origin = new URL(browserOrigin(env.DIFF_REVIEW_PUBLIC_ORIGIN))
  const port = Number(origin.port)
  if (origin.protocol !== 'http:' || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new AppError('UNSAFE_PUBLIC_ENTRY', 'The built-in public listener requires an explicit HTTP origin on an unprivileged port; HTTPS uses an external TLS entry')
  }
  return { host, port }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    server.once('error', failed)
    server.listen(port, host, () => {
      server.removeListener('error', failed)
      resolve()
    })
  })
}

export async function serveDaemon(): Promise<void> {
  const port = Number(process.env.DIFF_REVIEW_PORT ?? DEFAULT_PORT)
  const host = process.env.DIFF_REVIEW_HOST ?? DEFAULT_HOST
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new AppError('UNSAFE_BIND_ADDRESS', 'Diff Review private API only binds to loopback')
  }
  const publicEntry = publicListenerConfig()
  const store = new ReviewStore()
  const handler = new ApiHandler(store, findClientDirectory())
  const servers = [createServer(handler.handle)]
  if (publicEntry) servers.push(createServer(handler.handlePublic))
  try {
    await listen(servers[0]!, port, host)
    if (publicEntry) await listen(servers[1]!, publicEntry.port, publicEntry.host)
    writeOwnPidFile()
  } catch (error) {
    handler.close()
    for (const server of servers) {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    throw error
  }

  console.log(`Diff Review private API listening on http://${host}:${port}`)
  if (publicEntry) console.log(`Diff Review authenticated HTTP entry listening on ${process.env.DIFF_REVIEW_PUBLIC_ORIGIN}; HTTP does not provide transport encryption`)

  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    removeOwnPidFile()
    handler.close()
    for (const server of servers) server.closeAllConnections()
    void Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))).then(() => process.exit(0))
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}

function writeOwnPidFile(): void {
  mkdirSync(dataDirectory(), { recursive: true })
  writeFileSync(daemonPidPath(), `${process.pid}\n`)
}

function removeOwnPidFile(): void {
  try {
    const stored = Number(readFileSync(daemonPidPath(), 'utf8').trim())
    if (stored === process.pid) unlinkSync(daemonPidPath())
  } catch {
    // ignore
  }
}

function findClientDirectory(): string | null {
  const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)))
  if (packageRoot == null) return null
  const client = path.join(packageRoot, 'dist', 'client')
  return existsSync(path.join(client, 'index.html')) ? client : null
}
