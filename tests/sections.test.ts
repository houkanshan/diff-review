import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewStore } from '../src/server/store.js'
import { ApiHandler } from '../src/server/api.js'
import type { AddAnnotationInput } from '../src/shared/types.js'

let directory: string
let databasePath: string
let store: ReviewStore
let sessionId: string
const note: AddAnnotationInput = {
  filePath: 'file.ts', side: 'new', startLine: 1, endLine: 2, comment: 'Original', source: 'agent',
}
beforeEach(() => {
  vi.stubEnv('DIFF_REVIEW_TOKEN', '')
  vi.stubEnv('PI_MONITOR_TOKEN', '')
  vi.stubEnv('DIFF_REVIEW_PUBLIC_ORIGIN', '')
  directory = mkdtempSync(path.join(tmpdir(), 'diff-review-sections-'))
  databasePath = path.join(directory, 'review.sqlite')
  store = new ReviewStore(databasePath)
  sessionId = store.createSession(directory, 'repo', { kind: 'worktree' }, {
    label: 'worktree', gitCommand: 'git diff', patch: '', commits: [],
    oldSnapshot: { kind: 'worktree', id: directory }, newSnapshot: { kind: 'worktree', id: directory },
  }, false).id
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('ordered narrative sections', () => {
  it('persists partial upserts, finite orders, defaults and stable creation ties', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01'))
    expect(store.getSession(sessionId).sections).toEqual([])
    const first = store.setSection(sessionId, 'ZZ', { body: 'First' })
    const second = store.setSection(sessionId, 'AA', { body: 'Second', order: 10 })
    expect(store.setSection(sessionId, 'BB', { body: 'Third' }).order).toBe(20)
    expect(store.listSections(sessionId).map((section) => section.prefix)).toEqual(['ZZ', 'AA', 'BB'])
    vi.setSystemTime(new Date('2026-01-02'))
    expect(store.setSection(sessionId, 'ZZ', { order: 9.5 })).toMatchObject({
      body: 'First', order: 9.5, createdAt: first.createdAt,
    })
    expect(store.setSection(sessionId, 'AA', { body: 'Revised' })).toMatchObject({
      order: 10, createdAt: second.createdAt,
    })
    expect(store.setSection(sessionId, 'AA', {})).toMatchObject({ body: 'Revised', order: 10 })
    for (const order of [NaN, Infinity, -Infinity]) {
      expect(() => store.setSection(sessionId, 'AA', { order })).toThrow('finite')
    }
    expect(() => store.setSection(sessionId, 'NEW', { order: 0 })).toThrow('body is required')
    expect(() => store.setSection(sessionId, 'bad', { body: 'Bad' })).toThrow('prefix')
    expect(() => store.setSection(sessionId, 'AA', { body: '' })).toThrow('empty')
    store = new ReviewStore(databasePath)
    expect(store.getSession(sessionId).sections.map((section) => [section.prefix, section.order, section.body]))
      .toEqual([['ZZ', 9.5, 'First'], ['AA', 10, 'Revised'], ['BB', 20, 'Third']])
  })

  it('shares never-reused counters with legacy IDs and preserves notes and replies', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01'))
    const legacy = store.addAnnotation(sessionId, { ...note, shortIdPrefix: 'RETRY' })
    expect(legacy.shortId).toBe('RETRY-01')
    expect(() => store.addAnnotation(sessionId, { ...note, sectionPrefix: 'RETRY' })).toThrow('Section not found')
    store.setSection(sessionId, 'RETRY', { body: 'Overview' })
    const first = store.addAnnotation(sessionId, { ...note, sectionPrefix: 'RETRY' })
    const reply = store.addAnnotation(sessionId, { ...note, source: 'user', replyToId: first.id, comment: 'Question' })
    const second = store.addAnnotation(sessionId, { ...note, sectionPrefix: 'RETRY' })
    expect([first.shortId, second.shortId]).toEqual(['RETRY-2', 'RETRY-3'])
    expect(store.getSession(sessionId).annotations.map((item) => item.id)).toEqual([legacy.id, first.id, reply.id, second.id])
    vi.setSystemTime(new Date('2026-01-02'))
    expect(store.updateAgentAnnotationBody(sessionId, first.shortId, 'Revised')).toEqual({
      ...first, comment: 'Revised', updatedAt: new Date().toISOString(),
    })
    store.setSection(sessionId, 'RETRY', { body: 'New overview', order: -5 })
    expect(store.getSession(sessionId).annotations.find((item) => item.id === reply.id)).toEqual(reply)
    expect(store.getSession(sessionId).annotations.find((item) => item.id === legacy.id)).toEqual(legacy)
    expect(() => store.updateAnnotationComment(sessionId, first.id, 'User edit')).toThrow('User annotation not found')
    expect(() => store.updateAgentAnnotationBody(sessionId, reply.shortId, 'Agent edit')).toThrow('Agent annotation not found')
    store.deleteAnnotation(sessionId, second.id)
    expect(store.addAnnotation(sessionId, { ...note, sectionPrefix: 'RETRY' }).shortId).toBe('RETRY-4')
    // Simulate legacy IDs with no corresponding counter high-water mark.
    const raw = new DatabaseSync(databasePath)
    raw.prepare('UPDATE annotations SET short_id = ? WHERE id = ?').run('RETRY-009', legacy.id)
    raw.close()
    expect(store.addAnnotation(sessionId, { ...note, sectionPrefix: 'RETRY' }).shortId).toBe('RETRY-10')
    expect(store.addAnnotation(sessionId, { ...note, shortIdPrefix: 'RETRY' }).shortId).toBe('RETRY-11')
  })

  it('reads persisted importance without regrouping or allowing new writes', () => {
    const legacy = store.addAnnotation(sessionId, note)
    const raw = new DatabaseSync(databasePath)
    raw.prepare('UPDATE annotations SET importance = ? WHERE id = ?').run(0.75, legacy.id)
    raw.close()
    store = new ReviewStore(databasePath)
    expect(store.getSession(sessionId).sections).toEqual([])
    expect(store.getSession(sessionId).annotations[0]).toMatchObject({
      id: legacy.id, shortId: legacy.shortId, sectionPrefix: null, importance: 0.75,
    })
    for (const importance of [0, 0.5, null]) {
      expect(() => store.addAnnotation(sessionId, { ...note, importance } as AddAnnotationInput)).toThrow('no longer writable')
    }
  })

  it('exposes section and body routes and rejects importance on legacy and update routes', async () => {
    const handler = new ApiHandler(store, null)
    const server = createServer(handler.handle)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${sessionId}`
    const request = (route: string, method: string, input?: unknown) => fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json' }, body: input == null ? undefined : JSON.stringify(input),
    })
    try {
      expect((await request('/sections/RETRY', 'PUT', { body: 'Overview', order: 2.5 })).status).toBe(200)
      expect((await request('/sections/RETRY', 'PUT', { order: -2 })).status).toBe(200)
      const list = await request('/sections', 'GET')
      expect(await list.json()).toMatchObject([{ prefix: 'RETRY', body: 'Overview', order: -2 }])
      expect((await request('/sections/RETRY', 'PUT', { order: null })).status).toBe(400)
      const annotation = store.addAnnotation(sessionId, { ...note, sectionPrefix: 'RETRY' })
      const reply = store.addAnnotation(sessionId, { ...note, source: 'user', replyToId: annotation.id })
      const result = await request(`/annotations/${annotation.shortId}/body`, 'PATCH', { body: 'Revised' })
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({ id: annotation.id, comment: 'Revised', startLine: 1, endLine: 2 })
      expect(store.getSession(sessionId).annotations.find((item) => item.id === reply.id)).toEqual(reply)
      expect((await request(`/annotations/${annotation.id}`, 'PATCH', { comment: 'Cannot edit' })).status).toBe(404)
      for (const importance of [0, 0.5, null]) {
        for (const [route, method, payload] of [
          ['/annotations', 'POST', note],
          ['/global-comments', 'POST', { comment: 'Legacy summary', source: 'agent' }],
          [`/annotations/${reply.id}`, 'PATCH', { comment: 'Edit' }],
          [`/annotations/${annotation.shortId}/body`, 'PATCH', { body: 'Edit' }],
        ] as const) {
          const rejected = await request(route, method, { ...payload, importance })
          expect(rejected.status).toBe(400)
          expect(await rejected.json()).toMatchObject({ error: { message: 'importance is no longer writable' } })
        }
      }
      const session = await request('', 'GET')
      expect((await session.json() as { sections: unknown[] }).sections).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
