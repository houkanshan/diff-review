import type { Stats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

// Only Vite's content-hashed build assets are safe to cache across deployments.
const IMMUTABLE_ASSET = /^\/assets\/[^/]+-[\w-]{8}\.[a-z0-9]+$/i
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

type Encoding = 'br' | 'gzip' | 'identity'
interface OpenedFile {
  handle: FileHandle
  stat: Stats
}

function acceptedEncodings(header: string | undefined): Encoding[] {
  const qualities = new Map<string, number>()
  for (const part of (header ?? '').split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';')
    const q = parameters.find((parameter) => parameter.trim().startsWith('q='))
    const quality = q === undefined ? 1 : Number(q.trim().slice(2))
    qualities.set(name, Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : 0)
  }
  const quality = (encoding: Encoding) => qualities.get(encoding)
    ?? (encoding === 'identity' ? (qualities.get('*') === 0 ? 0 : 1) : (qualities.get('*') ?? 0))
  return (['br', 'gzip', 'identity'] as const)
    .filter((encoding) => quality(encoding) > 0)
    .sort((a, b) => quality(b) - quality(a))
}

async function openFile(filePath: string): Promise<OpenedFile | null> {
  try {
    const file = await open(filePath, 'r')
    try {
      const stat = await file.stat()
      if (stat.isFile()) return { handle: file, stat }
    } catch (error) {
      await file.close()
      throw error
    }
    await file.close()
    return null
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}

export async function serveStaticClient(
  request: IncomingMessage,
  response: ServerResponse,
  clientDirectory: string,
  pathname: string,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  // Never expose sidecars or dotfiles directly. URL parsing normalizes dot segments.
  if (pathname.split('/').some((segment) => segment.startsWith('.')) || /\.(?:br|gz)$/.test(pathname)) {
    response.writeHead(404).end()
    return
  }
  const root = path.resolve(clientDirectory)
  const candidate = path.resolve(root, pathname.replace(/^\//, '') || 'index.html')
  if (!candidate.startsWith(root + path.sep)) {
    response.writeHead(404).end()
    return
  }

  let filePath = candidate
  let file = await openFile(filePath)
  if (!file && !pathname.startsWith('/assets/') && !path.extname(pathname)) {
    filePath = path.join(root, 'index.html')
    file = await openFile(filePath)
  }
  if (!file) {
    response.writeHead(404).end()
    return
  }

  let encoding: Encoding = 'identity'
  try {
    const originalStat = file.stat
    for (const accepted of acceptedEncodings(request.headers['accept-encoding'])) {
      if (accepted === 'identity') break
      const compressed = await openFile(filePath + (accepted === 'br' ? '.br' : '.gz'))
      if (!compressed) continue
      // Ignore stale sidecars while a new build is replacing the original files.
      if (compressed.stat.mtimeMs < originalStat.mtimeMs) {
        await compressed.handle.close()
        continue
      }
      await file.handle.close()
      file = compressed
      encoding = accepted
      break
    }
    const stat = file.stat
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}-${encoding}"`
    response.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream')
    response.setHeader('Cache-Control', filePath === candidate && IMMUTABLE_ASSET.test(pathname)
      ? 'public, max-age=31536000, immutable' : 'no-cache')
    response.setHeader('ETag', etag)
    response.setHeader('Vary', 'Accept-Encoding')
    const validators = request.headers['if-none-match']?.split(',').map((value) => value.trim().replace(/^W\//, ''))
    if (validators?.some((value) => value === '*' || value === etag.replace(/^W\//, ''))) {
      response.writeHead(304).end()
      return
    }
    response.setHeader('Content-Length', stat.size)
    if (encoding !== 'identity') response.setHeader('Content-Encoding', encoding)
    response.writeHead(200)
    if (request.method === 'HEAD') response.end()
    else await pipeline(file.handle.createReadStream({ autoClose: false }), response)
  } finally {
    await file.handle.close()
  }
}
