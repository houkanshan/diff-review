import type { CommitSummary } from '../shared/types'
import { CommitStatsLabel } from './CommitStatsLabel'
import { formatTimestamp, relativeTime } from './time'

export function PullRequestCommits({
  commits,
  pullRequestUrl,
}: {
  commits: CommitSummary[]
  pullRequestUrl: string
}) {
  if (commits.length === 0) return null

  const newestFirst = [...commits].reverse()
  const collapsed = newestFirst.length > 10
  const middle = collapsed ? newestFirst.slice(5, -5) : []
  const renderCommit = (commit: CommitSummary) => (
    <li className="pr-sidebar-commit" key={commit.oid}>
      <p className="pr-sidebar-commit-message" title={commit.subject}>{commit.subject}</p>
      <div className="pr-sidebar-commit-meta">
        <a href={`${pullRequestUrl}/commits/${commit.oid}`} target="_blank" rel="noreferrer" title={commit.oid}>
          <code>{commit.shortOid}</code>
        </a>
        <span className="pr-sidebar-commit-author" title={commit.author}>{commit.author}</span>
        <CommitStatsLabel commit={commit} />
        {commit.authoredAt !== '' && (
          <time dateTime={commit.authoredAt} title={formatTimestamp(commit.authoredAt)}>
            {relativeTime(commit.authoredAt)}
          </time>
        )}
      </div>
    </li>
  )

  return (
    <section className="pr-sidebar-section pr-sidebar-commits-section" aria-label="Pull request commits">
      <h2>Commits <span>{commits.length}</span></h2>
      <ol className="pr-sidebar-commit-list">
        {(collapsed ? newestFirst.slice(0, 5) : newestFirst).map(renderCommit)}
        {collapsed && (
          <li>
            <details className="pr-sidebar-commit-middle">
              <summary>
                <span className="pr-commits-expand">Show {middle.length} more {middle.length === 1 ? 'commit' : 'commits'}</span>
                <span className="pr-commits-collapse">Hide middle commits</span>
              </summary>
              <ol className="pr-sidebar-commit-list">{middle.map(renderCommit)}</ol>
            </details>
          </li>
        )}
        {collapsed && newestFirst.slice(-5).map(renderCommit)}
      </ol>
    </section>
  )
}
