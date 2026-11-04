import type { Link, Parent, Root, RootContent, Text } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified, type Plugin } from 'unified'

import type { GitHubIssueReference } from './types.js'

const issueReferenceUrlPattern =
  /^https:\/\/github\.com\/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/(?<repository>[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(?<number>[1-9]\d*)(?:[/?#].*)?$/i
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

/** Parses a GitHub issue or pull request URL, e.g. https://github.com/acme/repo/pull/12/files. */
export function parseIssueReferenceUrl(
  url: string,
): { owner: string; repository: string; number: number } | null {
  const match = issueReferenceUrlPattern.exec(url)
  if (match?.groups == null) return null
  return {
    owner: match.groups.owner,
    repository: match.groups.repository,
    number: Number(match.groups.number),
  }
}

/** Case-insensitive identity shared by shorthand tokens, URLs, and resolved references. */
export function issueReferenceKey(reference: { owner: string; repository: string; number: number }): string {
  return `${reference.owner.toLowerCase()}/${reference.repository.toLowerCase()}#${reference.number}`
}

export function extractIssueReferenceTargets(markdownBodies: string[]): GitHubIssueReferenceTarget[] {
  const targets = new Map<string, GitHubIssueReferenceTarget>()
  const parser = unified().use(remarkParse).use(remarkGfm)
  for (const body of markdownBodies) {
    visitIssueReferenceText(parser.parse(body), false, (text) => {
      for (const { target } of issueReferenceMatches(text.value)) {
        targets.set(target.token.toLowerCase(), target)
      }
    }, (link) => {
      const parsed = parseIssueReferenceUrl(link.url)
      if (parsed == null) return
      const token = `${parsed.owner}/${parsed.repository}#${parsed.number}`
      targets.set(token.toLowerCase(), { token, ...parsed })
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
  const referencesByKey = new Map(
    references.map((reference) => [issueReferenceKey(reference), reference]),
  )
  return (tree) => {
    visitIssueReferenceText(tree, false, (text, insideListItem) => {
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
          children: [{
            type: 'text',
            value: insideListItem ? `${reference.label} ${reference.title}` : match.target.token,
          }],
        })
        cursor = match.index + match.target.token.length
      }
      if (children.length === 0) return undefined
      if (cursor < text.value.length) children.push({ type: 'text', value: text.value.slice(cursor) })
      return children
    }, (link, insideListItem) => {
      // Bare GitHub URLs (autolinks) render like GitHub does: as a short reference label.
      const parsed = parseIssueReferenceUrl(link.url)
      if (parsed == null) return
      const reference = referencesByKey.get(issueReferenceKey(parsed))
      const onlyChild = link.children.length === 1 ? link.children[0] : null
      if (reference == null || onlyChild?.type !== 'text' || onlyChild.value !== link.url) return
      onlyChild.value = insideListItem ? `${reference.label} ${reference.title}` : reference.label
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
  visit: (text: Text, insideListItem: boolean) => RootContent[] | undefined,
  visitLink?: (link: Link, insideListItem: boolean) => void,
): void {
  const nextInsideListItem = insideListItem || parent.type === 'listItem'
  parent.children = parent.children.flatMap((child) => {
    if (child.type === 'link') {
      visitLink?.(child, nextInsideListItem)
      return child
    }
    if (child.type === 'linkReference') return child
    if (child.type === 'text') return visit(child, nextInsideListItem) ?? child
    if ('children' in child) visitIssueReferenceText(child, nextInsideListItem, visit, visitLink)
    return child
  })
}
