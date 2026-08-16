import type { Parent, Root, RootContent, Text } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified, type Plugin } from 'unified'

import type { GitHubIssueReference } from './types.js'

const issueReferencePattern = /(?<![\w/-])(?:(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/(?<repository>[A-Za-z0-9_.-]+))?#(?<number>[1-9]\d*)\b/g

export interface GitHubIssueReferenceTarget {
  token: string
  owner: string | null
  repository: string | null
  number: number
}

interface GitHubIssueReferenceMatch {
  index: number
  target: GitHubIssueReferenceTarget
}

export function extractIssueReferenceTargets(markdownBodies: string[]): GitHubIssueReferenceTarget[] {
  const targets = new Map<string, GitHubIssueReferenceTarget>()
  const parser = unified().use(remarkParse).use(remarkGfm)
  for (const body of markdownBodies) {
    visitIssueReferenceText(parser.parse(body), false, (text) => {
      for (const { target } of issueReferenceMatches(text.value)) {
        targets.set(target.token.toLowerCase(), target)
      }
    })
  }
  return [...targets.values()]
}

export const remarkIssueReferences: Plugin<
  [{ references: GitHubIssueReference[] }],
  Root
> = ({ references }) => {
  const referencesByToken = new Map(
    references.map((reference) => [reference.token.toLowerCase(), reference]),
  )
  return (tree) => {
    visitIssueReferenceText(tree, false, (text) => {
      const children: RootContent[] = []
      let cursor = 0
      for (const match of issueReferenceMatches(text.value)) {
        const reference = referencesByToken.get(match.target.token.toLowerCase())
        if (reference == null) continue
        if (match.index > cursor) {
          children.push({ type: 'text', value: text.value.slice(cursor, match.index) })
        }
        children.push({
          type: 'link',
          url: reference.url,
          children: [{ type: 'text', value: `${reference.label} ${reference.title}` }],
        })
        cursor = match.index + match.target.token.length
      }
      if (children.length === 0) return undefined
      if (cursor < text.value.length) children.push({ type: 'text', value: text.value.slice(cursor) })
      return children
    })
  }
}

function issueReferenceMatches(value: string): GitHubIssueReferenceMatch[] {
  return [...value.matchAll(issueReferencePattern)].map((match) => ({
    index: match.index,
    target: {
      token: match[0],
      owner: match.groups?.owner ?? null,
      repository: match.groups?.repository ?? null,
      number: Number(match.groups?.number),
    },
  }))
}

function visitIssueReferenceText(
  parent: Parent,
  insideListItem: boolean,
  visit: (text: Text) => RootContent[] | undefined,
): void {
  const eligible = insideListItem || parent.type === 'listItem'
  parent.children = parent.children.flatMap((child) => {
    if (child.type === 'link' || child.type === 'linkReference') return child
    if (child.type === 'text' && eligible) return visit(child) ?? child
    if ('children' in child) visitIssueReferenceText(child, eligible, visit)
    return child
  })
}
