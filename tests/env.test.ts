import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { applyEnvFile, parseEnv } from '../src/server/env.js'

const previous = new Map<string, string | undefined>()

afterEach(() => {
  for (const [key, value] of previous) {
    if (value == null) delete process.env[key]
    else process.env[key] = value
  }
  previous.clear()
})

function stash(key: string): void {
  if (!previous.has(key)) previous.set(key, process.env[key])
}

describe('env files', () => {
  test('parses assignments, export, quotes, and comments', () => {
    expect(parseEnv(`
# comment
TYPESAFE_API_KEY=sk-plain
export DIFF_REVIEW_PORT=1234
QUOTED="say \\"hi\\""
SINGLE='keep # hash'
SPACED = value # note
PORT="47658" # local
EMPTY=
`)).toEqual([
      ['TYPESAFE_API_KEY', 'sk-plain'],
      ['DIFF_REVIEW_PORT', '1234'],
      ['QUOTED', 'say "hi"'],
      ['SINGLE', 'keep # hash'],
      ['SPACED', 'value'],
      ['PORT', '47658'],
      ['EMPTY', ''],
    ])
  })

  test('fills missing keys without overriding present values, including empty', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-env-'))
    try {
      const filePath = path.join(directory, '.env')
      writeFileSync(filePath, 'NEW_KEY=from-file\nKEEP_ME=file\nEMPTY_KEY=filled\n')
      stash('NEW_KEY')
      stash('KEEP_ME')
      stash('EMPTY_KEY')
      delete process.env.NEW_KEY
      process.env.KEEP_ME = 'shell'
      process.env.EMPTY_KEY = ''
      applyEnvFile(filePath)
      expect(process.env.NEW_KEY).toBe('from-file')
      expect(process.env.KEEP_ME).toBe('shell')
      expect(process.env.EMPTY_KEY).toBe('')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('ignores a missing file and throws for other read failures', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-env-'))
    try {
      expect(() => applyEnvFile(path.join(directory, 'missing.env'))).not.toThrow()
      expect(() => applyEnvFile(directory)).toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
