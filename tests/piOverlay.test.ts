import { describe, expect, test } from 'vitest'

import {
  applyPiOverlayEvent,
  createLiveOverlay,
  joinAssistantText,
  publicPiOverlay,
  reconcilePiOverlay,
} from '../src/shared/piOverlay'

function overlay() {
  return createLiveOverlay({
    overlayId: 'ov',
    requestId: 'req',
    afterTurnId: null,
    baseRevision: 'none',
    userText: 'hi',
  })
}

describe('joinAssistantText', () => {
  test('joins completed assistant messages the same way persisted turns do', () => {
    expect(joinAssistantText(['first', 'second'])).toBe('first\nsecond')
    expect(joinAssistantText(['first'], 'partial')).toBe('first\npartial')
    expect(joinAssistantText([], 'partial')).toBe('partial')
  })
})

describe('applyPiOverlayEvent', () => {
  test('streams text deltas and separates completed assistant messages with a newline', () => {
    const live = overlay()
    applyPiOverlayEvent(live, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
    })
    applyPiOverlayEvent(live, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    })
    applyPiOverlayEvent(live, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'World' },
    })
    expect(live.assistantText).toBe('Hello\nWorld')
    applyPiOverlayEvent(live, { type: 'agent_settled' })
    expect(live.working).toBe(false)
    expect(live.assistantText).toBe('Hello\nWorld')
  })

  test('records thinking and tool names in work detail', () => {
    const live = overlay()
    applyPiOverlayEvent(live, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'Look at git diff' },
    })
    applyPiOverlayEvent(live, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: 'Look at git diff' },
    })
    applyPiOverlayEvent(live, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_end', toolCall: { name: 'bash' } },
    })
    expect(live.hasWork).toBe(true)
    expect(live.workDetail).toBe('Look at git diff\ntool bash')
  })
})

describe('reconcilePiOverlay', () => {
  test('clears when the next snapshot is null', () => {
    const current = publicPiOverlay(overlay())
    expect(reconcilePiOverlay(current, null)).toBeNull()
  })

  test('keeps the higher seq for the same overlay and accepts a new overlay id', () => {
    const first = overlay()
    first.seq = 3
    first.assistantText = 'later'
    const stale = overlay()
    stale.seq = 1
    stale.assistantText = 'early'
    expect(reconcilePiOverlay(publicPiOverlay(first), publicPiOverlay(stale))?.assistantText)
      .toBe('later')
    const nextTurn = overlay()
    nextTurn.overlayId = 'ov-2'
    nextTurn.seq = 0
    expect(reconcilePiOverlay(publicPiOverlay(first), publicPiOverlay(nextTurn))?.overlayId)
      .toBe('ov-2')
  })
})
