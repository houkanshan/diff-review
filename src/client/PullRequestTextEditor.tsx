import {
  createContext, useContext, useRef, useState,
  type Dispatch, type SetStateAction, type KeyboardEvent, type ReactNode,
} from 'react'
import { Pencil } from 'lucide-react'
import { isModifiedSubmitEnter } from './textInputSubmit'

type TextEditState = { editing: boolean; draft: string; busy: boolean; error: string | null }
const initialEdit: TextEditState = { editing: false, draft: '', busy: false, error: null }
const TextEditsContext = createContext<{
  title: [TextEditState, Dispatch<SetStateAction<TextEditState>>]
  body: [TextEditState, Dispatch<SetStateAction<TextEditState>>]
  submitting: { current: { title: boolean; body: boolean } }
} | null>(null)

/** Keep drafts alive when the loading overview becomes a resolved workspace. */
export function PullRequestTextEditsProvider({ children }: { children: ReactNode }) {
  const title = useState(initialEdit)
  const body = useState(initialEdit)
  const submitting = useRef({ title: false, body: false })
  return <TextEditsContext.Provider value={{ title, body, submitting }}>{children}</TextEditsContext.Provider>
}

export function PullRequestTextEditor({
  field,
  value,
  onSave,
  children,
}: {
  field: 'title' | 'body'
  value: string
  onSave(value: string): Promise<void>
  children: ReactNode
}) {
  const label = field === 'title' ? 'title' : 'description'
  const edits = useContext(TextEditsContext)!
  const [{ editing, draft, busy, error }, setEdit] = edits[field]
  const setDraft = (draft: string) => setEdit((current) => ({ ...current, draft }))
  const canSave = field === 'body' || Boolean(draft.trim())
  const submit = async () => {
    if (edits.submitting.current[field] || !canSave) return
    const nextValue = field === 'title' ? draft.trim() : draft
    if (nextValue.replace(/\r\n/g, '\n') === value.replace(/\r\n/g, '\n')) {
      setEdit((current) => ({ ...current, editing: false }))
      return
    }
    edits.submitting.current[field] = true
    setEdit((current) => ({ ...current, busy: true, error: null }))
    try {
      await onSave(nextValue)
      setEdit((current) => ({ ...current, editing: false }))
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : String(caught)
      setEdit((current) => ({ ...current, error }))
    } finally {
      edits.submitting.current[field] = false
      setEdit((current) => ({ ...current, busy: false }))
    }
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (!isModifiedSubmitEnter(event.nativeEvent)) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }

  if (!editing) {
    return (
      <div className={`pr-editable-text is-${field}`}>
        {children}
        <button
          type="button"
          className="pr-edit-text-button"
          aria-label={`Edit pull request ${label}`}
          title={`Edit ${label}`}
          onClick={() => {
            setEdit({ draft: value, error: null, editing: true, busy: false })
          }}
        >
          <Pencil aria-hidden="true" />
        </button>
      </div>
    )
  }

  return (
    <form
      className="pr-action-composer pr-text-editor"
      aria-label={`Edit pull request ${label}`}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {field === 'title' ? (
        <input
          autoFocus
          aria-label="Pull request title"
          value={draft}
          readOnly={busy}
          aria-busy={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <textarea
          autoFocus
          aria-label="Pull request description"
          value={draft}
          readOnly={busy}
          aria-busy={busy}
          rows={8}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      {error != null && <p className="pr-action-error" role="alert">{error}</p>}
      <footer>
        <small>⌘/Ctrl+Enter to save</small>
        <div className="pr-text-editor-actions">
          <button type="button" disabled={busy} onClick={() => setEdit((current) => ({ ...current, editing: false }))}>Cancel</button>
          <button type="submit" disabled={busy || !canSave}>
            {busy ? 'Saving…' : `Save ${label}`}
          </button>
        </div>
      </footer>
    </form>
  )
}
