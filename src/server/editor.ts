import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { editorLabel, type EditorId } from '../shared/editor.js'
import { AppError } from './errors.js'

export interface EditorLaunchSpec {
  command: string
  args: string[]
}

export interface OpenFileInEditorInput {
  repositoryRoot: string
  filePath: string
  line: number
  editor: EditorId
}

const MAC_APPS: Record<EditorId, string | null> = {
  cursor: 'Cursor',
  vscode: 'Visual Studio Code',
  zed: 'Zed',
  nvim: null,
  sublime: 'Sublime Text',
  windsurf: 'Windsurf',
}

export function absoluteRepositoryFilePath(root: string, filePath: string): string {
  const normalizedPath = filePath.replace(/^\.\//, '')
  const absolutePath = path.resolve(root, normalizedPath)
  if (absolutePath === root || !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new AppError('INVALID_FILE_PATH', `File is outside the repository: ${filePath}`)
  }
  return absolutePath
}

const UNIX_TERMINALS = [
  'ghostty',
  'x-terminal-emulator',
  'kitty',
  'alacritty',
  'konsole',
  'xfce4-terminal',
  'xterm',
]

export function editorLaunchSpecs(
  editor: EditorId,
  absolutePath: string,
  line: number,
  options: {
    platform?: NodeJS.Platform
    terminal?: string
  } = {},
): EditorLaunchSpec[] {
  const platform = options.platform ?? process.platform
  if (editor === 'nvim') return nvimLaunchSpecs(absolutePath, line, platform, options.terminal)
  const primary = primaryLaunchSpec(editor, absolutePath, line)
  const specs = [primary]
  const macApp = MAC_APPS[editor]
  if (platform === 'darwin' && macApp != null) {
    specs.push({
      command: 'open',
      args: ['-a', macApp, '--args', ...primary.args],
    })
  }
  return specs
}

export async function openFileInEditor(
  input: OpenFileInEditorInput,
  spawnImpl: typeof spawn = spawn,
): Promise<EditorLaunchSpec> {
  if (!Number.isInteger(input.line) || input.line <= 0) {
    throw new AppError('INVALID_INPUT', 'line must be a positive integer')
  }
  const absolutePath = absoluteRepositoryFilePath(input.repositoryRoot, input.filePath)
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new AppError(
      'FILE_NOT_IN_WORKTREE',
      `File is not in the working tree: ${input.filePath}`,
    )
  }
  const specs = editorLaunchSpecs(input.editor, absolutePath, input.line, {
    terminal: process.env.TERMINAL,
  })
  return spawnFirstAvailable(specs, input.repositoryRoot, input.editor, spawnImpl)
}

function primaryLaunchSpec(
  editor: Exclude<EditorId, 'nvim'>,
  absolutePath: string,
  line: number,
): EditorLaunchSpec {
  const location = `${absolutePath}:${line}`
  switch (editor) {
    case 'cursor':
      return { command: 'cursor', args: ['-g', location] }
    case 'vscode':
      return { command: 'code', args: ['-g', location] }
    case 'zed':
      return { command: 'zed', args: [location] }
    case 'sublime':
      return { command: 'subl', args: [location] }
    case 'windsurf':
      return { command: 'windsurf', args: ['-g', location] }
  }
}

function nvimLaunchSpecs(
  absolutePath: string,
  line: number,
  platform: NodeJS.Platform,
  terminal: string | undefined,
): EditorLaunchSpec[] {
  if (platform === 'win32') {
    return [{ command: 'cmd', args: ['/c', 'start', '', 'nvim', `+${line}`, absolutePath] }]
  }
  const nvimArgs = ['-e', 'nvim', `+${line}`, absolutePath]
  const commands: string[] = []
  for (const command of [terminal, ...UNIX_TERMINALS]) {
    const next = command?.trim()
    if (next != null && next !== '' && !commands.includes(next)) commands.push(next)
  }
  return commands.map((command) => nvimTerminalSpec(command, nvimArgs, platform))
}

function nvimTerminalSpec(
  command: string,
  nvimArgs: string[],
  platform: NodeJS.Platform,
): EditorLaunchSpec {
  if (platform === 'darwin' && isGhosttyTerminal(command)) {
    return {
      command: 'open',
      args: ['-na', 'Ghostty.app', '--args', ...nvimArgs],
    }
  }
  return { command, args: nvimArgs }
}

function isGhosttyTerminal(command: string): boolean {
  return path.basename(command).replace(/\.app$/i, '').toLowerCase() === 'ghostty'
}

async function spawnFirstAvailable(
  specs: EditorLaunchSpec[],
  cwd: string,
  editor: EditorId,
  spawnImpl: typeof spawn,
): Promise<EditorLaunchSpec> {
  let missing = false
  for (const spec of specs) {
    try {
      await spawnDetached(spec, cwd, spawnImpl)
      return spec
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EDITOR_LAUNCH_FAILED') {
        missing = true
        continue
      }
      throw error
    }
  }
  if (missing) {
    throw new AppError(
      'EDITOR_NOT_FOUND',
      `${editorLabel(editor)} is not installed or is not on PATH`,
    )
  }
  throw new AppError('EDITOR_NOT_FOUND', `Could not open ${editorLabel(editor)}`)
}

function spawnDetached(
  spec: EditorLaunchSpec,
  cwd: string,
  spawnImpl: typeof spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.once('error', reject)
    if (spec.command === 'open') {
      child.once('exit', (code) => {
        if (code === 0) {
          child.unref()
          resolve()
          return
        }
        const error = new Error(`${spec.command} exited ${code}`) as NodeJS.ErrnoException
        error.code = 'EDITOR_LAUNCH_FAILED'
        reject(error)
      })
      return
    }
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

