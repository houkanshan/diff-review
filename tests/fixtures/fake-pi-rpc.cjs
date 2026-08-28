#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const args = process.argv.slice(2)
let sessionDir = ''
let sessionId = ''
let sessionFile = ''
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--session-dir') sessionDir = args[i + 1] ?? ''
  if (args[i] === '--session-id') sessionId = args[i + 1] ?? ''
  if (args[i] === '--session') sessionFile = args[i + 1] ?? ''
}
if (process.env.PI_TEST_OUTPUT) {
  fs.writeFileSync(
    process.env.PI_TEST_OUTPUT,
    [process.cwd(), execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(), ...args].join('\n'),
  )
}

function sessionPath() {
  if (sessionFile) return sessionFile
  fs.mkdirSync(sessionDir, { recursive: true })
  return path.join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`)
}

function append(entry) {
  const file = sessionPath()
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: sessionId, cwd: process.cwd() })}\n`)
  }
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`)
}

let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const index = buffer.indexOf('\n')
    if (index < 0) break
    let line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line) continue
    const command = JSON.parse(line)
    if (command.type !== 'prompt') continue
    const userId = Math.random().toString(16).slice(2, 10)
    const assistantId = Math.random().toString(16).slice(2, 10)
    append({
      type: 'message',
      id: userId,
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: command.message, timestamp: Date.now() },
    })
    process.stdout.write(`${JSON.stringify({ type: 'response', id: command.id, command: 'prompt', success: true })}\n`)
    process.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`)
    process.stdout.write(`${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello ' },
    })}\n`)
    process.stdout.write(`${JSON.stringify({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: command.message },
    })}\n`)
    process.stdout.write(`${JSON.stringify({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: `hello ${command.message}` }] },
    })}\n`)
    append({
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `hello ${command.message}` }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    })
    process.stdout.write(`${JSON.stringify({ type: 'agent_settled' })}\n`)
  }
})
process.stdin.resume()
