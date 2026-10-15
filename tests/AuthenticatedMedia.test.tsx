import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticatedFetch } from '../src/client/auth'
import { AuthenticatedImage, AuthenticatedVideo, loadMediaSource } from '../src/client/AuthenticatedMedia'

vi.mock('../src/client/auth', () => ({ authenticatedFetch: vi.fn() }))
const fetchMedia = vi.mocked(authenticatedFetch)
const createObjectURL = vi.fn(() => 'blob:protected-media')
const revokeObjectURL = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
})
afterEach(() => vi.unstubAllGlobals())

describe('authenticated media lifecycle', () => {
  it.each(['/api/avatar?url=avatar', '/api/github-attachment?url=attachment'])(
    'fetches %s as a blob and releases it on disposal', async (path) => {
      const blob = new Blob(['image'])
      fetchMedia.mockResolvedValue(new Response(blob))
      const onLoad = vi.fn()
      const onError = vi.fn()
      const dispose = loadMediaSource(path, onLoad, onError)
      await vi.waitFor(() => expect(onLoad).toHaveBeenCalledWith('blob:protected-media'))
      expect(fetchMedia).toHaveBeenCalledWith(path, { signal: expect.any(AbortSignal) })
      expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
      expect(onError).not.toHaveBeenCalled()
      const signal = fetchMedia.mock.calls[0]![1]!.signal!
      expect(signal.aborted).toBe(false)
      dispose()
      dispose()
      expect(signal.aborted).toBe(true)
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:protected-media')
    },
  )

  it('aborts in-flight body reads and never publishes a late blob', async () => {
    let finishRead!: (result: ReadableStreamReadResult<Uint8Array>) => void
    const pendingRead = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { finishRead = resolve })
    const read = vi.fn(() => pendingRead)
    const releaseLock = vi.fn()
    fetchMedia.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => ({ read, releaseLock }) },
    } as unknown as Response)
    const onLoad = vi.fn()
    const onError = vi.fn()
    const dispose = loadMediaSource('/api/avatar?url=avatar', onLoad, onError)
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    dispose()
    expect(fetchMedia.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    finishRead({ done: true, value: undefined })
    await vi.waitFor(() => expect(releaseLock).toHaveBeenCalled())
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(onLoad).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it.each([401, 404, 500])('reports HTTP %s without creating an object URL', async (status) => {
    fetchMedia.mockResolvedValue(new Response(null, { status }))
    const onLoad = vi.fn()
    const onError = vi.fn()
    const dispose = loadMediaSource('/api/avatar?url=avatar', onLoad, onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(onLoad).not.toHaveBeenCalled()
    expect(createObjectURL).not.toHaveBeenCalled()
    dispose()
  })

  it('rejects oversized Content-Length before reading a body', async () => {
    const cancel = vi.fn()
    const getReader = vi.fn()
    fetchMedia.mockResolvedValue({
      ok: true,
      headers: new Headers({ 'Content-Length': String(100 * 1024 * 1024 + 1) }),
      body: { cancel, getReader },
    } as unknown as Response)
    const onError = vi.fn()
    const dispose = loadMediaSource('/api/github-attachment?url=large', vi.fn(), onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(getReader).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(createObjectURL).not.toHaveBeenCalled()
    dispose()
  })

  it('cancels a streamed body that exceeds 100 MiB even without Content-Length', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    const cancel = vi.fn()
    const releaseLock = vi.fn()
    const read = vi.fn(async () => ({ done: false, value: chunk }))
    fetchMedia.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response)
    const onLoad = vi.fn()
    const onError = vi.fn()
    const dispose = loadMediaSource('/api/github-attachment?url=large', onLoad, onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(read).toHaveBeenCalledTimes(101)
    expect(cancel).toHaveBeenCalledOnce()
    expect(releaseLock).toHaveBeenCalledOnce()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(onLoad).not.toHaveBeenCalled()
    dispose()
  })

  it('reports network failures', async () => {
    fetchMedia.mockRejectedValue(new Error('Offline'))
    const onError = vi.fn()
    const dispose = loadMediaSource('/api/github-attachment?url=attachment', vi.fn(), onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    dispose()
  })

  it.each([
    'https://example.com/image.png',
    'https://example.com/api/avatar?url=avatar',
    '//example.com/api/github-attachment?url=attachment',
    '/api/avatar-not-media?url=avatar',
  ])('preserves external or non-media URL %s without an authenticated fetch', (source) => {
    const onLoad = vi.fn()
    const dispose = loadMediaSource(source, onLoad, vi.fn())
    expect(onLoad).toHaveBeenCalledExactlyOnceWith(source)
    expect(fetchMedia).not.toHaveBeenCalled()
    dispose()
    expect(revokeObjectURL).not.toHaveBeenCalled()
  })

  it('never embeds protected API URLs directly and preserves lazy image/video attributes', () => {
    const image = renderToStaticMarkup(<AuthenticatedImage src="/api/avatar?url=avatar" alt="Author" />)
    expect(image).not.toContain('src=')
    expect(image).toContain('loading="lazy"')
    const video = renderToStaticMarkup(<AuthenticatedVideo src="/api/github-attachment?url=attachment" />)
    expect(video).not.toContain('src=')
    expect(video).toContain('controls=""')
    expect(video).toContain('preload="metadata"')
    expect(fetchMedia).not.toHaveBeenCalled()
  })
})
