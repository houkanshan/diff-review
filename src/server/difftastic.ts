import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runCommand } from './command.js'
import { AppError } from './errors.js'
import { readSnapshotFile, type ResolvedReview } from './git.js'
import { buildDifftasticFileDiff } from '../shared/difftastic.js'
import type { DifftasticAvailability, DifftasticFileDiff } from '../shared/types.js'

export const DIFFT_INSTALL_HINT = 'Install difftastic and make sure `difft` is on PATH.'
const VERSION_CACHE_MS = 30_000

interface CachedAvailability {
  value: DifftasticAvailability
  expiresAt: number
}

let availabilityCache: CachedAvailability | null = null

export async function getDifftasticAvailability(): Promise<DifftasticAvailability> {
  const now = Date.now()
  if (availabilityCache != null && availabilityCache.expiresAt > now) {
    return availabilityCache.value
  }

  const value = await probeDifftastic()
  availabilityCache = { value, expiresAt: now + VERSION_CACHE_MS }
  return value
}

export async function renderDifftasticFile(input: {
  repositoryRoot: string
  review: ResolvedReview
  filePath: string
  oldPath: string | null
  newPath: string | null
}): Promise<DifftasticFileDiff> {
  const availability = await getDifftasticAvailability()
  if (!availability.available) {
    throw new AppError('DIFFT_NOT_FOUND', availability.installHint, 503)
  }

  const [oldText, newText] = await Promise.all([
    input.oldPath == null
      ? Promise.resolve(null)
      : readSnapshotFile(input.repositoryRoot, input.review.oldSnapshot, input.oldPath),
    input.newPath == null
      ? Promise.resolve(null)
      : readSnapshotFile(input.repositoryRoot, input.review.newSnapshot, input.newPath),
  ])

  const raw = await runDifftasticJson(oldText, newText, input.filePath)
  return buildDifftasticFileDiff({
    path: input.filePath,
    oldText,
    newText,
    raw,
  })
}

async function probeDifftastic(): Promise<DifftasticAvailability> {
  try {
    const result = await runCommand('difft', ['--version'], process.cwd(), true)
    if (result.exitCode !== 0) {
      return {
        available: false,
        version: null,
        installHint: DIFFT_INSTALL_HINT,
      }
    }
    const version = result.stdout.trim().split('\n')[0] || null
    return {
      available: true,
      version,
      installHint: DIFFT_INSTALL_HINT,
    }
  } catch (error) {
    if (error instanceof AppError && error.code === 'COMMAND_NOT_FOUND') {
      return {
        available: false,
        version: null,
        installHint: DIFFT_INSTALL_HINT,
      }
    }
    throw error
  }
}

async function runDifftasticJson(
  oldText: string | null,
  newText: string | null,
  filePath: string,
): Promise<unknown> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'diff-review-difft-'))
  try {
    const extension = path.extname(filePath)
    const suffix = extension || '.txt'
    const oldFile = path.join(directory, `old${suffix}`)
    const newFile = path.join(directory, `new${suffix}`)
    await Promise.all([
      writeFile(oldFile, oldText ?? '', 'utf8'),
      writeFile(newFile, newText ?? '', 'utf8'),
    ])
    const result = await runCommand(
      'difft',
      [
        '--display', 'json',
        '--color', 'never',
        '--ignore-comments',
        '--strip-cr', 'on',
        oldFile,
        newFile,
      ],
      directory,
      true,
      { DFT_UNSTABLE: 'yes' },
    )
    if (result.exitCode > 1) {
      throw new AppError(
        'DIFFT_FAILED',
        result.stderr.trim() || `difftastic failed for ${filePath}`,
      )
    }
    return parseJsonOutput(result.stdout, filePath)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function parseJsonOutput(stdout: string, filePath: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new AppError('DIFFT_OUTPUT_INVALID', `difftastic returned no JSON for ${filePath}`)
  }
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    throw new AppError('DIFFT_OUTPUT_INVALID', `difftastic returned invalid JSON for ${filePath}`)
  }
}
