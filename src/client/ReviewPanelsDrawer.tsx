import { Drawer } from '@base-ui/react/drawer'
import { PanelLeft as PanelsIcon, X as CloseIcon } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

/** Keep in sync with `@media (max-width: 940px)` in styles.css. */
export const COMPACT_REVIEW_MAX_WIDTH = 940
const COMPACT_REVIEW_MEDIA = `(max-width: ${COMPACT_REVIEW_MAX_WIDTH}px)`

export function useCompactReviewLayout() {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(COMPACT_REVIEW_MEDIA).matches,
  )
  useEffect(() => {
    const media = window.matchMedia(COMPACT_REVIEW_MEDIA)
    const update = () => setCompact(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return compact
}

export function ReviewPanelsDrawer({
  open,
  onOpenChange,
  files,
  inspector,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  files: ReactNode
  inspector: ReactNode
}) {
  const [panel, setPanel] = useState<'files' | 'annotations'>('files')

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      swipeDirection="left"
    >
      <Drawer.Trigger
        className="icon-button workspace-panels-trigger"
        aria-label="Open files and annotations"
      >
        <PanelsIcon />
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Backdrop className="workspace-drawer-backdrop" />
        <Drawer.Viewport className="workspace-drawer-viewport">
          <Drawer.Popup className="workspace-drawer-popup">
            <div className="workspace-drawer-header">
              <Drawer.Title className="sr-only">Files and annotations</Drawer.Title>
              <div className="workspace-drawer-tabs" role="tablist" aria-label="Review panels">
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === 'files'}
                  className={panel === 'files' ? 'is-active' : undefined}
                  onClick={() => setPanel('files')}
                >
                  Files
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === 'annotations'}
                  className={panel === 'annotations' ? 'is-active' : undefined}
                  onClick={() => setPanel('annotations')}
                >
                  Annotations
                </button>
              </div>
              <Drawer.Close className="icon-button" aria-label="Close panels">
                <CloseIcon />
              </Drawer.Close>
            </div>
            <Drawer.Content className="workspace-drawer-body">
              {panel === 'files' ? files : inspector}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
