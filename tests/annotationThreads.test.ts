import { describe, expect, test } from 'vitest'

import { annotationThreads } from '../src/shared/annotationThreads.js'
import type { SessionAnnotation } from '../src/shared/types.js'

function note(
  id: string,
  extras: Partial<SessionAnnotation> = {},
): SessionAnnotation {
  return {
    id,
    sessionId: 'session',
    filePath: 'src/a.ts',
    side: 'new',
    startLine: 4,
    endSide: null,
    endLine: 4,
    comment: id,
    importance: null,
    source: extras.source ?? 'user',
    intent: 'annotation',
    replyToId: extras.replyToId ?? null,
    archivedAt: null,
    submittedAt: null,
    viewedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extras,
  }
}

describe('annotationThreads', () => {
  test('nests replies under the parent agent note', () => {
    const agent = note('agent', { source: 'agent' })
    const reply = note('reply', { source: 'user', replyToId: agent.id })
    const other = note('other', { source: 'user' })
    expect(annotationThreads([agent, reply, other])).toEqual([
      { root: agent, replies: [reply] },
      { root: other, replies: [] },
    ])
  })

  test('keeps orphan replies as roots', () => {
    const reply = note('reply', { replyToId: 'missing' })
    expect(annotationThreads([reply])).toEqual([{ root: reply, replies: [] }])
  })
})
