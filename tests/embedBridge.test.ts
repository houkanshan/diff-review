import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  installEmbedBridge,
  isAllowedEmbedParentOrigin,
  publishEmbedLocation,
  setEmbedOrigins,
} from '../src/client/embedBridge'

afterEach(() => { setEmbedOrigins([]); vi.unstubAllGlobals() })

describe('Diff Review embed bridge', () => {
  it('accepts only HTTP loopback parent origins', () => {
    expect(isAllowedEmbedParentOrigin('http://127.0.0.1:4899')).toBe(true)
    expect(isAllowedEmbedParentOrigin('http://localhost:4899')).toBe(true)
    expect(isAllowedEmbedParentOrigin('http://[::1]:4899')).toBe(true)
    expect(isAllowedEmbedParentOrigin('https://127.0.0.1:4899')).toBe(false)
    expect(isAllowedEmbedParentOrigin('http://example.test:4899')).toBe(false)
    expect(isAllowedEmbedParentOrigin('not an origin')).toBe(false)
  })

  it('allows only configured HTTPS parents', () => {
    setEmbedOrigins(['https://monitor.example.test'])
    expect(isAllowedEmbedParentOrigin('https://monitor.example.test')).toBe(true)
    expect(isAllowedEmbedParentOrigin('https://other.example.test')).toBe(false)
    expect(isAllowedEmbedParentOrigin('https://monitor.example.test/path')).toBe(false)
  })

  it('validates an early HTTPS parent handshake once status supplies the allowlist', () => {
    let receive: ((event: MessageEvent) => void) | undefined
    const parent = { postMessage: vi.fn() }
    vi.stubGlobal('window', {
      parent, location: { href: 'https://review.example.test/s/one' },
      addEventListener: (_type: string, callback: (event: MessageEvent) => void) => { receive = callback },
    })
    installEmbedBridge()
    receive?.({ source: parent, origin: 'https://monitor.example.test', data: { type: 'pi-monitor:diff-review-connect', nonce: 'early' } } as unknown as MessageEvent)
    expect(parent.postMessage).not.toHaveBeenCalled()
    setEmbedOrigins(['https://monitor.example.test'])
    expect(parent.postMessage).toHaveBeenCalledWith({ type: 'diff-review:location', nonce: 'early', href: 'https://review.example.test/s/one' }, 'https://monitor.example.test')
  })

  it('binds replies to the loopback parent source, origin, and nonce', () => {
    let onMessage: ((event: MessageEvent) => void) | null = null
    const parent = { postMessage: vi.fn() }
    const fakeWindow = {
      parent,
      location: { href: 'http://127.0.0.1:47658/s/drs_abc' },
      addEventListener: vi.fn((type: string, listener: (event: MessageEvent) => void) => {
        if (type === 'message') onMessage = listener
      }),
    }
    vi.stubGlobal('window', fakeWindow)
    installEmbedBridge()

    const dispatch = (source: unknown, origin: string, data: unknown) => {
      if (!onMessage) throw new Error('missing message listener')
      onMessage({ source, origin, data } as MessageEvent)
    }
    dispatch({}, 'http://127.0.0.1:4899', {
      type: 'pi-monitor:diff-review-connect',
      nonce: 'wrong-source',
    })
    dispatch(parent, 'https://127.0.0.1:4899', {
      type: 'pi-monitor:diff-review-connect',
      nonce: 'wrong-origin',
    })
    expect(parent.postMessage).not.toHaveBeenCalled()

    dispatch(parent, 'http://127.0.0.1:4899', {
      type: 'pi-monitor:diff-review-connect',
      nonce: 'nonce-1',
    })
    expect(parent.postMessage).toHaveBeenLastCalledWith({
      type: 'diff-review:location',
      nonce: 'nonce-1',
      href: 'http://127.0.0.1:47658/s/drs_abc',
    }, 'http://127.0.0.1:4899')

    fakeWindow.location.href = 'http://127.0.0.1:47658/pull-requests?repo=%2Ftmp%2Frepo'
    publishEmbedLocation()
    expect(parent.postMessage).toHaveBeenLastCalledWith({
      type: 'diff-review:location',
      nonce: 'nonce-1',
      href: fakeWindow.location.href,
    }, 'http://127.0.0.1:4899')
  })
})
