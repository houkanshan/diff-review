import { createServer, get } from 'node:http'
import { createHmac } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiAuth, configuredToken } from '../src/server/auth'
import { ApiHandler } from '../src/server/api'
import { ReviewStore } from '../src/server/store'

async function withServer(env: NodeJS.ProcessEnv, run: (base: string) => Promise<void>) {
  const handler = new ApiHandler(new ReviewStore(':memory:'), null, new ApiAuth(env))
  const server = createServer(handler.handle)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`) }
  finally {
    handler.close()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

const token = 'test-only-random-token-not-a-real-secret'
const config = { DIFF_REVIEW_TOKEN: token, DIFF_REVIEW_PUBLIC_ORIGIN: 'https://review.example.test', DIFF_REVIEW_EMBED_ORIGINS: 'https://monitor.example.test' }
afterEach(() => vi.restoreAllMocks())

describe('daemon authentication boundary', () => {
  it('validates configuration and token fallback', () => {
    expect(configuredToken({ PI_MONITOR_TOKEN: 'fallback' })).toBe('fallback')
    expect(configuredToken({ DIFF_REVIEW_TOKEN: 'own', PI_MONITOR_TOKEN: 'fallback' })).toBe('own')
    for (const origin of ['ftp://review.test', 'https://review.test/path', 'https://user@review.test', 'https://review.test\\path', 'https://*.review.test']) {
      expect(() => new ApiAuth({ ...config, DIFF_REVIEW_PUBLIC_ORIGIN: origin })).toThrow()
    }
    expect(() => new ApiAuth({ ...config, DIFF_REVIEW_PUBLIC_ORIGIN: 'https://review.test/' })).not.toThrow()
    expect(() => new ApiAuth({ ...config, DIFF_REVIEW_PUBLIC_ORIGIN: 'http://review.test:47659' })).not.toThrow()
    expect(() => new ApiAuth({ DIFF_REVIEW_PUBLIC_ORIGIN: config.DIFF_REVIEW_PUBLIC_ORIGIN })).toThrow()
    expect(configuredToken({ DIFF_REVIEW_TOKEN: ' padded ' })).toBe(' padded ')
  })

  it('protects reads, writes, images and SSE even on loopback; permits bearer and health', async () => {
    await withServer(config, async (base) => {
      for (const path of ['/api/sessions', '/api/events', '/api/avatar?url=x', '/api/github-attachment?url=x']) {
        const response = await fetch(base + path)
        expect(response.status).toBe(401)
        expect(response.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin')
      }
      expect((await fetch(base + '/api/sessions', { method: 'POST' })).status).toBe(401)
      expect((await fetch(base + '/api/health')).status).toBe(200)
      expect((await fetch(base + '/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
      const status = await fetch(base + '/api/auth/status')
      expect(await status.json()).toMatchObject({ required: true, authenticated: false, publicOrigin: config.DIFF_REVIEW_PUBLIC_ORIGIN })
      expect(status.headers.get('content-security-policy')).toContain('https://monitor.example.test')
      expect(status.headers.get('content-security-policy')).not.toContain('https:;')
      expect(status.headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  it('issues persistent derived cookies, rejects CSRF, expires sessions and clears cookies', async () => {
    await withServer(config, async (base) => {
      const signIn = (origin: string, supplied = token) => fetch(base + '/api/auth/login', {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: supplied }),
      })
      expect((await signIn('https://evil.test')).status).toBe(403)
      expect((await signIn('null')).status).toBe(403)
      expect((await signIn(base, 'wrong')).status).toBe(401)
      const local = await signIn(base)
      const setCookie = local.headers.get('set-cookie')!
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('Max-Age=2592000')
      expect(setCookie).not.toContain(token)
      expect(setCookie).not.toContain('Domain=')
      expect(setCookie).not.toContain('Secure')
      const cookie = setCookie.split(';')[0]!
      expect((await fetch(base + '/api/sessions', { headers: { Cookie: cookie } })).status).toBe(200)
      expect((await fetch(base + '/api/sessions', { method: 'POST', headers: { Cookie: cookie } })).status).toBe(403)
      expect((await fetch(base + '/api/sessions', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://monitor.example.test' } })).status).toBe(403)
      const publicLogin = await signIn(config.DIFF_REVIEW_PUBLIC_ORIGIN)
      expect(publicLogin.headers.get('set-cookie')).toContain('__Host-diff_review_session=')
      expect(publicLogin.headers.get('set-cookie')).toContain('SameSite=Strict; Secure')
      const publicCookie = publicLogin.headers.get('set-cookie')!.split(';')[0]!
      const renamedLocalCookie = cookie.replace('diff_review_session=', '__Host-diff_review_session=')
      expect((await fetch(base + '/api/sessions', { headers: { Cookie: renamedLocalCookie, 'X-Forwarded-Proto': 'https' } })).status).toBe(401)
      const renamedPublicCookie = publicCookie.replace('__Host-diff_review_session=', 'diff_review_session=')
      expect((await fetch(base + '/api/sessions', { headers: { Cookie: renamedPublicCookie } })).status).toBe(401)
      expect((await fetch(base + '/api/sessions', { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' } })).status).toBe(401)
      expect((await fetch(base + '/api/sessions', { headers: { Cookie: publicCookie, 'X-Forwarded-Proto': 'https' } })).status).toBe(200)
      const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Origin: base, Cookie: cookie } })
      expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 24 * 60 * 60 * 1000)
      expect((await fetch(base + '/api/sessions', { headers: { Cookie: cookie } })).status).toBe(401)
    })
  })

  it('closes an already-open cookie stream at its signed expiry', async () => {
    await withServer(config, async (base) => {
      const expires = String(Date.now() + 300)
      const signature = createHmac('sha256', token).update(`diff-review:browser:v2:diff_review_session:${expires}`).digest('hex')
      const cookie = `diff_review_session=${expires}.${signature}`
      const response = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      expect((await reader.read()).done).toBe(true)
      expect(Date.now()).toBeGreaterThanOrEqual(Number(expires))
      expect((await fetch(base + '/api/sessions', { headers: { Cookie: cookie } })).status).toBe(401)
      expect((await fetch(base + '/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    })
  })

  it('throttles repeated wrong logins without blocking authenticated API clients', async () => {
    await withServer(config, async (base) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        expect((await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base }, body: '{"token":"wrong"}' })).status).toBe(401)
      }
      const limited = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: base }, body: '{"token":"wrong"}' })
      expect(limited.status).toBe(429)
      expect(limited.headers.get('retry-after')).toBe('60')
      expect((await fetch(base + '/api/sessions', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200)
    })
  })

  it('keeps tokenless loopback usable but rejects DNS rebinding and accidental proxies', async () => {
    await withServer({}, async (base) => {
      expect(await (await fetch(base + '/api/auth/status')).json()).toMatchObject({ publicOrigin: null })
      expect((await fetch(base + '/api/sessions')).status).toBe(200)
      const reboundStatus = await new Promise<number | undefined>((resolve, reject) => {
        get(base + '/api/sessions', { headers: { Host: 'evil.test' } }, (response) => {
          response.resume()
          resolve(response.statusCode)
        }).on('error', reject)
      })
      expect(reboundStatus).toBe(403)
      expect((await fetch(base + '/api/sessions', { headers: { 'X-Forwarded-Host': 'review.test' } })).status).toBe(403)
    })
  })
})
