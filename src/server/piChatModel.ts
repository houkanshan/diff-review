import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import {
  defaultPiChatModel,
  filterPiChatModels,
  parsePiChatModelChoice,
  parsePiListModelsTable,
} from '../shared/piChatModel.js'
import type { PiChatModelChoice, PiChatModelOption } from '../shared/types.js'

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

let listedModels: { key: string; models: PiChatModelOption[] } | null = null

export function listPiChatModels(): PiChatModelOption[] {
  const key = process.env.PATH ?? ''
  if (listedModels?.key === key) return listedModels.models
  const env = { ...process.env }
  delete env.PI_TEST_OUTPUT
  const result = spawnSync('pi', ['--list-models'], {
    encoding: 'utf8',
    timeout: 20_000,
    env,
  })
  const models = result.status === 0
    ? filterPiChatModels(parsePiListModelsTable(result.stdout ?? ''))
    : []
  listedModels = { key, models }
  return models
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
): PiChatModelChoice {
  const all = readChatModelMap(dataDirectory)
  const saved = model ?? defaultPiChatModel()
  all[chatKey] = saved
  writeChatModelMap(dataDirectory, all)
  return saved
}

export function readPiChatModel(dataDirectory: string): PiChatModelChoice | null {
  try {
    return parsePiChatModelChoice(JSON.parse(readFileSync(piChatModelPath(dataDirectory), 'utf8')))
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
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
        result[key] = defaultPiChatModel()
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

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}
