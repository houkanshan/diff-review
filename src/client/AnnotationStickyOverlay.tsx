import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useSetAtom } from 'jotai'

import { annotationThreads } from '../shared/annotationThreads'
import type { SessionAnnotation } from '../shared/types'
import { fileIdForAnnotation, stickyOverlayIdsAtom } from './annotationComposer'
import {
  measurePierreColumnLeft,
  measurePierreRangeGeometry,
  measureStickyCardBox,
  overlayCardBox,
  selectDockedAnnotationIds,
  stickyOverlayMode,
} from './annotationSticky'

const DEFAULT_CARD_HEIGHT = 72
const WHEEL_RESTORE_MS = 200

export function AnnotationStickyOverlay({
  scroller,
  annotations,
  files,
  collapsedFiles,
  renderCard,
}: {
  scroller: HTMLElement | null
  annotations: SessionAnnotation[]
  files: readonly { name: string; prevName?: string | null }[]
  collapsedFiles: Set<string>
  renderCard(annotation: SessionAnnotation, replies: SessionAnnotation[]): ReactNode
}) {
  const [ids, setIds] = useState<string[]>([])
  const boxes = useRef(new Map<string, { left: number; width: number; bottom: number }>())
  const nodes = useRef(new Map<string, HTMLElement>())
  const setOverlayIds = useSetAtom(stickyOverlayIdsAtom)

  useLayoutEffect(() => {
    if (scroller == null) return
    let frame = 0
    const sync = () => {
      const candidates: Array<{
        id: string
        fileId: string
        side: 'old' | 'new'
        startLine: number
        endLine: number
      }> = []
      const visible = annotations.filter((annotation) =>
        annotation.comment != null &&
        annotation.archivedAt == null &&
        !collapsedFiles.has(fileIdForAnnotation(annotation, files)),
      )
      for (const { root } of annotationThreads(visible)) {
        const fileId = fileIdForAnnotation(root, files)
        const geometry = measurePierreRangeGeometry(
          scroller,
          fileId,
          root.side,
          root.startLine,
          root.endSide ?? root.side,
          root.endLine,
        )
        if (geometry == null) continue
        const inDoc = measureStickyCardBox(scroller, root.id)
        const height = inDoc?.height ?? nodes.current.get(root.id)?.offsetHeight ?? DEFAULT_CARD_HEIGHT
        if (stickyOverlayMode(geometry, height, inDoc?.top ?? null) !== 'dock') continue
        candidates.push({
          id: root.id,
          fileId,
          side: root.endSide ?? root.side,
          startLine: root.startLine,
          endLine: root.endLine,
        })
      }
      const nextIds = selectDockedAnnotationIds(candidates)
      let bottom = 0
      for (const id of nextIds) {
        const root = visible.find((annotation) => annotation.id === id)
        if (root == null) continue
        const fileId = fileIdForAnnotation(root, files)
        const inDoc = measureStickyCardBox(scroller, root.id)
        const box = overlayCardBox(
          scroller,
          inDoc,
          measurePierreColumnLeft(scroller, fileId, root.endSide ?? root.side)
            ?? measurePierreColumnLeft(scroller, fileId, root.side),
        )
        boxes.current.set(root.id, { left: box.left, width: box.width, bottom })
        const node = nodes.current.get(root.id)
        if (node != null) applyBox(node, box.left, box.width, bottom)
        bottom += (node?.offsetHeight ?? DEFAULT_CARD_HEIGHT) + 8
      }
      setIds((current) => idsEqual(current, nextIds) ? current : nextIds)
      setOverlayIds((current: ReadonlySet<string>) =>
        idsEqual([...current], nextIds) ? current : new Set(nextIds),
      )
    }
    const schedule = () => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        sync()
      })
    }
    sync()
    scroller.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [annotations, collapsedFiles, files, scroller, setOverlayIds])

  useLayoutEffect(() => {
    const host = scroller?.parentElement
    if (scroller == null || host == null) return
    const pending = new Map<HTMLElement, number>()
    const restore = (node: HTMLElement) => {
      node.style.pointerEvents = ''
      pending.delete(node)
    }
    const onWheel = (event: Event) => {
      const { target, deltaX, deltaY } = event as WheelEvent
      const layer = wheelPassThroughLayer(target)
      if (layer == null) return
      layer.style.pointerEvents = 'none'
      if (layer.classList.contains('annotation-sticky-card')) {
        scroller.scrollBy({ top: deltaY, left: deltaX })
      }
      const prev = pending.get(layer)
      if (prev != null) window.clearTimeout(prev)
      pending.set(layer, window.setTimeout(() => restore(layer), WHEEL_RESTORE_MS))
    }
    host.addEventListener('wheel', onWheel, { capture: true, passive: true })
    return () => {
      host.removeEventListener('wheel', onWheel, true)
      for (const [node, timer] of pending) {
        window.clearTimeout(timer)
        restore(node)
      }
    }
  }, [scroller])

  useLayoutEffect(() => {
    for (const id of ids) {
      const box = boxes.current.get(id)
      const node = nodes.current.get(id)
      if (box != null && node != null) applyBox(node, box.left, box.width, box.bottom)
    }
  }, [ids])

  useLayoutEffect(() => () => {
    setOverlayIds(new Set<string>())
  }, [setOverlayIds])

  const threads = annotationThreads(annotations.filter((annotation) =>
    annotation.comment != null && annotation.archivedAt == null,
  ))
  const threadById = new Map(threads.map((thread) => [thread.root.id, thread]))

  return (
    <div className="annotation-sticky-layer" aria-hidden={ids.length === 0}>
      {ids.map((id) => {
        const thread = threadById.get(id)
        if (thread == null) return null
        return (
          <div
            key={id}
            className="annotation-sticky-card"
            ref={(node) => {
              if (node == null) nodes.current.delete(id)
              else nodes.current.set(id, node)
            }}
          >
            {renderCard(thread.root, thread.replies)}
          </div>
        )
      })}
    </div>
  )
}

function applyBox(node: HTMLElement, left: number, width: number, bottom: number): void {
  node.style.left = `${left}px`
  node.style.width = `${width}px`
  node.style.bottom = `${bottom}px`
}

function wheelPassThroughLayer(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || shouldRetainWheel(target)) return null
  return target.closest('.annotation-sticky-card')
    ?? target.closest('.inline-annotation')
}

function shouldRetainWheel(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const field = target.closest('textarea, select, [contenteditable="true"]')
  if (!(field instanceof HTMLElement)) return false
  return field.scrollHeight > field.clientHeight + 1
}

function idsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}
