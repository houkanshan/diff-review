import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode, type RefObject } from 'react'
import { authenticatedFetch } from './auth'

function isProtectedMedia(source: string): boolean {
  return ['/api/avatar', '/api/github-attachment'].some((path) =>
    source === path || source.startsWith(`${path}?`),
  )
}

// Match the server attachment cap. Videos buffer fully before playback.
const MAX_MEDIA_BYTES = 100 * 1024 * 1024

async function readMediaBlob(response: Response): Promise<Blob> {
  if (Number(response.headers.get('Content-Length')) > MAX_MEDIA_BYTES) {
    await response.body?.cancel()
    throw new Error('Media exceeds the size limit')
  }
  const reader = response.body?.getReader()
  const chunks: BlobPart[] = []
  let size = 0
  if (reader != null) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_MEDIA_BYTES) {
          await reader.cancel()
          throw new Error('Media exceeds the size limit')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  return new Blob(chunks, { type: response.headers.get('Content-Type') ?? '' })
}

// Each mounted consumer owns its blob; disposal also covers an in-flight body read.
export function loadMediaSource(
  source: string,
  onLoad: (url: string) => void,
  onError: () => void,
): () => void {
  if (!isProtectedMedia(source)) {
    onLoad(source)
    return () => {}
  }
  const controller = new AbortController()
  let disposed = false
  let objectUrl: string | undefined
  void authenticatedFetch(source, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) throw new Error('Unable to load media')
      const blob = await readMediaBlob(response)
      if (disposed) return
      objectUrl = URL.createObjectURL(blob)
      onLoad(objectUrl)
    })
    .catch(() => {
      controller.abort()
      if (!disposed) onError()
    })
  return () => {
    if (disposed) return
    disposed = true
    controller.abort()
    if (objectUrl != null) URL.revokeObjectURL(objectUrl)
  }
}

type MediaState = { source: string; url?: string; failed: boolean }

function useMediaSource(source: string | undefined, element: RefObject<HTMLElement | null>, lazy: boolean) {
  const [state, setState] = useState<MediaState | null>(null)
  useEffect(() => {
    setState(null)
    if (source == null || !isProtectedMedia(source)) return
    let dispose: (() => void) | undefined
    let observer: IntersectionObserver | undefined
    let started = false
    let cancelled = false
    const load = () => {
      if (started || cancelled) return
      started = true
      observer?.disconnect()
      dispose = loadMediaSource(
        source,
        (url) => setState({ source, url, failed: false }),
        () => setState({ source, failed: true }),
      )
    }
    if (lazy && element.current != null && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load()
      }, { rootMargin: '300px' })
      observer.observe(element.current)
    } else {
      load()
    }
    return () => {
      cancelled = true
      observer?.disconnect()
      dispose?.()
    }
  }, [source, element, lazy])
  if (source == null || !isProtectedMedia(source)) return { url: source, failed: false }
  return state?.source === source ? state : { url: undefined, failed: false }
}

export function AuthenticatedImage({
  src,
  loading = 'lazy',
  fallback,
  onError,
  ...props
}: ComponentPropsWithoutRef<'img'> & { fallback?: ReactNode }) {
  const element = useRef<HTMLImageElement>(null)
  const media = useMediaSource(src, element, loading === 'lazy')
  const [failedUrl, setFailedUrl] = useState<string>()
  if (fallback != null && (media.failed || (media.url != null && failedUrl === media.url))) return fallback
  return <img {...props} ref={element} src={media.url} loading={loading} onError={(event) => {
    setFailedUrl(media.url)
    onError?.(event)
  }} />
}

export function AuthenticatedVideo({ src, ...props }: ComponentPropsWithoutRef<'video'>) {
  const element = useRef<HTMLVideoElement>(null)
  const media = useMediaSource(src, element, true)
  return <video {...props} ref={element} src={media.url} controls preload="metadata" />
}
