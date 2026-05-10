// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LEGACY_RUN_ID,
  MARKDOWN_WARN_BYTES,
  type ManagerSnapshot,
} from '../src/shared/protocol'
import { createApp, type CodexProMaxApp } from './app'
import { getRunPath, writeInstructionAndStatus } from './protocolStore'

let rootPath: string
let appHandle: CodexProMaxApp | null = null

beforeEach(async () => {
  rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pro-max-'))
})

afterEach(async () => {
  if (appHandle) {
    await appHandle.close()
    appHandle = null
  }
  await fs.rm(rootPath, { recursive: true, force: true })
})

describe('Codex Pro Max multi-run API', () => {
  it('returns an empty manager snapshot when no runs exist', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/snapshot').expect(200)

    expect(response.body.rootPath).toBe(rootPath)
    expect(response.body.runs).toEqual([])
    expect(response.body.selectedRunId).toBeNull()
  })

  it('exposes root-level protocol files as legacy-root', async () => {
    await fs.writeFile(path.join(rootPath, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(rootPath, 'output.md'), 'Legacy output', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/snapshot').expect(200)

    expect(response.body.runs).toHaveLength(1)
    expect(response.body.runs[0]).toMatchObject({
      runId: LEGACY_RUN_ID,
      displayName: 'Legacy Root',
      status: 'WAITING_FOR_REVIEW',
      isLegacy: true,
    })
  })

  it('keeps two runs isolated when actions are sent to one run', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    const runB = getRunPath(rootPath, 'run-b')
    await fs.mkdir(runA, { recursive: true })
    await fs.mkdir(runB, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runB, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runB, 'instruction.txt'), 'Do not touch.\n', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app)
      .post('/api/runs/run-a/action')
      .send({ instruction: 'Ship run A.' })
      .expect(200)

    expect(response.body.snapshot.runId).toBe('run-a')
    expect(response.body.snapshot.status).toBe('INSTRUCTION_RECEIVED')
    await expect(fs.readFile(path.join(runA, 'instruction.txt'), 'utf8')).resolves.toBe('Ship run A.\n')
    await expect(fs.readFile(path.join(runA, 'status.txt'), 'utf8')).resolves.toBe('INSTRUCTION_RECEIVED\n')
    await expect(fs.readFile(path.join(runA, 'session.md'), 'utf8')).resolves.toContain('Ship run A.')
    await expect(fs.readFile(path.join(runB, 'instruction.txt'), 'utf8')).resolves.toBe('Do not touch.\n')
    await expect(fs.readFile(path.join(runB, 'status.txt'), 'utf8')).resolves.toBe('WAITING_FOR_REVIEW\n')
  })

  it('deletes only the selected run folder', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    const runB = getRunPath(rootPath, 'run-b')
    await fs.mkdir(runA, { recursive: true })
    await fs.mkdir(runB, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runB, 'status.txt'), 'IDLE\n', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).delete('/api/runs/run-a').expect(200)

    expect(response.body.snapshot.runs.map((run: { runId: string }) => run.runId)).toEqual(['run-b'])
    await expect(pathExists(runA)).resolves.toBe(false)
    await expect(pathExists(runB)).resolves.toBe(true)
  })

  it('clears conversation history without closing the selected run', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runA, 'output.md'), 'Current output.', 'utf8')
    await fs.writeFile(path.join(runA, 'instruction.txt'), 'Pending instruction.\n', 'utf8')
    await fs.writeFile(
      path.join(runA, 'session.md'),
      '<!-- codex-pro-max:message {"id":"assistant-1","role":"assistant","createdAtIso":"2026-05-07T00:00:00.000Z"} -->\n## Codex - 2026-05-07T00:00:00.000Z\n\nPrevious answer.\n\n',
      'utf8',
    )
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).delete('/api/runs/run-a/messages').expect(200)

    expect(response.body.snapshot.runId).toBe('run-a')
    expect(response.body.snapshot.status).toBe('WAITING_FOR_REVIEW')
    expect(response.body.snapshot.outputMd).toBe('Current output.')
    expect(response.body.snapshot.instruction).toBe('Pending instruction.\n')
    expect(response.body.snapshot.messages).toEqual([])
    await expect(fs.readFile(path.join(runA, 'session.md'), 'utf8')).resolves.toBe('')
    await expect(pathExists(runA)).resolves.toBe(true)
  })

  it('requests a session stop through the selected run instruction channel', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runA, 'output.md'), 'Current output.', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).post('/api/runs/run-a/stop').expect(200)

    expect(response.body.snapshot.runId).toBe('run-a')
    expect(response.body.snapshot.status).toBe('INSTRUCTION_RECEIVED')
    await expect(fs.readFile(path.join(runA, 'instruction.txt'), 'utf8')).resolves.toBe(
      'Stop this Codex Pro Max HITL session now.\n',
    )
    await expect(fs.readFile(path.join(runA, 'output.md'), 'utf8')).resolves.toBe('Current output.')
    await expect(fs.readFile(path.join(runA, 'session.md'), 'utf8')).resolves.toContain(
      'Stop this Codex Pro Max HITL session now.',
    )
  })

  it('rejects deleting legacy-root', async () => {
    await fs.writeFile(path.join(rootPath, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).delete('/api/runs/legacy-root').expect(400)

    expect(response.body.error).toMatch(/legacy root cannot be deleted/i)
  })

  it('writes instruction before status through the injected writer', async () => {
    const writes: string[] = []
    const writer = vi.fn(async (filePath: string) => {
      writes.push(path.basename(filePath))
    })

    await writeInstructionAndStatus(getRunPath(rootPath, 'run-a'), 'Order matters.', 'INSTRUCTION_RECEIVED', writer)

    expect(writes).toEqual(['instruction.txt', 'status.txt'])
    expect(writer).toHaveBeenCalledTimes(2)
  })

  it('returns per-run snapshots and markdown safety metadata', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    const output = 'a'.repeat(MARKDOWN_WARN_BYTES + 1)
    await fs.writeFile(path.join(runA, 'output.md'), output, 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/runs/run-a/snapshot').expect(200)

    expect(response.body.outputMd).toHaveLength(output.length)
    expect(response.body.markdownSafety['output.md']).toMatchObject({
      warning: true,
      truncated: false,
    })
  })

  it('maps legacy approval statuses out of snapshots', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    const runB = getRunPath(rootPath, 'run-b')
    await fs.mkdir(runA, { recursive: true })
    await fs.mkdir(runB, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'APPROVED\n', 'utf8')
    await fs.writeFile(path.join(runA, 'instruction.txt'), 'Ship it.\n', 'utf8')
    await fs.writeFile(path.join(runB, 'status.txt'), 'REVISION_REQUESTED\n', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const runAResponse = await request(appHandle.app).get('/api/runs/run-a/snapshot').expect(200)
    const runBResponse = await request(appHandle.app).get('/api/runs/run-b/snapshot').expect(200)

    expect(runAResponse.body.status).toBe('INSTRUCTION_RECEIVED')
    expect(runBResponse.body.status).toBe('IDLE')
  })

  it('rejects unsafe run ids', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app)
      .post('/api/runs/bad%24id/action')
      .send({ instruction: 'Hello' })
      .expect(400)

    expect(response.body.ok).toBe(false)
  })

  it('rejects blank instructions', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app)
      .post('/api/runs/run-a/action')
      .send({ instruction: '   ' })
      .expect(400)

    expect(response.body.error).toMatch(/require instruction text/i)
  })

  it('uploads attachments only to the selected run', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app)
      .post('/api/runs/run-a/upload')
      .attach('file', Buffer.from('fake png'), {
        filename: 'shot.png',
        contentType: 'image/png',
      })
      .expect(201)

    const runAAttachments = await fs.readdir(path.join(getRunPath(rootPath, 'run-a'), 'attachments'))
    const runBExists = await pathExists(path.join(getRunPath(rootPath, 'run-b'), 'attachments'))

    expect(response.body.snapshot.runId).toBe('run-a')
    expect(runAAttachments).toHaveLength(1)
    expect(runBExists).toBe(false)
  })

  it('logs user messages and watched protocol file changes', async () => {
    appHandle = createApp({ rootPath })
    await waitForWatcher(appHandle)

    await request(appHandle.app)
      .post('/api/runs/run-a/action')
      .send({ instruction: 'Continue from the latest checkpoint.' })
      .expect(200)

    const runA = getRunPath(rootPath, 'run-a')
    const userMessage = await readAuditEventUntil(runA, (event) => event.type === 'user.message')
    expect(userMessage).toMatchObject({
      status: 'INSTRUCTION_RECEIVED',
      instruction: 'Continue from the latest checkpoint.',
    })
    await expect(fs.readFile(path.join(runA, 'session.md'), 'utf8')).resolves.toContain(
      'Continue from the latest checkpoint.',
    )

    await fs.writeFile(path.join(runA, 'output.md'), '## Agent Output\n\nReady for review.', 'utf8')

    const outputChange = await readAuditEventUntil(
      runA,
      (event) => event.type === 'protocol.file.changed' && event.fileName === 'output.md',
    )
    expect(outputChange).toMatchObject({
      event: 'add',
      fileName: 'output.md',
      preview: '## Agent Output Ready for review.',
    })
  })

  it('rejects non-image and oversized uploads', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    await request(appHandle.app)
      .post('/api/runs/run-a/upload')
      .attach('file', Buffer.from('not an image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(400)

    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1)
    const response = await request(appHandle.app)
      .post('/api/runs/run-a/upload')
      .attach('file', oversized, {
        filename: 'huge.png',
        contentType: 'image/png',
      })
      .expect(413)

    expect(response.body.error).toMatch(/10MB/i)
  })

  it('emits an initial SSE manager snapshot and a later run update', async () => {
    appHandle = createApp({ rootPath })
    const server = await listen(appHandle.app)
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected an ephemeral HTTP port.')
    }

    const waitForStatus = readSseUntil(
      `http://127.0.0.1:${address.port}/api/events`,
      (snapshot) => snapshot.runs.some((run) => run.runId === 'run-a' && run.status === 'WAITING_FOR_REVIEW'),
    )

    await delay(200)
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')

    await expect(waitForStatus).resolves.toMatchObject({
      selectedRunId: 'run-a',
    })

    await closeServer(server)
  })
})

