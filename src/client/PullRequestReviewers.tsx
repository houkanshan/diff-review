import { Popover } from '@base-ui/react/popover'
import { useQuery } from '@tanstack/react-query'
import { Pencil } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { GitHubReviewer } from '../shared/types'
import { getReviewerCandidates } from './api'

function reviewerKey(reviewer: Pick<GitHubReviewer, 'kind' | 'login'>): string {
  return `${reviewer.kind}:${reviewer.login.toLowerCase()}`
}

/** Team logins may be `org/slug` or bare `slug`; compare by slug. */
export function reviewerIdentity(reviewer: Pick<GitHubReviewer, 'kind' | 'login'>): string {
  return reviewer.kind === 'team'
    ? `team:${reviewer.login.slice(reviewer.login.lastIndexOf('/') + 1).toLowerCase()}`
    : reviewerKey(reviewer)
}

export function reviewerOptions(
  candidates: GitHubReviewer[],
  current: GitHubReviewer[],
  search: string,
): GitHubReviewer[] {
  // Current reviewers stay listed (and removable) even when the search omits them.
  const choices = new Map<string, GitHubReviewer>()
  for (const reviewer of current) choices.set(reviewerIdentity(reviewer), reviewer)
  for (const candidate of candidates) {
    const identity = reviewerIdentity(candidate)
    if (!choices.has(identity)) choices.set(identity, candidate)
  }
  const needle = search.trim().toLowerCase()
  return [...choices.values()]
    .filter((reviewer) => needle === '' ||
      reviewer.login.toLowerCase().includes(needle) ||
      (reviewer.name ?? '').toLowerCase().includes(needle))
    .sort((left, right) =>
      Number(right.requested) - Number(left.requested) ||
      Number(right.reviewStatus !== 'none') - Number(left.reviewStatus !== 'none') ||
      left.login.localeCompare(right.login))
}

export function PullRequestReviewers({
  repositoryPath,
  reviewers,
  onSetReviewer,
  renderReviewer,
}: {
  repositoryPath: string
  reviewers: GitHubReviewer[]
  onSetReviewer(reviewer: GitHubReviewer, requested: boolean): Promise<void>
  renderReviewer(reviewer: GitHubReviewer): ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  const candidates = useQuery({
    queryKey: ['reviewer-candidates', repositoryPath, debouncedSearch.toLowerCase()],
    queryFn: () => getReviewerCandidates(repositoryPath, debouncedSearch),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: (previous) => previous,
  })
  const visible = reviewerOptions(candidates.data ?? [], reviewers, search)

  const setReviewer = async (reviewer: GitHubReviewer, requested: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await onSetReviewer(reviewer, requested)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pr-sidebar-section pr-sidebar-reviewers-section" aria-label="Pull request reviewers">
      <Popover.Root open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          setSearch('')
          setDebouncedSearch('')
        }
      }}>
        <div className="pr-label-section-heading">
          <h2>Reviewers</h2>
          <Popover.Trigger className="pr-edit-text-button" aria-label="Edit reviewers" title="Edit reviewers">
            <Pencil size={16} />
          </Popover.Trigger>
        </div>
        <Popover.Portal>
          <Popover.Positioner sideOffset={8} align="end" className="popup-positioner">
            <Popover.Popup className="pr-label-popover pr-reviewer-popover">
              <Popover.Title>Request reviewers</Popover.Title>
              <input
                type="search"
                aria-label="Search reviewers"
                placeholder="Search users and teams…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {candidates.isPending && <p role="status">Loading reviewers…</p>}
              {candidates.isError && (
                <p role="alert">
                  {candidates.error.message}{' '}
                  <button type="button" onClick={() => void candidates.refetch()}>Retry</button>
                </p>
              )}
              <div className="pr-label-options" aria-busy={busy}>
                {visible.map((reviewer) => (
                  <label key={reviewerKey(reviewer)}>
                    <input
                      type="checkbox"
                      checked={reviewer.requested}
                      disabled={busy}
                      onChange={(event) => void setReviewer(reviewer, event.target.checked)}
                    />
                    {renderReviewer(reviewer)}
                  </label>
                ))}
                {visible.length === 0 && !candidates.isPending && !candidates.isError && (
                  <p>{search ? 'No matching users or teams' : 'No reviewers available'}</p>
                )}
              </div>
              {busy && <p role="status">Updating reviewers…</p>}
              {error != null && <p role="alert">{error}</p>}
              <p className="pr-label-hint">
                Checking someone who already reviewed re-requests their review. Changes apply immediately.
              </p>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      {reviewers.length === 0
        ? <p className="pr-sidebar-empty">No reviewers</p>
        : (
            <div className="pr-sidebar-people">
              {reviewers.map((reviewer) => (
                <div className="pr-sidebar-person" key={reviewerKey(reviewer)}>
                  {renderReviewer(reviewer)}
                </div>
              ))}
            </div>
          )}
      {error != null && !open && <p role="alert">{error}</p>}
    </section>
  )
}
