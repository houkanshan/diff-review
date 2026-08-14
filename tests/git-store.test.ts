import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { afterAll, describe, expect, test } from 'vitest'

import {
  getRepositoryInfo,
  resolveCommitSpan,
  resolveTarget,
  validateAnnotationTarget,
} from '../src/server/git.js'
import { ReviewStore } from '../src/server/store.js'

const fixture = createGitFixture()

afterAll(() => {
  rmSync(fixture.directory, { recursive: true, force: true })
})

describe('Git review targets', () => {
  test('exposes the origin default branch comparison as a first-class range', async () => {
    const repository = await getRepositoryInfo(fixture.repository)

    expect(repository.defaultBranchRef).toBe('origin/main')
    expect(repository.branchRange).toBe('origin/main...HEAD')
  })

  test('resolves a merge-base range and lists only the first-parent timeline', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })

    expect(review.patch).toContain('feature one')
    expect(review.patch).toContain('from side')
    expect(review.commits.map((commit) => commit.subject)).toEqual([
      'feature one',
      'feature two',
      'merge side',
    ])
    expect(review.gitCommand).toBe("git diff 'origin/main...HEAD'")
  })

  test('can omit whitespace-only changes from a review', async () => {
    const review = await resolveTarget(
      fixture.repository,
      { kind: 'range', expression: 'origin/main...HEAD' },
      true,
    )

    expect(review.patch).not.toContain('spacing.txt')
    expect(review.patch).toContain('feature one')
    expect(review.gitCommand).toBe("git diff --ignore-all-space 'origin/main...HEAD'")
  })

  test('resolves a single selected commit against its first parent', async () => {
    const range = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const commit = range.commits[1]
    expect(commit).toBeDefined()

    const review = await resolveCommitSpan(fixture.repository, commit!.oid, commit!.oid)

    expect(review.patch).toContain('\n+feature two')
    expect(review.patch).not.toContain('\n+feature one')
    expect(review.commits).toHaveLength(1)
  })

  test('treats a lone revision as one commit rather than an implicit branch range', async () => {
    const range = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const commit = range.commits[0]!

    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: commit.oid,
    })

    expect(review.commits.map((item) => item.oid)).toEqual([commit.oid])
    expect(review.patch).toContain('\n+feature one')
    expect(review.patch).not.toContain('\n+feature two')
    expect(review.gitCommand).toMatch(/^git show /)
  })

  test('keeps unstaged, staged, and all-uncommitted targets distinct', async () => {
    const [unstaged, staged, worktree] = await Promise.all([
      resolveTarget(fixture.repository, { kind: 'unstaged' }),
      resolveTarget(fixture.repository, { kind: 'staged' }),
      resolveTarget(fixture.repository, { kind: 'worktree' }),
    ])

    expect(unstaged.patch).toContain('two edited')
    expect(unstaged.patch).not.toContain('staged content')
    expect(unstaged.patch).not.toContain('untracked content')

    expect(staged.patch).toContain('staged content')
    expect(staged.patch).toContain('deleted.txt')
    expect(staged.patch).not.toContain('two edited')

    expect(worktree.patch).toContain('two edited')
    expect(worktree.patch).toContain('staged content')
    expect(worktree.patch).toContain('untracked content')
  })

  test('validates ranges in new, old, deleted, and untracked file snapshots', async () => {
    const review = await resolveTarget(fixture.repository, { kind: 'worktree' })

    await expect(
      validateAnnotationTarget(fixture.repository, review, 'tracked.txt', 'new', 1, 1),
    ).resolves.toBeUndefined()
    await expect(
      validateAnnotationTarget(fixture.repository, review, 'deleted.txt', 'old', 1, 2),
    ).resolves.toBeUndefined()
    await expect(
      validateAnnotationTarget(fixture.repository, review, 'untracked.txt', 'new', 1, 1),
    ).resolves.toBeUndefined()
    await expect(
      validateAnnotationTarget(fixture.repository, review, 'tracked.txt', 'new', 99, 99),
    ).rejects.toThrow(/does not exist/)
  })
})

