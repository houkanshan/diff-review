import type {
  DifftasticFileDiff,
  DifftasticFileStatus,
  DifftasticHighlight,
  DifftasticHunk,
  DifftasticHunkLine,
  DifftasticLineKind,
  DifftasticSpan,
} from './types.js'

export const DIFFT_CONTEXT_LINES = 3

const HIGHLIGHTS = new Set<DifftasticHighlight>([
  'delimiter',
  'normal',
  'string',
  'type',
  'comment',
  'keyword',
  'tree_sitter_error',
])

const FILE_STATUSES = new Set<DifftasticFileStatus>([
  'unchanged',
  'changed',
  'created',
  'deleted',
])

interface RawChange {
  start: number
  end: number
  content: string
  highlight: DifftasticHighlight
}

interface RawSide {
  lineNumber: number
  changes: RawChange[]
}

interface RawAlignedLine {
  lhs: RawSide | null
  rhs: RawSide | null
}

export function parseDifftasticOutput(value: unknown): {
  language: string
  path: string
  status: DifftasticFileStatus
  chunks: RawAlignedLine[][]
} {
  const object = expectObject(value, 'difftastic output')
  const status = object.status
  if (typeof status !== 'string' || !FILE_STATUSES.has(status as DifftasticFileStatus)) {
    throw new Error('difftastic output is missing a valid status')
  }
  const language = typeof object.language === 'string' && object.language.length > 0
    ? object.language
    : 'Text'
  const filePath = typeof object.path === 'string' ? object.path : ''
  return {
    language,
    path: filePath,
    status: status as DifftasticFileStatus,
    chunks: parseChunks(object.chunks),
  }
}

export function buildDifftasticFileDiff(input: {
  path: string
  oldText: string | null
  newText: string | null
  raw: unknown
}): DifftasticFileDiff {
  const parsed = parseDifftasticOutput(input.raw)
  const oldLines = splitFileLines(input.oldText)
  const newLines = splitFileLines(input.newText)
  const hunks = coalesceHunks(
    parsed.chunks
      .map((chunk) => buildHunk(chunk, oldLines, newLines))
      .filter((hunk) => hunk.lines.length > 0),
    oldLines,
    newLines,
  )

  if (parsed.status === 'created' && hunks.length === 0 && newLines.length > 0) {
    hunks.push(wholeFileHunk(null, newLines, 'insert'))
  }
  if (parsed.status === 'deleted' && hunks.length === 0 && oldLines.length > 0) {
    hunks.push(wholeFileHunk(oldLines, null, 'delete'))
  }

  return {
    path: input.path,
    language: parsed.language,
    status: parsed.status,
    hunks,
  }
}

export function splitFileLines(contents: string | null): string[] {
  if (contents == null || contents === '') return []
  const lines = contents.split('\n')
  if (contents.endsWith('\n')) lines.pop()
  return lines
}

function buildHunk(
  chunk: RawAlignedLine[],
  oldLines: string[],
  newLines: string[],
): DifftasticHunk {
  const changes = chunk.map((line) => toHunkLine(line, oldLines, newLines))
  if (changes.length === 0) return { lines: [] }

  const oldNumbers = changes.flatMap((line) => line.oldLine == null ? [] : [line.oldLine])
  const newNumbers = changes.flatMap((line) => line.newLine == null ? [] : [line.newLine])

  let oldStart = oldNumbers.length === 0 ? null : Math.min(...oldNumbers)
  let oldEnd = oldNumbers.length === 0 ? null : Math.max(...oldNumbers)
  let newStart = newNumbers.length === 0 ? null : Math.min(...newNumbers)
  let newEnd = newNumbers.length === 0 ? null : Math.max(...newNumbers)

  if (oldStart == null && newStart != null) {
    oldStart = Math.min(oldLines.length + 1, newStart)
    oldEnd = Math.min(oldLines.length, Math.max(...newNumbers))
  } else if (newStart == null && oldStart != null) {
    newStart = Math.min(newLines.length + 1, oldStart)
    newEnd = Math.min(newLines.length, Math.max(...oldNumbers))
  }

  if (oldStart != null) {
    oldStart = Math.max(1, oldStart - DIFFT_CONTEXT_LINES)
    oldEnd = Math.min(oldLines.length, (oldEnd ?? oldStart) + DIFFT_CONTEXT_LINES)
  }
  if (newStart != null) {
    newStart = Math.max(1, newStart - DIFFT_CONTEXT_LINES)
    newEnd = Math.min(newLines.length, (newEnd ?? newStart) + DIFFT_CONTEXT_LINES)
  }

  const changeByOld = new Map<number, DifftasticHunkLine>()
  const changeByNew = new Map<number, DifftasticHunkLine>()
  for (const line of changes) {
    if (line.oldLine != null) changeByOld.set(line.oldLine, line)
    if (line.newLine != null) changeByNew.set(line.newLine, line)
  }

  if (
    oldStart != null && oldEnd != null && oldEnd >= oldStart &&
    newStart != null && newEnd != null && newEnd >= newStart
  ) {
    return {
      lines: mergeBothSides(oldStart, oldEnd, newStart, newEnd, oldLines, newLines, changeByOld, changeByNew),
    }
  }
  if (oldStart != null && oldEnd != null && oldEnd >= oldStart) {
    return {
      lines: rangeLines(oldStart, oldEnd).map((oldLine) =>
        changeByOld.get(oldLine) ?? contextLine(oldLine, null, oldLines[oldLine - 1] ?? '', null),
      ),
    }
  }
  if (newStart != null && newEnd != null && newEnd >= newStart) {
    return {
      lines: rangeLines(newStart, newEnd).map((newLine) =>
        changeByNew.get(newLine) ?? contextLine(null, newLine, null, newLines[newLine - 1] ?? ''),
      ),
    }
  }
  return { lines: changes }
}

