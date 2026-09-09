import { describe, expect, test } from 'vitest'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { formatWorkDuration, pagePiChatTurns, projectPiChatModel, projectPiChatTurns } from '../src/shared/piChat'
import {
  normalizePiChatModelChoice,
  parsePiChatModelChoice,
  piChatCliArgs,
  PI_CHAT_MODELS,
} from '../src/shared/piChatModel'
import {
  readChatModelSelection,
  readPiAgentDefaultModel,
  readPiChatModel,
  writeChatModelSelection,
  writePiChatModel,
} from '../src/server/piChatModel'

describe('projectPiChatTurns', () => {
  test('folds thinking and tools into work and keeps user plus final assistant text', () => {
    const turns = projectPiChatTurns([
      { type: 'session', id: 's1' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'Explain the retry move' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-01-01T00:00:08.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Look at the diff first.' },
            { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'git diff' } },
          ],
        },
      },
      {
        type: 'message',
        id: 'r1',
        parentId: 'a1',
        timestamp: '2026-01-01T00:00:09.000Z',
        message: { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: 'ok' },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'r1',
        timestamp: '2026-01-01T00:00:12.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'retry() moved into b.ts.' }],
        },
      },
    ])

    expect(turns).toEqual([
      {
        id: 'u1',
        userText: 'Explain the retry move',
        assistantText: 'retry() moved into b.ts.',
        work: {
          durationMs: 12_000,
          detail: 'Look at the diff first.\ntool bash\ntool bash',
        },
      },
    ])
  })

  test('follows the active leaf when the session tree has a branch', () => {
    const turns = projectPiChatTurns([
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'first' },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'a1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: 'abandoned' },
      },
      {
        type: 'message',
        id: 'u3',
        parentId: 'a1',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'user', content: 'kept' },
      },
      {
        type: 'message',
        id: 'a3',
        parentId: 'u3',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'B' }] },
      },
    ])

    expect(turns.map((turn) => turn.userText)).toEqual(['first', 'kept'])
    expect(turns[1]?.assistantText).toBe('B')
  })

  test('walks through non-message session entries in the parent chain', () => {
    const turns = projectPiChatTurns([
      { type: 'session', id: 's1', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'custom',
        id: 'c1',
        parentId: 's1',
        timestamp: '2026-01-01T00:00:00.000Z',
        customType: 'auto-title',
      },
      {
        type: 'message',
        id: 'u1',
        parentId: 'c1',
        timestamp: '2026-01-01T00:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'first' }] },
      },
      {
        type: 'session_info',
        id: 'info1',
        parentId: 'u1',
        timestamp: '2026-01-01T00:00:01.100Z',
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'info1',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
      },
      {
        type: 'custom',
        id: 'c2',
        parentId: 'a1',
        timestamp: '2026-01-01T00:00:02.100Z',
        customType: 'auto-review-status',
      },
      {
        type: 'message',
        id: 'u2',
        parentId: 'c2',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'second' }] },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'u2',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'B' }] },
      },
    ])

    expect(turns.map((turn) => turn.userText)).toEqual(['first', 'second'])
    expect(turns.map((turn) => turn.assistantText)).toEqual(['A', 'B'])
  })

  test('pages from the tail by turn id', () => {
    const turns = Array.from({ length: 5 }, (_, index) => ({
      id: `u${index + 1}`,
      userText: `m${index + 1}`,
      assistantText: '',
      work: null,
    }))
    expect(pagePiChatTurns(turns, null, 2)).toEqual({
      turns: [turns[3], turns[4]],
      nextBefore: 'u4',
    })
    expect(pagePiChatTurns(turns, 'u4', 2)).toEqual({
      turns: [turns[1], turns[2]],
      nextBefore: 'u2',
    })
    expect(pagePiChatTurns(turns, 'u2', 2).nextBefore).toBeNull()
  })
})

