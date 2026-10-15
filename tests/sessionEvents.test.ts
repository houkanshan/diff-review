import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { authenticatedFetch, requireAuthentication, isCredentialPersistent } = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  requireAuthentication: vi.fn(),
  isCredentialPersistent: vi.fn(),
}))
vi.mock('../src/client/auth', () => ({ authenticatedFetch, requireAuthentication, isCredentialPersistent }))

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>()
  private readonly listeners = new Set<(event: MessageEvent) => void>()

  constructor(public name: string) {
    const group = FakeBroadcastChannel.channels.get(name) ?? new Set()
    group.add(this)
    FakeBroadcastChannel.channels.set(name, group)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    if (type === 'message') this.listeners.add(listener)
  }

  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (other === this) continue
      for (const listener of other.listeners) listener({ data } as MessageEvent)
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }
}

function streamResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({
    start(next) { controller = next },
    cancel,
  })
  const encoder = new TextEncoder()
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    cancel,
    send: (value: string) => controller.enqueue(encoder.encode(value)),
    bytes: (value: Uint8Array) => controller.enqueue(value),
    close: () => controller.close(),
  }
}

function update(sessionId: string): string {
  return `data: ${JSON.stringify({ type: 'session-updated', sessionId })}\n\n`
}

// Stream reads, fetch, and Web Lock callbacks each schedule microtasks, not timers.
async function flush() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

const stops: Array<() => void> = []
function keep(stop: () => void) { stops.push(stop); return stop }

function stubBrowser(locks?: unknown, channel: unknown = FakeBroadcastChannel) {
  vi.stubGlobal('BroadcastChannel', channel)
  vi.stubGlobal('navigator', { locks })
  vi.stubGlobal('EventSource', vi.fn(() => { throw new Error('Native EventSource must not be used') }))
}

// Models exclusive queued Web Locks, including cancellation and leader handover.
function sharedLocks() {
  let tail = Promise.resolve()
  return {
    request: vi.fn((_name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) => {
      const previous = tail
      let release!: () => void
      tail = new Promise<void>((resolve) => { release = resolve })
      return new Promise<void>((resolve, reject) => {
        const aborted = () => { reject(new DOMException('Aborted', 'AbortError')) }
        options.signal.addEventListener('abort', aborted, { once: true })
        void previous.then(async () => {
          try {
            if (options.signal.aborted) return
            await callback()
            resolve()
          } finally {
            options.signal.removeEventListener('abort', aborted)
            release()
          }
        })
      })
    }),
  }
}

