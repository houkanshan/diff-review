import { type FileDiffMetadata, parsePatchFiles } from '@pierre/diffs'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/
const MAX_REVIEW_COMMENT_DIFF_LINES = 8

interface HunkHeader {
  deletionStart: number
  additionStart: number
  suffix: string
}

export function parseReviewCommentDiff(filePath: string, diffHunk: string): FileDiffMetadata | null {
  const normalizedHunk = normalizeReviewCommentHunk(diffHunk)
  if (normalizedHunk == null) return null
  const oldPath = JSON.stringify(`a/${filePath}`)
  const newPath = JSON.stringify(`b/${filePath}`)
  const patch = [
    `diff --git ${oldPath} ${newPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    normalizedHunk,
    '',
  ].join('\n')
  try {
    const fileDiff = parsePatchFiles(patch, `review-comment:${filePath}`, true).at(0)?.files.at(0)
    return fileDiff == null ? null : stripCollapsedReviewContext(fileDiff)
  } catch (caught) {
    console.error(`Could not parse review comment diff for ${filePath}`, caught)
    return null
  }
}

export function normalizeReviewCommentHunk(diffHunk: string): string | null {
  const lines = diffHunk.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines[0] === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return null

  const output: string[] = []
  let index = 0
  let sawHunk = false
  while (index < lines.length) {
    const header = parseHunkHeader(lines[index] ?? '')
    if (header == null) {
      if (!sawHunk) return wrapHunkLines(lines)
      break
    }
    sawHunk = true
    index += 1
    const body: string[] = []
    while (index < lines.length && !lines[index]?.startsWith('@@ ')) {
      body.push(lines[index] ?? '')
      index += 1
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    output.push(...limitHunk(header, body))
  }
  return output.length === 0 ? null : output.join('\n')
}

function wrapHunkLines(lines: string[]): string {
  const body = [...lines]
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return limitHunk({ deletionStart: 1, additionStart: 1, suffix: '' }, body).join('\n')
}

function parseHunkHeader(line: string): HunkHeader | null {
  const header = HUNK_HEADER.exec(line)
  if (header == null) return null
  return {
    deletionStart: Number(header[1]),
    additionStart: Number(header[3]),
    suffix: header[5] ?? '',
  }
}

function limitHunk(header: HunkHeader, body: readonly string[]): string[] {
  const skipped = countHunkLines(body.slice(0, Math.max(0, body.length - MAX_REVIEW_COMMENT_DIFF_LINES)))
  const kept = body.slice(-MAX_REVIEW_COMMENT_DIFF_LINES)
  const keptCounts = countHunkLines(kept)
  return [
    `@@ -${header.deletionStart + skipped.deletions},${keptCounts.deletions} +${header.additionStart + skipped.additions},${keptCounts.additions} @@${header.suffix}`,
    ...kept,
  ]
}

function countHunkLines(lines: readonly string[]): { deletions: number; additions: number } {
  let deletions = 0
  let additions = 0
  for (const line of lines) {
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
    else {
      additions += 1
      deletions += 1
    }
  }
  return { deletions, additions }
}


function stripCollapsedReviewContext(fileDiff: FileDiffMetadata): FileDiffMetadata {
  let unifiedLineStart = 0
  let splitLineStart = 0
  for (const hunk of fileDiff.hunks) {
    hunk.collapsedBefore = 0
    hunk.unifiedLineStart = unifiedLineStart
    hunk.splitLineStart = splitLineStart
    unifiedLineStart += hunk.unifiedLineCount
    splitLineStart += hunk.splitLineCount
  }
  fileDiff.unifiedLineCount = unifiedLineStart
  fileDiff.splitLineCount = splitLineStart
  return fileDiff
}
