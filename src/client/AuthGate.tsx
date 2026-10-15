import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AUTH_REQUIRED, CREDENTIAL_STORAGE_KEY, authStatus, isCredentialPersistent, login } from './auth'
import { setEmbedOrigins } from './embedBridge'

export function AuthGate({ children }: { children: ReactNode }) {
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>('checking')
  const [checking, setChecking] = useState(false)
  const [memoryOnly, setMemoryOnly] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const queryClient = useQueryClient()
  const authGeneration = useRef(0)
  useEffect(() => {
    let active = true
    const expired = () => {
      authGeneration.current++
      setAuthState('unauthenticated')
      setError('Your session expired. Sign in again.')
      queryClient.clear()
    }
    const probe = () => {
      const request = ++authGeneration.current
      void authStatus().then((status) => {
        if (!active || request !== authGeneration.current) return
        setEmbedOrigins(status.embedOrigins, status.allowAnyEmbedOrigin)
        setMemoryOnly(status.required && status.authenticated && !isCredentialPersistent())
        setAuthState(status.authenticated ? 'authenticated' : 'unauthenticated')
        if (status.authenticated) { setToken(''); setError('') }
        else queryClient.clear()
      }).catch(() => {
        if (!active || request !== authGeneration.current) return
        setError('Unable to connect. Reload to retry.')
        setAuthState('unauthenticated')
      })
    }
    const storageChanged = (event: StorageEvent) => {
      if (event.key === CREDENTIAL_STORAGE_KEY || event.key === null) probe()
    }
    window.addEventListener(AUTH_REQUIRED, expired)
    window.addEventListener('storage', storageChanged)
    probe()
    return () => {
      active = false
      window.removeEventListener(AUTH_REQUIRED, expired)
      window.removeEventListener('storage', storageChanged)
    }
  }, [queryClient])
  if (authState === 'authenticated') return <>
    {memoryOnly && <p className="auth-session-notice" role="status">Browser storage is unavailable. You are signed in for this tab; reload requires signing in again.</p>}
    {children}
  </>
  if (authState === 'checking') return <div className="auth-backdrop"><p role="status">Connecting…</p></div>
  return <div className="auth-backdrop">
    <form className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" onSubmit={(event) => {
      event.preventDefault()
      authGeneration.current++
      setChecking(true)
      setError('')
      void login(token).then((status) => {
        authGeneration.current++
        setToken('')
        setEmbedOrigins(status.embedOrigins, status.allowAnyEmbedOrigin)
        setMemoryOnly(status.required && !isCredentialPersistent())
        setAuthState('authenticated')
      }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Sign-in failed'))
        .finally(() => setChecking(false))
    }}>
      <h2 id="auth-title">Sign in to Diff Review</h2>
      <p>Enter the daemon token. This browser remembers an expiring browser credential in localStorage, not your daemon token. If storage is blocked, sign-in lasts until reload.</p>
      {window.location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname) && <p>HTTP does not encrypt your token or review data. Use a trusted private connection.</p>}
      <label>Token <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" autoFocus /></label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={checking || !token}>{checking ? 'Connecting…' : 'Sign in'}</button>
      {window.parent !== window && <a href={window.location.href} target="_blank" rel="noopener noreferrer">Open in new tab</a>}
    </form>
  </div>
}
