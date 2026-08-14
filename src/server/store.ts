import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AddAnnotationInput,
  CommitSummary,
  ReviewSession,
  ReviewTarget,
  SessionAnnotation,
} from '../shared/types.js'
import type { ResolvedReview } from './git.js'
import { AppError } from './errors.js'

interface SessionRow {
  id: string
  repository_root: string
  repository_name: string
  target_json: string
  target_label: string
  git_command: string
  patch: string
  resolved_json: string
  available_commits_json: string
  selected_commit_start: string | null
  selected_commit_end: string | null
  viewed_files_json: string
  ignore_whitespace: number
  created_at: string
  updated_at: string
}

interface AnnotationRow {
  id: string
  session_id: string
  file_path: string
  side: 'old' | 'new'
  start_line: number
  end_side: 'old' | 'new' | null
  end_line: number
  comment: string | null
  importance: number | null
  source: 'user' | 'agent'
  archived_at: string | null
  created_at: string
  updated_at: string
}

export class ReviewStore {
  private readonly database: DatabaseSync

  constructor(databasePath = defaultDatabasePath()) {
    mkdirSync(path.dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        repository_root TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        target_json TEXT NOT NULL,
        target_label TEXT NOT NULL,
        git_command TEXT NOT NULL,
        patch TEXT NOT NULL,
        resolved_json TEXT NOT NULL,
        available_commits_json TEXT NOT NULL,
        selected_commit_start TEXT,
        selected_commit_end TEXT,
        viewed_files_json TEXT NOT NULL DEFAULT '[]',
        ignore_whitespace INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS annotations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('old', 'new')),
        start_line INTEGER NOT NULL,
        end_side TEXT CHECK(end_side IN ('old', 'new')),
        end_line INTEGER NOT NULL,
        comment TEXT,
        importance REAL,
        source TEXT NOT NULL CHECK(source IN ('user', 'agent')),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS annotations_session_id ON annotations(session_id);
      CREATE INDEX IF NOT EXISTS sessions_repository_root ON sessions(repository_root);
    `)
    this.migrateSessionsTable()
    this.migrateAnnotationsTable()
  }

  createSession(
    repositoryRoot: string,
    repositoryName: string,
    target: ReviewTarget,
    resolved: ResolvedReview,
  ): ReviewSession {
    const id = createId('drs')
    const now = new Date().toISOString()
    const start = resolved.commits.at(0)?.oid ?? null
    const end = resolved.commits.at(-1)?.oid ?? null
    this.database
      .prepare(`
        INSERT INTO sessions (
          id, repository_root, repository_name, target_json, target_label,
          git_command, patch, resolved_json, available_commits_json,
          selected_commit_start, selected_commit_end, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        repositoryRoot,
        repositoryName,
        JSON.stringify(target),
        resolved.label,
        resolved.gitCommand,
        resolved.patch,
        JSON.stringify(withoutPatch(resolved)),
        JSON.stringify(resolved.commits),
        start,
        end,
        now,
        now,
      )
    return this.getSession(id)
  }

  listSessions(repositoryRoot?: string): ReviewSession[] {
    const rows = repositoryRoot
      ? (this.database
          .prepare('SELECT * FROM sessions WHERE repository_root = ? ORDER BY updated_at DESC')
          .all(repositoryRoot) as unknown as SessionRow[])
      : (this.database
          .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 50')
          .all() as unknown as SessionRow[])
    return rows.map((row) => this.sessionFromRow(row))
  }

  getSession(id: string): ReviewSession {
    const row = this.database
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as unknown as SessionRow | undefined
    if (row == null) throw new AppError('SESSION_NOT_FOUND', `Review session not found: ${id}`, 404)
    return this.sessionFromRow(row)
  }

  getResolvedReview(id: string): ResolvedReview {
    const row = this.database
      .prepare('SELECT resolved_json, patch FROM sessions WHERE id = ?')
      .get(id) as unknown as { resolved_json: string; patch: string } | undefined
    if (row == null) throw new AppError('SESSION_NOT_FOUND', `Review session not found: ${id}`, 404)
    return { ...(JSON.parse(row.resolved_json) as Omit<ResolvedReview, 'patch'>), patch: row.patch }
  }

