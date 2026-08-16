import type { PullRequestActivity } from './types.js'

export type ReviewCommentActivity = Extract<PullRequestActivity, { kind: 'review-comment' }>
export type ReviewActivity = Extract<PullRequestActivity, { kind: 'review' }>

export type ReviewCommentThread = {
  comment: ReviewCommentActivity
  replies: ReviewCommentActivity[]
}

export type ConversationActivity =
  | {
      kind: 'item'
      activity: Exclude<PullRequestActivity, ReviewCommentActivity>
      count: number
    }
  | {
      kind: 'review-group'
      review: ReviewActivity
      comments: ReviewCommentThread[]
    }
  | {
      kind: 'orphan-comments'
      comments: ReviewCommentThread[]
    }

type TimelineActivity = Extract<PullRequestActivity, { kind: 'timeline' }>

export function groupConversationActivities(activities: PullRequestActivity[]): ConversationActivity[] {
  const comments = activities.filter((activity): activity is ReviewCommentActivity => (
    activity.kind === 'review-comment'
  ))
  const threads = groupReviewCommentThreads(comments)
  const remainingThreads = new Map(threads.map((thread) => [thread.comment.id, thread]))
  const groups: ConversationActivity[] = []

  for (const activity of activities) {
    if (activity.kind === 'review-comment') continue

    if (activity.kind === 'review') {
      const reviewThreads = takeReviewThreads(activity.id, remainingThreads)
      if (reviewThreads.length === 0 && isHiddenReview(activity)) continue
      groups.push({ kind: 'review-group', review: activity, comments: reviewThreads })
      continue
    }

    const previous = groups.at(-1)
    if (
      activity.kind === 'timeline' &&
      previous?.kind === 'item' &&
      previous.activity.kind === 'timeline' &&
      timelineGroupKey(previous.activity) === timelineGroupKey(activity)
    ) {
      previous.count += 1
      continue
    }

    groups.push({ kind: 'item', activity, count: 1 })
  }

  if (remainingThreads.size > 0) {
    groups.push({
      kind: 'orphan-comments',
      comments: [...remainingThreads.values()],
    })
  }

  return groups
}

export function groupReviewCommentThreads(comments: ReviewCommentActivity[]): ReviewCommentThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]))
  const replies = new Map<string, ReviewCommentActivity[]>()
  const roots: ReviewCommentActivity[] = []

  for (const comment of comments) {
    const rootId = threadRootId(comment, byId)
    if (rootId === comment.id) {
      roots.push(comment)
      continue
    }
    const threadReplies = replies.get(rootId) ?? []
    threadReplies.push(comment)
    replies.set(rootId, threadReplies)
  }

  return roots.map((comment) => ({
    comment,
    replies: replies.get(comment.id) ?? [],
  }))
}

function takeReviewThreads(
  reviewId: string,
  remainingThreads: Map<string, ReviewCommentThread>,
): ReviewCommentThread[] {
  const threads: ReviewCommentThread[] = []
  for (const [id, thread] of remainingThreads) {
    if (thread.comment.reviewId !== reviewId) continue
    threads.push(thread)
    remainingThreads.delete(id)
  }
  return threads
}

function isHiddenReview(review: ReviewActivity): boolean {
  return !review.body.trim() && review.state.toUpperCase() === 'COMMENTED'
}

function threadRootId(
  comment: ReviewCommentActivity,
  byId: Map<string, ReviewCommentActivity>,
): string {
  const seen = new Set<string>([comment.id])
  let current = comment
  while (current.replyToId != null) {
    const parent = byId.get(current.replyToId)
    if (parent == null || seen.has(parent.id)) break
    seen.add(parent.id)
    current = parent
  }
  return current.id
}

function timelineGroupKey(activity: TimelineActivity): string {
  return JSON.stringify({
    event: activity.event,
    author: activity.author?.login ?? null,
    label: activity.label,
    subject: activity.subject,
    commitId: activity.commitId,
    previousTitle: activity.previousTitle,
    currentTitle: activity.currentTitle,
  })
}