function mergeBothSides(
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  oldLines: string[],
  newLines: string[],
  changeByOld: Map<number, DifftasticHunkLine>,
  changeByNew: Map<number, DifftasticHunkLine>,
): DifftasticHunkLine[] {
  const lines: DifftasticHunkLine[] = []
  let oldLine = oldStart
  let newLine = newStart
  const consumed = new Set<DifftasticHunkLine>()

  const emit = (line: DifftasticHunkLine) => {
    consumed.add(line)
    lines.push(line)
    if (line.oldLine != null && line.oldLine >= oldLine) oldLine = line.oldLine + 1
    if (line.newLine != null && line.newLine >= newLine) newLine = line.newLine + 1
  }

  while (oldLine <= oldEnd || newLine <= newEnd) {
    const oldChange = oldLine <= oldEnd ? changeByOld.get(oldLine) : undefined
    const newChange = newLine <= newEnd ? changeByNew.get(newLine) : undefined

    if (oldChange != null && !consumed.has(oldChange) && oldChange.newLine == null) {
      emit(oldChange)
      continue
    }
    if (newChange != null && !consumed.has(newChange) && newChange.oldLine == null) {
      emit(newChange)
      continue
    }
    if (
      oldChange != null && !consumed.has(oldChange) &&
      (oldChange.newLine === newLine || newLine > newEnd)
    ) {
      emit(oldChange)
      continue
    }
    if (
      newChange != null && !consumed.has(newChange) &&
      (newChange.oldLine === oldLine || oldLine > oldEnd)
    ) {
      emit(newChange)
      continue
    }
    if (oldChange != null && oldChange.newLine != null && oldChange.newLine > newLine && newLine <= newEnd) {
      if (newChange != null && !consumed.has(newChange)) {
        emit(newChange)
        continue
      }
      lines.push(contextLine(null, newLine, null, newLines[newLine - 1] ?? ''))
      newLine += 1
      continue
    }
    if (newChange != null && newChange.oldLine != null && newChange.oldLine > oldLine && oldLine <= oldEnd) {
      if (oldChange != null && !consumed.has(oldChange)) {
        emit(oldChange)
        continue
      }
      lines.push(contextLine(oldLine, null, oldLines[oldLine - 1] ?? '', null))
      oldLine += 1
      continue
    }
    if (oldLine <= oldEnd && newLine <= newEnd) {
      lines.push(contextLine(oldLine, newLine, oldLines[oldLine - 1] ?? '', newLines[newLine - 1] ?? ''))
      oldLine += 1
      newLine += 1
      continue
    }
    if (oldLine <= oldEnd) {
      lines.push(contextLine(oldLine, null, oldLines[oldLine - 1] ?? '', null))
      oldLine += 1
      continue
    }
    lines.push(contextLine(null, newLine, null, newLines[newLine - 1] ?? ''))
    newLine += 1
  }

  return lines
}

