import { Drawer } from '@base-ui/react/drawer'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, Check as CheckIcon, ChevronRight, X as CloseIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'

import { formatWorkDuration, PI_CHAT_PAGE_SIZE } from '../shared/piChat'
import { reconcilePiOverlay } from '../shared/piOverlay'
import type { PiChatOverlay, PiChatTurn, PiReviewStatus } from '../shared/types'
import { ClientError, getPiChat, sendPiChat } from './api'
import { PanelResizeHandle, storePanelWidth, storedPanelWidth } from './PanelResizeHandle'
import { subscribeServerEvents } from './sessionEvents'

export function PiChatControl({
  sessionId,
  status,
}: {
  sessionId: string
  status: PiReviewStatus
}) {
  const [open, setOpen] = useState(false)
  const running =
    status.state === 'creating' ||
    status.state === 'running' ||
    (status.state !== 'idle' && status.activePid != null)

  return (
    <>
      <button
        type="button"
        className="agent-button"
        onClick={() => setOpen(true)}
      >
        <span className={running ? 'pi-pulse' : ''}>π</span>
        Chat
      </button>
      <PiChatDrawer open={open} onOpenChange={setOpen} sessionId={sessionId} />
    </>
  )
}

const CHAT_WIDTH_MIN = 320
const CHAT_WIDTH_FALLBACK = 420

function chatWidthMax(): number {
  return Math.max(CHAT_WIDTH_MIN, window.innerWidth - 36)
}

