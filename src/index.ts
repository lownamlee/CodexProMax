import { createApp, getApiPort } from './app'

const { app, close, dataRoot, sessionsRoot } = createApp()
const port = getApiPort()

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Codex Pro Max Next API listening on http://127.0.0.1:${port}`)
  console.log(`Data root: ${dataRoot}`)
  console.log(`Codex sessions root: ${sessionsRoot}`)
})

server.on('error', (error) => {
  console.error('Codex Pro Max Next API server error:', error)
})

async function shutdown(): Promise<void> {
  close()
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
