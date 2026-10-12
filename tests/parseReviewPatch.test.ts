import { describe, expect, test } from 'vitest'
import { parsePatchFiles } from '@pierre/diffs'

import { buildCodeViewItems } from '../src/client/annotationComposer.js'
import { parseReviewPatch } from '../src/client/parseReviewPatch.js'

const deleted = `diff --git a/old/data.xml b/old/data.xml
deleted file mode 100644
index 1111111..0000000
--- a/old/data.xml
+++ /dev/null
@@ -1,2 +0,0 @@
-<data>
-</data>
\\ No newline at end of file
`
const added = `diff --git a/old/data.xml b/old/data.xml
new file mode 120000
index 0000000..2222222
--- /dev/null
+++ b/old/data.xml
@@ -0,0 +1 @@
+../new/data.xml
\\ No newline at end of file
`
const copied = `diff --git a/old/data.xml b/new/data.xml
similarity index 100%
copy from old/data.xml
copy to new/data.xml
`

function expectUniqueItems(patch: string, paths: string[]) {
  const files = parseReviewPatch(patch, 'session:content')
  const items = buildCodeViewItems(files, [], null, new Set())
  expect(items.map((item) => item.id)).toEqual(paths)
  expect(new Set(items.map((item) => item.id)).size).toBe(items.length)
  return files
}

describe('review patch file type changes', () => {
  test.each([
    ['deletion first', deleted + added],
    ['addition first', added + deleted],
  ])('merges both sides of a regular file replaced by a symlink (%s)', (_name, patch) => {
    expect(parsePatchFiles(patch, undefined, true)[0]?.files).toHaveLength(2)
    const files = expectUniqueItems(patch, ['old/data.xml'])
    expect(files[0]).toMatchObject({
      name: 'old/data.xml',
      type: 'change',
      isPartial: false,
      prevMode: '100644',
      mode: '120000',
      prevObjectId: '1111111',
      newObjectId: '2222222',
      cacheKey: 'session:content:old/data.xml',
      deletionLines: ['<data>\n', '</data>'],
      additionLines: ['../new/data.xml'],
      hunks: [{
        deletionStart: 1, deletionCount: 2,
        additionStart: 1, additionCount: 1,
        noEOFCRDeletions: true, noEOFCRAdditions: true,
      }],
    })
  })

  test('handles a symlink replaced by a regular file', () => {
    const patch = deleted.replace('100644', '120000') + added.replace('120000', '100644')
    const files = expectUniqueItems(patch, ['old/data.xml'])
    expect(files[0]).toMatchObject({
      type: 'change', prevMode: '120000', mode: '100644',
      deletionLines: ['<data>\n', '</data>'],
      additionLines: ['../new/data.xml'],
    })
  })

  test('retains a type change when both sides have identical contents', () => {
    const sameContentAdded = added.replace(
      '@@ -0,0 +1 @@\n+../new/data.xml',
      '@@ -0,0 +1,2 @@\n+<data>\n+</data>',
    )
    const files = expectUniqueItems(deleted + sameContentAdded, ['old/data.xml'])
    expect(files[0]).toMatchObject({
      type: 'change', prevMode: '100644', mode: '120000',
      hunks: [],
      deletionLines: ['<data>\n', '</data>'],
      additionLines: ['<data>\n', '</data>'],
    })
  })

  test('retains the moved content at its destination as a separate entry', () => {
    const files = expectUniqueItems(deleted + copied + added, ['old/data.xml', 'new/data.xml'])
    expect(files[0]?.deletionLines.join('')).toBe('<data>\n</data>')
    expect(files[0]?.additionLines.join('')).toBe('../new/data.xml')
    expect(files[1]?.prevName).toBe('old/data.xml')
  })

  test('preserves a final newline on both sides', () => {
    const patch = (deleted + added).replaceAll('\\ No newline at end of file\n', '')
    const files = expectUniqueItems(patch, ['old/data.xml'])
    expect(files[0]?.deletionLines.join('')).toBe('<data>\n</data>\n')
    expect(files[0]?.additionLines.join('')).toBe('../new/data.xml\n')
    expect(files[0]?.hunks[0]).toMatchObject({
      noEOFCRDeletions: false, noEOFCRAdditions: false,
    })
  })

  test('handles a binary file replaced by a symlink without inventing text content', () => {
    const binaryDeleted = `diff --git a/old/data.xml b/old/data.xml
deleted file mode 100644
index 1111111..0000000
GIT binary patch
literal 0
HcmV?d00001

`
    const files = expectUniqueItems(binaryDeleted + added, ['old/data.xml'])
    expect(files[0]).toMatchObject({
      prevMode: '100644', mode: '120000',
      deletionLines: [], additionLines: ['../new/data.xml'],
    })
  })

  test('leaves single-path changes unchanged', () => {
    const files = expectUniqueItems(deleted + copied, ['old/data.xml', 'new/data.xml'])
    const original = parsePatchFiles(deleted + copied, undefined, true).flatMap((part) => part.files)
    expect(files).toEqual(original.map((file) => ({
      ...file, cacheKey: `session:content:${file.name}`,
    })))
  })

  test('does not silently discard unexpected duplicate entries', () => {
    expect(() => parseReviewPatch(added + added, 'session:content'))
      .toThrow('Unexpected duplicate diff path: old/data.xml')
  })
})
