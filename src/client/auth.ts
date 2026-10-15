import { readStoredValue, writeStoredValue } from './browserStorage'

export const AUTH_REQUIRED = 'diff-review:auth-required'
const CREDENTIAL_KEY = 'diff-review-browser-credential:v1'

type BrowserCredential = { credential: string; expiresAt: number }
export type AuthStatus = { required: boolean; authenticated: boolean; publicOrigin: string | null; embedOrigins: string[]; allowAnyEmbedOrigin: boolean }

let currentCredential: BrowserCredential | null = null
let restored = false
let persistent = false

function parseCredential(value: unknown): BrowserCredential | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<BrowserCredential>
  const match = typeof candidate.credential === 'string' ? /^drb1\.(\d{13})\.[0-9a-f]{64}$/.exec(candidate.credential) : null
  return match && candidate.expiresAt === Number(match[1]) && candidate.expiresAt > Date.now()
    ? { credential: candidate.credential!, expiresAt: candidate.expiresAt } : null
}

function credential(): BrowserCredential | null {
  if (!restored) {
    restored = true
    const raw = readStoredValue(CREDENTIAL_KEY)
    try { currentCredential = raw ? parseCredential(JSON.parse(raw)) : null } catch { currentCredential = null }
    persistent = currentCredential !== null
    if (raw && !currentCredential) writeStoredValue(CREDENTIAL_KEY, null)
  }
  if (currentCredential && currentCredential.expiresAt <= Date.now()) {
    currentCredential = null
    persistent = false
    writeStoredValue(CREDENTIAL_KEY, null)
  }
  return currentCredential
}

export function isCredentialPersistent(): boolean {
  return credential() !== null && persistent
}

export function requireAuthentication(): void {
  currentCredential = null
  restored = true
  persistent = false
  writeStoredValue(CREDENTIAL_KEY, null)
  window.dispatchEvent(new Event(AUTH_REQUIRED))
}

/** Credentials never leave this origin or travel in cookies, URLs, or redirects. */
export async function authenticatedFetch(pathname: string, init?: RequestInit): Promise<Response> {
  if (!pathname.startsWith('/api/') || /[\\\s\u0000-\u001f\u007f]/.test(pathname) || pathname.includes('#')) {
    throw new Error('Authenticated requests require a local /api/ path')
  }
  const origin = window.location.origin
  const parsed = new URL(pathname, origin)
  if (parsed.origin !== origin || !parsed.pathname.startsWith('/api/')) throw new Error('Authenticated requests require a local /api/ path')
  const headers = new Headers(init?.headers)
  headers.delete('Authorization')
  const active = credential()
  if (active) headers.set('Authorization', `Bearer ${active.credential}`)
  const response = await fetch(parsed.href, { ...init, headers, credentials: 'omit', redirect: 'error' })
  if (response.status === 401 && active === currentCredential) requireAuthentication()
  return response
}

export async function authStatus(): Promise<AuthStatus> {
  const response = await authenticatedFetch('/api/auth/status', { cache: 'no-store' })
  if (!response.ok) throw new Error('Unable to check authentication')
  return response.json() as Promise<AuthStatus>
}

export async function login(token: string): Promise<AuthStatus> {
  const response = await authenticatedFetch('/api/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  })
  if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect token. Try again.' : 'Sign-in failed. Check the server origin configuration.')
  const next = parseCredential(await response.json())
  if (!next) throw new Error('The server did not return a valid browser credential. Update and restart Diff Review.')
  currentCredential = next
  restored = true
  persistent = writeStoredValue(CREDENTIAL_KEY, JSON.stringify(next))
  if (!persistent) writeStoredValue(CREDENTIAL_KEY, null)
  const status = await authStatus()
  if (!status.authenticated) {
    requireAuthentication()
    throw new Error('Sign-in could not be verified. Try again.')
  }
  return status
}
