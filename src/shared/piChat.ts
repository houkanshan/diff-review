import {
  findPiChatModel,
  normalizePiChatModelChoice,
  parsePiChatThinkingLevel,
} from './piChatModel.js'
import type { PiChatModelChoice, PiChatTurn, PiChatWork } from './types.js'

export const PI_CHAT_PAGE_SIZE = 40

export const PI_INSTALL_HINT = `Pi is not installed. Install it, then make sure \`pi\` is on PATH.

npm install -g --ignore-scripts @earendil-works/pi-coding-agent

or:

curl -fsSL https://pi.dev/install.sh | sh`

interface SessionMessageEntry {
  type: 'message'
  id: string
  parentId: string | null
  timestamp: string
  message: {
    role: string
    content?: unknown
    timestamp?: number
    toolCallId?: string
    toolName?: string
  }
}

export function projectPiChatTurns(entries: readonly unknown[]): PiChatTurn[] {
  const messages = activeMessageBranch(entries)
  const turns: PiChatTurn[] = []
  let current: MutableTurn | null = null

  const finish = () => {
    if (current == null) return
    if (current.work != null) {
      current.work = {
        ...current.work,
        durationMs: elapsedMs(current.startedAt, current.endedAt),
      }
    }
    turns.push({
      id: current.id,
      userText: current.userText,
      assistantText: current.assistantText,
      work: current.work,
    })
    current = null
  }

  for (const entry of messages) {
    const role = entry.message.role
    if (role === 'user') {
      finish()
      current = {
        id: entry.id,
        userText: contentText(entry.message.content),
        assistantText: '',
        work: null,
        startedAt: entry.timestamp,
        endedAt: entry.timestamp,
      }
      continue
    }
    if (current == null) continue
    current.endedAt = entry.timestamp
    if (role === 'assistant') {
      const text = contentText(entry.message.content)
      if (text) {
        current.assistantText = current.assistantText
          ? `${current.assistantText}\n${text}`
          : text
      }
    }
    const work = workFromMessage(entry.message, current.startedAt, entry.timestamp)
    if (work != null) current.work = mergeWork(current.work, work)
  }
  finish()
  return turns
}

export function projectPiChatModel(entries: readonly unknown[]): PiChatModelChoice | null {
  let provider = ''
  let modelId = ''
  let thinkingLevel: PiChatModelChoice['thinkingLevel'] = null
  for (const entry of activeTreeBranch(entries)) {
    if (entry.type === 'model_change') {
      if (entry.provider) provider = entry.provider
      if (entry.modelId) modelId = entry.modelId
    }
    if (entry.type === 'thinking_level_change' && entry.thinkingLevel != null) {
      thinkingLevel = parsePiChatThinkingLevel(entry.thinkingLevel) ?? thinkingLevel
    }
    if (entry.type === 'message' && entry.message?.role === 'assistant') {
      if (entry.assistantProvider) provider = entry.assistantProvider
      if (entry.assistantModel) modelId = entry.assistantModel
    }
  }
  if (!provider || !modelId) return null
  const option = findPiChatModel(provider, modelId)
  if (option != null) return normalizePiChatModelChoice(option, thinkingLevel ?? 'medium')
  return { provider, modelId, thinkingLevel }
}

export function pagePiChatTurns(
  turns: readonly PiChatTurn[],
  before: string | null,
  limit = PI_CHAT_PAGE_SIZE,
): { turns: PiChatTurn[]; nextBefore: string | null } {
  const capped = Math.min(100, Math.max(1, Math.floor(limit)))
  let end = turns.length
  if (before != null) {
    const index = turns.findIndex((turn) => turn.id === before)
    end = index < 0 ? turns.length : index
  }
  const start = Math.max(0, end - capped)
  const page = turns.slice(start, end)
  return {
    turns: page,
    nextBefore: start > 0 ? page[0]?.id ?? null : null,
  }
}