function coalesceHunks(
  hunks: DifftasticHunk[],
  oldLines: string[],
  newLines: string[],
): DifftasticHunk[] {
  if (hunks.length < 2) return hunks
  const merged: DifftasticHunk[] = [{ lines: [...hunks[0]!.lines] }]
  for (let index = 1; index < hunks.length; index += 1) {
    const current = hunks[index]!
    const previous = merged[merged.length - 1]!
    const gap = contextGap(previous, current, oldLines, newLines)
    if (gap == null) {
      merged.push({ lines: [...current.lines] })
      continue
    }
    previous.lines.push(...gap, ...uncoveredLines(previous, current))
  }
  return merged
}

function contextGap(
  left: DifftasticHunk,
  right: DifftasticHunk,
  oldLines: string[],
  newLines: string[],
): DifftasticHunkLine[] | null {
  const leftOld = lastNumber(left.lines, 'oldLine')
  const leftNew = lastNumber(left.lines, 'newLine')
  const rightOld = firstNumber(right.lines, 'oldLine')
  const rightNew = firstNumber(right.lines, 'newLine')
  const oldGap = numericGap(leftOld, rightOld)
  const newGap = numericGap(leftNew, rightNew)
  if (oldGap == null && newGap == null) return null
  const nearest = Math.min(oldGap ?? Number.POSITIVE_INFINITY, newGap ?? Number.POSITIVE_INFINITY)
  if (nearest > DIFFT_CONTEXT_LINES * 2) return null

  const lines: DifftasticHunkLine[] = []
  let oldLine = leftOld == null ? null : leftOld + 1
  let newLine = leftNew == null ? null : leftNew + 1
  const oldStop = rightOld == null ? null : rightOld - 1
  const newStop = rightNew == null ? null : rightNew - 1

  while (
    (oldLine != null && oldStop != null && oldLine <= oldStop) ||
    (newLine != null && newStop != null && newLine <= newStop)
  ) {
    const hasOld = oldLine != null && oldStop != null && oldLine <= oldStop && oldLine <= oldLines.length
    const hasNew = newLine != null && newStop != null && newLine <= newStop && newLine <= newLines.length
    const emitOld = hasOld ? oldLine : null
    const emitNew = hasNew ? newLine : null
    if (emitOld != null && emitNew != null) {
      lines.push(contextLine(emitOld, emitNew, oldLines[emitOld - 1] ?? '', newLines[emitNew - 1] ?? ''))
      oldLine = emitOld + 1
      newLine = emitNew + 1
      continue
    }
    if (emitOld != null) {
      lines.push(contextLine(emitOld, null, oldLines[emitOld - 1] ?? '', null))
      oldLine = emitOld + 1
      continue
    }
    if (emitNew != null) {
      lines.push(contextLine(null, emitNew, null, newLines[emitNew - 1] ?? ''))
      newLine = emitNew + 1
      continue
    }
    break
  }
  return lines
}

function uncoveredLines(left: DifftasticHunk, right: DifftasticHunk): DifftasticHunkLine[] {
  const leftOld = lastNumber(left.lines, 'oldLine')
  const leftNew = lastNumber(left.lines, 'newLine')
  return right.lines.filter((line) => {
    if (line.oldLine != null && leftOld != null && line.oldLine <= leftOld) return false
    if (line.newLine != null && leftNew != null && line.newLine <= leftNew) return false
    return true
  })
}

function lastNumber(lines: DifftasticHunkLine[], key: 'oldLine' | 'newLine'): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const value = lines[index]![key]
    if (value != null) return value
  }
  return null
}

function firstNumber(lines: DifftasticHunkLine[], key: 'oldLine' | 'newLine'): number | null {
  for (const line of lines) {
    const value = line[key]
    if (value != null) return value
  }
  return null
}

function numericGap(left: number | null, right: number | null): number | null {
  if (left == null || right == null) return null
  return right - left - 1
}

function contextLine(
  oldLine: number | null,
  newLine: number | null,
  oldText: string | null,
  newText: string | null,
): DifftasticHunkLine {
  return {
    kind: 'context',
    oldLine,
    newLine,
    oldText,
    newText,
    oldSpans: [],
    newSpans: [],
  }
}

