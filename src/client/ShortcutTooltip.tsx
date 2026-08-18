import { Tooltip } from '@base-ui/react/tooltip'
import type { ReactElement, ReactNode } from 'react'

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function ShortcutTooltip({
  label,
  shortcut,
  children,
}: {
  label: string
  shortcut: string
  children: ReactElement
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner className="tooltip-positioner" sideOffset={6}>
          <Tooltip.Popup className="tooltip-popup tooltip-popup-with-kbd">
            <span>{label}</span>
            <Kbd>{shortcut}</Kbd>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
