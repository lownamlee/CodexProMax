// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MARKDOWN_WARN_BYTES,
  type ManagerSnapshot,
} from '../src/shared/protocol'
import { createApp, type CodexProMaxApp } from './app'
import { getRunPath, resolveProtocolRoot, writeInstructionAndStatus } from './protocolStore'

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
  vi.unstubAllEnvs()
})

describe('Codex Pro Max multi-run API', () => {
  it('defaults protocol state to a user-owned data root', () => {
    const dataRoot = path.join(rootPath, 'codex-pro-max-data')

    vi.stubEnv('CODEX_PRO_MAX_ROOT', '')
    vi.stubEnv('CODEX_PRO_MAX_DATA_ROOT', dataRoot)

    expect(resolveProtocolRoot()).toBe(dataRoot)
  })

  it('lets CODEX_PRO_MAX_ROOT override the data root', () => {
    const dataRoot = path.join(rootPath, 'codex-pro-max-data')
    const explicitRoot = path.join(rootPath, 'explicit-root')

    vi.stubEnv('CODEX_PRO_MAX_DATA_ROOT', dataRoot)
    vi.stubEnv('CODEX_PRO_MAX_ROOT', explicitRoot)

    expect(resolveProtocolRoot()).toBe(explicitRoot)
  })

  it('returns an empty manager snapshot when no runs exist', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/snapshot').expect(200)

    expect(response.body.rootPath).toBe(rootPath)
    expect(response.body.runs).toEqual([])
    expect(response.body.selectedRunId).toBeNull()
  })

  it('stores prank teammates in the backend', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    const initialResponse = await request(appHandle.app).get('/api/teammates').expect(200)

    expect(initialResponse.body.teammates.map((teammate: { name: string }) => teammate.name)).toEqual([
      'Cheeseburger',
      'Double Burger',
      'Chicken Burger',
      'Fish Burger',
      'Veggie Burger',
    ])
    expect(initialResponse.body.teammates.map((teammate: { email: string }) => teammate.email)).toEqual([
      'cheeseburger@codexpromax.com',
      'doubleburger@codexpromax.com',
      'chickenburger@codexpromax.com',
      'fishburger@codexpromax.com',
      'veggieburger@codexpromax.com',
    ])
    expect(new Set(initialResponse.body.teammates.map((teammate: { avatarUrl: string }) => teammate.avatarUrl)).size)
      .toBe(5)

    const inviteResponse = await request(appHandle.app)
      .post('/api/teammates')
      .send({ email: 'newburger@codexpromax.com' })
      .expect(201)

    expect(inviteResponse.body.teammates).toHaveLength(6)
    expect(inviteResponse.body.teammates[5]).toMatchObject({
      name: 'Invited Burger 1',
      email: 'newburger@codexpromax.com',
      role: 'Member',
      seat: 'Codex Pro Max',
    })
    expect(new Set(inviteResponse.body.teammates.map((teammate: { avatarUrl: string }) => teammate.avatarUrl)).size)
      .toBe(6)
    await expect(fs.readFile(path.join(rootPath, 'teammates.json'), 'utf8')).resolves.toContain(
      'newburger@codexpromax.com',
    )

    const secondInviteResponse = await request(appHandle.app)
      .post('/api/teammates')
      .send({ email: 'anotherburger@codexpromax.com' })
      .expect(201)
    expect(secondInviteResponse.body.teammates).toHaveLength(7)
    expect(new Set(secondInviteResponse.body.teammates.map((teammate: { avatarUrl: string }) => teammate.avatarUrl)).size)
      .toBe(7)

    await request(appHandle.app)
      .post('/api/teammates')
      .send({ email: 'fullburger@codexpromax.com' })
      .expect(400)

    const savedResponse = await request(appHandle.app).get('/api/teammates').expect(200)
    expect(savedResponse.body.teammates).toHaveLength(7)
  })

  it('ignores root-level protocol files', async () => {
    await fs.writeFile(path.join(rootPath, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(rootPath, 'output.md'), 'Root output', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/snapshot').expect(200)

    expect(response.body.runs).toEqual([])
  })

  it('ignores non-run folders inside the runs directory', async () => {
    const logsPath = path.join(rootPath, 'runs', 'logs')
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(logsPath, { recursive: true })
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(logsPath, 'codex-pro-max-dev.out.log'), 'server output\n', 'utf8')
    await fs.writeFile(path.join(logsPath, 'codex-pro-max-dev.err.log'), '', 'utf8')
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/snapshot').expect(200)

    expect(response.body.runs.map((run: { runId: string }) => run.runId)).toEqual(['run-a'])
    expect(response.body.selectedRunId).toBe('run-a')
  })

  it('defaults selection to the oldest run waiting for review', async () => {
    const oldReview = getRunPath(rootPath, 'old-review')
    const newRunning = getRunPath(rootPath, 'new-running')
    await fs.mkdir(oldReview, { recursive: true })
    await fs.mkdir(newRunning, { recursive: true })
    await fs.writeFile(path.join(oldReview, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(newRunning, 'status.txt'), 'RUNNING\n', 'utf8')
    await fs.utimes(path.join(oldReview, 'status.txt'), new Date('2026-05-07T00:00:00.000Z'), new Date('2026-05-07T00:00:00.000Z'))
    await fs.utimes(path.join(newRunning, 'status.txt'), new Date('2026-05-07T00:05:00.000Z'), new Date('2026-05-07T00:05:00.000Z'))
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/snapshot').expect(200)

    expect(response.body.runs.map((run: { runId: string }) => run.runId)).toEqual(['new-running', 'old-review'])
    expect(response.body.selectedRunId).toBe('old-review')
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

  it('accepts instructions for a stopped run so it can resume', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'STOPPED\n', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app)
      .post('/api/runs/run-a/action')
      .send({ instruction: 'Resume after stop.' })
      .expect(200)

    expect(response.body.snapshot.status).toBe('INSTRUCTION_RECEIVED')
    await expect(fs.readFile(path.join(runA, 'instruction.txt'), 'utf8')).resolves.toBe('Resume after stop.\n')
    await expect(fs.readFile(path.join(runA, 'status.txt'), 'utf8')).resolves.toBe('INSTRUCTION_RECEIVED\n')
    await expect(fs.readFile(path.join(runA, 'session.md'), 'utf8')).resolves.toContain('Resume after stop.')
  })

  it('deletes only the selected run folder', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    const runB = getRunPath(rootPath, 'run-b')
    await fs.mkdir(runA, { recursive: true })
    await fs.mkdir(runB, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runB, 'status.txt'), 'RUNNING\n', 'utf8')
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

  it('marks a selected run stopped through the stop session endpoint', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runA, 'output.md'), 'Current output.', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).post('/api/runs/run-a/stop').expect(200)

    expect(response.body.snapshot.runId).toBe('run-a')
    expect(response.body.snapshot.status).toBe('STOPPED')
    await expect(fs.readFile(path.join(runA, 'status.txt'), 'utf8')).resolves.toBe('STOPPED\n')
    await expect(fs.readFile(path.join(runA, 'instruction.txt'), 'utf8')).resolves.toBe('')
    await expect(fs.readFile(path.join(runA, 'output.md'), 'utf8')).resolves.toBe('Current output.')
    await expect(fs.readFile(path.join(runA, 'session.md'), 'utf8')).resolves.toContain(
      'Stop this Codex Pro Max session now.',
    )
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

  it('returns selected protocol file content for preview', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(runA, 'output.md'), '## Preview\n\nReady.', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/runs/run-a/files/output.md').expect(200)
    const statusResponse = await request(appHandle.app).get('/api/runs/run-a/files/status.txt').expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      fileName: 'output.md',
      content: '## Preview\n\nReady.',
      truncated: false,
      size: 18,
    })
    expect(statusResponse.body).toMatchObject({
      ok: true,
      fileName: 'status.txt',
      content: 'WAITING_FOR_REVIEW\n',
      truncated: false,
      size: 19,
    })
  })

  it('marks invalid statuses as error', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    await fs.mkdir(runA, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'UNKNOWN_STATUS\n', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app).get('/api/runs/run-a/snapshot').expect(200)

    expect(response.body.status).toBe('ERROR')
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
    expect(response.body.attachment).toMatchObject({
      mimeType: 'image/png',
      kind: 'image',
    })
    expect(runAAttachments).toHaveLength(1)
    expect(runBExists).toBe(false)
  })

  it('serves attachment previews from dot-prefixed protocol roots', async () => {
    const dotRootPath = path.join(rootPath, '.codex-pro-max')
    appHandle = createApp({ rootPath: dotRootPath, startWatcher: false })

    const uploadResponse = await request(appHandle.app)
      .post('/api/runs/run-a/upload')
      .attach('file', Buffer.from('fake png'), {
        filename: 'shot.png',
        contentType: 'image/png',
      })
      .expect(201)

    const fileName = uploadResponse.body.attachment.name
    const previewResponse = await request(appHandle.app)
      .get(`/api/runs/run-a/attachments/${encodeURIComponent(fileName)}`)
      .expect(200)

    expect(previewResponse.headers['content-type']).toMatch(/image\/png/)
    expect(previewResponse.text || previewResponse.body.toString()).toBe('fake png')
  })

  it('deletes one attachment without deleting the selected run', async () => {
    const runA = getRunPath(rootPath, 'run-a')
    const attachmentsPath = path.join(runA, 'attachments')
    await fs.mkdir(attachmentsPath, { recursive: true })
    await fs.writeFile(path.join(runA, 'status.txt'), 'WAITING_FOR_REVIEW\n', 'utf8')
    await fs.writeFile(path.join(attachmentsPath, 'evidence.png'), 'fake image', 'utf8')
    appHandle = createApp({ rootPath, startWatcher: false })

    const response = await request(appHandle.app)
      .delete('/api/runs/run-a/attachments/evidence.png')
      .expect(200)

    expect(response.body.snapshot.runId).toBe('run-a')
    expect(response.body.snapshot.attachments).toEqual([])
    await expect(pathExists(path.join(attachmentsPath, 'evidence.png'))).resolves.toBe(false)
    await expect(pathExists(runA)).resolves.toBe(true)
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

  it('accepts non-image attachments and rejects oversized uploads', async () => {
    appHandle = createApp({ rootPath, startWatcher: false })

    const textResponse = await request(appHandle.app)
      .post('/api/runs/run-a/upload')
      .attach('file', Buffer.from('not an image'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(201)

    expect(textResponse.body.attachment).toMatchObject({
      mimeType: 'text/plain',
      kind: 'text',
    })

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