function toHunkLine(
  line: RawAlignedLine,
  oldLines: string[],
  newLines: string[],
): DifftasticHunkLine {
  const oldLine = line.lhs == null ? null : line.lhs.lineNumber + 1
  const newLine = line.rhs == null ? null : line.rhs.lineNumber + 1
  const oldText = oldLine == null ? null : lineText(oldLines, oldLine)
  const newText = newLine == null ? null : lineText(newLines, newLine)
  return {
    kind: lineKind(oldLine, newLine),
    oldLine,
    newLine,
    oldText,
    newText,
    oldSpans: line.lhs == null || oldText == null ? [] : toSpans(oldText, line.lhs.changes),
    newSpans: line.rhs == null || newText == null ? [] : toSpans(newText, line.rhs.changes),
  }
}

function lineKind(oldLine: number | null, newLine: number | null): DifftasticLineKind {
  if (oldLine != null && newLine != null) return 'change'
  if (oldLine != null) return 'delete'
  if (newLine != null) return 'insert'
  return 'context'
}

function wholeFileHunk(
  oldLines: string[] | null,
  newLines: string[] | null,
  kind: Exclude<DifftasticLineKind, 'change' | 'context'>,
): DifftasticHunk {
  const count = oldLines?.length ?? newLines?.length ?? 0
  return {
    lines: Array.from({ length: count }, (_, index) => ({
      kind,
      oldLine: oldLines == null ? null : index + 1,
      newLine: newLines == null ? null : index + 1,
      oldText: oldLines?.[index] ?? null,
      newText: newLines?.[index] ?? null,
      oldSpans: [],
      newSpans: [],
    })),
  }
}

function lineText(lines: string[], lineNumber: number): string {
  return lines[lineNumber - 1] ?? ''
}

function toSpans(text: string, changes: RawChange[]): DifftasticSpan[] {
  return changes
    .filter((change) => change.end > change.start || change.content.length > 0)
    .map((change) => ({
      start: utf8OffsetToUtf16(text, change.start),
      end: utf8OffsetToUtf16(text, change.end),
      content: change.content,
      highlight: change.highlight,
    }))
}

export function utf8OffsetToUtf16(text: string, utf8Offset: number): number {
  if (utf8Offset <= 0) return 0
  const encoder = new TextEncoder()
  let utf8 = 0
  for (let index = 0; index < text.length; ) {
    if (utf8 >= utf8Offset) return index
    const codePoint = text.codePointAt(index)
    if (codePoint == null) return index
    const width = codePoint > 0xffff ? 2 : 1
    utf8 += encoder.encode(text.slice(index, index + width)).length
    index += width
  }
  return text.length
}

function rangeLines(start: number, end: number): number[] {
  const lines: number[] = []
  for (let line = start; line <= end; line += 1) lines.push(line)
  return lines
}

function parseChunks(value: unknown): RawAlignedLine[][] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('difftastic chunks must be an array')
  return value.map((chunk, chunkIndex) => {
    if (!Array.isArray(chunk)) {
      throw new Error(`difftastic chunk ${chunkIndex} must be an array`)
    }
    return chunk.map((line, lineIndex) => parseAlignedLine(line, chunkIndex, lineIndex))
  })
}

function parseAlignedLine(value: unknown, chunkIndex: number, lineIndex: number): RawAlignedLine {
  const object = expectObject(value, `difftastic chunk ${chunkIndex} line ${lineIndex}`)
  return {
    lhs: object.lhs == null ? null : parseSide(object.lhs, 'lhs'),
    rhs: object.rhs == null ? null : parseSide(object.rhs, 'rhs'),
  }
}

function parseSide(value: unknown, label: string): RawSide {
  const object = expectObject(value, `difftastic ${label}`)
  const lineNumber = Number(object.line_number)
  if (!Number.isInteger(lineNumber) || lineNumber < 0) {
    throw new Error(`difftastic ${label} is missing a valid line_number`)
  }
  return {
    lineNumber,
    changes: parseChanges(object.changes, label),
  }
}

function parseChanges(value: unknown, label: string): RawChange[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error(`difftastic ${label} changes must be an array`)
  return value.map((change, index) => {
    const object = expectObject(change, `difftastic ${label} change ${index}`)
    const start = Number(object.start)
    const end = Number(object.end)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new Error(`difftastic ${label} change ${index} has an invalid range`)
    }
    const highlight = object.highlight
    return {
      start,
      end,
      content: typeof object.content === 'string' ? object.content : '',
      highlight: typeof highlight === 'string' && HIGHLIGHTS.has(highlight as DifftasticHighlight)
        ? highlight as DifftasticHighlight
        : 'normal',
    }
  })
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}
