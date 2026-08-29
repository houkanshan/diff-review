import { describe, expect, test } from 'vitest'

import { allFilesStageChange, stageActionForFile } from '../src/client/staging'

const unstaged = new Set(['partial.txt', 'unstaged.txt'])
const staged = new Set(['partial.txt', 'staged.txt'])

describe('staging direction', () => {
  test('unstages displayed index changes in a staged review', () => {
    expect(stageActionForFile('staged', 'partial.txt', unstaged, staged)).toBe('unstage')
    expect(allFilesStageChange('staged', ['partial.txt'], unstaged, staged)).toEqual({
      filePaths: ['partial.txt'],
      staged: false,
    })
  })

  test('stages displayed worktree changes in an unstaged review', () => {
    expect(stageActionForFile('unstaged', 'partial.txt', unstaged, staged)).toBe('add')
    expect(allFilesStageChange('unstaged', ['partial.txt'], unstaged, staged)).toEqual({
      filePaths: ['partial.txt'],
      staged: true,
    })
  })

  test('stages remaining worktree changes before unstaging a combined review', () => {
    expect(stageActionForFile('worktree', 'partial.txt', unstaged, staged)).toBe('add')
    expect(allFilesStageChange(
      'worktree',
      ['partial.txt', 'staged.txt'],
      unstaged,
      staged,
    )).toEqual({ filePaths: ['partial.txt'], staged: true })
  })
})