function PiChatDrawer({
  open,
  onOpenChange,
  sessionId,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  sessionId: string
}) {
  const [width, setWidth] = useState(() =>
    storedPanelWidth('chat', CHAT_WIDTH_FALLBACK, CHAT_WIDTH_MIN, chatWidthMax()),
  )

  useEffect(() => {
    const clamp = () => {
      setWidth((current) => {
        const next = Math.min(chatWidthMax(), Math.max(CHAT_WIDTH_MIN, current))
        if (next !== current) storePanelWidth('chat', next)
        return next
      })
    }
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])

  return (
    <Drawer.Root
      open={open}
      onOpenChange={onOpenChange}
      swipeDirection="right"
      modal={false}
      disablePointerDismissal
    >
      <Drawer.Portal>
        <Drawer.Viewport className="workspace-drawer-viewport pi-chat-drawer-viewport">
          <Drawer.Popup
            className="workspace-drawer-popup pi-chat-drawer-popup"
            style={{ width }}
          >
            <PanelResizeHandle
              className="panel-resizer pi-chat-resizer"
              label="Resize chat"
              side="right"
              size={width}
              min={CHAT_WIDTH_MIN}
              max={chatWidthMax()}
              onChange={(next) => {
                setWidth(next)
                storePanelWidth('chat', next)
              }}
            />
            <div className="workspace-drawer-header">
              <Drawer.Title className="pi-chat-title">Chat</Drawer.Title>
              <Drawer.Close className="icon-button" aria-label="Close chat">
                <CloseIcon />
              </Drawer.Close>
            </div>
            {open ? <PiChatConversation sessionId={sessionId} /> : null}
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function PiChatConversation({ sessionId }: { sessionId: string }) {
  const [turns, setTurns] = useState<PiChatTurn[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<PiChatOverlay | null>(null)
  const [sending, setSending] = useState(false)
  const [piInstalled, setPiInstalled] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [explain, setExplain] = useState(false)
  const [pinned, setPinned] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const revisionRef = useRef('none')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const prependHeightRef = useRef<number | null>(null)
  const loadingOlderRef = useRef(false)

  const loadTail = useCallback(async () => {
    const page = await getPiChat(sessionId, { limit: PI_CHAT_PAGE_SIZE })
    revisionRef.current = page.transcriptRevision
    setTurns(page.turns)
    setNextBefore(page.nextBefore)
    setOverlay((current) => reconcilePiOverlay(current, page.overlay))
    setPiInstalled(page.piInstalled)
    setError(page.piInstalled ? page.error : null)
  }, [sessionId])

  useEffect(() => {
    void loadTail().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    })
    return subscribeServerEvents(sessionId, (event) => {
      if (event.type === 'session-updated') {
        if (event.sessionId === '*') void loadTail().catch(() => undefined)
        return
      }
      setOverlay((current) => reconcilePiOverlay(current, event.overlay))
      if (event.overlay?.working) return
      if (event.transcriptRevision !== revisionRef.current) {
        void loadTail().catch(() => undefined)
      }
    })
  }, [loadTail, sessionId])

  useEffect(() => {
    if (!sending && overlay?.working !== true) return
    const poll = window.setInterval(() => {
      void loadTail().catch(() => undefined)
    }, 400)
    const clock = window.setInterval(() => setNow(Date.now()), 1000)
    return () => {
      window.clearInterval(poll)
      window.clearInterval(clock)
    }
  }, [loadTail, overlay?.working, sending])

  const visibleTurns = useMemo(
    () => turnsForOverlay(turns, overlay),
    [overlay, turns],
  )
  const showOverlay = overlay != null && !overlayCaughtUp(turns, overlay)
  const items = useMemo(() => {
    const rows: ChatRow[] = visibleTurns.map((turn) => ({ key: turn.id, kind: 'turn', turn }))
    if (showOverlay && overlay != null) {
      rows.push({ key: overlay.overlayId, kind: 'live', overlay })
    }
    return rows
  }, [overlay, showOverlay, visibleTurns])

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => 88,
    overscan: 8,
    getItemKey: (index) => items[index]?.key ?? index,
  })

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller == null || prependHeightRef.current == null) return
    scroller.scrollTop += scroller.scrollHeight - prependHeightRef.current
    prependHeightRef.current = null
  }, [turns])

  useLayoutEffect(() => {
    if (!pinned) return
    virtualizer.scrollToOffset(virtualizer.getTotalSize(), { align: 'end' })
  }, [items, pinned, virtualizer, overlay?.assistantText])

  const loadOlder = async () => {
    if (nextBefore == null || loadingOlderRef.current) return
    loadingOlderRef.current = true
    const scroller = scrollerRef.current
    if (scroller != null) prependHeightRef.current = scroller.scrollHeight
    try {
      const page = await getPiChat(sessionId, { before: nextBefore, limit: PI_CHAT_PAGE_SIZE })
      setTurns((current) => mergeTurns(page.turns, current))
      setNextBefore(page.nextBefore)
    } finally {
      loadingOlderRef.current = false
    }
  }

  const send = async () => {
    const draftText = draft.trim()
    if ((!draftText && !explain) || sending || overlay?.working) return
    setDraft('')
    setError(null)
    setPinned(true)
    setSending(true)
    try {
      const page = await sendPiChat(sessionId, draftText, explain)
      revisionRef.current = page.transcriptRevision
      setTurns((current) => mergeTurns(current, page.turns))
      setOverlay((current) => reconcilePiOverlay(current, page.overlay))
      setPiInstalled(page.piInstalled)
      setError(page.piInstalled ? page.error : null)
    } catch (caught) {
      setDraft(draftText)
      if (caught instanceof ClientError && caught.code === 'COMMAND_NOT_FOUND') {
        setPiInstalled(false)
        setError(null)
      } else {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      setSending(false)
    }
  }

  const caughtUp = overlay != null && overlayCaughtUp(turns, overlay)
  const working = sending || (overlay?.working === true && !caughtUp)

  return (
    <>
      <Drawer.Content className="workspace-drawer-body pi-chat-body">
        <div
          ref={scrollerRef}
          className="pi-chat-scroller"
          onScroll={(event) => {
            const scroller = event.currentTarget
            const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
            setPinned(distance < 32)
            if (scroller.scrollTop < 160) void loadOlder()
          }}
        >
          {!piInstalled && items.length === 0 ? (
            <InstallPiHelp />
          ) : items.length === 0 ? (
            <p className="pi-chat-empty">Ask about this pull request.</p>
          ) : (
            <div
              className="pi-chat-virtual"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const item = items[virtualItem.index]
                if (item == null) return null
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    className="pi-chat-virtual-item"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    {item.kind === 'turn' ? (
                      <TurnView turn={item.turn} />
                    ) : (
                      <LiveTurnView overlay={item.overlay} now={now} />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {!pinned && items.length > 0 && (
          <button
            type="button"
            className="pi-chat-jump"
            onClick={() => {
              setPinned(true)
              virtualizer.scrollToOffset(virtualizer.getTotalSize(), { align: 'end' })
            }}
          >
            <ArrowDown size={14} />
            Jump to latest
          </button>
        )}
      </Drawer.Content>
      <form
        className="pi-chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {error != null && <div className="menu-error">{error}</div>}
        <textarea
          value={draft}
          disabled={working || !piInstalled}
          placeholder={
            !piInstalled
              ? 'Install Pi to chat'
              : working
                ? 'Pi is working…'
                : explain
                  ? 'Additional instructions (optional)'
                  : 'Message Pi'
          }
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (!isSubmitEnter(event)) return
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }}
        />
        <div className="pi-chat-composer-actions">
          <button
            type="button"
            className="pi-chat-explain-toggle"
            aria-pressed={explain}
            disabled={working || !piInstalled}
            onClick={() => setExplain((current) => !current)}
          >
            <span className="pi-chat-explain-checkbox" aria-hidden="true">
              {explain ? <CheckIcon /> : null}
            </span>
            Explain
          </button>
          <button
            type="submit"
            disabled={working || !piInstalled || (!explain && draft.trim() === '')}
          >
            Send
          </button>
        </div>
      </form>
    </>
  )
}

type ChatRow =
  | { key: string; kind: 'turn'; turn: PiChatTurn }
  | { key: string; kind: 'live'; overlay: PiChatOverlay }

function InstallPiHelp() {
  return (
    <div className="pi-chat-install">
      <p>Pi is not installed.</p>
      <p>Install it, then make sure <code>pi</code> is on PATH.</p>
      <pre>npm install -g --ignore-scripts @earendil-works/pi-coding-agent</pre>
      <p>or</p>
      <pre>curl -fsSL https://pi.dev/install.sh | sh</pre>
      <p>
        <a href="https://pi.dev" target="_blank" rel="noreferrer">pi.dev</a>
      </p>
    </div>
  )
}

function TurnView({ turn }: { turn: PiChatTurn }) {
  return (
    <article className="pi-chat-turn">
      <p className="pi-chat-user">{turn.userText}</p>
      {turn.work != null && (
        <WorkFold
          label={workLabel(false, turn.work.durationMs, turn.work.durationMs)}
          detail={turn.work.detail}
        />
      )}
      {turn.assistantText ? <AssistantMarkdown text={turn.assistantText} /> : null}
    </article>
  )
}

function LiveTurnView({ overlay, now }: { overlay: PiChatOverlay; now: number }) {
  const durationMs = Math.max(0, now - Date.parse(overlay.startedAt))
  return (
    <article className="pi-chat-turn">
      <p className="pi-chat-user">{overlay.userText}</p>
      {(overlay.working || overlay.hasWork) && (
        <WorkFold
          label={workLabel(overlay.working, overlay.hasWork ? durationMs : null, durationMs)}
          detail={overlay.workDetail}
        />
      )}
      {overlay.assistantText ? (
        <AssistantMarkdown text={overlay.assistantText} streaming={overlay.working} />
      ) : null}
    </article>
  )
}

function AssistantMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="pi-chat-assistant markdown-body">
      <Streamdown
        mode={streaming ? 'streaming' : 'static'}
        isAnimating={streaming}
        controls={{ table: false }}
      >
        {text}
      </Streamdown>
    </div>
  )
}

