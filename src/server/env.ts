import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function loadEnvFiles(): void {
  applyEnvFile(path.join(process.cwd(), '.env'))
  const dataDir = process.env.DIFF_REVIEW_DATA_DIR ?? path.join(homedir(), '.diff-review')
  applyEnvFile(path.join(dataDir, '.env'))
}

export function parseEnv(text: string): Array<[string, string]> {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const entries: Array<[string, string]> = []
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const assignment = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separator = assignment.indexOf('=')
    if (separator <= 0) continue
    const key = assignment.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    entries.push([key, parseEnvValue(assignment.slice(separator + 1).trim())])
  }
  return entries
}

export function applyEnvFile(filePath: string): void {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
  for (const [key, value] of parseEnv(text)) {
    if (process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

function parseEnvValue(value: string): string {
  const quote = value.at(0)
  if (quote === '"' || quote === "'") {
    const closed = closingQuoteIndex(value, quote)
    if (closed != null) {
      const inner = value.slice(1, closed)
      return quote === '"' ? inner.replace(/\\([\\nrt"])/g, unescapeEnv) : inner
    }
  }
  const comment = value.indexOf(' #')
  return (comment < 0 ? value : value.slice(0, comment)).trim()
}

function closingQuoteIndex(value: string, quote: string): number | null {
  for (let index = 1; index < value.length; index += 1) {
    if (quote === '"' && value[index] === '\\' && index + 1 < value.length) {
      index += 1
      continue
    }
    if (value[index] === quote) return index
  }
  return null
}

function unescapeEnv(match: string): string {
  switch (match) {
    case '\\n':
      return '\n'
    case '\\r':
      return '\r'
    case '\\t':
      return '\t'
    case '\\"':
      return '"'
    case '\\\\':
      return '\\'
    default:
      return match
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error != null && 'code' in error && error.code === 'ENOENT'
}
