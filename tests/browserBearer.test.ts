import { createHmac } from 'node:crypto'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiHandler } from '../src/server/api'
import { ApiAuth } from '../src/server/auth'
import { ReviewStore } from '../src/server/store'

const token = 'test-master-token-not-a-real-secret'
const publicOrigin = 'http://review.test:47659'
const maxAge = 30 * 24 * 60 * 60 * 1000
const config = { DIFF_REVIEW_TOKEN: token, DIFF_REVIEW_PUBLIC_ORIGIN: publicOrigin }
type Result = { status: number; body: string; headers: Record<string, string | string[] | undefined> }

async function withEntries(run: (call: (path: string, options?: { local?: boolean; method?: string; headers?: Record<string, string>; body?: string }) => Promise<Result>, localOrigin: string, publicBase: string) => Promise<void>, env = config) {
  const handler = new ApiHandler(new ReviewStore(':memory:'), null, new ApiAuth(env))
  const local = createServer(handler.handle)
  const publicEntry = createServer(handler.handlePublic)
  const servers = [local, publicEntry]
  try {
    for (const server of servers) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const localOrigin = `http://127.0.0.1:${(local.address() as AddressInfo).port}`
    const call = (path: string, options: { local?: boolean; method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Result>((resolve, reject) => {
      const server = options.local ? local : publicEntry
      const req = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method: options.method ?? 'GET', headers: { Host: options.local ? new URL(localOrigin).host : new URL(env.DIFF_REVIEW_PUBLIC_ORIGIN).host, ...options.headers } }, (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode!, body, headers: response.headers }))
      })
      req.setTimeout(3000, () => req.destroy(new Error('Test request timed out')))
      req.on('error', reject)
      req.end(options.body)
    })
    await run(call, localOrigin, `http://127.0.0.1:${(publicEntry.address() as AddressInfo).port}`)
  } finally {
    handler.close()
    for (const server of servers) {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}

afterEach(() => vi.restoreAllMocks())
describe('expiring browser bearer credentials', () => {
  it('exchanges the master token without cookies and protects all API transports', async () => {
    await withEntries(async (call) => {
      const response = await call('/api/auth/token', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      expect(response.status).toBe(200)
      expect(response.headers['set-cookie']).toBeUndefined()
      const session = JSON.parse(response.body) as { credential: string; expiresAt: number }
      expect(session.credential).toMatch(/^drb1\.\d{13}\.[0-9a-f]{64}$/)
      expect(session.credential).not.toContain(token)
      expect(session.expiresAt).toBeGreaterThan(Date.now() + maxAge - 5000)
      const headers = { Authorization: `Bearer ${session.credential}` }
      expect((await call('/api/sessions', { headers })).status).toBe(200)
      expect((await call('/api/auth/token', { method: 'POST', headers: { ...headers, Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: session.credential }) })).status).toBe(401)
      const farFuture = String(Date.now() + maxAge + 120_000)
      const invalidLifetime = createHmac('sha256', token).update(`diff-review:bearer:v1:${publicOrigin}:${farFuture}`).digest('hex')
      expect((await call('/api/sessions', { headers: { Authorization: `Bearer drb1.${farFuture}.${invalidLifetime}` } })).status).toBe(401)
      expect(JSON.parse((await call('/api/auth/status', { headers })).body).authenticated).toBe(true)
      // Missing upstream URL proves media requests passed auth and reached the route.
      expect((await call('/api/avatar', { headers })).status).toBe(400)
      expect((await call('/api/github-attachment', { headers })).status).toBe(400)
      expect((await call('/api/sessions', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400)
      expect((await call(`/api/sessions?token=${encodeURIComponent(session.credential)}`)).status).toBe(401)
      expect((await call('/api/sessions', { headers: { Cookie: `diff_review_http_session=${session.credential}` } })).status).toBe(401)
      const preflight = await call('/api/sessions', { method: 'OPTIONS', headers: { ...headers, Origin: 'http://other-parent.test', 'Access-Control-Request-Headers': 'Authorization' } })
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined()
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined()
    })
  })

  it('sandboxes proxied SVG/media documents and prevents protected response caching', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>throw 1</script></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }))))
    try {
      await withEntries(async call => {
        for (const [endpoint, source] of [['avatar', 'https://avatars.githubusercontent.com/test'], ['github-attachment', 'https://private-user-images.githubusercontent.com/test.svg']]) {
          const response = await call(`/api/${endpoint}?url=${encodeURIComponent(source!)}`, { headers: { Authorization: `Bearer ${token}` } })
          expect(response.status).toBe(200)
          expect(response.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
          expect(response.headers['cache-control']).toBe('private, no-store')
          expect(response.headers['access-control-allow-origin']).toBeUndefined()
        }
      })
    } finally { vi.unstubAllGlobals() }
  })

  it('requires exact login Origin, JSON, the master token, and shared login throttling', async () => {
    await withEntries(async (call) => {
      const good = { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }
      expect((await call('/api/auth/token', { ...good, headers: { ...good.headers, Origin: 'http://any-parent.test' } })).status).toBe(403)
      expect((await call('/api/auth/token', { ...good, headers: { ...good.headers, Origin: 'null' } })).status).toBe(403)
      expect((await call('/api/auth/token', { ...good, headers: { Origin: publicOrigin, 'Content-Type': 'text/plain' } })).status).toBe(415)
      expect((await call('/api/auth/token', { ...good, body: '{' })).status).toBe(400)
      for (let attempt = 0; attempt < 20; attempt++) {
        expect((await call(attempt % 2 ? '/api/auth/login' : '/api/auth/token', { ...good, body: '{"token":"wrong"}' })).status).toBe(401)
      }
      expect((await call('/api/auth/token', good)).status).toBe(429)
      expect((await call('/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    })
  })

  it('isolates public and loopback credentials and rejects rotation, tampering and expired credentials', async () => {
    let publicCredential = ''
    await withEntries(async (call, localOrigin) => {
      const issue = async (local: boolean) => JSON.parse((await call('/api/auth/token', { local, method: 'POST', headers: { Origin: local ? localOrigin : publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })).body).credential as string
      publicCredential = await issue(false)
      const localCredential = await issue(true)
      expect((await call('/api/sessions', { local: true, headers: { Authorization: `Bearer ${publicCredential}` } })).status).toBe(401)
      expect((await call('/api/sessions', { headers: { Authorization: `Bearer ${localCredential}` } })).status).toBe(401)
      expect((await call('/api/sessions', { local: true, headers: { Authorization: `Bearer ${localCredential}` } })).status).toBe(200)
      expect((await call('/api/sessions', { headers: { Authorization: `Bearer ${publicCredential}extra` } })).status).toBe(401)
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + maxAge + 1000)
      expect((await call('/api/sessions', { headers: { Authorization: `Bearer ${publicCredential}` } })).status).toBe(401)
      vi.restoreAllMocks()
    })
    for (const env of [{ ...config, DIFF_REVIEW_TOKEN: 'rotated' }, { ...config, DIFF_REVIEW_PUBLIC_ORIGIN: 'http://other.test:47659' }]) {
      await withEntries(async call => {
        expect((await call('/api/sessions', { headers: { Authorization: `Bearer ${publicCredential}` } })).status).toBe(401)
      }, env)
    }
  })

  it('closes an already-open browser bearer stream at its signed expiry', async () => {
    await withEntries(async (_call, _localOrigin, base) => {
      const expires = String(Date.now() + 350)
      const signature = createHmac('sha256', token).update(`diff-review:bearer:v1:${publicOrigin}:${expires}`).digest('hex')
      const stream = await new Promise<{ status: number; data: string }>((resolve, reject) => {
        const req = request(base + '/api/events', { headers: { Host: new URL(publicOrigin).host, Authorization: `Bearer drb1.${expires}.${signature}` } }, response => {
          let data = ''
          response.setEncoding('utf8')
          response.on('data', chunk => { data += chunk })
          response.on('end', () => resolve({ status: response.statusCode!, data }))
          response.on('error', reject)
        })
        req.setTimeout(3000, () => req.destroy(new Error('SSE expiry test timed out')))
        req.on('error', reject)
        req.end()
      })
      expect(stream.status).toBe(200)
      expect(stream.data).toContain(':')
      expect(Date.now()).toBeGreaterThanOrEqual(Number(expires))
    })
  })
})
