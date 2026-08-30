import { createServer } from 'node:http'

const port = Number(process.env.DIFF_REVIEW_PORT ?? 47_658)
const host = process.env.DIFF_REVIEW_HOST ?? '127.0.0.1'

const server = createServer((request, response) => {
  if (request.url === '/api/health') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ app: 'diff-review', ok: true }))
    return
  }
  response.statusCode = 404
  response.end()
})

await new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(port, host, () => resolve())
})

const close = () => {
  server.close(() => process.exit(0))
}
process.on('SIGINT', close)
process.on('SIGTERM', close)
