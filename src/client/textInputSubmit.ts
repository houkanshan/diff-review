type SubmitKeyEvent = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  repeat: boolean
  isComposing: boolean
  keyCode: number
}

/** Submit text forms without consuming newlines or IME confirmation. */
export function isModifiedSubmitEnter(event: SubmitKeyEvent): boolean {
  return event.key === 'Enter' &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey && !event.altKey && !event.repeat &&
    !event.isComposing && event.keyCode !== 229
}