describe('local review storage', () => {
  test('preserves the full commit timeline while viewing a selected span', async () => {
    const review = await resolveTarget(fixture.repository, {
      kind: 'range',
      expression: 'origin/main...HEAD',
    })
    const databasePath = path.join(fixture.directory, 'store.db')
    const store = new ReviewStore(databasePath)
    const session = store.createSession(
      fixture.repository,
      'repo',
      { kind: 'range', expression: 'origin/main...HEAD' },
      review,
    )
    const selectedCommit = review.commits[1]!
    const selected = await resolveCommitSpan(
      fixture.repository,
      selectedCommit.oid,
      selectedCommit.oid,
    )

    const updated = store.updateResolvedReview(
      session.id,
      selected,
      selectedCommit.oid,
      selectedCommit.oid,
    )

    expect(updated.commits).toEqual(review.commits)
    expect(updated.selectedCommitStart).toBe(selectedCommit.oid)
    expect(updated.patch).toContain('feature two')
    expect(updated.ignoreWhitespace).toBe(false)

    expect(
      store.updateResolvedReview(
        session.id,
        selected,
        selectedCommit.oid,
        selectedCommit.oid,
        undefined,
        true,
      ).ignoreWhitespace,
    ).toBe(true)

    const annotation = store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'new',
      startLine: 5,
      endLine: 5,
      comment: 'The second feature change',
      source: 'agent',
    })
    expect(annotation.importance).toBeNull()
    expect(annotation.endSide).toBeNull()
    expect(annotation.archivedAt).toBeNull()
    expect(store.getSession(session.id).annotations).toEqual([annotation])

    const archived = store.setAnnotationArchived(session.id, annotation.id, true)
    expect(archived.archivedAt).not.toBeNull()
    expect(store.getSession(session.id).annotations[0]?.archivedAt).toBe(archived.archivedAt)

    const restored = store.setAnnotationArchived(session.id, annotation.id, false)
    expect(restored.archivedAt).toBeNull()

    const crossSide = store.addAnnotation(session.id, {
      filePath: 'tracked.txt',
      side: 'old',
      startLine: 4,
      endSide: 'new',
      endLine: 5,
      comment: 'The replacement as a whole',
      source: 'user',
    })
    expect(crossSide.endSide).toBe('new')

    expect(store.setFileViewed(session.id, 'tracked.txt', true).viewedFiles).toEqual([
      'tracked.txt',
    ])
    expect(store.setFileViewed(session.id, 'tracked.txt', true).viewedFiles).toEqual([
      'tracked.txt',
    ])
    expect(store.setFileViewed(session.id, 'tracked.txt', false).viewedFiles).toEqual([])

    const individuallyArchived = store.setAnnotationArchived(session.id, annotation.id, true)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const archiveAll = store.archiveAllAnnotations(session.id)
    expect(archiveAll.annotations).toHaveLength(2)
    expect(archiveAll.annotations.every((item) => item.archivedAt !== null)).toBe(true)
    expect(
      archiveAll.annotations.find((item) => item.id === annotation.id)?.updatedAt,
    ).toBe(individuallyArchived.updatedAt)
    expect(store.archiveAllAnnotations(session.id).annotations).toEqual(archiveAll.annotations)
  })

  test('migrates sessions created before commit timelines were stored separately', () => {
    const databasePath = path.join(fixture.directory, 'legacy.db')
    const database = new DatabaseSync(databasePath)
    database.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        repository_root TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        target_json TEXT NOT NULL,
        target_label TEXT NOT NULL,
        git_command TEXT NOT NULL,
        patch TEXT NOT NULL,
        resolved_json TEXT NOT NULL,
        selected_commit_start TEXT,
        selected_commit_end TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('old', 'new')),
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        comment TEXT,
        importance REAL,
        source TEXT NOT NULL CHECK(source IN ('user', 'agent')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const commit = {
      oid: 'a'.repeat(40),
      shortOid: 'aaaaaaaa',
      subject: 'legacy commit',
      author: 'Reviewer',
      authoredAt: '2026-01-01T00:00:00Z',
    }
    database
      .prepare(`
        INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        'drs_legacy',
        fixture.repository,
        'repo',
        JSON.stringify({ kind: 'range', expression: 'main..HEAD' }),
        'main..HEAD',
        "git diff 'main..HEAD'",
        '',
        JSON.stringify({
          label: 'main..HEAD',
          gitCommand: "git diff 'main..HEAD'",
          oldSnapshot: { kind: 'commit', id: 'b'.repeat(40) },
          newSnapshot: { kind: 'commit', id: commit.oid },
          commits: [commit],
        }),
        commit.oid,
        commit.oid,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      )
    database
      .prepare('INSERT INTO annotations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'ann_legacy',
        'drs_legacy',
        'tracked.txt',
        'new',
        5,
        5,
        'Legacy note',
        null,
        'agent',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
      )
    database.close()

    const store = new ReviewStore(databasePath)

    expect(store.getSession('drs_legacy').commits).toEqual([commit])
    expect(store.getSession('drs_legacy').viewedFiles).toEqual([])
    expect(store.getSession('drs_legacy').ignoreWhitespace).toBe(false)
    expect(store.getSession('drs_legacy').annotations).toMatchObject([
      { id: 'ann_legacy', endSide: null, archivedAt: null },
    ])
  })
})

function createGitFixture(): { directory: string; repository: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-'))
  const repository = path.join(directory, 'repo')
  const remote = path.join(directory, 'remote.git')
  mkdirSync(repository)
  git(repository, ['init', '-b', 'main'])
  git(repository, ['config', 'user.name', 'Diff Reviewer'])
  git(repository, ['config', 'user.email', 'reviewer@example.com'])

  writeFileSync(path.join(repository, 'tracked.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(repository, 'deleted.txt'), 'old\nremoved\n')
  writeFileSync(path.join(repository, 'spacing.txt'), 'const value = 1\n')
  git(repository, ['add', '.'])
  git(repository, ['commit', '-m', 'base'])

  git(directory, ['init', '--bare', '--initial-branch=main', remote])
  git(repository, ['remote', 'add', 'origin', remote])
  git(repository, ['push', '-u', 'origin', 'main'])
  git(repository, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])

  git(repository, ['switch', '-c', 'feature'])
  writeFileSync(path.join(repository, 'tracked.txt'), 'one\ntwo\nthree\nfeature one\n')
  writeFileSync(path.join(repository, 'spacing.txt'), 'const value  =  1\n')
  git(repository, ['add', 'tracked.txt', 'spacing.txt'])
  git(repository, ['commit', '-m', 'feature one'])

  git(repository, ['switch', '-c', 'side'])
  writeFileSync(path.join(repository, 'side.txt'), 'from side\n')
  git(repository, ['add', 'side.txt'])
  git(repository, ['commit', '-m', 'side branch commit'])

  git(repository, ['switch', 'feature'])
  writeFileSync(
    path.join(repository, 'tracked.txt'),
    'one\ntwo\nthree\nfeature one\nfeature two\n',
  )
  git(repository, ['add', 'tracked.txt'])
  git(repository, ['commit', '-m', 'feature two'])
  git(repository, ['merge', '--no-ff', 'side', '-m', 'merge side'])

  writeFileSync(path.join(repository, 'staged.txt'), 'staged content\n')
  git(repository, ['add', 'staged.txt'])
  git(repository, ['rm', 'deleted.txt'])
  writeFileSync(
    path.join(repository, 'tracked.txt'),
    'one\ntwo edited\nthree\nfeature one\nfeature two\n',
  )
  writeFileSync(path.join(repository, 'untracked.txt'), 'untracked content\n')

  return { directory, repository }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  })
}
