const CONNECT_TYPE = 'pi-monitor:diff-review-connect'
const LOCATION_TYPE = 'diff-review:location'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

type EmbedPeer = {
  source: WindowProxy
  origin: string
  nonce: string
}

let peer: EmbedPeer | null = null

export function isAllowedEmbedParentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname)
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
    if (!isAllowedEmbedParentOrigin(event.origin)) return
    const nonce = connectNonce(event.data)
    if (!nonce) return
    peer = {
      source: event.source as WindowProxy,
      origin: event.origin,
      nonce,
    }
    publishEmbedLocation()
  })
}
