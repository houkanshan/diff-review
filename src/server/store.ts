import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  AddAnnotationInput,
  CommitSummary,
  PiReviewRun,
  PullRequestRevision,
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
  global_comment: string | null
  viewed_files_json: string
  ignore_whitespace: number
  revision_base_oid: string | null
  revision_head_oid: string | null
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
  intent: 'annotation' | 'review-comment'
  archived_at: string | null
  submitted_at: string | null
  created_at: string
  updated_at: string
}

interface PiReviewRunRow {
  id: string
  session_id: string
  worktree_path: string
  pi_session_dir: string
  pi_session_id: string
  pi_session_path: string | null
  state: PiReviewRun['state']
  active_pid: number | null
  keep: number
  error: string | null
  started_at: string
  completed_at: string | null
  last_used_at: string
  cleanup_eligible_at: string
  cleaned_at: string | null
}

export class ReviewStore {
  private readonly database: DatabaseSync
  private readonly databasePath: string

  constructor(databasePath = defaultDatabasePath()) {
    this.databasePath = databasePath
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
        global_comment TEXT,
        viewed_files_json TEXT NOT NULL DEFAULT '[]',
        ignore_whitespace INTEGER NOT NULL DEFAULT 0,
        revision_base_oid TEXT,
        revision_head_oid TEXT,
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
        intent TEXT NOT NULL DEFAULT 'annotation' CHECK(intent IN ('annotation', 'review-comment')),
        archived_at TEXT,
        submitted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pi_review_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        worktree_path TEXT NOT NULL,
        pi_session_dir TEXT NOT NULL,
        pi_session_id TEXT NOT NULL,
        pi_session_path TEXT,
        state TEXT NOT NULL CHECK(state IN (
          'creating', 'running', 'completed', 'failed', 'interrupted',
          'cleaning', 'cleanup-blocked', 'cleaned'
        )),
        active_pid INTEGER,
        keep INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        last_used_at TEXT NOT NULL,
        cleanup_eligible_at TEXT NOT NULL,
        cleaned_at TEXT
      );

