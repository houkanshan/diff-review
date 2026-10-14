import { useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AUTH_REQUIRED, authStatus, login } from './auth'
import { setEmbedOrigins } from './embedBridge'

export function AuthGate({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>('checking')
  const [checking, setChecking] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  useEffect(() => {
    let active = true
    const expired = () => {
      setAuthState('unauthenticated')
      setError('Your session expired. Sign in again.')
      queryClient.clear()
    }
    window.addEventListener(AUTH_REQUIRED, expired)
    void authStatus().then((status) => {
      if (!active) return
      setEmbedOrigins(status.embedOrigins)
      setAuthState(status.authenticated ? 'authenticated' : 'unauthenticated')
    }).catch(() => {
      if (!active) return
      setError('Unable to connect. Reload to retry.')
      setAuthState('unauthenticated')
    })
    return () => { active = false; window.removeEventListener(AUTH_REQUIRED, expired) }
  }, [queryClient])
  if (authState === 'authenticated') return children
  if (authState === 'checking') return <div className="auth-backdrop"><p role="status">Connecting…</p></div>
  return <div className="auth-backdrop">
    <form className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" onSubmit={(event) => {
      event.preventDefault()
      setChecking(true)
      setError('')
      void login(token).then((status) => {
        setToken('')
        setEmbedOrigins(status.embedOrigins)
        setAuthState('authenticated')
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Sign-in failed'))
        .finally(() => setChecking(false))
    }}>
      <h2 id="auth-title">Sign in to Diff Review</h2>
      <p>Enter the daemon token. This browser remembers your sign-in using an HttpOnly cookie.</p>
      <label>Token <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" autoFocus /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={checking || !token}>{checking ? 'Connecting…' : 'Sign in'}</button>
      {window.parent !== window && <a href={window.location.href} target="_blank" rel="noopener noreferrer">Open in new tab</a>}
    </form>
  </div>
}
