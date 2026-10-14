export const AUTH_REQUIRED = 'diff-review:auth-required'

export type AuthStatus = { required: boolean; authenticated: boolean; publicOrigin: string | null; embedOrigins: string[] }

export function requireAuthentication(): void {
  window.dispatchEvent(new Event(AUTH_REQUIRED))
}

export async function authStatus(): Promise<AuthStatus> {
  const response = await fetch('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' })
  if (!response.ok) throw new Error('Unable to check authentication')
  return response.json() as Promise<AuthStatus>
}

export async function login(token: string): Promise<AuthStatus> {
  const response = await fetch('/api/auth/login', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  })
  if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect token. Try again.' : 'Sign-in failed. Check the server origin configuration.')
  const status = await authStatus()
  if (!status.authenticated) throw new Error('Your browser blocked the sign-in cookie. Open Diff Review in a new tab.')
  return status
}
