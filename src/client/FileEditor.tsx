import {
  CodeView,
  EditProvider,
  type CodeViewItem,
  type FileContents,
} from '@pierre/diffs/react'
import { Editor, type EditorOptions } from '@pierre/diffs/edit'
import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ReviewSession } from '../shared/types'
import { getFileContents, saveFileContents } from './api'
import { PierreWorkerPool } from './PierreWorkerPool'

function createEditor(options: EditorOptions<undefined>) {
  return new Editor(options)
}

export function FileEditor({
  sessionId,
  filePath,
  editable,
  resolvedTheme,
  onSaved,
  onDirtyChange,
}: {
  sessionId: string
  filePath: string | null
  editable: boolean
  resolvedTheme: 'light' | 'dark'
  onSaved(session: ReviewSession): void
  onDirtyChange(dirty: boolean): void
}) {
  const [file, setFile] = useState<FileContents | null>(null)
  const [draft, setDraft] = useState('')
  const [version, setVersion] = useState(0)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setFile(null)
    setDraft('')
    setError(null)
    if (filePath == null) return

    setLoading(true)
    void getFileContents(sessionId, filePath, 'new')
      .then((contents) => {
        if (cancelled) return
        if (contents == null) {
          setError('Deleted files cannot be edited.')
          return
        }
        setVersion((current) => current + 1)
        setFile({
          name: filePath,
          contents,
          cacheKey: `${sessionId}:file:${filePath}`,
        })
        setDraft(contents)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [filePath, sessionId])

  const dirty = file != null && draft !== file.contents

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (!dirty) return
    const preventDataLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventDataLoss)
    return () => window.removeEventListener('beforeunload', preventDataLoss)
  }, [dirty])

  const save = useCallback(async () => {
    if (file == null || filePath == null || !dirty || saving || !editable) return
    setSaving(true)
    setError(null)
    try {
      const updated = await saveFileContents(sessionId, filePath, draft, file.contents)
      setVersion((current) => current + 1)
      setFile({
        ...file,
        contents: draft,
        cacheKey: `${sessionId}:file:${filePath}:saved`,
      })
      onSaved(updated)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }, [dirty, draft, editable, file, filePath, onSaved, saving, sessionId])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return
      event.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  const items = useMemo<CodeViewItem[]>(() => file == null ? [] : [{
    id: file.name,
    type: 'file',
    file,
    edit: editable && !saving,
    version: version * 2 + (saving ? 1 : 0),
  }], [editable, file, saving, version])

  return (
    <EditProvider createEditor={createEditor}>
      <div className="file-editor">
        <div className="file-editor-toolbar">
          <span className="file-editor-path">{filePath ?? 'No editable file selected'}</span>
          <span className="file-editor-status" role={error == null ? 'status' : 'alert'}>
            {error ?? (saving ? 'Saving…' : dirty ? 'Unsaved changes' : editable ? 'Saved' : 'Read only')}
          </span>
          <button type="button" disabled={!editable || !dirty || saving} onClick={() => void save()}>
            Save
          </button>
        </div>
        {loading ? (
          <div className="file-editor-empty">Loading file…</div>
        ) : file == null ? (
          <div className="file-editor-empty">{error ?? 'Select a file to edit.'}</div>
        ) : (
          <div className="file-editor-view-host">
            <PierreWorkerPool>
              <CodeView
                className="file-editor-view"
                items={items}
                options={{
                  theme: { dark: 'pierre-dark', light: 'pierre-light' },
                  themeType: resolvedTheme,
                  overflow: 'scroll',
                  stickyHeaders: true,
                  layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
                  itemMetrics: { lineHeight: 16 },
                }}
                onItemEditChange={(_item, nextFile) => setDraft(nextFile.contents)}
              />
            </PierreWorkerPool>
          </div>
        )}
      </div>
    </EditProvider>
  )
}
