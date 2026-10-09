import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { pierreOpenLineNumber, difftasticOpenLineNumber } from '../src/client/editor.js'
import { parseEditorId } from '../src/shared/editor.js'
import {
  absoluteRepositoryFilePath,
  editorLaunchSpecs,
  openFileInEditor,
} from '../src/server/editor.js'
import { AppError } from '../src/server/errors.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('editor ids', () => {
  test('accepts known editors and rejects anything else', () => {
    expect(parseEditorId('cursor')).toBe('cursor')
    expect(parseEditorId('vscode')).toBe('vscode')
    expect(parseEditorId('zed')).toBe('zed')
    expect(parseEditorId('nvim')).toBe('nvim')
    expect(parseEditorId('notepad')).toBeNull()
    expect(parseEditorId(1)).toBeNull()
  })
})

describe('editor launch specs', () => {
  test.each([
    ['cursor', 'cursor', ['-g']],
    ['vscode', 'code', ['-g']],
    ['zed', 'zed', []],
    ['sublime', 'subl', []],
  ] as const)('opens the repository folder and file at the requested line with %s', (editor, command, flags) => {
    const repositoryRoot = '/review project'
    const file = '/review project/src/app.ts'
    expect(editorLaunchSpecs(editor, file, 18, { repositoryRoot, platform: 'linux' })).toEqual([
      { command, args: [repositoryRoot, ...flags, `${file}:18`] },
    ])
  })

  test.each([
    ['cursor', 'Cursor', ['-g']],
    ['vscode', 'Visual Studio Code', ['-g']],
    ['zed', 'Zed', []],
    ['sublime', 'Sublime Text', []],
  ] as const)('includes the folder in the macOS app fallback for %s', (editor, app, flags) => {
    const repositoryRoot = '/review project'
    const file = '/review project/file.ts'
    const specs = editorLaunchSpecs(editor, file, 4, { repositoryRoot, platform: 'darwin' })
    expect(specs[0]?.args).toEqual([repositoryRoot, ...flags, `${file}:4`])
    expect(specs[1]).toEqual({
      command: 'open',
      args: ['-a', app, '--args', repositoryRoot, ...flags, `${file}:4`],
    })
  })

  test('keeps the unverified Windsurf launcher unchanged', () => {
    expect(editorLaunchSpecs('windsurf', '/repo/file.ts', 4, {
      repositoryRoot: '/repo',
      platform: 'linux',
    })).toEqual([{ command: 'windsurf', args: ['-g', '/repo/file.ts:4'] }])
  })

  test('uses $TERMINAL first for nvim on macOS and Linux', () => {
    const file = '/tmp/says "hi".ts'
    expect(editorLaunchSpecs('nvim', file, 9, { repositoryRoot: '/repo', platform: 'darwin' })[0]).toEqual({
      command: 'open',
      args: ['-na', 'Ghostty.app', '--args', '-e', 'nvim', '+9', file],
    })
    expect(editorLaunchSpecs('nvim', file, 9, { repositoryRoot: '/repo', platform: 'darwin', terminal: 'ghostty' })[0]).toEqual({
      command: 'open',
      args: ['-na', 'Ghostty.app', '--args', '-e', 'nvim', '+9', file],
    })
    expect(editorLaunchSpecs('nvim', file, 9, { repositoryRoot: '/repo', platform: 'darwin', terminal: 'kitty' })[0]).toEqual({
      command: 'kitty',
      args: ['-e', 'nvim', '+9', file],
    })
    expect(editorLaunchSpecs('nvim', file, 9, { repositoryRoot: '/repo', platform: 'linux', terminal: 'kitty' })[0]).toEqual({
      command: 'kitty',
      args: ['-e', 'nvim', '+9', file],
    })
    expect(editorLaunchSpecs('nvim', "/tmp/o'reilly.ts", 3, { repositoryRoot: '/repo', platform: 'darwin', terminal: 'ghostty' })[0]?.args.at(-1))
      .toBe("/tmp/o'reilly.ts")
    expect(editorLaunchSpecs('nvim', '/tmp/new\nline.ts', 1, { repositoryRoot: '/repo', platform: 'darwin', terminal: 'ghostty' })[0]?.args.at(-1))
      .toBe('/tmp/new\nline.ts')
    expect(editorLaunchSpecs('nvim', '/tmp/foo\\bar.ts', 1, { repositoryRoot: '/repo', platform: 'darwin', terminal: 'ghostty' })[0]?.args.at(-1))
      .toBe('/tmp/foo\\bar.ts')
  })

  test('tries $TERMINAL then common Unix terminals for nvim', () => {
    const file = '/tmp/app.ts'
    const specs = editorLaunchSpecs('nvim', file, 9, { repositoryRoot: '/repo', platform: 'linux', terminal: 'kitty' })
    expect(specs[0]).toEqual({ command: 'kitty', args: ['-e', 'nvim', '+9', file] })
    expect(specs.map((spec) => spec.command)).toEqual([
      'kitty',
      'ghostty',
      'x-terminal-emulator',
      'alacritty',
      'konsole',
      'xfce4-terminal',
      'xterm',
    ])
  })
})