      CREATE INDEX IF NOT EXISTS annotations_session_id ON annotations(session_id);
      CREATE INDEX IF NOT EXISTS sessions_repository_root ON sessions(repository_root);
      CREATE INDEX IF NOT EXISTS pi_review_runs_session_latest
        ON pi_review_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS pi_review_runs_cleanup
        ON pi_review_runs(keep, state, cleanup_eligible_at);
    `)
    this.migrateSessionsTable()
    this.migrateAnnotationsTable()
  }

  get dataDirectory(): string {
    return path.dirname(this.databasePath)
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
    const revision = target.kind === 'pr' ? revisionFromResolved(resolved) : null
    this.database
      .prepare(`
        INSERT INTO sessions (
          id, repository_root, repository_name, target_json, target_label,
          git_command, patch, resolved_json, available_commits_json,
          selected_commit_start, selected_commit_end, revision_base_oid,
          revision_head_oid, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        revision?.baseOid ?? null,
        revision?.headOid ?? null,
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

  findPullRequestRevision(
    repositoryRoot: string,
    number: number,
    baseOid: string,
    headOid: string,
  ): ReviewSession | null {
    const rows = this.database
      .prepare(`
        SELECT * FROM sessions
        WHERE repository_root = ? AND revision_base_oid = ? AND revision_head_oid = ?
        ORDER BY updated_at DESC
      `)
      .all(repositoryRoot, baseOid, headOid) as unknown as SessionRow[]
    const row = rows.find((candidate) => {
      const target = JSON.parse(candidate.target_json) as ReviewTarget
      return target.kind === 'pr' && target.number === number
    })
    return row == null ? null : this.sessionFromRow(row)
  }

  listPullRequestRevisions(repositoryRoot: string, number: number): PullRequestRevision[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM sessions
        WHERE repository_root = ? AND revision_base_oid IS NOT NULL AND revision_head_oid IS NOT NULL
        ORDER BY created_at DESC
      `)
      .all(repositoryRoot) as unknown as SessionRow[]
    const revisions = new Map<string, PullRequestRevision>()
    for (const row of rows) {
      const target = JSON.parse(row.target_json) as ReviewTarget
      if (target.kind !== 'pr' || target.number !== number) continue
      const baseOid = row.revision_base_oid
      const headOid = row.revision_head_oid
      if (baseOid == null || headOid == null) continue
      const key = `${baseOid}:${headOid}`
      const candidate = {
        sessionId: row.id,
        baseOid,
        headOid,
        annotationCount: this.annotationsForSession(row.id).length,
        createdAt: row.created_at,
      }
      const existing = revisions.get(key)
      if (existing == null || candidate.annotationCount > existing.annotationCount) {
        revisions.set(key, candidate)
      }
    }
    return [...revisions.values()]
  }

  getSession(id: string): ReviewSession {
    const row = this.database
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as unknown as SessionRow | undefined
    if (row == null) throw new AppError('SESSION_NOT_FOUND', `Review session not found: ${id}`, 404)
    return this.sessionFromRow(row)
  }

  createPiReviewRun(
    sessionId: string,
    worktreePath: string,
    piSessionDir: string,
    piSessionId: string,
    cleanupEligibleAt: string,
  ): PiReviewRun {
    this.getSession(sessionId)
    const id = createId('pir')
    const now = new Date().toISOString()
    this.database
      .prepare(`
        INSERT INTO pi_review_runs (
          id, session_id, worktree_path, pi_session_dir, pi_session_id, pi_session_path,
          state, active_pid, keep, error, started_at, completed_at, last_used_at,
          cleanup_eligible_at, cleaned_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        sessionId,
        worktreePath,
        piSessionDir,
        piSessionId,
        null,
        'creating',
        null,
        0,
        null,
        now,
        null,
        now,
        cleanupEligibleAt,
        null,
      )
    return this.getPiReviewRun(id)!
  }

  getPiReviewRun(runId: string): PiReviewRun | null {
    const row = this.database
      .prepare('SELECT * FROM pi_review_runs WHERE id = ?')
      .get(runId) as unknown as PiReviewRunRow | undefined
    return row == null ? null : piReviewRunFromRow(row)
  }

  latestPiReviewRun(sessionId: string): PiReviewRun | null {
    const row = this.database
      .prepare(`
        SELECT * FROM pi_review_runs
        WHERE session_id = ?
        ORDER BY started_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(sessionId) as unknown as PiReviewRunRow | undefined
    return row == null ? null : piReviewRunFromRow(row)
  }

  listPiReviewRunsEligibleForCleanup(now: string): PiReviewRun[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM pi_review_runs
        WHERE keep = 0
          AND state IN ('completed', 'failed', 'interrupted', 'cleaning', 'cleanup-blocked')
          AND cleanup_eligible_at <= ?
        ORDER BY cleanup_eligible_at ASC
      `)
      .all(now) as unknown as PiReviewRunRow[]
    return rows.map(piReviewRunFromRow)
  }

  listActivePiReviewRuns(): PiReviewRun[] {
    const rows = this.database
      .prepare("SELECT * FROM pi_review_runs WHERE state IN ('creating', 'running')")
      .all() as unknown as PiReviewRunRow[]
    return rows.map(piReviewRunFromRow)
  }

  claimPiReviewRunForCleanup(runId: string): PiReviewRun | null {
    const result = this.database
      .prepare(`
        UPDATE pi_review_runs
        SET state = 'cleaning', error = NULL
        WHERE id = ?
          AND keep = 0
          AND active_pid IS NULL
          AND state IN ('completed', 'failed', 'interrupted', 'cleaning', 'cleanup-blocked')
      `)
      .run(runId)
    return result.changes === 0 ? null : this.getPiReviewRun(runId)
  }

  updatePiReviewRun(
    runId: string,
    patch: Partial<
      Pick<
        PiReviewRun,
        | 'piSessionPath'
        | 'state'
        | 'activePid'
        | 'keep'
        | 'error'
        | 'completedAt'
        | 'lastUsedAt'
        | 'cleanupEligibleAt'
        | 'cleanedAt'
      >
    >,
  ): PiReviewRun {
    const fields: string[] = []
    const values: (string | number | null)[] = []
    const add = (key: keyof typeof patch, column: string, value: string | number | null): void => {
      if (!(key in patch)) return
      fields.push(`${column} = ?`)
      values.push(value)
    }
    add('piSessionPath', 'pi_session_path', patch.piSessionPath ?? null)
    add('state', 'state', patch.state ?? null)
    add('activePid', 'active_pid', patch.activePid ?? null)
    add('keep', 'keep', patch.keep == null ? null : Number(patch.keep))
    add('error', 'error', patch.error ?? null)
    add('completedAt', 'completed_at', patch.completedAt ?? null)
    add('lastUsedAt', 'last_used_at', patch.lastUsedAt ?? null)
    add('cleanupEligibleAt', 'cleanup_eligible_at', patch.cleanupEligibleAt ?? null)
    add('cleanedAt', 'cleaned_at', patch.cleanedAt ?? null)

    if (fields.length === 0) {
      const run = this.getPiReviewRun(runId)
      if (run == null) throw piReviewRunNotFound(runId)
      return run
    }
    const result = this.database
      .prepare(`UPDATE pi_review_runs SET ${fields.join(', ')} WHERE id = ?`)
      .run(...values, runId)
    if (result.changes === 0) throw piReviewRunNotFound(runId)
    return this.getPiReviewRun(runId)!
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
          comment, importance, source, intent, archived_at, submitted_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.source === 'user' ? input.intent ?? 'annotation' : 'annotation',
        null,
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
        WHERE id = ? AND session_id = ? AND (? = 1 OR submitted_at IS NULL)
      `)
      .run(archived ? now : null, now, annotationId, sessionId, Number(archived))
    if (result.changes === 0) {
      throw new AppError('ANNOTATION_NOT_FOUND', `Annotation not found: ${annotationId}`, 404)
    }
    return this.getAnnotation(annotationId)
  }

  markAnnotationsSubmitted(sessionId: string, annotationIds: string[]): void {
    this.getSession(sessionId)
    if (annotationIds.length === 0) return
    const now = new Date().toISOString()
    const placeholders = annotationIds.map(() => '?').join(', ')
    this.database
      .prepare(`
        UPDATE annotations
        SET submitted_at = ?, archived_at = ?, updated_at = ?
        WHERE session_id = ? AND id IN (${placeholders})
          AND source = 'user' AND intent = 'review-comment' AND submitted_at IS NULL
      `)
      .run(now, now, now, sessionId, ...annotationIds)
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
        WHERE id = ? AND session_id = ? AND source = 'user' AND submitted_at IS NULL
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

  setGlobalComment(sessionId: string, comment: string): ReviewSession {
    const result = this.database
      .prepare('UPDATE sessions SET global_comment = ?, updated_at = ? WHERE id = ?')
      .run(comment, new Date().toISOString(), sessionId)
    if (result.changes === 0) {
      throw new AppError('SESSION_NOT_FOUND', `Review session not found: ${sessionId}`, 404)
    }
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
    if (!columns.some((column) => column.name === 'global_comment')) {
      this.database.exec('ALTER TABLE sessions ADD COLUMN global_comment TEXT')
    }
    if (!columns.some((column) => column.name === 'revision_base_oid')) {
      this.database.exec('ALTER TABLE sessions ADD COLUMN revision_base_oid TEXT')
    }
    if (!columns.some((column) => column.name === 'revision_head_oid')) {
      this.database.exec('ALTER TABLE sessions ADD COLUMN revision_head_oid TEXT')
    }
    const rows = this.database
      .prepare(`
        SELECT id, target_json, resolved_json, revision_base_oid, revision_head_oid
        FROM sessions
        WHERE revision_base_oid IS NULL OR revision_head_oid IS NULL
      `)
      .all() as unknown as Pick<
        SessionRow,
        'id' | 'target_json' | 'resolved_json' | 'revision_base_oid' | 'revision_head_oid'
      >[]
    const updateRevision = this.database.prepare(
      'UPDATE sessions SET revision_base_oid = ?, revision_head_oid = ? WHERE id = ?',
    )
    for (const row of rows) {
      const target = JSON.parse(row.target_json) as ReviewTarget
      if (target.kind !== 'pr') continue
      const revision = revisionFromResolved(JSON.parse(row.resolved_json) as ResolvedReview)
      if (revision != null) updateRevision.run(revision.baseOid, revision.headOid, row.id)
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
    if (!columns.some((column) => column.name === 'intent')) {
      this.database.exec(
        "ALTER TABLE annotations ADD COLUMN intent TEXT NOT NULL DEFAULT 'annotation' CHECK(intent IN ('annotation', 'review-comment'))",
      )
    }
    if (!columns.some((column) => column.name === 'submitted_at')) {
      this.database.exec('ALTER TABLE annotations ADD COLUMN submitted_at TEXT')
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
      globalComment: row.global_comment,
      viewedFiles: JSON.parse(row.viewed_files_json) as string[],
      ignoreWhitespace: row.ignore_whitespace === 1,
      revisionBaseOid: row.revision_base_oid,
      revisionHeadOid: row.revision_head_oid,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

function piReviewRunFromRow(row: PiReviewRunRow): PiReviewRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    worktreePath: row.worktree_path,
    piSessionDir: row.pi_session_dir,
    piSessionId: row.pi_session_id,
    piSessionPath: row.pi_session_path,
    state: row.state,
    activePid: row.active_pid,
    keep: row.keep === 1,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastUsedAt: row.last_used_at,
    cleanupEligibleAt: row.cleanup_eligible_at,
    cleanedAt: row.cleaned_at,
  }
}

function piReviewRunNotFound(runId: string): AppError {
  return new AppError('PI_REVIEW_RUN_NOT_FOUND', `Pi review run not found: ${runId}`, 404)
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
    intent: row.intent,
    archivedAt: row.archived_at,
    submittedAt: row.submitted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function withoutPatch(resolved: ResolvedReview): Omit<ResolvedReview, 'patch'> {
  const { patch: _, ...rest } = resolved
  return rest
}

function revisionFromResolved(
  resolved: Pick<ResolvedReview, 'oldSnapshot' | 'newSnapshot'>,
): { baseOid: string; headOid: string } | null {
  if (resolved.oldSnapshot.kind !== 'commit' || resolved.newSnapshot.kind !== 'commit') return null
  return { baseOid: resolved.oldSnapshot.id, headOid: resolved.newSnapshot.id }
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function defaultDatabasePath(): string {
  const dataDirectory =
    process.env.DIFF_REVIEW_DATA_DIR ?? path.join(homedir(), '.diff-review')
  return path.join(dataDirectory, 'reviews.db')
}
