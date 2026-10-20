import { Popover } from '@base-ui/react/popover'
import { useQuery } from '@tanstack/react-query'
import { useState, type CSSProperties } from 'react'
import type { GitHubLabel } from '../shared/types'
import { getRepositoryLabels } from './api'

export function PullRequestLabels({
  repositoryPath,
  labels,
  onSetLabel,
}: {
  repositoryPath: string
  labels: GitHubLabel[]
  onSetLabel(label: GitHubLabel, selected: boolean): Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = useQuery({
    queryKey: ['repository-labels', repositoryPath],
    queryFn: () => getRepositoryLabels(repositoryPath),
    enabled: open,
    staleTime: 5 * 60_000,
    retry: false,
  })
  // Keep assigned labels removable even if the repository catalog is stale.
  const choices = new Map((available.data ?? []).map((label) => [label.name, label]))
  for (const label of labels) choices.set(label.name, label)
  const visible = [...choices.values()]
    .filter((label) => label.name.toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name))
  const additionalReviewLabel = labels.find((label) => label.name === 'additional-review-needed')

  const setLabel = async (label: GitHubLabel, selected: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await onSetLabel(label, selected)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {error != null && !open && <span role="alert">{error}</span>}
      {additionalReviewLabel != null && (
        <button
          type="button"
          className="remove-additional-label-button"
          disabled={busy}
          onClick={() => void setLabel(additionalReviewLabel, false)}
        >
          {busy ? 'Updating…' : 'Remove addi. label'}
        </button>
      )}
      <Popover.Root open={open} onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) setSearch('')
      }}>
        <Popover.Trigger className="pr-draft-button">Labels</Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner sideOffset={8} align="end" className="popup-positioner">
            <Popover.Popup className="pr-label-popover">
              <Popover.Title>Change labels</Popover.Title>
              <input
                type="search"
                aria-label="Search labels"
                placeholder="Search labels…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {available.isPending && <p role="status">Loading labels…</p>}
              {available.isError && (
                <p role="alert">
                  {available.error.message}{' '}
                  <button type="button" onClick={() => void available.refetch()}>Retry</button>
                </p>
              )}
              <div className="pr-label-options" aria-busy={busy}>
                {visible.map((label) => (
                  <label key={label.name}>
                    <input
                      type="checkbox"
                      checked={labels.some((selected) => selected.name === label.name)}
                      disabled={busy}
                      onChange={(event) => void setLabel(label, event.target.checked)}
                    />
                    <span className="pr-label-swatch" style={{ '--label-color': `#${label.color}` } as CSSProperties} />
                    <span>{label.name}</span>
                  </label>
                ))}
                {visible.length === 0 && !available.isPending && !available.isError && (
                  <p>{search ? 'No matching labels' : 'No repository labels'}</p>
                )}
              </div>
              {busy && <p role="status">Updating labels…</p>}
              {error != null && <p role="alert">{error}</p>}
              <p className="pr-label-hint">Changes apply immediately.</p>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  )
}
