import type { PiChatOverlay, PiChatTurn } from '../shared/types'

export type ChatRow =
  | { key: string; kind: 'turn'; turn: PiChatTurn }
  | { key: string; kind: 'live'; live: LiveTurn }
  | { key: string; kind: 'queued'; text: string }

export interface LiveTurn {
  overlay: PiChatOverlay
  userText: string
  assistantText: string
  streaming: boolean
  showWork: boolean
}

/**
 * The overlay holds the live prompt plus any steered messages, one transcript
 * turn each. A live turn yields to its persisted copy once that copy has a
 * reply or a later turn follows it; after Pi settles, any persisted turn wins.
 */
export function chatRows(turns: PiChatTurn[], overlay: PiChatOverlay | null): ChatRow[] {
  const turnRows = (list: PiChatTurn[]): ChatRow[] =>
    list.map((turn) => ({ key: turn.id, kind: 'turn', turn }))
  if (overlay == null) return turnRows(turns)
  const live = [
    { userText: overlay.userText, assistantText: overlay.assistantText },
    ...overlay.steered,
  ]
  const later = turnsAfter(turns, overlay.afterTurnId)
  let caughtUp = 0
  if (!overlay.working && later.length > 0) {
    caughtUp = live.length
  } else {
    while (
      caughtUp < live.length
      && caughtUp < later.length
      && (later[caughtUp]?.assistantText.trim() !== '' || caughtUp < later.length - 1)
    ) caughtUp += 1
  }
  if (caughtUp >= live.length) return withQueued(turnRows(turns), overlay)
  const rows = turnRows([...turnsBefore(turns, overlay.afterTurnId), ...later.slice(0, caughtUp)])
  const last = live.length - 1
  live.slice(caughtUp).forEach((turn, offset) => {
    const index = caughtUp + offset
    rows.push({
      key: `${overlay.overlayId}:${index}`,
      kind: 'live',
      live: {
        overlay,
        userText: turn.userText,
        assistantText: turn.assistantText,
        streaming: overlay.working && index === last,
        showWork: index === last,
      },
    })
  })
  return withQueued(rows, overlay)
}

/** Queued steers stay visible while Pi works, even once the transcript has every live turn. */
function withQueued(rows: ChatRow[], overlay: PiChatOverlay): ChatRow[] {
  if (!overlay.working) return rows
  overlay.queued.forEach((text, index) => {
    rows.push({ key: `${overlay.overlayId}:queued:${index}`, kind: 'queued', text })
  })
  return rows
}

function turnsBefore(turns: PiChatTurn[], afterTurnId: string | null): PiChatTurn[] {
  if (afterTurnId == null) return []
  const index = turns.findIndex((turn) => turn.id === afterTurnId)
  // Mirrors turnsAfter, which treats every turn as later when the anchor is missing.
  return index < 0 ? [] : turns.slice(0, index + 1)
}

function turnsAfter(turns: PiChatTurn[], afterTurnId: string | null): PiChatTurn[] {
  if (afterTurnId == null) return turns
  const index = turns.findIndex((turn) => turn.id === afterTurnId)
  if (index < 0) return turns
  return turns.slice(index + 1)
}