export function formatWorkDuration(durationMs: number | null): string | null {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return null
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.round(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function assistantTextFromContent(content: unknown): string {
  return contentText(content)
}

function activeMessageBranch(entries: readonly unknown[]): SessionMessageEntry[] {
  return activeTreeBranch(entries).filter(isMessageEntry)
}

function activeTreeBranch(entries: readonly unknown[]): SessionTreeEntry[] {
  const nodes: SessionTreeEntry[] = []
  for (const entry of entries) {
    const parsed = parseTreeEntry(entry)
    if (parsed != null) nodes.push(parsed)
  }
  if (nodes.length === 0) return []
  const byId = new Map(nodes.map((entry) => [entry.id, entry]))
  const children = new Set<string>()
  for (const entry of nodes) {
    if (entry.parentId != null) children.add(entry.parentId)
  }
  let leaf = [...nodes].reverse().find((entry) => !children.has(entry.id)) ?? nodes.at(-1)
  const branch: SessionTreeEntry[] = []
  const seen = new Set<string>()
  while (leaf != null && !seen.has(leaf.id)) {
    seen.add(leaf.id)
    branch.push(leaf)
    leaf = leaf.parentId == null ? undefined : byId.get(leaf.parentId)
  }
  return branch.reverse()
}

function isMessageEntry(entry: SessionTreeEntry): entry is SessionMessageEntry {
  return entry.type === 'message' && entry.message != null
}

interface SessionTreeEntry {
  type: string
  id: string
  parentId: string | null
  timestamp: string
  message?: SessionMessageEntry['message']
  provider?: string
  modelId?: string
  thinkingLevel?: string
  assistantProvider?: string
  assistantModel?: string
}

function parseTreeEntry(value: unknown): SessionTreeEntry | null {
  if (typeof value !== 'object' || value == null) return null
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string') return null
  const parentId = typeof entry.parentId === 'string' ? entry.parentId : null
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : ''
  const provider = typeof entry.provider === 'string' ? entry.provider : undefined
  const modelId = typeof entry.modelId === 'string' ? entry.modelId : undefined
  const thinkingLevel = typeof entry.thinkingLevel === 'string' ? entry.thinkingLevel : undefined
  if (entry.type === 'message') {
    if (typeof entry.message !== 'object' || entry.message == null) return null
    const message = entry.message as Record<string, unknown>
    if (typeof message.role !== 'string') return null
    return {
      type: 'message',
      id: entry.id,
      parentId,
      timestamp,
      provider,
      modelId,
      thinkingLevel,
      assistantProvider: typeof message.provider === 'string' ? message.provider : undefined,
      assistantModel: typeof message.model === 'string' ? message.model : undefined,
      message: {
        role: message.role,
        content: message.content,
        timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined,
        toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
        toolName: typeof message.toolName === 'string' ? message.toolName : undefined,
      },
    }
  }
  return {
    type: typeof entry.type === 'string' ? entry.type : 'unknown',
    id: entry.id,
    parentId,
    timestamp,
    provider,
    modelId,
    thinkingLevel,
  }
}

interface MutableTurn {
  id: string
  userText: string
  assistantText: string
  work: PiChatWork | null
  startedAt: string
  endedAt: string
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) => {
      if (typeof block === 'string') return [block]
      if (typeof block !== 'object' || block == null) return []
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') return [record.text]
      return []
    })
    .join('')
}

function workFromMessage(
  message: SessionMessageEntry['message'],
  startedAt: string,
  endedAt: string,
): PiChatWork | null {
  const details: string[] = []
  if (message.role === 'toolResult' || message.role === 'bashExecution') {
    details.push(message.toolName ? `tool ${message.toolName}` : message.role)
  }
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block !== 'object' || block == null) continue
      const record = block as Record<string, unknown>
      if (record.type === 'thinking' && typeof record.thinking === 'string' && record.thinking.trim()) {
        details.push(record.thinking.trim())
      }
      if (record.type === 'toolCall') {
        const name = typeof record.name === 'string' ? record.name : 'tool'
        details.push(`tool ${name}`)
      }
    }
  }
  if (details.length === 0) return null
  return {
    durationMs: elapsedMs(startedAt, endedAt),
    detail: details.join('\n'),
  }
}

function mergeWork(current: PiChatWork | null, next: PiChatWork): PiChatWork {
  if (current == null) return next
  return {
    durationMs: next.durationMs ?? current.durationMs,
    detail: current.detail ? `${current.detail}\n${next.detail}` : next.detail,
  }
}

function elapsedMs(start: string, end: string): number | null {
  const from = Date.parse(start)
  const to = Date.parse(end)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null
  return to - from
}
