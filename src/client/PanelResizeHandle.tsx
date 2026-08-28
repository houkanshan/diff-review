import { useEffect, useRef } from 'react'

export type PanelWidthSide = 'left' | 'right' | 'pr' | 'chat'

export function storedPanelWidth(
  side: PanelWidthSide,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(window.localStorage.getItem(`diff-review-${side}-panel-width`))
  return Number.isFinite(value) && value > 0 ? Math.min(max, Math.max(min, value)) : fallback
}

export function storePanelWidth(side: PanelWidthSide, width: number): void {
  window.localStorage.setItem(`diff-review-${side}-panel-width`, String(width))
}

export function PanelResizeHandle({
  label,
  side,
  size,
  min,
  max,
  className = 'panel-resizer',
  onChange,
}: {
  label: string
  side: 'left' | 'right'
  size: number
  min: number
  max: number
  className?: string
  onChange(size: number): void
}) {
  const dragStart = useRef<{ x: number; size: number } | null>(null)
  const stopDrag = useRef<(() => void) | null>(null)
  const latest = useRef({ size, min, max, side, onChange })
  latest.current = { size, min, max, side, onChange }

  useEffect(() => () => {
    stopDrag.current?.()
  }, [])

  return (
    <div
      className={className}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={size}
      tabIndex={0}
      data-base-ui-swipe-ignore=""
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        stopDrag.current?.()
        dragStart.current = { x: event.clientX, size: latest.current.size }
        document.body.classList.add('resizing-panels')
        const onMove = (move: PointerEvent) => {
          if (dragStart.current == null) return
          if (move.buttons === 0) {
            onUp()
            return
          }
          const current = latest.current
          const delta = move.clientX - dragStart.current.x
          const next = dragStart.current.size + (current.side === 'left' ? delta : -delta)
          current.onChange(Math.min(current.max, Math.max(current.min, Math.round(next))))
        }
        const onUp = () => {
          dragStart.current = null
          stopDrag.current = null
          document.body.classList.remove('resizing-panels')
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
        stopDrag.current = onUp
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        const delta = event.key === 'ArrowRight' ? 10 : -10
        const next = size + (side === 'left' ? delta : -delta)
        onChange(Math.min(max, Math.max(min, next)))
      }}
    />
  )
}
