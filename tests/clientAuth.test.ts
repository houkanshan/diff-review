import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const key = 'diff-review-browser-credential:v1'
const status = { required: true, authenticated: true, publicOrigin: null, embedOrigins: [], allowAnyEmbedOrigin: false }
const expiresAt = Date.now() + 60_000
const session = { credential: `drb1.${expiresAt}.${'a'.repeat(64)}`, expiresAt }
let values: Map<string, string>
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> }
let dispatchEvent: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.resetModules()
  values = new Map()
  storage = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { values.set(name, value) }),
    removeItem: vi.fn((name: string) => { values.delete(name) }),
  }
  dispatchEvent = vi.fn()
  vi.stubGlobal('window', { localStorage: storage, dispatchEvent, location: new URL('http://review.test:47659') })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function loginFetch() {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(session)).mockImplementation(() => Promise.resolve(Response.json(status)))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('cookie-independent browser authentication', () => {
  it('exchanges the master token and persists only the expiring browser credential', async () => {
    const fetcher = loginFetch()
    const auth = await import('../src/client/auth')
    expect(await auth.login('master-secret')).toEqual(status)
    expect(JSON.parse(values.get(key)!)).toEqual(session)
    expect(values.get(key)).not.toContain('master-secret')
    expect(auth.isCredentialPersistent()).toBe(true)
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://review.test:47659/api/auth/token')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"token":"master-secret"}', credentials: 'omit', redirect: 'error' })
    expect((fetcher.mock.calls[1]?.[1]?.headers as Headers).get('authorization')).toBe(`Bearer ${session.credential}`)
    vi.resetModules()
    const reloaded = await import('../src/client/auth')
    await reloaded.authStatus()
    expect((fetcher.mock.lastCall?.[1]?.headers as Headers).get('authorization')).toBe(`Bearer ${session.credential}`)
  })

  it('works in memory when the localStorage getter is denied', async () => {
    loginFetch()
    vi.stubGlobal('window', { dispatchEvent, location: new URL('http://review.test:47659'), get localStorage() { throw new DOMException('blocked', 'SecurityError') } })
    const auth = await import('../src/client/auth')
    await expect(auth.login('master-secret')).resolves.toEqual(status)
    expect(auth.isCredentialPersistent()).toBe(false)
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json([])))
    vi.stubGlobal('fetch', fetcher)
    const { getSessions } = await import('../src/client/api')
    expect(await getSessions()).toEqual([])
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get('authorization')).toBe(`Bearer ${session.credential}`)
    vi.resetModules()
    const reloaded = await import('../src/client/auth')
    await reloaded.authStatus()
    expect((fetcher.mock.lastCall?.[1]?.headers as Headers).has('authorization')).toBe(false)
  })

  it('survives quota failure without saving the master token', async () => {
    loginFetch()
    storage.setItem.mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError') })
    const auth = await import('../src/client/auth')
    await expect(auth.login('master-secret')).resolves.toEqual(status)
    expect(auth.isCredentialPersistent()).toBe(false)
    expect(values.size).toBe(0)
  })

  it('ignores invalid persisted credentials without deleting shared storage', async () => {
    values.set(key, JSON.stringify({ ...session, expiresAt: 1 }))
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ...status, authenticated: false }))
    vi.stubGlobal('fetch', fetcher)
    const auth = await import('../src/client/auth')
    await auth.authStatus()
    expect(values.has(key)).toBe(true)
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).has('authorization')).toBe(false)
  })

  it('does not accept an arbitrary or master-shaped credential from the exchange endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ credential: 'master-secret', expiresAt })))
    const { login } = await import('../src/client/auth')
    await expect(login('master-secret')).rejects.toThrow('valid browser credential')
    expect(values.size).toBe(0)
  })

  it('reports a wrong token without an auth probe or retry', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    const { login } = await import('../src/client/auth')
    await expect(login('wrong')).rejects.toThrow('Incorrect token')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a failed credential locally without deleting shared storage on an API401', async () => {
    loginFetch()
    const auth = await import('../src/client/auth')
    await auth.login('master-secret')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in' } }, { status: 401 })))
    const { getSessions } = await import('../src/client/api')
    await expect(getSessions()).rejects.toThrow('Sign in')
    expect(JSON.parse(values.get(key)!)).toEqual(session)
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(auth.isCredentialPersistent()).toBe(false)
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe(auth.AUTH_REQUIRED)
  })

  it('adopts another tab\'s newer credential before handling local expiry', async () => {
    loginFetch()
    const auth = await import('../src/client/auth')
    await auth.login('master-secret')
    const next = { credential: `drb1.${expiresAt + 120_000}.${'b'.repeat(64)}`, expiresAt: expiresAt + 120_000 }
    values.set(key, JSON.stringify(next))
    vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1)
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(status)))
    vi.stubGlobal('fetch', fetcher)
    await auth.authStatus()
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get('authorization')).toBe(`Bearer ${next.credential}`)
    expect(JSON.parse(values.get(key)!)).toEqual(next)
    expect(auth.isCredentialPersistent()).toBe(true)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it.each(['GET', 'POST'])('preserves another tab\'s login after a stale %s401 without replaying mutations', async (method) => {
    loginFetch()
    const auth = await import('../src/client/auth')
    await auth.login('master-secret')
    let rejectStale!: (response: Response) => void
    const pendingResponse = new Promise<Response>(resolve => { rejectStale = resolve })
    const fetcher = vi.fn().mockReturnValueOnce(pendingResponse).mockImplementation(() => Promise.resolve(Response.json(status)))
    vi.stubGlobal('fetch', fetcher)
    const pending = auth.authenticatedFetch('/api/sessions', { method })
    const next = { credential: `drb1.${expiresAt + 1000}.${'b'.repeat(64)}`, expiresAt: expiresAt + 1000 }
    values.set(key, JSON.stringify(next))
    rejectStale(Response.json({}, { status: 401 }))
    expect((await pending).status).toBe(method === 'GET' ? 200 : 401)
    expect(fetcher).toHaveBeenCalledTimes(method === 'GET' ? 2 : 1)
    expect(JSON.parse(values.get(key)!)).toEqual(next)
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
    expect(auth.isCredentialPersistent()).toBe(true)
  })

  it('never removes a new credential written after its last storage read', async () => {
    loginFetch()
    const auth = await import('../src/client/auth')
    await auth.login('master-secret')
    const next = { credential: `drb1.${expiresAt + 1000}.${'b'.repeat(64)}`, expiresAt: expiresAt + 1000 }
    let reads = 0
    storage.getItem.mockImplementation((name: string) => {
      const raw = values.get(name) ?? null
      if (++reads === 2) values.set(key, JSON.stringify(next))
      return raw
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 401 })))
    await auth.authenticatedFetch('/api/sessions')
    expect(JSON.parse(values.get(key)!)).toEqual(next)
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it('rejects non-API paths and overrides unsafe credential/redirect settings', async () => {
    const fetcher = loginFetch()
    const auth = await import('../src/client/auth')
    await auth.login('master-secret')
    fetcher.mockClear()
    for (const path of ['https://evil.test/api/data', '//evil.test/api/data', '/api/../static', '/api/../../api/../outside', '/api/\\evil', '/api/test#fragment']) {
      await expect(auth.authenticatedFetch(path)).rejects.toThrow('local /api/ path')
    }
    expect(fetcher).not.toHaveBeenCalled()
    await auth.authenticatedFetch('/api/sessions', { credentials: 'include', redirect: 'follow', headers: { Authorization: 'Bearer wrong' } })
    expect(fetcher.mock.calls[0]?.[0]).toBe('http://review.test:47659/api/sessions')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect((fetcher.mock.calls[0]?.[1]?.headers as Headers).get('authorization')).toBe(`Bearer ${session.credential}`)
  })
})
