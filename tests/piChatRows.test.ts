import { describe, expect, test } from 'vitest'

import { chatRows } from '../src/client/piChatRows'
import type { PiChatOverlay, PiChatTurn } from '../src/shared/types'

function overlay(patch: Partial<PiChatOverlay> = {}): PiChatOverlay {
  return {
    overlayId: 'ov',
    requestId: 'req',
    afterTurnId: 't0',
    baseRevision: 'none',
    userText: 'hi',
    assistantText: 'first',
    working: true,
    hasWork: false,
    workDetail: '',
    startedAt: '2026-01-01T00:00:00.000Z',
    seq: 1,
    steered: [{ userText: 'steer', assistantText: 'second' }],
    queued: ['later'],
    ...patch,
  }
}

function turn(id: string, userText: string, assistantText = ''): PiChatTurn {
  return { id, userText, assistantText, work: null }
}

const kinds = (rows: ReturnType<typeof chatRows>) =>
  rows.map((row) => (row.kind === 'turn' ? `turn:${row.turn.id}` : row.kind === 'live' ? `live:${row.live.userText}` : `queued:${row.text}`))

describe('chatRows', () => {
  test('shows the prompt, steered turns, and queued messages while Pi works', () => {
    const rows = chatRows([turn('t0', 'old', 'reply')], overlay())
    expect(kinds(rows)).toEqual(['turn:t0', 'live:hi', 'live:steer', 'queued:later'])
    const live = rows.filter((row) => row.kind === 'live')
    expect(live.map((row) => row.kind === 'live' && row.live.streaming)).toEqual([false, true])
  })

  test('replaces live turns with persisted ones as the transcript catches up', () => {
    const turns = [turn('t0', 'old', 'reply'), turn('t1', 'hi', 'first'), turn('t2', 'steer')]
    expect(kinds(chatRows(turns, overlay()))).toEqual([
      'turn:t0',
      'turn:t1',
      'live:steer',
      'queued:later',
    ])
  })

  test('uses the transcript once Pi settles', () => {
    const turns = [turn('t0', 'old', 'reply'), turn('t1', 'hi', 'first'), turn('t2', 'steer', 'second')]
    expect(kinds(chatRows(turns, overlay({ working: false })))).toEqual(['turn:t0', 'turn:t1', 'turn:t2'])
  })

  test('keeps the live turns after Pi settles until the transcript has them', () => {
    expect(kinds(chatRows([turn('t0', 'old', 'reply')], overlay({ working: false }))))
      .toEqual(['turn:t0', 'live:hi', 'live:steer'])
  })
})
