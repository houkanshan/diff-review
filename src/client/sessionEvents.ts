import type { PiChatOverlay, ServerEvent, SessionUpdatedEvent } from '../shared/types'

import { authenticatedFetch, isCredentialPersistent } from './auth'

const SSE_LOCK = 'diff-review:sse'
const SSE_CHANNEL = 'diff-review:sse'
const RESYNC_SESSION_ID = '*'

const listeners = new Set<(event: ServerEvent) => void>()

type Transport = {
  abort: AbortController
  channel: BroadcastChannel | null
  lockAbort: AbortController | null
  releaseLock: (() => void) | null
  streamStarted: boolean
}

// Channel availability is independent of whether this frame already has a transport.
let transport: Transport | null = null

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

function disableSharing(run: Transport): void {
  run.lockAbort?.abort()
  run.lockAbort = null
  run.releaseLock?.()
  run.releaseLock = null
  try { run.channel?.close() } catch { /* Coordination may be denied by browser policy. */ }
  run.channel = null
}

function dispatch(event: ServerEvent, run?: Transport): void {
  for (const listener of listeners) listener(event)
  if (run?.channel != null) {
    try {
      run.channel.postMessage(event)
    } catch {
      // Release leadership too: waiting frames must not depend on a broken channel.
      disableSharing(run)
    }
  }
}

function startStream(run: Transport): void {
  if (run.streamStarted || run.abort.signal.aborted) return
  run.streamStarted = true
  void readSessionEvents(run)
}

function ensureTransport(): void {
  if (transport != null) return
  const run: Transport = {
    abort: new AbortController(), channel: null, lockAbort: null,
    releaseLock: null, streamStarted: false,
  }
  transport = run
  // An in-memory credential belongs only to this frame, not to an origin-wide leader.
  if (!isCredentialPersistent()) {
    startStream(run)
    return
  }
  try {
    run.channel = new BroadcastChannel(SSE_CHANNEL)
    run.channel.addEventListener('message', (message) => {
      if (!run.abort.signal.aborted && isServerEvent(message.data)) dispatch(message.data)
    })
    // A lock is useful only when this frame can receive the leader's events.
    const locks = navigator.locks
    if (locks != null) {
      const lockAbort = new AbortController()
      run.lockAbort = lockAbort
      void locks.request(SSE_LOCK, { signal: lockAbort.signal }, () => (
        new Promise<void>((resolve) => {
          if (run.abort.signal.aborted || lockAbort.signal.aborted) {
            resolve()
            return
          }
          run.releaseLock = resolve
          startStream(run)
        })
      )).catch(() => {
        if (!run.abort.signal.aborted) {
          disableSharing(run)
          startStream(run)
        }
      })
      return
    }
  } catch {
    disableSharing(run)
  }
  startStream(run)
}

function stopTransport(run: Transport): void {
  run.abort.abort()
  disableSharing(run)
}

function addListener(listener: (event: ServerEvent) => void): () => void {
  listeners.add(listener)
  ensureTransport()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && transport != null) {
      const run = transport
      // React can replace an effect subscription in the same commit. Keep its stream
      // through that synchronous handover to avoid a connect/resync/render loop.
      void Promise.resolve().then(() => {
        if (listeners.size === 0 && transport === run) {
          stopTransport(run)
          transport = null
        }
      })
    }
  }
}

/** One authenticated stream per frame; a Web Lock and channel share it when available. */
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

function retryDelay(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

async function readSessionEvents(run: Transport): Promise<void> {
  const signal = run.abort.signal
  let delay = 1_000
  while (!signal.aborted) {
    const connectedAt = Date.now()
    try {
      const response = await authenticatedFetch('/api/events', {
        headers: { Accept: 'text/event-stream' }, cache: 'no-store', signal,
      })
      if (signal.aborted || response.status === 401) {
        // authenticatedFetch asks the auth gate to sign in on 401. Never retry it.
        stopTransport(run)
        await response.body?.cancel().catch(() => {})
        return
      }
      if (!response.ok || response.body == null) {
        await response.body?.cancel().catch(() => {})
        throw new Error('Event stream unavailable')
      }
      dispatch({ type: 'session-updated', sessionId: RESYNC_SESSION_ID }, run)
      await consumeEvents(response.body, signal, (event) => dispatch(event, run))
    } catch {
      // Network failures and EOF reconnect with bounded backoff; cancellation never does.
    }
    if (signal.aborted) return
    if (Date.now() - connectedAt >= 30_000) delay = 1_000
    await retryDelay(signal, delay)
    delay = Math.min(delay * 2, 30_000)
  }
}

async function consumeEvents(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: ServerEvent) => void,
): Promise<void> {
  const reader = body.getReader()
  const cancel = () => { void reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  let pending = ''
  let skipLF = false
  let data: string[] = []
  let eventType = ''
  const line = (value: string) => {
    if (value === '') {
      if (data.length > 0 && (eventType === '' || eventType === 'message')) {
        try {
          const event: unknown = JSON.parse(data.join('\n'))
          if (isServerEvent(event)) onEvent(event)
        } catch { /* Ignore malformed frames. */ }
      }
      data = []
      eventType = ''
      return
    }
    const colon = value.indexOf(':')
    const field = colon === -1 ? value : value.slice(0, colon)
    let valueText = colon === -1 ? '' : value.slice(colon + 1)
    if (valueText.startsWith(' ')) valueText = valueText.slice(1)
    if (field === 'data') data.push(valueText)
    if (field === 'event') eventType = valueText
  }
  try {
    if (signal.aborted) cancel()
    while (!signal.aborted) {
      const chunk = await reader.read()
      if (chunk.done || signal.aborted) break
      pending += decoder.decode(chunk.value, { stream: true })
      let start = 0
      for (let index = 0; index < pending.length; index++) {
        const character = pending[index]
        if (skipLF) {
          skipLF = false
          if (character === '\n') { start = index + 1; continue }
        }
        if (character === '\r' || character === '\n') {
          line(pending.slice(start, index))
          start = index + 1
          skipLF = character === '\r'
        }
      }
      pending = pending.slice(start)
    }
    // An incomplete event at EOF is not dispatched (SSE requires a blank line).
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export type { SessionUpdatedEvent }
