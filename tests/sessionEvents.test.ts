import { afterEach, describe, expect, it, vi } from 'vitest'

import { subscribeSessionEvents } from '../src/client/sessionEvents'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  onmessage: ((event: { data: string }) => void) | null = null
  onopen: (() => void) | null = null
  closed = false

  constructor(public url: string) {
    FakeEventSource.instances.push(this)
  }

  close() {
    this.closed = true
  }

  emit(sessionId: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'session-updated', sessionId }) })
  }

  open() {
    this.onopen?.()
  }
}

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
    const group = FakeBroadcastChannel.channels.get(this.name)
    if (group == null) return
    for (const other of group) {
      if (other === this) continue
      const event = { data } as MessageEvent
      for (const listener of other.listeners) listener(event)
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this)
  }
}

function stubBrowser(locks: unknown) {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
  vi.stubGlobal('navigator', { locks })
}

describe('subscribeSessionEvents', () => {
  afterEach(() => {
    FakeEventSource.instances = []
    FakeBroadcastChannel.channels.clear()
    vi.unstubAllGlobals()
  })

  it('opens one EventSource for two subscribers and fans matching events out', async () => {
    let grant: (() => void) | undefined
    stubBrowser({
      request(_name: string, _options: unknown, callback: () => Promise<void>) {
        return new Promise<void>((resolve) => {
          grant = () => {
            void callback().then(resolve)
          }
        })
      },
    })

    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = subscribeSessionEvents('session-a', first)
    const stopSecond = subscribeSessionEvents('session-a', second)
    expect(FakeEventSource.instances).toHaveLength(0)

    grant?.()
    await Promise.resolve()
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toBe('/api/events')

    FakeEventSource.instances[0]?.emit('session-a')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    FakeEventSource.instances[0]?.emit('session-b')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    stopFirst()
    expect(FakeEventSource.instances[0]?.closed).toBe(false)
    stopSecond()
    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })

  it('falls back to one EventSource per tab when Web Locks are missing', () => {
    stubBrowser(undefined)
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = subscribeSessionEvents('session-a', first)
    const stopSecond = subscribeSessionEvents('session-b', second)
    expect(FakeEventSource.instances).toHaveLength(1)

    FakeEventSource.instances[0]?.emit('session-b')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    stopFirst()
    stopSecond()
    expect(FakeEventSource.instances[0]?.closed).toBe(true)
  })

  it('refetches every subscribed session when the EventSource reconnects', () => {
    stubBrowser(undefined)
    const first = vi.fn()
    const second = vi.fn()
    const stopFirst = subscribeSessionEvents('session-a', first)
    const stopSecond = subscribeSessionEvents('session-b', second)

    FakeEventSource.instances[0]?.open()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)

    stopFirst()
    stopSecond()
  })
})
