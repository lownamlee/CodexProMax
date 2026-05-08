import { createApp, getApiPort } from './app'

const { app, close, rootPath } = createApp()
const port = getApiPort()

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Codex Pro Max API listening on http://127.0.0.1:${port}`)
  console.log(`Protocol root: ${rootPath}`)
})

server.on('close', () => {
  console.log('Codex Pro Max API server closed')
})

server.on('error', (error) => {
  console.error('Codex Pro Max API server error:', error)
})

;(globalThis as unknown as { __codexProMaxApiServer?: unknown }).__codexProMaxApiServer = server

async function shutdown(): Promise<void> {
  await close()
  server.close(() => {
    process.exit(0)
  })
}

process.on('SIGINT', () => {
  void shutdown()
})

process.on('SIGTERM', () => {
  void shutdown()
})
