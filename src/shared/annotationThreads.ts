import type { SessionAnnotation } from './types.js'

export type AnnotationThread = {
  root: SessionAnnotation
  replies: SessionAnnotation[]
}

export function annotationThreads(annotations: SessionAnnotation[]): AnnotationThread[] {
  const ids = new Set(annotations.map((annotation) => annotation.id))
  const repliesByParent = new Map<string, SessionAnnotation[]>()
  const roots: SessionAnnotation[] = []
  for (const annotation of annotations) {
    if (annotation.replyToId != null && ids.has(annotation.replyToId)) {
      const existing = repliesByParent.get(annotation.replyToId)
      if (existing == null) repliesByParent.set(annotation.replyToId, [annotation])
      else existing.push(annotation)
      continue
    }
    roots.push(annotation)
  }
  return roots.map((root) => ({
    root,
    replies: repliesByParent.get(root.id) ?? [],
  }))
}

export function isAnnotationThreadRoot(annotation: SessionAnnotation, visibleIds: Set<string>): boolean {
  return annotation.replyToId == null || !visibleIds.has(annotation.replyToId)
}
