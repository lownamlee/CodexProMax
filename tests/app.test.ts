import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type CodexProMaxNextApp } from '../src/app'

let tempRoot = ''
let dataRoot = ''
let sessionsRoot = ''
let handle: CodexProMaxNextApp | null = null

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-pro-max-next-'))
  dataRoot = path.join(tempRoot, 'data')
  sessionsRoot = path.join(tempRoot, 'codex-sessions')
})

afterEach(async () => {
  if (handle) {
    handle.close()
    handle = null
  }
  await fs.rm(tempRoot, { recursive: true, force: true })
})

describe('Codex Pro Max Next API', () => {
  it('exposes simple health endpoints', async () => {
    handle = createApp({ dataRoot, sessionsRoot })

    const health = await request(handle.app).get('/api/health').expect(200)
    const healthy = await request(handle.app).get('/api/healthy').expect(200)

    expect(health.body).toMatchObject({
      ok: true,
      service: 'codex-pro-max-next',
      dataRoot,
      sessionsRoot,
    })
    expect(healthy.body).toEqual({ ok: true })
  })

  it('resolves rollout path and Codex live session id from a thread id', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    const rolloutPath = await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })

    const response = await request(handle.app)
      .get(`/api/codex-live/rollout?threadId=${encodeURIComponent(`"${threadId.replaceAll('-', '')}"`)}`)
      .expect(200)
    const pathOnly = await request(handle.app)
      .get(`/api/codex-live/rollout/${threadId}?format=path`)
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      codexThreadId: threadId,
      rootPath: sessionsRoot,
      rolloutPath,
      matchCount: 1,
      session: {
        id: Buffer.from(`2026/05/21/${path.basename(rolloutPath)}`, 'utf8').toString('base64url'),
        relativePath: `2026/05/21/${path.basename(rolloutPath)}`,
      },
    })
    expect(pathOnly.text).toBe(`${rolloutPath}\n`)
  })

  it('creates a Codex session, records a conclusion, waits, and consumes a queued instruction', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    const rolloutPath = await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })

    const createResponse = await request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}`)
      .send({ displayName: 'Current Codex conversation' })
      .expect(201)

    const sessionId = createResponse.body.session.id as string
    expect(createResponse.body.session).toMatchObject({
      codexThreadId: threadId,
      rolloutPath,
      status: 'RUNNING',
      displayName: 'Current Codex conversation',
    })
    expect(createResponse.body.session.codexLiveSessionId).toBeTruthy()

    const conclusionResponse = await request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/conclusion`)
      .send({ content: 'Built the requested website.' })
      .expect(201)

    expect(conclusionResponse.body.session.status).toBe('WAITING_FOR_INSTRUCTION')
    expect(conclusionResponse.body.conclusion.content).toBe('Built the requested website.')

    const waitResponsePromise = request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/wait?timeoutMs=2000`)
      .send({})
      .expect(200)

    await delay(50)

    const queued = await request(handle.app)
      .post(`/api/sessions/${sessionId}/instructions`)
      .send({ content: 'Now add a contact form.' })
      .expect(201)

    expect(queued.body.instruction.consumedAt).toBeNull()

    const waitResponse = await waitResponsePromise
    expect(waitResponse.body).toMatchObject({
      ok: true,
      timedOut: false,
      instruction: {
        content: 'Now add a contact form.',
      },
      session: {
        status: 'RUNNING',
      },
    })
    expect(waitResponse.body.instruction.consumedAt).toBeTruthy()

    const detail = await request(handle.app).get(`/api/sessions/${sessionId}`).expect(200)
    expect(detail.body.session.messages.map((message: { role: string; content: string }) => [message.role, message.content]))
      .toEqual([
        ['codex', 'Built the requested website.'],
        ['user', 'Now add a contact form.'],
      ])
    expect(detail.body.session.instructions[0].consumedAt).toBeTruthy()
  })

  it('broadcasts one queued instruction to every active wait request', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    await request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/conclusion`)
      .send({ content: 'Ready for the next instruction.' })
      .expect(201)

    const firstWait = request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/wait`)
      .send({})
      .expect(200)
      .then((response) => response)
    const secondWait = request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/wait`)
      .send({})
      .expect(200)
      .then((response) => response)

    await delay(50)

    await request(handle.app)
      .post(`/api/sessions/${sessionId}/instructions`)
      .send({ content: 'Deliver this to every waiter.' })
      .expect(201)

    const [firstResponse, secondResponse] = await Promise.all([firstWait, secondWait])
    expect(firstResponse.body).toMatchObject({
      ok: true,
      timedOut: false,
      instruction: {
        content: 'Deliver this to every waiter.',
      },
    })
    expect(secondResponse.body).toMatchObject({
      ok: true,
      timedOut: false,
      instruction: {
        content: 'Deliver this to every waiter.',
      },
    })
    expect(firstResponse.body.instruction.id).toBe(secondResponse.body.instruction.id)

    const detail = await request(handle.app).get(`/api/sessions/${sessionId}`).expect(200)
    expect(detail.body.session.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1)
  })

  it('reads conversation usage and rate limits from the current rollout', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId, [
      JSON.stringify({
        timestamp: '2026-05-21T07:34:12.705Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: {
              input_tokens: 500,
              cached_input_tokens: 100,
              output_tokens: 80,
              reasoning_output_tokens: 20,
              total_tokens: 600,
            },
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 200,
              output_tokens: 300,
              reasoning_output_tokens: 50,
              total_tokens: 1350,
            },
          },
          rate_limits: {
            limit_id: 'codex',
            plan_type: 'plus',
            rate_limit_reached_type: null,
            primary: {
              used_percent: 22,
              window_minutes: 300,
              resets_at: 1779366112,
            },
            secondary: {
              used_percent: 26,
              window_minutes: 10080,
              resets_at: 1779835796,
            },
            credits: null,
          },
        },
      }),
    ])
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)

    const response = await request(handle.app)
      .get(`/api/sessions/${createResponse.body.session.id}/usage`)
      .expect(200)

    expect(response.body.usage).toMatchObject({
      contextWindow: 258400,
      usedTokens: 600,
      inputTokens: 500,
      rateLimits: {
        primary: {
          usedPercent: 22,
          remainingPercent: 78,
          windowMinutes: 300,
        },
        secondary: {
          usedPercent: 26,
          remainingPercent: 74,
          windowMinutes: 10080,
        },
      },
    })
    expect(response.body.activity).toMatchObject({
      hasRolloutActivity: true,
      latestRecordType: 'event_msg',
      latestEventAt: '2026-05-21T07:34:12.705Z',
    })
  })

  it('returns current-turn assistant rollout messages for the thinking box', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId, [
      JSON.stringify({
        timestamp: '2026-05-21T07:34:10.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Old assistant message.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-21T07:34:11.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Implement the request.',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-21T07:34:12.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ text: 'Hidden reasoning should not show.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-21T07:34:13.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking the new UI path.' }],
        },
      }),
    ])
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)

    const response = await request(handle.app)
      .get(`/api/sessions/${createResponse.body.session.id}/usage`)
      .expect(200)

    expect(response.body.thinkingRecords.map((record: { text: string }) => record.text)).toEqual([
      'Checking the new UI path.',
    ])
  })

  it('filters rollout thinking records before the latest SQLite user message', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    const oldAssistantAt = new Date(Date.now() - 60_000).toISOString()
    const currentAssistantAt = new Date(Date.now() + 60_000).toISOString()
    await writeRollout(threadId, [
      JSON.stringify({
        timestamp: oldAssistantAt,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Assistant message before latest user.' }],
        },
      }),
      JSON.stringify({
        timestamp: currentAssistantAt,
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Assistant message after latest user.' }],
        },
      }),
    ])
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    await request(handle.app)
      .post(`/api/sessions/${sessionId}/instructions`)
      .send({ content: 'Latest user instruction.' })
      .expect(201)
    await request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/wait`)
      .send({})
      .expect(200)

    const response = await request(handle.app)
      .get(`/api/sessions/${sessionId}/usage`)
      .expect(200)

    expect(response.body.thinkingRecords.map((record: { text: string }) => record.text)).toEqual([
      'Assistant message after latest user.',
    ])
  })

  it('finds latest usage before oversized rollout records', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId, [
      JSON.stringify({
        timestamp: '2026-05-21T07:34:12.705Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 1000,
            last_token_usage: {
              total_tokens: 250,
            },
            total_token_usage: {
              total_tokens: 5000,
            },
          },
          rate_limits: null,
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-21T07:34:13.705Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          encrypted_content: 'x'.repeat(2 * 1024 * 1024 + 1024),
        },
      }),
    ])
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)

    const response = await request(handle.app)
      .get(`/api/sessions/${createResponse.body.session.id}/usage`)
      .expect(200)

    expect(response.body.usage).toMatchObject({
      contextWindow: 1000,
      usedTokens: 250,
      percentUsed: 25,
    })
  })

  it('returns a timeout without creating a delivered instruction state', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)

    const response = await request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/wait?timeoutMs=25`)
      .send({})
      .expect(200)

    expect(response.body).toMatchObject({
      ok: true,
      timedOut: true,
      instruction: null,
      session: {
        status: 'WAITING_FOR_INSTRUCTION',
      },
    })
  })

  it('clears conversation records without deleting queued instruction records', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    await request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/conclusion`)
      .send({ content: 'First conclusion.' })
      .expect(201)
    await request(handle.app)
      .post(`/api/sessions/${sessionId}/instructions`)
      .send({ content: 'Queued but not consumed.' })
      .expect(201)

    const response = await request(handle.app).delete(`/api/sessions/${sessionId}/messages`).expect(200)

    expect(response.body.session.messages).toEqual([])
    expect(response.body.session.conclusions).toEqual([])
    expect(response.body.session.instructions).toHaveLength(1)
    expect(response.body.session.instructions[0]).toMatchObject({
      content: 'Queued but not consumed.',
      consumedAt: null,
    })
  })

  it('limits a session to ten queued instructions', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    for (let index = 0; index < 10; index += 1) {
      await request(handle.app)
        .post(`/api/sessions/${sessionId}/instructions`)
        .send({ content: `Queued instruction ${index + 1}` })
        .expect(201)
    }

    const response = await request(handle.app)
      .post(`/api/sessions/${sessionId}/instructions`)
      .send({ content: 'This should be rejected.' })
      .expect(409)

    expect(response.body.error).toContain('Instruction queue is full')
  })

  it('updates and deletes queued instructions before Codex consumes them', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    const first = await request(handle.app)
      .post(`/api/sessions/${sessionId}/instructions`)
      .send({ content: 'Draft instruction.' })
      .expect(201)
    const second = await request(handle.app)
      .post(`/api/sessions/${sessionId}/instructions`)
      .send({ content: 'Delete me.' })
      .expect(201)

    const updated = await request(handle.app)
      .patch(`/api/sessions/${sessionId}/instructions/${first.body.instruction.id}`)
      .send({ content: 'Updated instruction.' })
      .expect(200)
    expect(updated.body.instruction).toMatchObject({
      content: 'Updated instruction.',
      consumedAt: null,
    })

    const deleted = await request(handle.app)
      .delete(`/api/sessions/${sessionId}/instructions/${second.body.instruction.id}`)
      .expect(200)
    expect(deleted.body.deleted).toBe(true)
    expect(deleted.body.deletedInstruction.content).toBe('Delete me.')
    expect(deleted.body.session.instructions.map((item: { content: string }) => item.content))
      .toEqual(['Updated instruction.'])

    const wait = await request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/wait`)
      .send({ timeoutMs: 25 })
      .expect(200)
    expect(wait.body.instruction.content).toBe('Updated instruction.')
  })

  it('stops a session and wakes a waiting Codex caller without consuming an instruction', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    const waitResponsePromise = request(handle.app)
      .post(`/api/codex/sessions/by-thread/${threadId}/wait?timeoutMs=2000`)
      .send({})
      .expect(200)

    await delay(50)

    const stopResponse = await request(handle.app).post(`/api/sessions/${sessionId}/stop`).expect(200)
    expect(stopResponse.body.session.status).toBe('STOPPED')

    const waitResponse = await waitResponsePromise
    expect(waitResponse.body).toMatchObject({
      ok: true,
      timedOut: false,
      stopped: true,
      instruction: null,
      session: {
        status: 'STOPPED',
      },
    })
  })

  it('stores user attachments under the managed data root', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    const upload = await request(handle.app)
      .post(`/api/sessions/${sessionId}/attachments`)
      .attach('file', Buffer.from('attachment bytes'), {
        filename: 'evidence.txt',
        contentType: 'text/plain',
      })
      .expect(201)

    expect(upload.body.attachment).toMatchObject({
      sessionId,
      mimeType: 'text/plain',
      sizeBytes: 16,
    })
    expect(upload.body.attachment.originalName).toMatch(/^evidence-\d{8}-\d{6}-\d{3}\.txt$/)
    expect(upload.body.attachment.storagePath).toContain(path.join(dataRoot, 'attachments', sessionId))
    await expect(fs.readFile(upload.body.attachment.storagePath, 'utf8')).resolves.toBe('attachment bytes')

    const download = await request(handle.app)
      .get(`/api/sessions/${sessionId}/attachments/${upload.body.attachment.id}`)
      .expect(200)
    expect(download.text).toBe('attachment bytes')
  })

  it('deletes one attachment and deletes session attachment files with the session', async () => {
    const threadId = '019e4914-8bbe-7d70-9e55-3ec6fc52d221'
    await writeRollout(threadId)
    handle = createApp({ dataRoot, sessionsRoot })
    const createResponse = await request(handle.app).post(`/api/codex/sessions/by-thread/${threadId}`).send({}).expect(201)
    const sessionId = createResponse.body.session.id as string

    const firstUpload = await request(handle.app)
      .post(`/api/sessions/${sessionId}/attachments`)
      .attach('file', Buffer.from('first'), {
        filename: 'first.txt',
        contentType: 'text/plain',
      })
      .expect(201)
    const secondUpload = await request(handle.app)
      .post(`/api/sessions/${sessionId}/attachments`)
      .attach('file', Buffer.from('second'), {
        filename: 'second.txt',
        contentType: 'text/plain',
      })
      .expect(201)

    const firstPath = firstUpload.body.attachment.storagePath as string
    const secondPath = secondUpload.body.attachment.storagePath as string
    await request(handle.app)
      .delete(`/api/sessions/${sessionId}/attachments/${firstUpload.body.attachment.id}`)
      .expect(200)

    await expect(pathExists(firstPath)).resolves.toBe(false)
    await expect(pathExists(secondPath)).resolves.toBe(true)

    const deleteResponse = await request(handle.app).delete(`/api/sessions/${sessionId}`).expect(200)
    expect(deleteResponse.body.deleted).toBe(true)
    await expect(pathExists(path.join(dataRoot, 'attachments', sessionId))).resolves.toBe(false)
  })
})

async function writeRollout(threadId: string, lines: string[] = []): Promise<string> {
  const fileName = `rollout-2026-05-21T13-49-08-${threadId}.jsonl`
  const filePath = path.join(sessionsRoot, '2026', '05', '21', fileName)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, ['{"type":"session_meta"}', ...lines].join('\n') + '\n', 'utf8')
  return filePath
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}
