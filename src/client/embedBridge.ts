const CONNECT_TYPE = 'pi-monitor:diff-review-connect'
const LOCATION_TYPE = 'diff-review:location'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

type EmbedPeer = {
  source: WindowProxy
  origin: string
  nonce: string
}

let peer: EmbedPeer | null = null
let embedOrigins: string[] = []
let allowAnyEmbedOrigin = false
let pendingPeer: EmbedPeer | null = null

export function setEmbedOrigins(origins: string[], allowAny = false): void {
  embedOrigins = origins
  allowAnyEmbedOrigin = allowAny
  if (peer && !isAllowedEmbedParentOrigin(peer.origin)) peer = null
  if (pendingPeer && isAllowedEmbedParentOrigin(pendingPeer.origin)) {
    peer = pendingPeer
    publishEmbedLocation()
  }
  pendingPeer = null
}

export function isAllowedEmbedParentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return url.origin === origin && ['http:', 'https:'].includes(url.protocol)
      && (allowAnyEmbedOrigin || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname)) || embedOrigins.includes(origin))
  } catch {
    return false
  }
}

function connectNonce(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const message = value as { type?: unknown; nonce?: unknown }
  if (message.type !== CONNECT_TYPE || typeof message.nonce !== 'string') return null
  return message.nonce.length > 0 && message.nonce.length <= 128 ? message.nonce : null
}

export function publishEmbedLocation(): void {
  if (!peer) return
  peer.source.postMessage({
    type: LOCATION_TYPE,
    nonce: peer.nonce,
    href: window.location.href,
  }, peer.origin)
}

export function installEmbedBridge(): void {
  window.addEventListener('message', (event) => {
    if (window.parent === window || event.source !== window.parent) return
    const nonce = connectNonce(event.data)
    if (!nonce) return
    const candidate = { source: event.source as WindowProxy, origin: event.origin, nonce }
    if (!isAllowedEmbedParentOrigin(event.origin)) {
      pendingPeer = candidate
      return
    }
    peer = candidate
    publishEmbedLocation()
  })
}
