import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import type { FileDiffProps } from '@pierre/diffs/react'
import { NarrativeDiffView, revealNarrativeLine } from '../src/client/NarrativeDiffView'
import type { ReviewLineAnnotation } from '../src/client/annotationComposer'

const captured = vi.hoisted(() => [] as FileDiffProps<ReviewLineAnnotation, undefined>[])
vi.mock('@pierre/diffs/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pierre/diffs/react')>()
  return { ...actual,
    FileDiff: (props: FileDiffProps<ReviewLineAnnotation, undefined>) => {
      captured.push(props)
      return <div data-rendered-file={props.fileDiff.name} />
    },
  }
})

const file = parsePatchFiles('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n')[0].files[0]
const section = (prefix: string) => ({ prefix, sessionId: 's', order: 1, body: 'Overview', createdAt: '', updatedAt: '' })
function props(): ComponentProps<typeof NarrativeDiffView> {
  return {
    groups: [{ section: section('FIRST'), files: [file], references: [] },
      { section: section('EMPTY'), files: [], references: [] }],
    items: [{ type: 'diff', id: file.name, fileDiff: file, collapsed: true, annotations: [] }],
    options: { stickyHeader: true, diffStyle: 'split' },
    selection: null,
    onSelectionChange: vi.fn(), onSelectionEnd: vi.fn(), onVisibleFileChange: vi.fn(), onPostRender: vi.fn(),
    renderOverview: (group) => <h2>{group.section?.prefix}</h2>,
    renderHeaderFilenameSuffix: vi.fn(), renderHeaderMetadata: vi.fn(), renderAnnotation: vi.fn(),
  }
}
beforeEach(() => captured.splice(0))

describe('narrative Pierre rendering', () => {
  it('interleaves real files and empty overviews in one continuous scroll root', () => {
    const input = props()
    const html = renderToStaticMarkup(<NarrativeDiffView {...input} />)
    expect(html.match(/class="diff-view"/g)).toHaveLength(1)
    expect(html.indexOf('FIRST')).toBeLessThan(html.indexOf('data-narrative-file="a.ts"'))
    expect(html.indexOf('data-narrative-file="a.ts"')).toBeLessThan(html.indexOf('EMPTY'))
    expect(captured).toHaveLength(1)
    expect(captured[0].fileDiff).toBe(file)
    expect(captured[0].options).toMatchObject({ collapsed: true, stickyHeader: true, diffStyle: 'split' })
    expect(captured[0].lineAnnotations).toBe(input.items[0].annotations)
    captured[0].renderHeaderMetadata?.(file)
    expect(input.renderHeaderMetadata).toHaveBeenCalledWith(input.items[0])
  })

  it('routes change and end selections by file and ignores a nonowner clearing selection', () => {
    const input = props()
    input.selection = { id: 'other.ts', range: { start: 1, end: 2, side: 'additions' } }
    renderToStaticMarkup(<NarrativeDiffView {...input} />)
    const options = captured[0].options!
    options.onLineSelectionChange?.(null)
    expect(input.onSelectionChange).not.toHaveBeenCalled()
    const range = { start: 3, end: 4, side: 'deletions' as const, endSide: 'additions' as const }
    options.onLineSelectionChange?.(range)
    options.onLineSelectionEnd?.(range)
    expect(input.onSelectionChange).toHaveBeenCalledWith({ id: 'a.ts', range })
    expect(input.onSelectionEnd).toHaveBeenCalledWith({ id: 'a.ts', range })
  })

  it('allows the selection owner to clear its composer and passes controlled selection through', () => {
    const input = props()
    input.selection = { id: 'a.ts', range: { start: 1, end: 2, side: 'additions' } }
    renderToStaticMarkup(<NarrativeDiffView {...input} />)
    expect(captured[0].selectedLines).toEqual(input.selection.range)
    captured[0].options?.onLineSelectionChange?.(null)
    expect(input.onSelectionChange).toHaveBeenCalledWith(null)
  })
})

describe('narrative virtualized context navigation', () => {
  const diff: FileDiffMetadata = { ...file, hunks: [{ ...file.hunks[0], collapsedBefore: 100,
    additionStart: 201, additionCount: 5, deletionStart: 101, deletionCount: 3 }] }
  it('expands the requested old-side gap rather than using new-side line numbers', () => {
    const expandHunk = vi.fn()
    revealNarrativeLine({ fileDiff: diff, expandHunk }, 80, 'deletions')
    expect(expandHunk).toHaveBeenCalledExactlyOnceWith(0, 'down', 41)
    expandHunk.mockClear()
    revealNarrativeLine({ fileDiff: diff, expandHunk }, 102, 'deletions')
    expect(expandHunk).not.toHaveBeenCalled()
  })
  it('expands new-side gaps and trailing context using the selected side', () => {
    const expandHunk = vi.fn()
    revealNarrativeLine({ fileDiff: diff, expandHunk }, 180, 'additions')
    expect(expandHunk).toHaveBeenLastCalledWith(0, 'down', 41)
    revealNarrativeLine({ fileDiff: diff, expandHunk }, 220, 'additions')
    expect(expandHunk).toHaveBeenLastCalledWith(1, 'up', 35)
    revealNarrativeLine({ fileDiff: diff, expandHunk }, 120, 'deletions')
    expect(expandHunk).toHaveBeenLastCalledWith(1, 'up', 37)
  })
})
