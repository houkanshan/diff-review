import { describe, expect, test } from 'vitest'

import { reviewTargetForRepositorySwitch } from '../src/shared/types.js'

describe('reviewTargetForRepositorySwitch', () => {
  test('keeps pull requests on the pull request list', () => {
    expect(reviewTargetForRepositorySwitch({ kind: 'pr', number: 12 })).toBeNull()
  })

  test('reuses local target kinds', () => {
    expect(reviewTargetForRepositorySwitch({ kind: 'worktree' })).toEqual({ kind: 'worktree' })
    expect(reviewTargetForRepositorySwitch({ kind: 'branch-worktree' })).toEqual({
      kind: 'branch-worktree',
    })
    expect(reviewTargetForRepositorySwitch({ kind: 'staged' })).toEqual({ kind: 'staged' })
    expect(reviewTargetForRepositorySwitch({ kind: 'unstaged' })).toEqual({ kind: 'unstaged' })
  })

  test('rebinds the built-in branch commits target to the destination default range', () => {
    expect(
      reviewTargetForRepositorySwitch(
        { kind: 'range', expression: 'origin/main...HEAD' },
        {
          sourceBranchRange: 'origin/main...HEAD',
          destinationBranchRange: 'origin/master...HEAD',
        },
      ),
    ).toEqual({ kind: 'range', expression: 'origin/master...HEAD' })
  })

  test('keeps custom revision ranges', () => {
    expect(
      reviewTargetForRepositorySwitch(
        { kind: 'range', expression: 'HEAD~2..HEAD' },
        {
          sourceBranchRange: 'origin/main...HEAD',
          destinationBranchRange: 'origin/master...HEAD',
        },
      ),
    ).toEqual({ kind: 'range', expression: 'HEAD~2..HEAD' })
  })

  test('keeps single-revision ranges opened from a pull request commit', () => {
    expect(
      reviewTargetForRepositorySwitch(
        { kind: 'range', expression: 'abc1234' },
        {
          sourceBranchRange: 'origin/main...HEAD',
          destinationBranchRange: 'origin/master...HEAD',
        },
      ),
    ).toEqual({ kind: 'range', expression: 'abc1234' })
  })

  test('keeps the current range when the destination has no default branch', () => {
    expect(
      reviewTargetForRepositorySwitch(
        { kind: 'range', expression: 'origin/main...HEAD' },
        { sourceBranchRange: 'origin/main...HEAD', destinationBranchRange: null },
      ),
    ).toEqual({ kind: 'range', expression: 'origin/main...HEAD' })
  })
})
