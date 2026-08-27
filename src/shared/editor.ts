export const EDITORS = [
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'zed', label: 'Zed' },
  { id: 'nvim', label: 'Neovim' },
  { id: 'sublime', label: 'Sublime Text' },
  { id: 'windsurf', label: 'Windsurf' },
] as const

export type EditorId = (typeof EDITORS)[number]['id']

const EDITOR_IDS = new Set<string>(EDITORS.map((editor) => editor.id))

export function isEditorId(value: string): value is EditorId {
  return EDITOR_IDS.has(value)
}

export function parseEditorId(value: unknown): EditorId | null {
  return typeof value === 'string' && isEditorId(value) ? value : null
}

export function editorLabel(id: EditorId): string {
  return EDITORS.find((editor) => editor.id === id)?.label ?? id
}

export function editorIdList(): string {
  return EDITORS.map((editor) => editor.id).join(', ')
}