function listen(app: CodexProMaxApp['app']): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function readSseUntil(
  url: string,
  predicate: (snapshot: ManagerSnapshot, count: number) => boolean,
): Promise<ManagerSnapshot> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 4_000)

  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new Error(`SSE request failed with ${response.status}`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let count = 0

    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        throw new Error('SSE stream closed before predicate matched.')
      }

      buffer += decoder.decode(value, { stream: true })
      let separatorIndex = buffer.indexOf('\n\n')

      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        separatorIndex = buffer.indexOf('\n\n')

        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')

        if (data) {
          count += 1
          const snapshot = JSON.parse(data) as ManagerSnapshot
          if (predicate(snapshot, count)) {
            await reader.cancel()
            return snapshot
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function waitForWatcher(handle: CodexProMaxApp): Promise<void> {
  const started = Date.now()
  while (!handle.hub.watcherReady) {
    if (Date.now() - started > 4_000) {
      throw new Error('Watcher did not become ready.')
    }
    await delay(25)
  }
}

async function readAuditEventUntil(
  runPath: string,
  predicate: (event: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const eventsPath = path.join(runPath, 'events.ndjson')
  const started = Date.now()

  while (Date.now() - started < 4_000) {
    try {
      const raw = await fs.readFile(eventsPath, 'utf8')
      const events = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const match = events.find(predicate)
      if (match) {
        return match
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error
      }
    }
    await delay(25)
  }

  throw new Error('Audit event was not written.')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
