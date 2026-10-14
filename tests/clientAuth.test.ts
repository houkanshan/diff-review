import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTH_REQUIRED, authStatus, login } from '../src/client/auth'
import { getSessions } from '../src/client/api'

const status = { required: true, authenticated: true, embedOrigins: [] }
afterEach(() => vi.unstubAllGlobals())

describe('browser authentication', () => {
  it('probes persisted cookies without storing a token in browser storage', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(status))
    vi.stubGlobal('fetch', fetcher)
    expect(await authStatus()).toEqual(status)
    expect(fetcher).toHaveBeenCalledWith('/api/auth/status', { cache: 'no-store', credentials: 'same-origin' })
  })
  it('verifies the cookie after login, catching blocked iframe cookies without retries', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ ...status, authenticated: false }))
    vi.stubGlobal('fetch', fetcher)
    await expect(login('secret')).rejects.toThrow('Open Diff Review in a new tab')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: '{"token":"secret"}' })
  })
  it('reports a wrong token visibly and does not probe or retry', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 401 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(login('wrong')).rejects.toThrow('Incorrect token')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('notifies the gate when an ordinary API request returns 401', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('window', { dispatchEvent })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in' } }, { status: 401 })))
    await expect(getSessions()).rejects.toThrow('Sign in')
    expect(dispatchEvent.mock.calls[0]?.[0].type).toBe(AUTH_REQUIRED)
  })
})
