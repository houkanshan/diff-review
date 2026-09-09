import { spawn } from 'node:child_process'
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
let listedModelsInflight: { key: string; promise: Promise<PiChatModelOption[]> } | null = null

export function cachedPiChatModels(): PiChatModelOption[] {
  const key = process.env.PATH ?? ''
  return listedModels?.key === key ? listedModels.models : []
}

export async function listPiChatModels(): Promise<PiChatModelOption[]> {
  const key = process.env.PATH ?? ''
  if (listedModels?.key === key) return listedModels.models
  if (listedModelsInflight?.key === key) return listedModelsInflight.promise
  const promise = loadPiChatModels().then(
    (models) => {
      listedModels = { key, models }
      if (listedModelsInflight?.promise === promise) listedModelsInflight = null
      return models
    },
    (error: unknown) => {
      if (listedModelsInflight?.promise === promise) listedModelsInflight = null
      throw error
    },
  )
  listedModelsInflight = { key, promise }
  try {
    return await promise
  } catch {
    return []
  }
}

async function loadPiChatModels(): Promise<PiChatModelOption[]> {
  const env = { ...process.env }
  delete env.PI_TEST_OUTPUT
  const result = await runPiListModels(env)
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `pi --list-models exited with ${result.status}`)
  }
  return filterPiChatModels(parsePiListModelsTable(result.stdout))
}

function runPiListModels(
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn('pi', ['--list-models'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('pi --list-models timed out'))
    }, 20_000)
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        status: status ?? 1,
      })
    })
  })
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
