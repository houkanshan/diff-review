import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'

// Review navigation, annotations, and CodeView share one entry per file path.
export function parseReviewPatch(patch: string, cacheKeyPrefix: string): FileDiffMetadata[] {
  const filesByPath = new Map<string, FileDiffMetadata>()
  for (const file of parsePatchFiles(patch, cacheKeyPrefix, true).flatMap((part) => part.files)) {
    const previous = filesByPath.get(file.name)
    if (previous == null) {
      filesByPath.set(file.name, file)
      continue
    }

    // Git emits separate deletion/addition blocks when a file changes type,
    // for example when a moved regular file is replaced by a symlink.
    const deleted = previous.type === 'deleted' ? previous : file
    const added = previous.type === 'new' ? previous : file
    if (deleted.type !== 'deleted' || added.type !== 'new') {
      throw new Error(`Unexpected duplicate diff path: ${file.name}`)
    }
    const merged = parseDiffFromFile(
      { name: file.name, contents: deleted.deletionLines.join('') },
      { name: file.name, contents: added.additionLines.join('') },
      undefined,
      true,
    )
    merged.prevMode = deleted.mode
    merged.mode = added.mode
    merged.prevObjectId = deleted.prevObjectId
    merged.newObjectId = added.newObjectId
    filesByPath.set(file.name, merged)
  }

  const files = [...filesByPath.values()]
  for (const file of files) file.cacheKey = `${cacheKeyPrefix}:${file.name}`
  return files
}
