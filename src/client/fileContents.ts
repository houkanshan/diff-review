import { getFilePair } from './api'

export type FilePair = { old: string | null; new: string | null }

const MAX_ENTRIES = 64
const cache = new Map<string, Promise<FilePair>>()

/**
 * Whole old/new file contents for one reviewed file, shared by Pierre's
 * collapsed-context hydration and sticky scope lines so each file is fetched
 * once per patch. `contentKey` changes whenever the session patch does.
 */
export function loadReviewFilePair(
  sessionId: string,
  contentKey: string,
  oldPath: string | null,
  newPath: string | null,
): Promise<FilePair> {
  const key = JSON.stringify([sessionId, contentKey, oldPath, newPath])
  const existing = cache.get(key)
  if (existing != null) {
    cache.delete(key)
    cache.set(key, existing)
    return existing
  }
  const pending = getFilePair(sessionId, oldPath, newPath)
  cache.set(key, pending)
  pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key)
  })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest == null) break
    cache.delete(oldest)
  }
  return pending
}
