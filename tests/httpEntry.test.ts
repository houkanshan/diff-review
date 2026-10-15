import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { ApiAuth } from '../src/server/auth'
import { ApiHandler } from '../src/server/api'
import { publicListenerConfig } from '../src/server/daemon'
import { ReviewStore } from '../src/server/store'

const token = 'http-entry-test-token'
const origin = 'http://review.test:47659'
const env = { DIFF_REVIEW_TOKEN: token, DIFF_REVIEW_PUBLIC_ORIGIN: origin }

describe('opt-in authenticated HTTP entry', () => {
  it('requires explicit interface, unprivileged HTTP origin and credentials', () => {
    expect(publicListenerConfig({})).toBeNull()
    expect(publicListenerConfig({ ...env, DIFF_REVIEW_PUBLIC_LISTEN_HOST: '100.100.246.17' })).toEqual({ host: '100.100.246.17', port: 47659 })
    for (const host of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0', 'ec2-dev', '*']) {
      expect(() => publicListenerConfig({ ...env, DIFF_REVIEW_PUBLIC_LISTEN_HOST: host })).toThrow()
    }
    for (const bad of [
      { DIFF_REVIEW_TOKEN: '' }, { DIFF_REVIEW_PUBLIC_ORIGIN: '' },
      { DIFF_REVIEW_PUBLIC_ORIGIN: 'https://review.test:47659' },
      { DIFF_REVIEW_PUBLIC_ORIGIN: 'http://review.test' },
      { DIFF_REVIEW_PUBLIC_ORIGIN: 'http://review.test:443' },
    ]) expect(() => publicListenerConfig({ ...env, ...bad, DIFF_REVIEW_PUBLIC_LISTEN_HOST: '100.100.246.17' })).toThrow()
  })

  it('enforces listener identity, exact Host/Origin, isolated cookies, reads, streams and CSRF', async () => {
    const handler = new ApiHandler(new ReviewStore(':memory:'), null, new ApiAuth(env))
    const publicServer = createServer(handler.handlePublic)
    const localServer = createServer(handler.handle)
    const otherOrigin = 'http://other-review.test:47659'
    const otherHandler = new ApiHandler(new ReviewStore(':memory:'), null, new ApiAuth({ ...env, DIFF_REVIEW_PUBLIC_ORIGIN: otherOrigin }))
    const otherServer = createServer(otherHandler.handlePublic)
    const servers = [publicServer, localServer, otherServer]
    type Result = { status: number; cookie: string; body: string }
    const call = (local: boolean, pathname: string, headers: Record<string, string> = {}, method = 'GET', body = '') => new Promise<Result>((resolve, reject) => {
      const server = local ? localServer : publicServer
      const req = request({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, path: pathname, method, headers: { Host: local ? `127.0.0.1:${(server.address() as AddressInfo).port}` : 'review.test:47659', ...headers } }, (res) => {
        let content = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { content += chunk })
        res.on('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0] ?? '', body: content }))
      })
      req.on('error', reject)
      req.end(body)
    })
    try {
      for (const server of servers) await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const localOrigin = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`
      const login = (local: boolean, originHeader: string) => call(local, '/api/auth/login', { Origin: originHeader, 'Content-Type': 'application/json' }, 'POST', JSON.stringify({ token }))
      expect((await call(false, '/api/sessions', { Host: '127.0.0.1:47658', Authorization: `Bearer ${token}` })).status).toBe(403)
      expect((await call(false, '/api/sessions', { 'X-Forwarded-Host': 'review.test:47659', Authorization: `Bearer ${token}` })).status).toBe(403)
      expect((await call(false, '/api/sessions', { Host: 'evil.test:47659' })).status).toBe(403)
      for (const pathname of ['/api/sessions', '/api/events', '/api/avatar?url=x']) expect((await call(false, pathname)).status).toBe(401)
      expect((await call(false, '/api/health')).status).toBe(200)
      expect((await login(false, localOrigin)).status).toBe(403)
      expect((await login(false, 'http://monitor.test:4899')).status).toBe(403)
      const signedIn = await login(false, origin)
      expect(signedIn.status).toBe(200)
      expect(signedIn.cookie).toContain('diff_review_http_session=')
      expect(signedIn.cookie).toContain('HttpOnly; SameSite=Strict')
      expect(signedIn.cookie).not.toMatch(/Secure|__Host-|Domain=/)
      expect(signedIn.cookie).not.toContain(token)
      const cookie = signedIn.cookie.split(';')[0]!
      expect((await call(false, '/api/sessions', { Cookie: cookie })).status).toBe(200)
      const copiedCookieStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: (otherServer.address() as AddressInfo).port, path: '/api/sessions', headers: { Host: new URL(otherOrigin).host, Cookie: cookie } }, (res) => { res.resume(); resolve(res.statusCode) })
        req.on('error', reject)
        req.end()
      })
      expect(copiedCookieStatus).toBe(401)
      const streamStatus = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: (publicServer.address() as AddressInfo).port, path: '/api/events', headers: { Host: new URL(origin).host, Cookie: cookie } }, (res) => {
          res.once('data', () => { resolve(res.statusCode); res.destroy() })
          res.once('error', reject)
        })
        req.on('error', reject)
        req.end()
      })
      expect(streamStatus).toBe(200)
      expect(JSON.parse((await call(false, '/api/auth/status', { Cookie: cookie })).body)).toMatchObject({ authenticated: true, publicOrigin: origin, embedOrigins: [], allowAnyEmbedOrigin: true })
      for (const suppliedOrigin of ['', localOrigin, 'http://monitor.test:4899']) {
        expect((await call(false, '/api/sessions', { Cookie: cookie, ...(suppliedOrigin ? { Origin: suppliedOrigin } : {}) }, 'POST')).status).toBe(403)
      }
      expect((await call(false, '/api/sessions', { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, 'POST', '{}')).status).toBe(400)
      expect((await call(false, '/api/sessions', { Cookie: cookie.replace('diff_review_http_session=', '__Host-diff_review_session=') })).status).toBe(401)
      expect((await call(false, '/api/auth/logout', { Cookie: cookie }, 'POST')).status).toBe(403)
      expect((await call(false, '/api/auth/logout', { Cookie: cookie, Origin: localOrigin }, 'POST')).status).toBe(403)
      expect((await call(false, '/api/auth/logout', { Cookie: cookie, Origin: 'http://monitor.test:4899' }, 'POST')).status).toBe(403)
      expect((await call(false, '/api/auth/logout', { Cookie: cookie, Origin: origin }, 'POST')).cookie).toContain('Max-Age=0')
      expect((await call(true, '/api/sessions', { Cookie: cookie.replace('diff_review_http_session=', 'diff_review_session=') })).status).toBe(401)
      const localCookie = (await login(true, localOrigin)).cookie.split(';')[0]!
      expect((await call(false, '/api/sessions', { Cookie: localCookie.replace('diff_review_session=', 'diff_review_http_session=') })).status).toBe(401)
      expect((await call(false, '/api/sessions', { Authorization: `Bearer ${token}` })).status).toBe(200)
    } finally {
      handler.close()
      otherHandler.close()
      for (const server of servers) {
        server.closeAllConnections()
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  })
})
