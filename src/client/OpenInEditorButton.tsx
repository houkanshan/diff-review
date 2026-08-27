import { Tooltip } from '@base-ui/react/tooltip'
import { SquareArrowOutUpRight as OpenInEditorIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { editorLabel, type EditorId } from '../shared/editor'
import { ClientError, openInEditor } from './api'
import { hoveredDiffLineFromPath, type HoveredDiffLine } from './editor'

const BUTTON_SIZE = 22
const BUTTON_INSET = 8

export function OpenInEditorButton({
  sessionId,
  editor,
  stage,
}: {
  sessionId: string
  editor: EditorId
  stage: HTMLElement | null
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const hoverRef = useRef<HoveredDiffLine | null>(null)
  const [hover, setHover] = useState<HoveredDiffLine | null>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)

  const syncPosition = useCallback((next: HoveredDiffLine | null) => {
    hoverRef.current = next
    setHover(next)
    if (next == null || stage == null) return
    const stageRect = stage.getBoundingClientRect()
    const lineRect = next.element.getBoundingClientRect()
    if (lineRect.bottom <= stageRect.top || lineRect.top >= stageRect.bottom) {
      setPosition(null)
      return
    }
    const x = Math.min(lineRect.right, stageRect.right) - stageRect.left - BUTTON_SIZE - BUTTON_INSET
    const y = lineRect.top - stageRect.top + (lineRect.height - BUTTON_SIZE) / 2
    setPosition({
      x: Math.max(BUTTON_INSET, x),
      y: Math.min(
        Math.max(BUTTON_INSET, y),
        Math.max(BUTTON_INSET, stageRect.height - BUTTON_SIZE - BUTTON_INSET),
      ),
    })
  }, [stage])

  useEffect(() => {
    if (stage == null) return

    const targetIsButton = (target: EventTarget | null) =>
      target instanceof Node && buttonRef.current != null && (
        buttonRef.current === target || buttonRef.current.contains(target)
      )

    const onPointerMove = (event: PointerEvent) => {
      if (targetIsButton(event.target)) return
      const next = hoveredDiffLineFromPath(event.composedPath())
      const current = hoverRef.current
      if (
        current?.filePath === next?.filePath &&
        current?.line === next?.line &&
        current?.element === next?.element
      ) return
      syncPosition(next)
    }
    const onPointerLeave = (event: PointerEvent) => {
      if (targetIsButton(event.relatedTarget)) return
      syncPosition(null)
    }
    const onScrollOrResize = () => {
      syncPosition(hoverRef.current)
    }

    stage.addEventListener('pointermove', onPointerMove)
    stage.addEventListener('pointerleave', onPointerLeave)
    stage.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      stage.removeEventListener('pointermove', onPointerMove)
      stage.removeEventListener('pointerleave', onPointerLeave)
      stage.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [stage, syncPosition])

  const open = async () => {
    const target = hoverRef.current
    if (target == null || opening) return
    setOpening(true)
    setError(null)
    try {
      await openInEditor(sessionId, {
        filePath: target.filePath,
        line: target.line,
        editor,
      })
    } catch (cause) {
      setError(cause instanceof ClientError ? cause.message : 'Could not open editor')
      window.setTimeout(() => setError(null), 2400)
    } finally {
      setOpening(false)
    }
  }

  const visible = hover != null && position != null
  const label = error ?? `Open in ${editorLabel(editor)}`

  return (
    <Tooltip.Root open={visible ? undefined : false}>
      <Tooltip.Trigger
        render={
          <button
            ref={buttonRef}
            type="button"
            className={`open-in-editor-button${visible ? ' is-visible' : ''}`}
            aria-label={label}
            aria-hidden={!visible}
            disabled={!visible || opening}
            style={
              position == null
                ? undefined
                : {
                    transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
                  }
            }
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void open()
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <OpenInEditorIcon />
          </button>
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner className="tooltip-positioner" side="left" sideOffset={6}>
          <Tooltip.Popup className="tooltip-popup">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