describe('open file in editor', () => {
  test('rejects paths outside the repository', () => {
    const root = tempDir()
    expect(() => absoluteRepositoryFilePath(root, '../secret.txt')).toThrow(AppError)
  })

  test.each(['zed', 'cursor', 'vscode', 'sublime'] as const)('spawns %s in the review repository at the requested line', async (editor) => {
    const root = tempDir()
    const filePath = 'src/app.ts'
    writeFileSync(path.join(root, 'src/app.ts'), 'export {}\n')
    const spawned: Array<{ command: string; args: string[]; cwd: string }> = []

    const used = await openFileInEditor(
      { repositoryRoot: root, filePath, line: 12, editor },
      ((command: string, args: string[], options: { cwd: string }) => {
        spawned.push({ command, args, cwd: options.cwd })
        return fakeChild('spawn')
      }) as typeof import('node:child_process').spawn,
    )

    expect(root).not.toBe(process.cwd())
    const command = { zed: 'zed', cursor: 'cursor', vscode: 'code', sublime: 'subl' }[editor]
    const flags = editor === 'cursor' || editor === 'vscode' ? ['-g'] : []
    expect(used).toEqual({ command, args: [root, ...flags, `${path.join(root, filePath)}:12`] })
    expect(spawned).toEqual([{ ...used, cwd: root }])
  })

  test('falls back when the CLI binary is missing', async () => {
    const root = tempDir()
    writeFileSync(path.join(root, 'src/app.ts'), 'export {}\n')
    const commands: string[] = []
    const spawnMissing = ((command: string) => {
      commands.push(command)
      return fakeChild(command === 'cursor' ? 'ENOENT' : 'spawn')
    }) as typeof import('node:child_process').spawn
    const input = {
      repositoryRoot: root,
      filePath: 'src/app.ts',
      line: 3,
      editor: 'cursor',
    } as const

    if (process.platform === 'darwin') {
      const used = await openFileInEditor(input, spawnMissing)
      expect(used).toEqual({
        command: 'open',
        args: ['-a', 'Cursor', '--args', root, '-g', `${path.join(root, input.filePath)}:3`],
      })
      expect(commands).toEqual(['cursor', 'open'])
      return
    }

    await expect(openFileInEditor(input, spawnMissing)).rejects.toMatchObject({
      code: 'EDITOR_NOT_FOUND',
    })
    expect(commands).toEqual(['cursor'])
  })

  test('errors when the worktree file is missing', async () => {
    const root = tempDir()
    await expect(
      openFileInEditor({
        repositoryRoot: root,
        filePath: 'src/missing.ts',
        line: 1,
        editor: 'cursor',
      }),
    ).rejects.toMatchObject({ code: 'FILE_NOT_IN_WORKTREE' })
  })
})

describe('hovered line numbers', () => {
  test('prefers the new side for context and additions', () => {
    expect(pierreOpenLineNumber({
      lineType: 'change-addition',
      line: '20',
      inDeletions: false,
    })).toBe(20)
    expect(pierreOpenLineNumber({
      lineType: 'context',
      line: '8',
      altLine: '11',
      inDeletions: true,
    })).toBe(11)
    expect(pierreOpenLineNumber({
      lineType: 'context',
      line: '11',
      altLine: '8',
      inDeletions: false,
    })).toBe(11)
    expect(pierreOpenLineNumber({
      lineType: 'change-deletion',
      line: '6',
      inDeletions: true,
    })).toBe(6)
  })

  test('uses gutter column numbers and ignores non-code rows', () => {
    expect(pierreOpenLineNumber({
      lineType: 'context',
      columnNumber: '4',
      inDeletions: false,
    })).toBe(4)
    expect(pierreOpenLineNumber({
      lineType: 'expand',
      line: '4',
      inDeletions: false,
    })).toBeNull()
  })

  test('prefers difftastic new-side numbers', () => {
    expect(difftasticOpenLineNumber(3, 9)).toBe(9)
    expect(difftasticOpenLineNumber(3, null)).toBe(3)
    expect(difftasticOpenLineNumber(null, null)).toBeNull()
  })
})

function tempDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'diff-review-editor-'))
  mkdirSync(path.join(directory, 'src'))
  tempDirs.push(directory)
  return directory
}

function fakeChild(mode: 'spawn' | 'ENOENT' | 'exit1') {
  const child = new EventEmitter()
  Object.assign(child, { unref() {} })
  queueMicrotask(() => {
    if (mode === 'ENOENT') {
      const error = new Error('not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      child.emit('error', error)
      return
    }
    child.emit('spawn')
    child.emit('exit', mode === 'exit1' ? 1 : 0)
  })
  return child
}
