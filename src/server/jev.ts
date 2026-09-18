import { createHash } from 'node:crypto'

import {
  isLocalChangesOid,
  JEV_FILE_ORDER_API_KEY_HINT,
  JEV_FILE_ORDER_FAILED_HINT,
  type ReviewSession,
} from '../shared/types.js'
import { AppError } from './errors.js'

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone'
const READ_FIRST_QUESTION = 'read_first'
const READ_FIRST_INSTRUCTIONS =
  'When reviewing this code change, which file should a reviewer look at first so the change is easiest to understand and the important parts are reviewed before the rest?'

export function typesafeApiKey(): string | null {
  const key = process.env.TYPESAFE_API_KEY?.trim()
  return key == null || key.length === 0 ? null : key
}

export function jevFileOrderFingerprint(input: {
  files: readonly string[]
  branch: string | null
  commitMessages: readonly string[]
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      files: [...input.files].sort(),
      branch: input.branch,
      commitMessages: input.commitMessages,
      instructions: READ_FIRST_INSTRUCTIONS,
    }))
    .digest('hex')
}

export function reviewCommitMessages(session: Pick<
  ReviewSession,
  'commits' | 'selectedCommitStart' | 'selectedCommitEnd'
>): string[] {
  const start = session.commits.findIndex((commit) => commit.oid === session.selectedCommitStart)
  const end = session.commits.findIndex((commit) => commit.oid === session.selectedCommitEnd)
  const selected = start >= 0 && end >= 0 && start <= end
    ? session.commits.slice(start, end + 1)
    : session.commits
  return selected
    .filter((commit) => !isLocalChangesOid(commit.oid))
    .map((commit) => commit.subject.trim())
    .filter((subject) => subject.length > 0)
}

export async function rankFilesForReview(input: {
  files: readonly string[]
  branch: string | null
  commitMessages: readonly string[]
}): Promise<string[]> {
  const files = [...input.files]
  if (files.length <= 1) return files
  const apiKey = typesafeApiKey()
  if (apiKey == null) {
    throw new AppError('TYPESAFE_API_KEY_MISSING', JEV_FILE_ORDER_API_KEY_HINT, 503)
  }

  const criteria: Record<string, null> = {}
  for (const filePath of files) criteria[filePath] = null

  const state = reviewState(input.branch, input.commitMessages)
  logJev('request', {
    files,
    instructions: READ_FIRST_INSTRUCTIONS,
    state,
  })
  let response: Response
  try {
    response = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state,
        model: 'jev-latest',
        questions: {
          [READ_FIRST_QUESTION]: {
            type: 'choice',
            instructions: READ_FIRST_INSTRUCTIONS,
            criteria,
          },
        },
      }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (error) {
    logJev('error', { message: error instanceof Error ? error.message : String(error) })
    throw new AppError('TYPESAFE_REQUEST_FAILED', JEV_FILE_ORDER_FAILED_HINT, 502, error)
  }
  if (!response.ok) {
    logJev('error', { status: response.status })
    throw new AppError('TYPESAFE_REQUEST_FAILED', JEV_FILE_ORDER_FAILED_HINT, 502)
  }

  const payload: unknown = await response.json()
  const probabilities = choiceProbabilities(payload, READ_FIRST_QUESTION)
  const ranking = files
    .map((filePath, index) => ({ filePath, index, score: probabilities[filePath] ?? 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
  logJev('result', {
    ranking: ranking.map((entry) => ({ path: entry.filePath, score: entry.score })),
    usage: payloadUsage(payload),
  })
  return ranking.map((entry) => entry.filePath)
}

function logJev(event: string, details: Record<string, unknown>): void {
  console.log(`diff-review jev ${event}: ${JSON.stringify(details)}`)
}

function payloadUsage(payload: unknown): { input_tokens?: number; output_tokens?: number } | null {
  if (payload == null || typeof payload !== 'object') return null
  const usage = (payload as { usage?: unknown }).usage
  if (usage == null || typeof usage !== 'object') return null
  const input = (usage as { input_tokens?: unknown }).input_tokens
  const output = (usage as { output_tokens?: unknown }).output_tokens
  return {
    ...(typeof input === 'number' ? { input_tokens: input } : {}),
    ...(typeof output === 'number' ? { output_tokens: output } : {}),
  }
}

function reviewState(
  branch: string | null,
  commitMessages: readonly string[],
): string | { branch?: string; commit_messages?: string[] } {
  const state: { branch?: string; commit_messages?: string[] } = {}
  if (branch != null && branch !== '') state.branch = branch
  if (commitMessages.length > 0) state.commit_messages = [...commitMessages]
  if (state.branch == null && state.commit_messages == null) {
    return 'Changed files in a code review.'
  }
  return state
}

function choiceProbabilities(payload: unknown, questionId: string): Record<string, number> {
  if (payload == null || typeof payload !== 'object') {
    throw new AppError('TYPESAFE_REQUEST_FAILED', JEV_FILE_ORDER_FAILED_HINT, 502)
  }
  const answers = (payload as { answers?: unknown }).answers
  if (answers == null || typeof answers !== 'object') {
    throw new AppError('TYPESAFE_REQUEST_FAILED', JEV_FILE_ORDER_FAILED_HINT, 502)
  }
  const answer = (answers as Record<string, unknown>)[questionId]
  if (answer == null || typeof answer !== 'object') {
    throw new AppError('TYPESAFE_REQUEST_FAILED', JEV_FILE_ORDER_FAILED_HINT, 502)
  }
  const probabilities = (answer as { probabilities?: unknown }).probabilities
  if (probabilities == null || typeof probabilities !== 'object') {
    throw new AppError('TYPESAFE_REQUEST_FAILED', JEV_FILE_ORDER_FAILED_HINT, 502)
  }
  const scores: Record<string, number> = {}
  for (const [filePath, value] of Object.entries(probabilities)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    scores[filePath] = value
  }
  return scores
}
