import type { PiChatOverlay, ServerEvent, SessionUpdatedEvent } from '../shared/types'

const SSE_LOCK = 'diff-review:sse'
const SSE_CHANNEL = 'diff-review:sse'

const listeners = new Set<(event: ServerEvent) => void>()

let channel: BroadcastChannel | null = null
let source: EventSource | null = null
let lockAbort: AbortController | null = null

const RESYNC_SESSION_ID = '*'

function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== 'object' || value == null || !('type' in value) || !('sessionId' in value)) {
    return false
  }
  if (typeof (value as { sessionId: unknown }).sessionId !== 'string') return false
  if (value.type === 'session-updated') return true
  if (value.type !== 'pi-chat') return false
  const event = value as { transcriptRevision?: unknown; overlay?: unknown }
  return typeof event.transcriptRevision === 'string' && isPiChatOverlay(event.overlay)
}

function isPiChatOverlay(value: unknown): value is PiChatOverlay | null {
  if (value == null) return true
  if (typeof value !== 'object') return false
  const overlay = value as Record<string, unknown>
  return (
    typeof overlay.overlayId === 'string'
    && typeof overlay.requestId === 'string'
    && (overlay.afterTurnId === null || typeof overlay.afterTurnId === 'string')
    && typeof overlay.baseRevision === 'string'
    && typeof overlay.userText === 'string'
    && typeof overlay.assistantText === 'string'
    && typeof overlay.working === 'boolean'
    && typeof overlay.hasWork === 'boolean'
    && typeof overlay.workDetail === 'string'
    && typeof overlay.startedAt === 'string'
    && typeof overlay.seq === 'number'
  )
}

function dispatch(event: ServerEvent, broadcast: boolean): void {
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
    if (isServerEvent(message.data)) dispatch(message.data, false)
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

function addListener(listener: (event: ServerEvent) => void): () => void {
  listeners.add(listener)
  ensureTransport()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) releaseTransport()
  }
}

/** One EventSource for the whole origin; tabs share it through a Web Lock. */
export function subscribeSessionEvents(
  sessionId: string,
  onEvent: () => void,
): () => void {
  return addListener((event) => {
    if (event.type !== 'session-updated') return
    if (event.sessionId === sessionId || event.sessionId === RESYNC_SESSION_ID) onEvent()
  })
}

export function subscribeServerEvents(
  sessionId: string,
  onEvent: (event: ServerEvent) => void,
): () => void {
  return addListener((event) => {
    if (event.sessionId === sessionId || event.sessionId === RESYNC_SESSION_ID) onEvent(event)
  })
}

function openSessionEventSource(
  onEvent: (event: ServerEvent) => void,
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
    if (isServerEvent(parsed)) onEvent(parsed)
  }
  return next
}

export type { SessionUpdatedEvent }
