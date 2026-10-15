export interface ClipboardEnvironment {
  isSecureContext?: boolean
  navigator?: { clipboard?: { writeText(text: string): Promise<void> } }
  document?: Document
}

// The async Clipboard API only exists in secure contexts, so plain-HTTP
// remote access falls back to a hidden textarea and execCommand('copy').
export async function writeClipboardText(
  text: string,
  environment: ClipboardEnvironment = globalThis as ClipboardEnvironment,
): Promise<void> {
  const clipboard = environment.navigator?.clipboard
  if (environment.isSecureContext && clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return
    } catch (error) {
      if (!environment.document) throw error
    }
  }
  const doc = environment.document
  if (!doc) throw new Error('Clipboard is unavailable')
  copyWithTextarea(doc, text)
}

function copyWithTextarea(doc: Document, text: string): void {
  const previousFocus = doc.activeElement as HTMLElement | null
  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '0'
  textarea.style.left = '0'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  doc.body.appendChild(textarea)
  try {
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, text.length)
    if (!doc.execCommand('copy')) throw new Error('Copy command was rejected')
  } finally {
    textarea.remove()
    previousFocus?.focus?.()
  }
}
