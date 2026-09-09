import type { PiChatModelChoice, PiChatThinkingLevel } from './types.js'

export const PI_CHAT_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly PiChatThinkingLevel[]

export const PI_CHAT_MODELS = [
  { provider: 'xai', id: 'grok-4.6', name: 'Grok 4.6', thinking: true },
  { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 sol', thinking: true },
  { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'GPT-5.6 luna', thinking: true },
  { provider: 'cursor', id: 'composer-2.5', name: 'Composer 2.5', thinking: false },
] as const

export type PiChatModelOption = (typeof PI_CHAT_MODELS)[number]

const THINKING_LEVELS = new Set<string>(PI_CHAT_THINKING_LEVELS)

export function findPiChatModel(
  provider: string,
  modelId: string,
): PiChatModelOption | undefined {
  return PI_CHAT_MODELS.find((model) => model.provider === provider && model.id === modelId)
}

export function defaultPiChatModel(): PiChatModelChoice {
  return normalizePiChatModelChoice(PI_CHAT_MODELS[0])
}

export function piChatModelLabel(choice: PiChatModelChoice | null): string {
  const resolved = choice ?? defaultPiChatModel()
  return findPiChatModel(resolved.provider, resolved.modelId)?.name ?? resolved.modelId
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
  const option = findPiChatModel(provider, modelId)
  if (option == null) return null
  return normalizePiChatModelChoice(option, record.thinkingLevel)
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