function WorkFold({ label, detail }: { label: string; detail: string }) {
  return (
    <details className="pi-chat-work">
      <summary>
        <span className="pi-chat-work-line" />
        <span>{label}</span>
        <ChevronRight aria-hidden="true" />
        <span className="pi-chat-work-line" />
      </summary>
      {detail ? <pre className="pi-chat-work-detail">{detail}</pre> : null}
    </details>
  )
}

function workLabel(working: boolean, durationMs: number | null, fallbackMs?: number | null): string {
  if (working) return 'Working…'
  const formatted = formatWorkDuration(durationMs ?? fallbackMs ?? null)
  return formatted ? `Worked for ${formatted}` : 'Worked'
}

function overlayCaughtUp(turns: PiChatTurn[], overlay: PiChatOverlay): boolean {
  const later = turnsAfter(turns, overlay.afterTurnId)
  if (later.some((turn) => turn.assistantText.trim() !== '')) return true
  if (overlay.working) return false
  return later.length > 0
}

function turnsAfter(turns: PiChatTurn[], afterTurnId: string | null): PiChatTurn[] {
  if (afterTurnId == null) return turns
  const index = turns.findIndex((turn) => turn.id === afterTurnId)
  if (index < 0) return turns
  return turns.slice(index + 1)
}

function turnsForOverlay(turns: PiChatTurn[], overlay: PiChatOverlay | null): PiChatTurn[] {
  if (overlay == null || overlayCaughtUp(turns, overlay)) return turns
  if (overlay.afterTurnId == null) return []
  const index = turns.findIndex((turn) => turn.id === overlay.afterTurnId)
  if (index < 0) return turns
  return turns.slice(0, index + 1)
}

function mergeTurns(left: PiChatTurn[], right: PiChatTurn[]): PiChatTurn[] {
  const seen = new Set<string>()
  const merged: PiChatTurn[] = []
  for (const turn of [...left, ...right]) {
    if (seen.has(turn.id)) continue
    seen.add(turn.id)
    merged.push(turn)
  }
  return merged
}

function isSubmitEnter(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return event.key === 'Enter' &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229
}