describe('projectPiChatModel', () => {
  test('uses the latest model and thinking events on the active branch', () => {
    expect(
      projectPiChatModel([
        { type: 'session', id: 's1' },
        {
          type: 'model_change',
          id: 'm1',
          parentId: null,
          provider: 'openai-codex',
          modelId: 'gpt-5.5',
        },
        {
          type: 'thinking_level_change',
          id: 't1',
          parentId: 'm1',
          thinkingLevel: 'medium',
        },
        {
          type: 'model_change',
          id: 'm2',
          parentId: 't1',
          provider: 'xai',
          modelId: 'grok-4.6',
        },
        {
          type: 'message',
          id: 'u1',
          parentId: 'm2',
          message: { role: 'user', content: 'hi' },
        },
        {
          type: 'message',
          id: 'a1',
          parentId: 'u1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            provider: 'xai',
            model: 'grok-4.6',
          },
        },
      ]),
    ).toEqual({
      provider: 'xai',
      modelId: 'grok-4.6',
      thinkingLevel: 'medium',
    })
  })
})

describe('pi chat model', () => {
  test('maps a catalog choice to Pi CLI flags without a default-model write', () => {
    const sol = PI_CHAT_MODELS.find((model) => model.id === 'gpt-5.6-sol')
    if (sol == null) throw new Error('expected sol')
    const choice = normalizePiChatModelChoice(sol, 'high')
    expect(parsePiChatModelChoice({ provider: 'unknown', modelId: 'nope' })).toBeNull()
    expect(piChatCliArgs(null)).toEqual([])
    expect(piChatCliArgs(choice)).toEqual([
      '--model',
      'openai-codex/gpt-5.6-sol',
      '--thinking',
      'high',
    ])
    expect(normalizePiChatModelChoice(
      PI_CHAT_MODELS.find((model) => model.id === 'composer-2.5')!,
      'high',
    ).thinkingLevel).toBeNull()
  })

  test('stores an explicit Pi default separately from an unset chat', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-chat-model-'))
    try {
      expect(readChatModelSelection(directory, 'pr:/repo:1')).toEqual({ status: 'unset' })
      expect(writeChatModelSelection(directory, 'pr:/repo:1', {
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      })).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      })
      expect(writeChatModelSelection(directory, 'pr:/repo:2', null)).toBeNull()
      expect(readChatModelSelection(directory, 'pr:/repo:1')).toEqual({
        status: 'set',
        model: {
          provider: 'openai-codex',
          modelId: 'gpt-5.6-sol',
          thinkingLevel: 'high',
        },
      })
      expect(readChatModelSelection(directory, 'pr:/repo:2')).toEqual({
        status: 'set',
        model: null,
      })
      expect(readChatModelSelection(directory, 'pr:/repo:3')).toEqual({ status: 'unset' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('remembers the choice in the Diff Review data directory', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-model-'))
    try {
      expect(readPiChatModel(directory)).toBeNull()
      const saved = writePiChatModel(directory, {
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'medium',
      })
      expect(saved).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'medium',
      })
      expect(JSON.parse(readFileSync(path.join(directory, 'pi-chat-model.json'), 'utf8'))).toEqual(
        saved,
      )
      expect(readPiChatModel(directory)).toEqual(saved)
      expect(writePiChatModel(directory, null)).toBeNull()
      expect(readPiChatModel(directory)).toBeNull()
      writeFileSync(path.join(directory, 'pi-chat-model.json'), '{')
      expect(() => readPiChatModel(directory)).toThrow()
      expect(
        readPiAgentDefaultModel(path.join(directory, 'missing-pi-settings.json')),
      ).toBeNull()
      const settings = path.join(directory, 'settings.json')
      writeFileSync(
        settings,
        JSON.stringify({
          defaultProvider: 'openai-codex',
          defaultModel: 'gpt-5.6-sol',
          defaultThinkingLevel: 'high',
        }),
      )
      expect(readPiAgentDefaultModel(settings)).toEqual({
        provider: 'openai-codex',
        modelId: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('formatWorkDuration', () => {
  test('rounds to seconds and minutes', () => {
    expect(formatWorkDuration(400)).toBe('1 second')
    expect(formatWorkDuration(12_400)).toBe('12 seconds')
    expect(formatWorkDuration(80_000)).toBe('1 minute')
  })
})
