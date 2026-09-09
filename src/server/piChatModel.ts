import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parsePiChatModelChoice, parsePiChatThinkingLevel } from '../shared/piChatModel.js'
import type { PiChatModelChoice } from '../shared/types.js'

export const PI_CHAT_MODEL_FILE = 'pi-chat-model.json'
export const PI_CHAT_MODELS_FILE = 'pi-chat-models.json'

export type ChatModelSelection =
  | { status: 'unset' }
  | { status: 'set'; model: PiChatModelChoice | null }

export function piChatModelPath(dataDirectory: string): string {
  return path.join(dataDirectory, PI_CHAT_MODEL_FILE)
}

export function piChatModelsPath(dataDirectory: string): string {
  return path.join(dataDirectory, PI_CHAT_MODELS_FILE)
}

export function readChatModelSelection(
  dataDirectory: string,
  chatKey: string,
): ChatModelSelection {
  const all = readChatModelMap(dataDirectory)
  if (!Object.hasOwn(all, chatKey)) return { status: 'unset' }
  return { status: 'set', model: all[chatKey] ?? null }
}

export function writeChatModelSelection(
  dataDirectory: string,
  chatKey: string,
  model: PiChatModelChoice | null,
): PiChatModelChoice | null {
  const all = readChatModelMap(dataDirectory)
  all[chatKey] = model
  writeChatModelMap(dataDirectory, all)
  return model
}

export function readPiChatModel(dataDirectory: string): PiChatModelChoice | null {
  try {
    return parsePiChatModelChoice(JSON.parse(readFileSync(piChatModelPath(dataDirectory), 'utf8')))
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

export function readPiAgentDefaultModel(
  settingsPath = process.env.DIFF_REVIEW_PI_AGENT_SETTINGS ?? defaultPiAgentSettingsPath(),
): PiChatModelChoice | null {
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    const provider = typeof raw.defaultProvider === 'string' ? raw.defaultProvider.trim() : ''
    const modelId = typeof raw.defaultModel === 'string' ? raw.defaultModel.trim() : ''
    if (!provider || !modelId) return null
    return {
      provider,
      modelId,
      thinkingLevel: parsePiChatThinkingLevel(raw.defaultThinkingLevel),
    }
  } catch {
    return null
  }
}

export function writePiChatModel(
  dataDirectory: string,
  choice: PiChatModelChoice | null,
): PiChatModelChoice | null {
  const file = piChatModelPath(dataDirectory)
  if (choice == null) {
    try {
      rmSync(file)
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
    return null
  }
  mkdirSync(dataDirectory, { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(choice, null, 2)}\n`)
  renameSync(temp, file)
  return choice
}

function readChatModelMap(dataDirectory: string): Record<string, PiChatModelChoice | null> {
  try {
    const raw = JSON.parse(readFileSync(piChatModelsPath(dataDirectory), 'utf8')) as unknown
    if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return {}
    const result: Record<string, PiChatModelChoice | null> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value == null) {
        result[key] = null
        continue
      }
      const parsed = parsePiChatModelChoice(value)
      if (parsed != null) result[key] = parsed
    }
    return result
  } catch (error) {
    if (isMissingFile(error)) return {}
    throw error
  }
}

function writeChatModelMap(
  dataDirectory: string,
  models: Record<string, PiChatModelChoice | null>,
): void {
  mkdirSync(dataDirectory, { recursive: true })
  const file = piChatModelsPath(dataDirectory)
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(models, null, 2)}\n`)
  renameSync(temp, file)
}

function defaultPiAgentSettingsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'settings.json')
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
