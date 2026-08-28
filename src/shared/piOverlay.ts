import type { PiChatOverlay } from './types.js'
import { assistantTextFromContent } from './piChat.js'

export interface LivePiOverlay {
  overlayId: string
  requestId: string
  afterTurnId: string | null
  baseRevision: string
  userText: string
  assistantText: string
  working: boolean
  hasWork: boolean
  workDetail: string
  startedAt: string
  seq: number
  completedParts: string[]
  streaming: string
  thinking: string
}

export function createLiveOverlay(input: {
  overlayId: string
  requestId: string
  afterTurnId: string | null
  baseRevision: string
  userText: string
}): LivePiOverlay {
  return {
    ...input,
    assistantText: '',
    working: true,
    hasWork: false,
    workDetail: '',
    startedAt: new Date().toISOString(),
    seq: 0,
    completedParts: [],
    streaming: '',
    thinking: '',
  }
}

export function publicPiOverlay(overlay: LivePiOverlay): PiChatOverlay {
  return {
    overlayId: overlay.overlayId,
    requestId: overlay.requestId,
    afterTurnId: overlay.afterTurnId,
    baseRevision: overlay.baseRevision,
    userText: overlay.userText,
    assistantText: overlay.assistantText,
    working: overlay.working,
    hasWork: overlay.hasWork,
    workDetail: overlay.workDetail,
    startedAt: overlay.startedAt,
    seq: overlay.seq,
  }
}

export function joinAssistantText(parts: readonly string[], streaming = ''): string {
  const completed = parts.filter(Boolean)
  if (!streaming) return completed.join('\n')
  return completed.length === 0 ? streaming : `${completed.join('\n')}\n${streaming}`
}

export function applyPiOverlayEvent(
  overlay: LivePiOverlay,
  event: Record<string, unknown>,
): boolean {
  const type = event.type
  if (type === 'agent_start') {
    overlay.working = true
    overlay.seq += 1
    return true
  }
  if (type === 'agent_settled') {
    overlay.working = false
    overlay.assistantText = joinAssistantText(overlay.completedParts, overlay.streaming)
    overlay.seq += 1
    return true
  }
  if (type === 'tool_execution_start') {
    const name = typeof event.toolName === 'string' ? event.toolName : 'tool'
    appendWork(overlay, `tool ${name}`)
    overlay.seq += 1
    return true
  }
  if (type === 'message_start') {
    const message = event.message as Record<string, unknown> | undefined
    if (message?.role === 'assistant') overlay.streaming = ''
    overlay.seq += 1
    return true
  }
  if (type === 'message_update') {
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined
    if (update == null || typeof update.type !== 'string') return false
    if (update.type === 'thinking_delta' && typeof update.delta === 'string') {
      overlay.hasWork = true
      overlay.thinking += update.delta
      overlay.seq += 1
      return true
    }
    if (update.type === 'thinking_end') {
      const thinking = typeof update.content === 'string' && update.content
        ? update.content
        : overlay.thinking
      overlay.thinking = ''
      appendWork(overlay, thinking)
      overlay.seq += 1
      return true
    }
    if (update.type === 'toolcall_end') {
      const call = update.toolCall as Record<string, unknown> | undefined
      const name = typeof call?.name === 'string' ? call.name : 'tool'
      appendWork(overlay, `tool ${name}`)
      overlay.seq += 1
      return true
    }
    if (update.type.startsWith('thinking_') || update.type.includes('tool')) {
      overlay.hasWork = true
      overlay.seq += 1
      return true
    }
    if (update.type === 'text_delta' && typeof update.delta === 'string') {
      overlay.streaming += update.delta
      overlay.assistantText = joinAssistantText(overlay.completedParts, overlay.streaming)
      overlay.seq += 1
      return true
    }
    if (update.type === 'text_end' && typeof update.content === 'string') {
      overlay.streaming = update.content
      overlay.assistantText = joinAssistantText(overlay.completedParts, overlay.streaming)
      overlay.seq += 1
      return true
    }
    return false
  }
  if (type === 'message_end' || type === 'turn_end') {
    const message = event.message as Record<string, unknown> | undefined
    if (message?.role !== 'assistant') return type === 'turn_end'
    const text = assistantTextFromContent(message.content) || overlay.streaming
    if (text) overlay.completedParts.push(text)
    overlay.streaming = ''
    overlay.assistantText = joinAssistantText(overlay.completedParts)
    overlay.seq += 1
    return true
  }
  return false
}

export function reconcilePiOverlay(
  current: PiChatOverlay | null,
  next: PiChatOverlay | null,
): PiChatOverlay | null {
  if (next == null) return null
  if (current == null) return next
  if (current.overlayId !== next.overlayId) return next
  return next.seq >= current.seq ? next : current
}

function appendWork(overlay: LivePiOverlay, detail: string): void {
  const trimmed = detail.trim()
  if (!trimmed) {
    overlay.hasWork = overlay.hasWork || overlay.thinking.length > 0
    return
  }
  overlay.hasWork = true
  overlay.workDetail = overlay.workDetail ? `${overlay.workDetail}\n${trimmed}` : trimmed
}
