import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ApiHandler } from './api.js'
import { AppError } from './errors.js'
import { findPackageRoot } from './packageRoot.js'
import { ReviewStore } from './store.js'

export const DEFAULT_PORT = 47_658
export const DEFAULT_HOST = '127.0.0.1'

export async function serveDaemon(): Promise<void> {
  const port = Number(process.env.DIFF_REVIEW_PORT ?? DEFAULT_PORT)
  const host = process.env.DIFF_REVIEW_HOST ?? DEFAULT_HOST
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new AppError('UNSAFE_BIND_ADDRESS', 'Diff Review daemon only binds to loopback')
  }

  const store = new ReviewStore()
  const handler = new ApiHandler(store, findClientDirectory())
  const server = createServer((request, response) => {
    void handler.handle(request, response)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  console.log(`Diff Review daemon listening on http://${host}:${port}`)

  const close = () => {
    handler.close()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
}

function findClientDirectory(): string | null {
  const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)))
  if (packageRoot == null) return null
  const client = path.join(packageRoot, 'dist', 'client')
  return existsSync(path.join(client, 'index.html')) ? client : null
}
