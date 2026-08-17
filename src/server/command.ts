import { spawn } from 'node:child_process'

import { AppError } from './errors.js'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

const MAX_OUTPUT_BYTES = 128 * 1024 * 1024

export async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  allowFailure = false,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  const result = await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill()
        reject(new AppError('COMMAND_OUTPUT_TOO_LARGE', `${command} output exceeded 128 MiB`))
        return
      }
      target.push(chunk)
    }

    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.on('error', (error) => reject(error))
    child.on('close', (exitCode) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? 1,
      })
    })
  }).catch((error: unknown) => {
    if (error instanceof AppError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('COMMAND_NOT_FOUND', `Required command not found: ${command}`)
    }
    throw error
  })

  if (!allowFailure && result.exitCode !== 0) {
    throw new AppError(
      command === 'git' ? 'GIT_COMMAND_FAILED' : 'COMMAND_FAILED',
      result.stderr.trim() || `${command} exited with ${result.exitCode}`,
      400,
      { command, args, exitCode: result.exitCode },
    )
  }
  return result
}
