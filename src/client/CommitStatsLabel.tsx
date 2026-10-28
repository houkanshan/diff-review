import type { CommitSummary } from '../shared/types'

/** Per-commit `+N −N`; renders nothing for legacy sessions without stats. */
export function CommitStatsLabel({ commit }: { commit: CommitSummary }) {
  const stats = commit.stats
  if (stats == null) return null
  return (
    <span
      className="commit-stats"
      title={`${stats.additions} ${stats.additions === 1 ? 'line' : 'lines'} added, ${stats.deletions} ${stats.deletions === 1 ? 'line' : 'lines'} deleted`}
    >
      <span className="addition">+{stats.additions}</span>{' '}
      <span className="deletion">−{stats.deletions}</span>
    </span>
  )
}
