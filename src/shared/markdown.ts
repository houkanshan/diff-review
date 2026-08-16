import type { ListItem, Paragraph, Root } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified, type Plugin } from 'unified'

import type { GitHubIssueReference } from './types.js'

const issueReferencePattern = /^(?:(?<owner>[^/\s#]+)\/(?<repository>[^/\s#]+))?#(?<number>[1-9]\d*)$/

export interface GitHubIssueReferenceTarget {
  token: string
  owner: string | null
  repository: string | null
  number: number
}

export function extractIssueReferenceTargets(markdownBodies: string[]): GitHubIssueReferenceTarget[] {
  const targets = new Map<string, GitHubIssueReferenceTarget>()
  const parser = unified().use(remarkParse).use(remarkGfm)
  for (const body of markdownBodies) {
    visitListItems(parser.parse(body), (item) => {
      const target = issueReferenceTarget(item)
      if (target != null) targets.set(target.token.toLowerCase(), target)
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
    visitListItems(tree, (item) => {
      const paragraph = issueReferenceParagraph(item)
      const target = paragraph == null ? null : issueReferenceTarget(item)
      const reference = target == null
        ? undefined
        : referencesByToken.get(target.token.toLowerCase())
      if (paragraph == null || reference == null) return
      paragraph.children = [{
        type: 'link',
        url: reference.url,
        children: [{ type: 'text', value: `${reference.label} ${reference.title}` }],
      }]
    })
  }
}

function issueReferenceTarget(item: ListItem): GitHubIssueReferenceTarget | null {
  const paragraph = issueReferenceParagraph(item)
  if (paragraph == null) return null
  const reference = paragraph.children[0]
  if (reference.type !== 'text') return null
  const match = issueReferencePattern.exec(reference.value)
  if (match?.groups == null) return null
  return {
    token: reference.value,
    owner: match.groups.owner ?? null,
    repository: match.groups.repository ?? null,
    number: Number(match.groups.number),
  }
}

function issueReferenceParagraph(item: ListItem): Paragraph | null {
  const paragraph = item.children[0]
  return paragraph?.type === 'paragraph' &&
    paragraph.children.length === 1 &&
    paragraph.children[0].type === 'text'
    ? paragraph
    : null
}

function visitListItems(node: Root | Root['children'][number], visit: (item: ListItem) => void): void {
  if (node.type === 'listItem') visit(node)
  if ('children' in node) {
    for (const child of node.children) visitListItems(child, visit)
  }
}