  updateResolvedReview(
    id: string,
    resolved: ResolvedReview,
    selectedStart: string | null,
    selectedEnd: string | null,
    availableCommits?: CommitSummary[],
    ignoreWhitespace?: boolean,
  ): ReviewSession {
    const now = new Date().toISOString()
    const result = this.database
      .prepare(`
        UPDATE sessions
        SET target_label = ?, git_command = ?, patch = ?, resolved_json = ?,
            available_commits_json = COALESCE(?, available_commits_json),
            selected_commit_start = ?, selected_commit_end = ?,
            ignore_whitespace = COALESCE(?, ignore_whitespace), updated_at = ?
        WHERE id = ?
      `)
      .run(
        resolved.label,
        resolved.gitCommand,
        resolved.patch,
        JSON.stringify(withoutPatch(resolved)),
        availableCommits == null ? null : JSON.stringify(availableCommits),
        selectedStart,
        selectedEnd,
        ignoreWhitespace == null ? null : Number(ignoreWhitespace),
        now,
        id,
      )
    if (result.changes === 0) {
      throw new AppError('SESSION_NOT_FOUND', `Review session not found: ${id}`, 404)
    }
    return this.getSession(id)
  }

  addAnnotation(sessionId: string, input: AddAnnotationInput): SessionAnnotation {
    this.getSession(sessionId)
    const id = createId('ann')
    const now = new Date().toISOString()
    this.database
      .prepare(`
        INSERT INTO annotations (
          id, session_id, file_path, side, start_line, end_side, end_line,
          comment, importance, source, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        sessionId,
        input.filePath,
        input.side,
        input.startLine,
        input.endSide ?? null,
        input.endLine,
        input.comment ?? null,
        input.importance ?? null,
        input.source,
        null,
        now,
        now,
      )
    return this.getAnnotation(id)
  }

  setAnnotationArchived(
    sessionId: string,
    annotationId: string,
    archived: boolean,
  ): SessionAnnotation {
    const now = new Date().toISOString()
    const result = this.database
      .prepare(`
        UPDATE annotations
        SET archived_at = ?, updated_at = ?
        WHERE id = ? AND session_id = ?
      `)
      .run(archived ? now : null, now, annotationId, sessionId)
    if (result.changes === 0) {
      throw new AppError('ANNOTATION_NOT_FOUND', `Annotation not found: ${annotationId}`, 404)
    }
    return this.getAnnotation(annotationId)
  }

  updateAnnotationComment(
    sessionId: string,
    annotationId: string,
    comment: string,
  ): SessionAnnotation {
    const result = this.database
      .prepare(`
        UPDATE annotations
        SET comment = ?, updated_at = ?
        WHERE id = ? AND session_id = ? AND source = 'user'
      `)
      .run(comment, new Date().toISOString(), annotationId, sessionId)
    if (result.changes === 0) {
      throw new AppError(
        'ANNOTATION_NOT_EDITABLE',
        `User annotation not found: ${annotationId}`,
        404,
      )
    }
    return this.getAnnotation(annotationId)
  }

  archiveAllAnnotations(sessionId: string): ReviewSession {
    this.getSession(sessionId)
    const now = new Date().toISOString()
    this.database
      .prepare(`
        UPDATE annotations
        SET archived_at = ?, updated_at = ?
        WHERE session_id = ? AND archived_at IS NULL
      `)
      .run(now, now, sessionId)
    return this.getSession(sessionId)
  }

  setFileViewed(sessionId: string, filePath: string, viewed: boolean): ReviewSession {
    const session = this.getSession(sessionId)
    const viewedFiles = new Set(session.viewedFiles)
    if (viewed) viewedFiles.add(filePath)
    else viewedFiles.delete(filePath)
    this.database
      .prepare('UPDATE sessions SET viewed_files_json = ? WHERE id = ?')
      .run(JSON.stringify([...viewedFiles]), sessionId)
    return this.getSession(sessionId)
  }

  deleteAnnotation(sessionId: string, annotationId: string): void {
    const result = this.database
      .prepare('DELETE FROM annotations WHERE id = ? AND session_id = ?')
      .run(annotationId, sessionId)
    if (result.changes === 0) {
      throw new AppError('ANNOTATION_NOT_FOUND', `Annotation not found: ${annotationId}`, 404)
    }
  }

  private getAnnotation(id: string): SessionAnnotation {
    const row = this.database
      .prepare('SELECT * FROM annotations WHERE id = ?')
      .get(id) as unknown as AnnotationRow | undefined
    if (row == null) throw new AppError('ANNOTATION_NOT_FOUND', `Annotation not found: ${id}`, 404)
    return annotationFromRow(row)
  }

  private annotationsForSession(sessionId: string): SessionAnnotation[] {
    const rows = this.database
      .prepare('SELECT * FROM annotations WHERE session_id = ? ORDER BY created_at ASC')
      .all(sessionId) as unknown as AnnotationRow[]
    return rows.map(annotationFromRow)
  }

  private migrateSessionsTable(): void {
    const columns = this.database
      .prepare('PRAGMA table_info(sessions)')
      .all() as unknown as { name: string }[]
    if (!columns.some((column) => column.name === 'available_commits_json')) {
      this.database.exec(
        "ALTER TABLE sessions ADD COLUMN available_commits_json TEXT NOT NULL DEFAULT '[]'",
      )
      const rows = this.database
        .prepare('SELECT id, resolved_json FROM sessions')
        .all() as unknown as { id: string; resolved_json: string }[]
      const update = this.database.prepare(
        'UPDATE sessions SET available_commits_json = ? WHERE id = ?',
      )
      for (const row of rows) {
        const resolved = JSON.parse(row.resolved_json) as Partial<ResolvedReview>
        update.run(JSON.stringify(resolved.commits ?? []), row.id)
      }
    }
    if (!columns.some((column) => column.name === 'viewed_files_json')) {
      this.database.exec(
        "ALTER TABLE sessions ADD COLUMN viewed_files_json TEXT NOT NULL DEFAULT '[]'",
      )
    }
    if (!columns.some((column) => column.name === 'ignore_whitespace')) {
      this.database.exec(
        'ALTER TABLE sessions ADD COLUMN ignore_whitespace INTEGER NOT NULL DEFAULT 0',
      )
    }
  }

  private migrateAnnotationsTable(): void {
    const columns = this.database
      .prepare('PRAGMA table_info(annotations)')
      .all() as unknown as { name: string }[]
    if (!columns.some((column) => column.name === 'end_side')) {
      this.database.exec(
        "ALTER TABLE annotations ADD COLUMN end_side TEXT CHECK(end_side IN ('old', 'new'))",
      )
    }
    if (!columns.some((column) => column.name === 'archived_at')) {
      this.database.exec('ALTER TABLE annotations ADD COLUMN archived_at TEXT')
    }
  }

  private sessionFromRow(row: SessionRow): ReviewSession {
    const resolved = JSON.parse(row.resolved_json) as Omit<ResolvedReview, 'patch'>
    return {
      id: row.id,
      repositoryRoot: row.repository_root,
      repositoryName: row.repository_name,
      target: JSON.parse(row.target_json) as ReviewTarget,
      targetLabel: row.target_label,
      gitCommand: row.git_command,
      patch: row.patch,
      commits: JSON.parse(row.available_commits_json) as ReviewSession['commits'],
      selectedCommitStart: row.selected_commit_start,
      selectedCommitEnd: row.selected_commit_end,
      annotations: this.annotationsForSession(row.id),
      viewedFiles: JSON.parse(row.viewed_files_json) as string[],
      ignoreWhitespace: row.ignore_whitespace === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

function annotationFromRow(row: AnnotationRow): SessionAnnotation {
  return {
    id: row.id,
    sessionId: row.session_id,
    filePath: row.file_path,
    side: row.side,
    startLine: row.start_line,
    endSide: row.end_side,
    endLine: row.end_line,
    comment: row.comment,
    importance: row.importance,
    source: row.source,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function withoutPatch(resolved: ResolvedReview): Omit<ResolvedReview, 'patch'> {
  const { patch: _, ...rest } = resolved
  return rest
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function defaultDatabasePath(): string {
  const dataDirectory =
    process.env.DIFF_REVIEW_DATA_DIR ?? path.join(homedir(), '.diff-review')
  return path.join(dataDirectory, 'reviews.db')
}
