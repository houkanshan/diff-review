import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { FileDiff, Virtualizer, useVirtualizer, type CodeViewItem, type FileDiffOptions } from '@pierre/diffs/react'
import { DEFAULT_VIRTUAL_FILE_METRICS, VirtualizedFileDiff, type CodeViewLineSelection, type FileDiff as FileDiffInstance, type FileDiffMetadata, type SelectionSide } from '@pierre/diffs'
import type { NarrativeGroup, ReviewLineAnnotation } from './annotationComposer'

export interface NarrativeDiffViewHandle {
  scrollToFile(id: string): void
  scrollToAnnotation(id: string, line: number, side: SelectionSide, align?: 'start' | 'center'): void
}

type Props = {
  groups: NarrativeGroup<FileDiffMetadata>[]
  items: CodeViewItem<ReviewLineAnnotation>[]
  options: FileDiffOptions<ReviewLineAnnotation, undefined>
  selection: CodeViewLineSelection | null
  onSelectionChange(selection: CodeViewLineSelection | null): void
  onSelectionEnd(selection: CodeViewLineSelection): void
  onVisibleFileChange(id: string): void
  onPostRender(node: HTMLElement, id: string): void
  renderOverview(group: NarrativeGroup<FileDiffMetadata>): ReactNode
  renderHeaderFilenameSuffix(item: CodeViewItem<ReviewLineAnnotation>): ReactNode
  renderHeaderMetadata(item: CodeViewItem<ReviewLineAnnotation>): ReactNode
  renderAnnotation: NonNullable<React.ComponentProps<typeof FileDiff<ReviewLineAnnotation>>['renderAnnotation']>
}

/** Expand only the context gap containing the requested line, on its actual side. */
export function revealNarrativeLine(
  instance: Pick<FileDiffInstance<ReviewLineAnnotation>, 'fileDiff' | 'expandHunk'>,
  line: number,
  side: SelectionSide,
): boolean {
  const diff = instance.fileDiff
  if (diff == null) return false
  for (const [index, hunk] of diff.hunks.entries()) {
    const start = side === 'deletions' ? hunk.deletionStart : hunk.additionStart
    const count = side === 'deletions' ? hunk.deletionCount : hunk.additionCount
    if (line < start) {
      if (line < start - hunk.collapsedBefore) return false
      instance.expandHunk(index, 'down', start - line + 20)
      return true
    }
    if (line < start + count) return false
  }
  const last = diff.hunks.at(-1)
  if (last == null) return false
  const end = side === 'deletions'
    ? last.deletionStart + last.deletionCount
    : last.additionStart + last.additionCount
  instance.expandHunk(diff.hunks.length, 'up', line - end + 21)
  return true
}

