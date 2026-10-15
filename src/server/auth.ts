import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const LOCAL_COOKIE = 'diff_review_session'
const PUBLIC_COOKIE = '__Host-diff_review_session'
const HTTP_PUBLIC_COOKIE = 'diff_review_http_session'
const MAX_AGE = 30 * 24 * 60 * 60
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function configuredToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIFF_REVIEW_TOKEN || env.PI_MONITOR_TOKEN || ''
}

export function browserOrigin(value: string): string {
  const url = new URL(value)
  if (!/^https?:\/\/[^/?#\s@\\]+\/?$/i.test(value) || url.username || url.password || url.hostname.includes('*') || url.pathname !== '/' || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) origin without path, credentials, query or fragment')
  return url.origin
}

function equal(actual: string, expected: string): boolean {
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** One boundary for API authorization, browser sessions, CSRF, and embedding policy. */
export class ApiAuth {
  private readonly token: string
  private readonly publicOrigin: string | null
  private readonly embedOrigins: string[]
  private readonly allowAnyEmbedOrigin: boolean
  private readonly publicRequests = new WeakSet<IncomingMessage>()
  private failedLogins = 0
  private loginWindow = 0

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.token = configuredToken(env)
    this.publicOrigin = env.DIFF_REVIEW_PUBLIC_ORIGIN ? browserOrigin(env.DIFF_REVIEW_PUBLIC_ORIGIN) : null
    this.embedOrigins = (env.DIFF_REVIEW_EMBED_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean).map(browserOrigin)
    if (this.publicOrigin && !this.token) throw new Error('DIFF_REVIEW_PUBLIC_ORIGIN requires a token')
    this.allowAnyEmbedOrigin = !!this.publicOrigin && !!this.token && this.embedOrigins.length === 0
  }

  private signature(expires: string, cookieName: string): string {
    const context = cookieName === LOCAL_COOKIE
      ? `v2:${cookieName}` : `v3:${cookieName}:${this.publicOrigin}`
    return createHmac('sha256', this.token).update(`diff-review:browser:${context}:${expires}`).digest('hex')
  }

  private publicRequest(request: IncomingMessage): boolean {
    return this.publicRequests.has(request)
      || (this.publicOrigin !== null && request.headers.host === new URL(this.publicOrigin).host)
      || Object.keys(request.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-'))
      || (this.publicOrigin !== null && request.headers.origin === this.publicOrigin)
  }

  private browserBearerSignature(expires: string, request: IncomingMessage): string {
    const audience = this.publicRequest(request) ? this.publicOrigin : 'loopback'
    return createHmac('sha256', this.token).update(`diff-review:bearer:v1:${audience}:${expires}`).digest('hex')
  }

  private bearer(request: IncomingMessage): { expiresAt: number | null } | null {
    if (!this.token) return null
    const authorization = request.headers.authorization ?? ''
    if (equal(authorization, `Bearer ${this.token}`)) return { expiresAt: null }
    const match = /^Bearer drb1\.(\d{13})\.([0-9a-f]{64})$/.exec(authorization)
    if (!match) return null
    const expiresAt = Number(match[1])
    if (expiresAt <= Date.now() || expiresAt > Date.now() + MAX_AGE * 1000 + 60_000) return null
    return equal(match[2]!, this.browserBearerSignature(match[1]!, request)) ? { expiresAt } : null
  }

  /** Only master credentials and tokenless local streams have no deadline. */
  streamExpiresAt(request: IncomingMessage): number | null {
    if (!this.token) return null
    const bearer = this.bearer(request)
    return bearer ? bearer.expiresAt : this.cookieExpiresAt(request) ?? 0
  }

  private cookieExpiresAt(request: IncomingMessage): number | null {
    const name = this.cookieName(request)
    const value = request.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1)
    if (!value) return null
    const [expires, signature] = value.split('.')
    return expires && signature && /^\d+$/.test(expires) && equal(signature, this.signature(expires, name))
      ? Number(expires) : null
  }

  private allowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return false
    if (origin === this.publicOrigin) return true
    if (this.publicRequest(request)) return false
    try {
      const url = new URL(origin)
      return url.origin === origin && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
        && url.host === request.headers.host
    } catch { return false }
  }

  private cookieName(request: IncomingMessage): string {
    if (!this.publicRequest(request)) return LOCAL_COOKIE
    return this.publicOrigin?.startsWith('http:') ? HTTP_PUBLIC_COOKIE : PUBLIC_COOKIE
  }

  private cookie(request: IncomingMessage, value: string, maxAge: number): string {
    const name = this.cookieName(request)
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${name === LOCAL_COOKIE ? 'Lax' : 'Strict'}${name === PUBLIC_COOKIE ? '; Secure' : ''}`
  }

  async handle(request: IncomingMessage, response: ServerResponse, pathname: string, publicEntry = false): Promise<boolean> {
    if (publicEntry) this.publicRequests.add(request)
    const ancestors = this.allowAnyEmbedOrigin
      ? 'http: https:'
      : `'self' http://localhost:* http://127.0.0.1:* http://[::1]:* ${this.embedOrigins.join(' ')}`.trim()
    response.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cache-Control', 'no-store')
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
      return true
    }
    const deny = (status: number, message: string) => send(status, { error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message } })
    let hostAllowed = false
    try {
      const host = request.headers.host ?? ''
      const local = new URL(`http://${host}`)
      hostAllowed = local.host === host && LOOPBACK.has(local.hostname)
      if (this.publicOrigin && host === new URL(this.publicOrigin).host) hostAllowed = true
    } catch { /* Invalid Host is never trusted. */ }
    const forwarded = Object.keys(request.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-'))
    if (publicEntry && (!this.token || !this.publicOrigin || request.headers.host !== new URL(this.publicOrigin).host || forwarded)) return deny(403, 'Untrusted public request host or proxy')
    if (!hostAllowed || (forwarded && (!this.token || !this.publicOrigin))) return deny(403, 'Untrusted request host or proxy')
    if (!pathname.startsWith('/api/')) return false
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    const bearer = this.bearer(request)
    const authenticated = !this.token || bearer !== null || (this.cookieExpiresAt(request) ?? 0) > Date.now()
    const method = request.method ?? 'GET'
    if (pathname === '/api/health' && method === 'GET') return false
    if (pathname === '/api/auth/status' && method === 'GET') {
      return send(200, { required: !!this.token, authenticated, publicOrigin: this.publicOrigin, embedOrigins: this.embedOrigins, allowAnyEmbedOrigin: this.allowAnyEmbedOrigin })
    }
    if (['/api/auth/login', '/api/auth/logout', '/api/auth/token'].includes(pathname) && method === 'POST') {
      if (!this.allowedOrigin(request)) return deny(403, 'Untrusted request origin')
      if (pathname.endsWith('/logout')) {
        response.setHeader('Set-Cookie', this.cookie(request, '', 0))
        return send(200, { ok: true })
      }
      if (pathname === '/api/auth/token' && request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return deny(415, 'Expected application/json')
      if (Date.now() - this.loginWindow >= 60_000) {
        this.loginWindow = Date.now()
        this.failedLogins = 0
      }
      if (this.failedLogins >= 20) {
        response.setHeader('Retry-After', '60')
        return deny(429, 'Too many sign-in attempts. Try again in a minute.')
      }
      let raw = ''
      for await (const chunk of request) {
        raw += String(chunk)
        if (Buffer.byteLength(raw) > 4096) return deny(413, 'Login body too large')
      }
      let supplied: unknown
      try { supplied = (JSON.parse(raw) as { token?: unknown }).token } catch { return deny(400, 'Invalid login body') }
      if (!this.token || typeof supplied !== 'string' || !equal(supplied, this.token)) {
        this.failedLogins += 1
        return deny(401, 'Incorrect token')
      }
      const expires = String(Date.now() + MAX_AGE * 1000)
      if (pathname === '/api/auth/token') {
        return send(200, { credential: `drb1.${expires}.${this.browserBearerSignature(expires, request)}`, expiresAt: Number(expires) })
      }
      const cookieName = this.cookieName(request)
      response.setHeader('Set-Cookie', this.cookie(request, `${expires}.${this.signature(expires, cookieName)}`, MAX_AGE))
      return send(200, { ok: true })
    }
    if (!authenticated) return deny(401, 'Sign in to Diff Review')
    // Bearer clients do not use ambient credentials. Browsers must prove their origin.
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(method) && (this.token || request.headers.origin) && !this.allowedOrigin(request)) {
      return deny(403, 'Untrusted request origin')
    }
    return false
  }
}
