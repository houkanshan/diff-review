import type { SessionUpdatedEvent } from '../shared/types'

const SSE_LOCK = 'diff-review:sse'
const SSE_CHANNEL = 'diff-review:sse'

const listeners = new Set<(event: SessionUpdatedEvent) => void>()

let channel: BroadcastChannel | null = null
let source: EventSource | null = null
let lockAbort: AbortController | null = null

const RESYNC_SESSION_ID = '*'

function isSessionEvent(value: unknown): value is SessionUpdatedEvent {
  return (
    typeof value === 'object'
    && value != null
    && 'type' in value
    && value.type === 'session-updated'
    && 'sessionId' in value
    && typeof value.sessionId === 'string'
  )
}

function dispatch(event: SessionUpdatedEvent, broadcast: boolean): void {
  for (const listener of listeners) listener(event)
  if (broadcast) channel?.postMessage(event)
}

function resyncSubscribers(broadcast: boolean): void {
  dispatch({ type: 'session-updated', sessionId: RESYNC_SESSION_ID }, broadcast)
}

function ensureTransport(): void {
  if (channel != null) return
  channel = new BroadcastChannel(SSE_CHANNEL)
  channel.addEventListener('message', (message) => {
    if (isSessionEvent(message.data)) dispatch(message.data, false)
  })

  const locks = navigator.locks
  if (locks == null) {
    source = openSessionEventSource(
      (event) => dispatch(event, true),
      () => resyncSubscribers(true),
    )
    return
  }

  lockAbort = new AbortController()
  void locks.request(SSE_LOCK, { signal: lockAbort.signal }, () => (
    new Promise<void>((resolve) => {
      source = openSessionEventSource(
        (event) => dispatch(event, true),
        () => resyncSubscribers(true),
      )
      const stop = () => {
        source?.close()
        source = null
        resolve()
      }
      if (lockAbort?.signal.aborted) {
        stop()
        return
      }
      lockAbort?.signal.addEventListener('abort', stop, { once: true })
    })
  )).catch(() => {
    // This tab released the lock without becoming leader.
  })
}

function releaseTransport(): void {
  lockAbort?.abort()
  lockAbort = null
  source?.close()
  source = null
  channel?.close()
  channel = null
}

/** One EventSource for the whole origin; tabs share it through a Web Lock. */
export function subscribeSessionEvents(
  sessionId: string,
  onEvent: () => void,
): () => void {
  const listener = (event: SessionUpdatedEvent) => {
    if (event.sessionId === sessionId || event.sessionId === RESYNC_SESSION_ID) onEvent()
  }
  listeners.add(listener)
  ensureTransport()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) releaseTransport()
  }
}

function openSessionEventSource(
  onEvent: (event: SessionUpdatedEvent) => void,
  onOpen: () => void,
): EventSource {
  const next = new EventSource('/api/events')
  next.onopen = () => onOpen()
  next.onmessage = (message) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(message.data) as unknown
    } catch {
      return
    }
    if (isSessionEvent(parsed)) onEvent(parsed)
  }
  return next
}