export const NarrativeDiffView = forwardRef<NarrativeDiffViewHandle, Props>(function NarrativeDiffView(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const instances = useRef(new Map<string, VirtualizedFileDiff<ReviewLineAnnotation>>())
  const navigationFrame = useRef<number | null>(null)
  const latest = useRef(props)
  latest.current = props
  useEffect(() => () => {
    if (navigationFrame.current != null) cancelAnimationFrame(navigationFrame.current)
  }, [])

  useImperativeHandle(ref, () => {
    function navigate(id: string, target?: { line: number; side: SelectionSide; align: 'start' | 'center' }) {
      if (navigationFrame.current != null) cancelAnimationFrame(navigationFrame.current)
      let attempts = 0
      let expandedDiff: FileDiffMetadata | undefined
      let waitingForContents = false
      const tick = () => {
        const scroller = host.current?.querySelector<HTMLElement>('.diff-view')
        const node = [...(scroller?.querySelectorAll<HTMLElement>('[data-narrative-file]') ?? [])]
          .find((element) => element.dataset.narrativeFile === id)
        const instance = instances.current.get(id)
        if (scroller != null && node != null) {
          const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
          if (target == null) {
            scroller.scrollTop = Math.max(0, top - 8)
            return
          }
          if (instance != null && !instance.options.collapsed) {
            if (expandedDiff !== instance.fileDiff) {
              expandedDiff = instance.fileDiff
              waitingForContents = revealNarrativeLine(instance, target.line, target.side) && instance.fileDiff?.isPartial === true
            } else if (!waitingForContents) {
              const position = instance.getLinePosition(target.line, target.side)
              if (position != null) {
                scroller.scrollTop = Math.max(0, top + position.top - (target.align === 'center'
                  ? (scroller.clientHeight - position.height) / 2 : 48))
                return
              }
            }
          }
          // Bring an offscreen file into the virtualizer's render window first.
          scroller.scrollTop = Math.max(0, top - 8)
        }
        if (++attempts < 90) navigationFrame.current = requestAnimationFrame(tick)
      }
      navigationFrame.current = requestAnimationFrame(tick)
    }
    return {
      scrollToFile: (id) => navigate(id),
      scrollToAnnotation: (id, line, side, align = 'center') => navigate(id, { line, side, align }),
    }
  }, [])

  // One flat keyed sibling list: moving a file between sections never remounts it.
  const byId = useMemo(() => new Map(props.items.map((item) => [item.id, item])), [props.items])
  const cancelNavigation = () => {
    if (navigationFrame.current != null) cancelAnimationFrame(navigationFrame.current)
    navigationFrame.current = null
  }
  return <div ref={host} className="narrative-diff-host"
    onWheelCapture={cancelNavigation}
    onPointerDownCapture={cancelNavigation}
    onScrollCapture={(event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.classList.contains('diff-view')) return
    const scroller = event.target
    const files = [...scroller.querySelectorAll<HTMLElement>('[data-narrative-file]')]
      .filter((node) => !latest.current.items.find((item) => item.id === node.dataset.narrativeFile)?.collapsed)
    const top = scroller.getBoundingClientRect().top + 48
    let visible = files[0]
    for (const file of files) {
      if (file.getBoundingClientRect().top > top) break
      visible = file
    }
    if (visible?.dataset.narrativeFile != null) latest.current.onVisibleFileChange(visible.dataset.narrativeFile)
  }}>
    <Virtualizer className="diff-view">
      <VirtualizerLayout groups={props.groups} options={props.options} />
      {props.groups.flatMap((group) => [
        <div key={`overview:${group.section?.prefix ?? 'other'}`}>{props.renderOverview(group)}</div>,
        ...group.files.flatMap((file) => {
          const item = byId.get(file.name)
          if (item?.type !== 'diff') return []
          return [<NarrativeFile key={`file:${item.id}`} {...props} item={item} instances={instances.current} />]
        }),
      ])}
    </Virtualizer>
  </div>
})

function VirtualizerLayout({ groups, options }: Pick<Props, 'groups' | 'options'>) {
  const virtualizer = useVirtualizer()
  useLayoutEffect(() => { virtualizer?.markDOMDirty() }, [virtualizer, groups, options])
  return null
}

const FILE_METRICS = { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: 16 }

function NarrativeFile({ item, instances, ...props }: Props & {
  item: Extract<CodeViewItem<ReviewLineAnnotation>, { type: 'diff' }>
  instances: Map<string, VirtualizedFileDiff<ReviewLineAnnotation>>
}) {
  const latest = useRef(props)
  latest.current = props
  const options = useMemo<FileDiffOptions<ReviewLineAnnotation, undefined>>(() => ({
    ...props.options,
    collapsed: item.collapsed,
    onLineSelectionChange: (range) => {
      if (range == null && latest.current.selection?.id !== item.id) return
      props.onSelectionChange(range == null ? null : { id: item.id, range })
    },
    onLineSelectionEnd: (range) => {
      if (range != null) props.onSelectionEnd({ id: item.id, range })
    },
    onPostRender: (node, instance, phase) => {
      if (phase === 'unmount') {
        if (instances.get(item.id) === instance) instances.delete(item.id)
        return
      }
      if (instance instanceof VirtualizedFileDiff) instances.set(item.id, instance)
      props.onPostRender(node, item.id)
    },
  }), [item.id, item.collapsed, props.options, props.onSelectionChange, props.onSelectionEnd, props.onPostRender, instances])
  return <article data-file-id={item.id} data-narrative-file={item.id}>
    <FileDiff<ReviewLineAnnotation>
      fileDiff={item.fileDiff}
      options={options}
      metrics={FILE_METRICS}
      lineAnnotations={item.annotations}
      selectedLines={props.selection?.id === item.id ? props.selection.range : null}
      renderHeaderFilenameSuffix={() => props.renderHeaderFilenameSuffix(item)}
      renderHeaderMetadata={() => props.renderHeaderMetadata(item)}
      renderAnnotation={props.renderAnnotation}
    />
  </article>
}
