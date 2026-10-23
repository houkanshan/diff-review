import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { ApiHandler } from '../src/server/api'
import { ApiAuth } from '../src/server/auth'
import { ReviewStore } from '../src/server/store'

const assetPath = '/assets/index-aB_12-34.js'
const source = 'console.log("static fixture");'.repeat(200)
const html = '<!doctype html><div id="root"></div>'

async function withClient(run: (client: {
  directory: string
  get: (pathname: string, headers?: Record<string, string>, method?: string) => Promise<{
    status: number
    headers: IncomingHttpHeaders
    body: Buffer
  }>
}) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'diff-review-static-'))
  const handler = new ApiHandler(new ReviewStore(':memory:'), directory, new ApiAuth({ DIFF_REVIEW_TOKEN: 'test-token' }))
  const server = createServer(handler.handle)
  try {
    await mkdir(path.join(directory, 'assets'))
    await writeFile(path.join(directory, 'index.html'), html)
    await writeFile(path.join(directory, assetPath), source)
    await writeFile(path.join(directory, assetPath + '.br'), brotliCompressSync(source))
    await writeFile(path.join(directory, assetPath + '.gz'), gzipSync(source))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    await run({
      directory,
      get: (pathname, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 2000 }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('error', reject)
          response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }))
        })
        request.on('timeout', () => request.destroy(new Error(`Timed out: ${method} ${pathname}`)))
        request.on('error', reject)
        request.end()
      }),
    })
  } finally {
    handler.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

describe('production static client', () => {
  it('caches hashed assets but revalidates HTML and unversioned files', async () => {
    await withClient(async ({ get, directory }) => {
      const asset = await get(assetPath)
      expect(asset.status).toBe(200)
      expect(asset.body.toString()).toBe(source)
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable')
      expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8')
      expect(asset.headers['content-length']).toBe(String(Buffer.byteLength(source)))
      expect(asset.headers.etag).toBeTruthy()
      expect(asset.headers.vary).toBe('Accept-Encoding')
      await writeFile(path.join(directory, 'favicon.svg'), '<svg/>')
      for (const pathname of ['/', '/index.html', '/s/drs_example', '/pull-requests', '/favicon.svg']) {
        const response = await get(pathname)
        expect(response.status).toBe(200)
        expect(response.headers['cache-control']).toBe('no-cache')
        expect(response.headers.etag).toBeTruthy()
      }
      await writeFile(path.join(directory, 'index.html'), html + '<!-- new build -->')
      const before = await get('/')
      await writeFile(path.join(directory, 'index.html'), html + '<!-- next build -->')
      const next = await get('/', { 'If-None-Match': before.headers.etag! })
      expect(next.status).toBe(200)
      expect(next.body.toString()).toContain('next build')
    })
  })

  it.each([
    ['br, gzip', 'br'],
    ['br;q=0, gzip', 'gzip'],
    ['br;q=0.5, gzip;q=0.8, identity;q=0', 'gzip'],
    ['BR; Q=1, gzip', 'br'],
    ['*;q=1', 'br'],
    ['identity', undefined],
    ['br;q=0, gzip;q=0', undefined],
    ['', undefined],
  ])('negotiates %s as %s', async (accept, encoding) => {
    await withClient(async ({ get }) => {
      const response = await get(assetPath, { 'Accept-Encoding': accept })
      expect(response.status).toBe(200)
      expect(response.headers['content-encoding']).toBe(encoding)
      expect(response.body).toEqual(encoding === 'br' ? brotliCompressSync(source)
        : encoding === 'gzip' ? gzipSync(source) : Buffer.from(source))
      expect(response.headers['content-length']).toBe(String(response.body.length))
    })
  })

  it('validates GET and HEAD with weak tags, lists and wildcard without sending bytes', async () => {
    await withClient(async ({ get }) => {
      const initial = await get(assetPath, { 'Accept-Encoding': 'br' })
      const etag = initial.headers.etag!
      for (const validator of [etag, etag.replace('W/', ''), `"other", ${etag}`, '*']) {
        for (const method of ['GET', 'HEAD']) {
          const response = await get(assetPath, { 'Accept-Encoding': 'br', 'If-None-Match': validator }, method)
          expect(response.status).toBe(304)
          expect(response.body.length).toBe(0)
          expect(response.headers.etag).toBe(etag)
          expect(response.headers.vary).toBe('Accept-Encoding')
          expect(response.headers['cache-control']).toContain('immutable')
        }
      }
      const identity = await get(assetPath, { 'If-None-Match': etag })
      expect(identity.status).toBe(200)
      expect(identity.body.toString()).toBe(source)
      const head = await get(assetPath, { 'Accept-Encoding': 'br' }, 'HEAD')
      expect(head.status).toBe(200)
      expect(head.body.length).toBe(0)
      expect(head.headers['content-length']).toBe(initial.headers['content-length'])
      expect(head.headers['content-encoding']).toBe('br')
      const htmlResponse = await get('/s/drs_example')
      expect((await get('/s/drs_example', { 'If-None-Match': htmlResponse.headers.etag! })).status).toBe(304)
    })
  })

  it('falls back when sidecars are missing or stale', async () => {
    await withClient(async ({ get, directory }) => {
      await rm(path.join(directory, assetPath + '.br'))
      expect((await get(assetPath, { 'Accept-Encoding': 'br, gzip' })).headers['content-encoding']).toBe('gzip')
      await utimes(path.join(directory, assetPath + '.gz'), 0, 0)
      const response = await get(assetPath, { 'Accept-Encoding': 'br, gzip' })
      expect(response.headers['content-encoding']).toBeUndefined()
      expect(response.body.toString()).toBe(source)
    })
  })

  it('does not cache errors, return HTML for missing assets or expose sidecars/dotfiles', async () => {
    await withClient(async ({ get, directory }) => {
      await writeFile(path.join(directory, '.secret'), 'hidden')
      for (const pathname of ['/assets/missing-12345678.js', '/favicon.png', assetPath + '.br', '/.secret']) {
        const response = await get(pathname)
        expect(response.status).toBe(404)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.body.toString()).not.toContain(html)
      }
      const post = await get('/', {}, 'POST')
      expect(post.status).toBe(405)
      expect(post.headers.allow).toBe('GET, HEAD')
      expect(post.headers['cache-control']).toBe('no-store')
    })
  })

  it('keeps host validation and private API responses ahead of static caching', async () => {
    await withClient(async ({ get }) => {
      const blocked = await get(assetPath, { Host: 'untrusted.example', 'If-None-Match': '*' })
      expect(blocked.status).toBe(403)
      expect(blocked.headers['cache-control']).toBe('no-store')
      expect(blocked.headers.etag).toBeUndefined()
      const health = await get('/api/health')
      expect(health.status).toBe(200)
      expect(health.headers['cache-control']).toBe('no-store')
      const privateApi = await get('/api/sessions')
      expect(privateApi.status).toBe(401)
      expect(privateApi.headers['cache-control']).toBe('no-store')
      const authenticated = await get('/api/sessions', { Authorization: 'Bearer test-token' })
      expect(authenticated.status).toBe(200)
      expect(authenticated.headers['cache-control']).toBe('no-store')
    })
  })
})
