import { describe, expect, test } from 'vitest'

import { compareReviewFilePaths } from '../src/client/reviewFileOrder.js'

describe('review file order', () => {
  test('puts files before folders at the same depth', () => {
    const paths = ['src/nested/inner.ts', 'README.md', 'src/index.ts', 'package.json']
    expect([...paths].sort(compareReviewFilePaths)).toEqual([
      'package.json',
      'README.md',
      'src/index.ts',
      'src/nested/inner.ts',
    ])
  })
})
