import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps, MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydratePartialDiff, parsePatchFiles, VirtualizedFileDiff } from '@pierre/diffs'
import type { FileDiffProps } from '@pierre/diffs/react'
import { NarrativeDiffView, type NarrativeDiffViewHandle } from '../src/client/NarrativeDiffView'
import type { ReviewLineAnnotation } from '../src/client/annotationComposer'

// SSR supplies the component tree; only host geometry and the imperative effect
// need substitutes to exercise navigation without a browser DOM dependency.
const harness = vi.hoisted(() => ({
  refs: [] as MutableRefObject<unknown>[],
  handle: undefined as NarrativeDiffViewHandle | undefined,
  fileProps: undefined as FileDiffProps<ReviewLineAnnotation, undefined> | undefined,
}))
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual,
    useRef: (initial: unknown) => {
      const ref = actual.useRef(initial)
      harness.refs.push(ref)
      return ref
    },
    useImperativeHandle: (_ref: unknown, create: () => NarrativeDiffViewHandle) => {
      harness.handle = create()
    },
  }
})
vi.mock('@pierre/diffs/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs/react')>()
  return { ...actual,
    FileDiff: (props: FileDiffProps<ReviewLineAnnotation, undefined>) => {
      harness.fileProps = props
      return <div />
    },
  }
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  harness.refs.length = 0
  harness.handle = undefined
  harness.fileProps = undefined
})

describe('narrative navigation during in-place hydration', () => {
  it.each(['additions', 'deletions'] as const)('waits for contents, then scrolls to the %s line without a new diff object', async (side) => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16))
    vi.stubGlobal('cancelAnimationFrame', clearTimeout)
    const file = parsePatchFiles('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -101 +101 @@\n-old\n+new\n')[0].files[0]
    const input: ComponentProps<typeof NarrativeDiffView> = {
      groups: [{ files: [file], references: [] }],
      items: [{ type: 'diff', id: file.name, fileDiff: file, collapsed: false }],
      options: {}, selection: null,
      onSelectionChange: vi.fn(), onSelectionEnd: vi.fn(), onVisibleFileChange: vi.fn(), onPostRender: vi.fn(),
      renderOverview: () => null, renderHeaderFilenameSuffix: () => null,
      renderHeaderMetadata: () => null, renderAnnotation: () => null,
    }
    renderToStaticMarkup(<NarrativeDiffView {...input} />)
    const scroller = {
      scrollTop: 0, clientHeight: 400,
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => [node],
    }
    const node = {
      dataset: { narrativeFile: file.name },
      getBoundingClientRect: () => ({ top: 1000 - scroller.scrollTop }),
    }
    harness.refs[0].current = { querySelector: () => scroller }
    let finishHydration!: () => void
    const hydration = new Promise<void>((resolve) => { finishHydration = resolve }).then(() => {
      const lines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}\n`)
      return hydratePartialDiff('merge', file, {
        oldFile: { name: file.name, contents: lines.join('') },
        newFile: { name: file.name, contents: lines.join('') },
      })
    })
    const expandHunk = vi.fn()
    // A partial diff can report estimated positions: navigation must not use
    // them while the requested context is still loading.
    const getLinePosition = vi.fn(() => ({ top: 800, height: 16 }))
    const instance = Object.assign(Object.create(VirtualizedFileDiff.prototype), {
      fileDiff: file, options: { collapsed: false }, expandHunk, getLinePosition,
    }) as VirtualizedFileDiff<ReviewLineAnnotation>
    harness.fileProps!.options!.onPostRender!(node as unknown as HTMLElement, instance, 'mount')

    harness.handle!.scrollToAnnotation(file.name, 80, side)
    await vi.advanceTimersByTimeAsync(48)
    expect(file.isPartial).toBe(true)
    expect(expandHunk).toHaveBeenCalledExactlyOnceWith(0, 'down', 41)
    expect(getLinePosition).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(992)

    finishHydration()
    expect(await hydration).toBe(file)
    expect(instance.fileDiff).toBe(file)
    expect(file.isPartial).toBe(false)
    await vi.advanceTimersByTimeAsync(16)
    expect(getLinePosition).toHaveBeenCalledWith(80, side)
    expect(scroller.scrollTop).toBe(1608)
    expect(expandHunk).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