describe('authenticated session event stream', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    stubBrowser()
    authenticatedFetch.mockReset()
    requireAuthentication.mockReset()
    isCredentialPersistent.mockReset().mockReturnValue(true)
    authenticatedFetch.mockImplementation(async (path: string, init: RequestInit) => {
      const response = await fetch(path, init)
      // This is the auth helper's contract; sessionEvents must not ask twice.
      if (response.status === 401) requireAuthentication()
      return response
    })
  })

  afterEach(async () => {
    for (const stop of stops.splice(0)) stop()
    await flush()
    FakeBroadcastChannel.channels.clear()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shares one cancellable fetch within a frame and routes matching sessions', async () => {
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValue(stream.response)
    vi.stubGlobal('fetch', fetch)
    const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = keep(subscribeSessionEvents('session-a', first))
    const stopSecond = keep(subscribeSessionEvents('session-b', second))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/events', expect.objectContaining({
      headers: { Accept: 'text/event-stream' }, signal: expect.any(AbortSignal),
    }))
    expect(first).toHaveBeenCalledTimes(1) // Initial resync.
    expect(second).toHaveBeenCalledTimes(1)
    stream.send(update('session-b'))
    await flush()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    stopFirst()
    expect(stream.cancel).not.toHaveBeenCalled()
    stopSecond()
    await flush()
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retains the stream across synchronous effect unsubscribe/resubscribe without another resync', async () => {
    isCredentialPersistent.mockReturnValue(false)
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValue(stream.response)
    vi.stubGlobal('fetch', fetch)
    const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
    const first = vi.fn()
    const stopFirst = keep(subscribeSessionEvents('session-a', first))
    await flush()
    expect(first).toHaveBeenCalledTimes(1)

    stopFirst()
    const replacement = vi.fn()
    const stopReplacement = keep(subscribeSessionEvents('session-a', replacement))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(stream.cancel).not.toHaveBeenCalled()
    expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(false)
    expect(replacement).not.toHaveBeenCalled()

    stream.send(update('session-a'))
    await flush()
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    stopReplacement()
    expect(stream.cancel).not.toHaveBeenCalled()
    await flush()
    expect(stream.cancel).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('decodes split UTF-8, CRLF and multiline frames; ignores heartbeats and invalid events', async () => {
    const stream = streamResponse()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response))
    const { subscribeServerEvents } = await import('../src/client/sessionEvents')
    const listener = vi.fn()
    keep(subscribeServerEvents('session-猫', listener))
    await flush()
    listener.mockClear()
    const encoded = new TextEncoder().encode(
      ': heartbeat\r\n\r\ndata: not JSON\r\n\r\n'
      + 'data: {"type":"unknown","sessionId":"session-猫"}\n\n'
      + 'data: {"type":"pi-chat","sessionId":"session-猫","overlay":{}}\n\n'
      + 'event: ignored\ndata: {"type":"session-updated","sessionId":"session-猫"}\n\n'
      + 'event: message\r\ndata: {"type":"session-updated",\r\n'
      + 'data: "sessionId":"session-猫"}\r\n\r\n'
      + 'data: {"type":"pi-chat","sessionId":"session-猫","overlay":null,"transcriptRevision":"v2"}\r\r'
      + ': another heartbeat\n\n',
    )
    // Every byte boundary is exercised, including multibyte code points and CR|LF.
    for (const byte of encoded) stream.bytes(Uint8Array.of(byte))
    await flush()
    // Each read takes a microtask, so wait for this finite queued input to drain.
    for (let index = 0; index < encoded.length; index++) await Promise.resolve()
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: 'session-updated', sessionId: 'session-猫' },
      { type: 'pi-chat', sessionId: 'session-猫', overlay: null, transcriptRevision: 'v2' },
    ])
    stream.send('data: {"type":"session-updated","sessionId":"session-猫"}')
    stream.close()
    await flush()
    expect(listener).toHaveBeenCalledTimes(2) // EOF does not dispatch an unfinished frame.
  })

  it('resyncs on reconnect, backs off repeated EOFs, and cancels a pending retry', async () => {
    const firstStream = streamResponse()
    const nextStream = streamResponse()
    const fetch = vi.fn().mockResolvedValueOnce(firstStream.response).mockResolvedValueOnce(nextStream.response)
    vi.stubGlobal('fetch', fetch)
    const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
    const listener = vi.fn()
    const stop = keep(subscribeSessionEvents('session-a', listener))
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    firstStream.close()
    await flush()
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(2)
    nextStream.close()
    await flush()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops on reconnect 401 and asks for sign-in once without a retry loop', async () => {
    const stream = streamResponse()
    const fetch = vi.fn().mockResolvedValueOnce(stream.response)
      .mockResolvedValue(new Response('Expired', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
    keep(subscribeSessionEvents('session-a', vi.fn()))
    await flush()
    stream.close()
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(requireAuthentication).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    keep(subscribeSessionEvents('session-b', vi.fn()))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight fetch on final unsubscribe without a zombie reconnect', async () => {
    const fetch = vi.fn((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetch)
    const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
    const stop = keep(subscribeSessionEvents('session-a', vi.fn()))
    stop()
    await flush()
    expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['absent channel', 'denied channel', 'denied lock getter', 'denied lock request', 'rejected lock request', 'denied channel post'])(
    'keeps a single local stream when coordination is %s', async (failure) => {
      const request = vi.fn(() => Promise.reject(new DOMException('Denied', 'SecurityError')))
      if (failure === 'absent channel') {
        stubBrowser({ request })
        vi.stubGlobal('BroadcastChannel', undefined)
      }
      if (failure === 'denied channel') stubBrowser({ request }, class { constructor() { throw new Error('Denied') } })
      if (failure === 'denied lock getter') {
        vi.stubGlobal('navigator', { get locks() { throw new Error('Denied') } })
      }
      if (failure === 'denied lock request') stubBrowser({ request() { throw new Error('Denied') } })
      if (failure === 'rejected lock request') stubBrowser({ request })
      if (failure === 'denied channel post') {
        stubBrowser(sharedLocks(), class extends FakeBroadcastChannel {
          postMessage() { throw new Error('Denied') }
        })
      }
      const stream = streamResponse()
      const fetch = vi.fn().mockResolvedValue(stream.response)
      vi.stubGlobal('fetch', fetch)
      const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
      const first = vi.fn()
      const second = vi.fn()
      keep(subscribeSessionEvents('session-a', first))
      keep(subscribeSessionEvents('session-a', second))
      await flush()
      stream.send(update('session-a'))
      await flush()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(first).toHaveBeenCalledTimes(2)
      expect(second).toHaveBeenCalledTimes(2)
    },
  )

  it('uses independent per-frame streams for memory-only credentials without coordination', async () => {
    isCredentialPersistent.mockReturnValue(false)
    const request = vi.fn()
    const channel = vi.fn(() => { throw new Error('Must not coordinate memory-only auth') })
    stubBrowser({ request }, channel)
    const firstStream = streamResponse()
    const secondStream = streamResponse()
    const fetch = vi.fn().mockResolvedValueOnce(firstStream.response).mockResolvedValueOnce(secondStream.response)
    vi.stubGlobal('fetch', fetch)
    const firstFrame = await import('../src/client/sessionEvents')
    vi.resetModules()
    const secondFrame = await import('../src/client/sessionEvents')
    const first = vi.fn()
    const second = vi.fn()
    keep(firstFrame.subscribeSessionEvents('session-a', first))
    keep(firstFrame.subscribeSessionEvents('session-b', vi.fn()))
    keep(secondFrame.subscribeSessionEvents('session-a', second))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(request).not.toHaveBeenCalled()
    expect(channel).not.toHaveBeenCalled()
    firstStream.send(update('session-a'))
    await flush()
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('shares across frames and hands leadership over when the leader unmounts', async () => {
    const locks = sharedLocks()
    stubBrowser(locks)
    const leaderStream = streamResponse()
    const followerStream = streamResponse()
    const fetch = vi.fn().mockResolvedValueOnce(leaderStream.response).mockResolvedValueOnce(followerStream.response)
    vi.stubGlobal('fetch', fetch)
    const leader = await import('../src/client/sessionEvents')
    vi.resetModules()
    const follower = await import('../src/client/sessionEvents')
    const first = vi.fn()
    const second = vi.fn()
    const stopLeader = keep(leader.subscribeSessionEvents('session-a', first))
    keep(follower.subscribeSessionEvents('session-a', second))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(locks.request).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1) // Leader's initial resync is broadcast.
    leaderStream.send(update('session-a'))
    await flush()
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    stopLeader()
    await flush()
    expect(leaderStream.cancel).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(3) // New leader resyncs before consuming events.
    followerStream.send(update('session-a'))
    await flush()
    expect(second).toHaveBeenCalledTimes(4)
  })

  it('releases a broken broadcaster so another frame is not stranded waiting for events', async () => {
    let denyPost = true
    stubBrowser(sharedLocks(), class extends FakeBroadcastChannel {
      postMessage(data: unknown) {
        if (denyPost) { denyPost = false; throw new Error('Denied') }
        super.postMessage(data)
      }
    })
    const firstStream = streamResponse()
    const secondStream = streamResponse()
    const fetch = vi.fn().mockResolvedValueOnce(firstStream.response).mockResolvedValueOnce(secondStream.response)
    vi.stubGlobal('fetch', fetch)
    const firstFrame = await import('../src/client/sessionEvents')
    vi.resetModules()
    const secondFrame = await import('../src/client/sessionEvents')
    const first = vi.fn()
    const second = vi.fn()
    keep(firstFrame.subscribeSessionEvents('session-a', first))
    keep(secondFrame.subscribeSessionEvents('session-a', second))
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    firstStream.send(update('session-a'))
    secondStream.send(update('session-a'))
    await flush()
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('bounds network-failure retry delays at thirty seconds', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('Offline'))
    vi.stubGlobal('fetch', fetch)
    const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
    keep(subscribeSessionEvents('session-a', vi.fn()))
    await flush()
    let attempts = 1
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fetch).toHaveBeenCalledTimes(attempts)
      await vi.advanceTimersByTimeAsync(1)
      expect(fetch).toHaveBeenCalledTimes(++attempts)
    }
  })

  it('cancels a queued lock without starting a stream after unmount', async () => {
    let grant!: () => Promise<void>
    stubBrowser({ request(_name: string, _options: unknown, callback: () => Promise<void>) {
      grant = callback
      return Promise.resolve()
    } })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const { subscribeSessionEvents } = await import('../src/client/sessionEvents')
    const stop = keep(subscribeSessionEvents('session-a', vi.fn()))
    stop()
    await flush()
    await grant()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).not.toHaveBeenCalled()
  })
})
