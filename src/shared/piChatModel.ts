import type { PiChatModelChoice, PiChatModelOption, PiChatThinkingLevel } from './types.js'

export const PI_CHAT_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly PiChatThinkingLevel[]

export const PI_CHAT_MODEL_ID_FILTERS = ['gpt-5.6', 'gpt-6'] as const

const THINKING_LEVELS = new Set<string>(PI_CHAT_THINKING_LEVELS)

export function findPiChatModel(
  models: readonly PiChatModelOption[],
  provider: string,
  modelId: string,
): PiChatModelOption | undefined {
  return models.find((model) => model.provider === provider && model.id === modelId)
}

export function defaultPiChatModel(
  models: readonly PiChatModelOption[] = [],
): PiChatModelChoice {
  const first = models[0]
  if (first != null) return normalizePiChatModelChoice(first)
  return {
    provider: 'openai-codex',
    modelId: 'gpt-5.6-luna',
    thinkingLevel: 'medium',
  }
}

export function piChatModelLabel(
  choice: PiChatModelChoice | null,
  models: readonly PiChatModelOption[] = [],
): string {
  const resolved = choice ?? defaultPiChatModel(models)
  return findPiChatModel(models, resolved.provider, resolved.modelId)?.name ?? resolved.modelId
}

export function piChatModelKey(choice: PiChatModelChoice | null): string {
  if (choice == null) return ''
  return `${choice.provider}/${choice.modelId}:${choice.thinkingLevel ?? 'none'}`
}

export function piChatCliArgs(choice: PiChatModelChoice | null): string[] {
  if (choice == null) return []
  const args = ['--model', `${choice.provider}/${choice.modelId}`]
  if (choice.thinkingLevel != null) args.push('--thinking', choice.thinkingLevel)
  return args
}

export function parsePiChatThinkingLevel(value: unknown): PiChatThinkingLevel | null {
  return typeof value === 'string' && THINKING_LEVELS.has(value)
    ? (value as PiChatThinkingLevel)
    : null
}

export function parsePiChatModelChoice(value: unknown): PiChatModelChoice | null {
  if (value == null) return null
  if (typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const modelId = typeof record.modelId === 'string'
    ? record.modelId.trim()
    : typeof record.id === 'string'
      ? record.id.trim()
      : ''
  if (!provider || !modelId) return null
  return {
    provider,
    modelId,
    thinkingLevel: parsePiChatThinkingLevel(record.thinkingLevel) ?? 'medium',
  }
}

export function normalizePiChatModelChoice(
  option: PiChatModelOption,
  thinkingLevel: unknown = 'medium',
): PiChatModelChoice {
  if (!option.thinking) {
    return { provider: option.provider, modelId: option.id, thinkingLevel: null }
  }
  return {
    provider: option.provider,
    modelId: option.id,
    thinkingLevel: parsePiChatThinkingLevel(thinkingLevel) ?? 'medium',
  }
}

export function parsePiListModelsTable(stdout: string): PiChatModelOption[] {
  const rows: PiChatModelOption[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) continue
    const provider = parts[0] ?? ''
    const id = parts[1] ?? ''
    const thinking = parts.at(-2)
    if (provider === 'provider' || !provider || !id) continue
    rows.push({
      provider,
      id,
      name: piListModelName(id),
      thinking: thinking === 'yes',
    })
  }
  return rows
}

export function filterPiChatModels(rows: readonly PiChatModelOption[]): PiChatModelOption[] {
  const matched = rows.filter((row) => {
    if (row.id.includes('@') || row.id.includes(':')) return false
    return PI_CHAT_MODEL_ID_FILTERS.some(
      (filter) => row.id === filter || row.id.startsWith(`${filter}-`),
    )
  })
  const ranked = [...matched].sort(
    (left, right) => providerRank(left.provider) - providerRank(right.provider),
  )
  const seen = new Set<string>()
  const models: PiChatModelOption[] = []
  for (const row of ranked) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    models.push(row)
  }
  return models
}

function piListModelName(id: string): string {
  return id.replace(/^gpt-/, 'GPT-').replace(/-([a-z])/g, ' $1')
}

function providerRank(provider: string): number {
  if (provider === 'openai-codex') return 0
  if (provider === 'openai-codex-2') return 1
  return 2
}
