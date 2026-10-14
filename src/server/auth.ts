import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const LOCAL_COOKIE = 'diff_review_session'
const PUBLIC_COOKIE = '__Host-diff_review_session'
const MAX_AGE = 30 * 24 * 60 * 60
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function configuredToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.DIFF_REVIEW_TOKEN || env.PI_MONITOR_TOKEN || ''
}

function httpsOrigin(value: string): string {
  const url = new URL(value)
  if (!/^https:\/\/[^/?#\s@\\]+\/?$/.test(value) || url.username || url.password || url.hostname.includes('*') || url.pathname !== '/' || url.search || url.hash || url.protocol !== 'https:') throw new Error('Expected an HTTPS origin without path, credentials, query or fragment')
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
  private failedLogins = 0
  private loginWindow = 0

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.token = configuredToken(env)
    this.publicOrigin = env.DIFF_REVIEW_PUBLIC_ORIGIN ? httpsOrigin(env.DIFF_REVIEW_PUBLIC_ORIGIN) : null
    this.embedOrigins = (env.DIFF_REVIEW_EMBED_ORIGINS ?? '').split(/[\s,]+/).filter(Boolean).map(httpsOrigin)
    if (this.publicOrigin && !this.token) throw new Error('DIFF_REVIEW_PUBLIC_ORIGIN requires a token')
  }

  private signature(expires: string): string {
    return createHmac('sha256', this.token).update(`diff-review:browser:v1:${expires}`).digest('hex')
  }

  private publicRequest(request: IncomingMessage): boolean {
    return (this.publicOrigin !== null && request.headers.host === new URL(this.publicOrigin).host)
      || Object.keys(request.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-'))
      || (this.publicOrigin !== null && request.headers.origin === this.publicOrigin)
  }

  private cookieValid(request: IncomingMessage): boolean {
    const name = this.publicRequest(request) ? PUBLIC_COOKIE : LOCAL_COOKIE
    const value = request.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1)
    if (!value) return false
    const [expires, signature] = value.split('.')
    return !!expires && !!signature && /^\d+$/.test(expires) && Number(expires) > Date.now()
      && equal(signature, this.signature(expires))
  }

  private allowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return false
    if (origin === this.publicOrigin) return true
    try {
      const url = new URL(origin)
      return url.origin === origin && url.protocol === 'http:' && LOOPBACK.has(url.hostname)
        && url.host === request.headers.host
    } catch { return false }
  }

  private cookie(request: IncomingMessage, value: string, maxAge: number): string {
    const secure = this.publicRequest(request)
    return `${secure ? PUBLIC_COOKIE : LOCAL_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${secure ? 'Strict; Secure' : 'Lax'}`
  }

  async handle(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
    response.setHeader('Content-Security-Policy', `frame-ancestors 'self' http://localhost:* http://127.0.0.1:* http://[::1]:* ${this.embedOrigins.join(' ')}`.trim())
    response.setHeader('X-Content-Type-Options', 'nosniff')
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
    if (!hostAllowed || (forwarded && (!this.token || !this.publicOrigin))) return deny(403, 'Untrusted request host or proxy')
    if (!pathname.startsWith('/api/')) return false
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    const bearer = !!this.token && equal(request.headers.authorization ?? '', `Bearer ${this.token}`)
    const authenticated = !this.token || bearer || this.cookieValid(request)
    const method = request.method ?? 'GET'
    if (pathname === '/api/health' && method === 'GET') return false
    if (pathname === '/api/auth/status' && method === 'GET') {
      return send(200, { required: !!this.token, authenticated, embedOrigins: this.embedOrigins })
    }
    if ((pathname === '/api/auth/login' || pathname === '/api/auth/logout') && method === 'POST') {
      if (!this.allowedOrigin(request)) return deny(403, 'Untrusted request origin')
      if (pathname.endsWith('/logout')) {
        response.setHeader('Set-Cookie', this.cookie(request, '', 0))
        return send(200, { ok: true })
      }
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
      response.setHeader('Set-Cookie', this.cookie(request, `${expires}.${this.signature(expires)}`, MAX_AGE))
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
