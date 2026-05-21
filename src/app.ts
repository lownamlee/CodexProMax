import express, { type ErrorRequestHandler } from 'express'
import multer from 'multer'
import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexProMaxStore } from './database'
import { HttpError, isNodeError } from './errors'
import { findRolloutByCodexThreadId, getDefaultCodexSessionsRoot, validateCodexThreadId } from './rolloutResolver'
import type { RolloutLookup, SessionRecord } from './types'
import { WaitHub } from './waitHub'
import { readCodexLiveSessionState } from './codexLiveUsage'

const DEFAULT_PORT = 53127
const MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_QUEUED_INSTRUCTIONS = 10

export interface CreateAppOptions {
  dataRoot?: string
  dbPath?: string
  sessionsRoot?: string
}

export interface CodexProMaxNextApp {
  app: express.Express
  store: CodexProMaxStore
  waitHub: WaitHub
  dataRoot: string
  sessionsRoot: string
  close: () => void
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
})

export function createApp(options: CreateAppOptions = {}): CodexProMaxNextApp {
  const dataRoot = path.resolve(options.dataRoot ?? getDefaultDataRoot())
  const sessionsRoot = path.resolve(options.sessionsRoot ?? getDefaultCodexSessionsRoot())
  const store = new CodexProMaxStore({ dataRoot, dbPath: options.dbPath })
  const waitHub = new WaitHub()
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '2mb' }))

  app.get('/api/health', (_request, response) => {
    response.json({
      ok: true,
      service: 'codex-pro-max-next',
      dataRoot,
      dbPath: store.dbPath,
      sessionsRoot,
      serverTimeIso: new Date().toISOString(),
    })
  })

  app.get('/api/healthy', (_request, response) => {
    response.json({ ok: true })
  })

  app.get('/api/codex-live/rollout', async (request, response) => {
    const threadId = parseThreadId(readQueryString(request.query.threadId ?? request.query.codexThreadId))
    const rollout = await getRequiredRollout(threadId, sessionsRoot)
    sendRollout(response, request, rollout)
  })

  app.get('/api/codex-live/rollout/:threadId', async (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    const rollout = await getRequiredRollout(threadId, sessionsRoot)
    sendRollout(response, request, rollout)
  })

  app.get('/api/sessions', (_request, response) => {
    response.json({
      ok: true,
      sessions: store.listSessionSummaries(),
    })
  })

  app.get('/api/sessions/:sessionId', (request, response) => {
    response.json({
      ok: true,
      session: getSessionDetailOrThrow(store, request.params.sessionId),
    })
  })

  app.get('/api/sessions/:sessionId/usage', async (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const liveState = await readSessionLiveState(session, store.getLatestUserMessageCreatedAt(session.id))
    response.json({
      ok: true,
      usage: liveState.usage,
      activity: liveState.activity,
      thinkingRecords: liveState.thinkingRecords,
    })
  })

  app.delete('/api/sessions/:sessionId', async (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const deleted = store.deleteSession(session.id)
    if (deleted) {
      await fs.rm(store.getSessionAttachmentsRoot(session.id), { recursive: true, force: true })
      waitHub.notify(session.id)
    }
    response.json({
      ok: true,
      deleted,
      sessions: store.listSessionSummaries(),
    })
  })

  app.delete('/api/sessions/by-thread/:threadId', async (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    const session = getSessionByThreadOrThrow(store, threadId)
    const deleted = store.deleteSession(session.id)
    if (deleted) {
      await fs.rm(store.getSessionAttachmentsRoot(session.id), { recursive: true, force: true })
      waitHub.notify(session.id)
    }
    response.json({
      ok: true,
      deleted,
      sessions: store.listSessionSummaries(),
    })
  })

  app.delete('/api/sessions/:sessionId/messages', (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    store.clearConversation(session.id)
    response.json({
      ok: true,
      session: store.getSessionDetailById(session.id),
    })
  })

  app.post('/api/sessions/:sessionId/stop', (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const stopped = store.markSessionStatus(session.id, 'STOPPED')
    waitHub.notify(session.id)
    response.json({
      ok: true,
      session: stopped,
    })
  })

  app.post('/api/sessions/by-thread/:threadId/stop', (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    const session = getSessionByThreadOrThrow(store, threadId)
    const stopped = store.markSessionStatus(session.id, 'STOPPED')
    waitHub.notify(session.id)
    response.json({
      ok: true,
      session: stopped,
    })
  })

  app.post('/api/sessions/:sessionId/instructions', (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const content = parseContent(request.body, 'Instruction')
    assertQueueCapacity(store, session.id)
    const instruction = store.enqueueInstruction(session.id, content)
    waitHub.notify(session.id, instruction.id)
    response.status(201).json({
      ok: true,
      instruction,
      session: store.getSessionById(session.id),
    })
  })

  app.patch('/api/sessions/:sessionId/instructions/:instructionId', (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const content = parseContent(request.body, 'Instruction')
    const instruction = store.updateQueuedInstruction(
      session.id,
      parseId(request.params.instructionId, 'Instruction id'),
      content,
    )
    if (!instruction) {
      throw new HttpError(404, 'Queued instruction not found.')
    }

    response.json({
      ok: true,
      instruction,
      session: store.getSessionDetailById(session.id),
    })
  })

  app.delete('/api/sessions/:sessionId/instructions/:instructionId', (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const deletedInstruction = store.deleteQueuedInstruction(
      session.id,
      parseId(request.params.instructionId, 'Instruction id'),
    )

    response.json({
      ok: true,
      deleted: Boolean(deletedInstruction),
      deletedInstruction,
      session: store.getSessionDetailById(session.id),
    })
  })

  app.post('/api/sessions/by-thread/:threadId/instructions', (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    const session = getSessionByThreadOrThrow(store, threadId)
    const content = parseContent(request.body, 'Instruction')
    assertQueueCapacity(store, session.id)
    const instruction = store.enqueueInstruction(session.id, content)
    waitHub.notify(session.id, instruction.id)
    response.status(201).json({
      ok: true,
      instruction,
      session: store.getSessionById(session.id),
    })
  })

  app.post('/api/sessions/:sessionId/attachments', upload.single('file'), async (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const file = request.file
    if (!file) {
      throw new HttpError(400, 'Attachment upload requires a file field named "file".')
    }

    const attachment = await saveAttachment(store, session.id, file)
    response.status(201).json({
      ok: true,
      attachment,
    })
  })

  app.get('/api/sessions/:sessionId/attachments/:attachmentId', (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const attachment = store.getAttachmentById(parseId(request.params.attachmentId, 'Attachment id'))
    if (!attachment || attachment.sessionId !== session.id) {
      throw new HttpError(404, 'Attachment not found.')
    }
    response.sendFile(attachment.storagePath, { dotfiles: 'allow' })
  })

  app.delete('/api/sessions/:sessionId/attachments/:attachmentId', async (request, response) => {
    const session = getSessionOrThrow(store, request.params.sessionId)
    const attachment = store.deleteAttachment(session.id, parseId(request.params.attachmentId, 'Attachment id'))
    if (!attachment) {
      throw new HttpError(404, 'Attachment not found.')
    }

    await fs.rm(attachment.storagePath, { force: true })
    response.json({
      ok: true,
      deletedAttachment: attachment,
      session: store.getSessionDetailById(session.id),
    })
  })

  app.post('/api/codex/sessions', async (request, response) => {
    const threadId = parseThreadId(readBodyString(request.body, 'codexThreadId'))
    const session = await createOrResumeSession(store, sessionsRoot, threadId, readBodyString(request.body, 'displayName'))
    response.status(201).json({
      ok: true,
      session,
    })
  })

  app.post('/api/codex/sessions/by-thread/:threadId', async (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    const session = await createOrResumeSession(store, sessionsRoot, threadId, readBodyString(request.body, 'displayName'))
    response.status(201).json({
      ok: true,
      session,
    })
  })

  app.get('/api/codex/sessions/by-thread/:threadId', (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    response.json({
      ok: true,
      session: getSessionByThreadOrThrow(store, threadId),
    })
  })

  app.post('/api/codex/sessions/by-thread/:threadId/conclusion', async (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    const session = await ensureSessionForCodex(store, sessionsRoot, threadId)
    const content = parseContent(request.body, 'Conclusion')
    const conclusion = store.recordConclusion(session.id, content)
    response.status(201).json({
      ok: true,
      conclusion,
      session: store.getSessionById(session.id),
    })
  })

  app.post('/api/codex/sessions/by-thread/:threadId/wait', async (request, response) => {
    const threadId = parseThreadId(request.params.threadId)
    const session = await ensureSessionForCodex(store, sessionsRoot, threadId)
    const timeoutMs = readWaitTimeout(Number(request.query.timeoutMs || readBodyNumber(request.body, 'timeoutMs') || 0))

    if (session.status === 'STOPPED') {
      response.json({
        ok: true,
        timedOut: false,
        stopped: true,
        instruction: null,
        session,
      })
      return
    }

    const immediateInstruction = store.consumeNextInstruction(session.id)
    if (immediateInstruction) {
      response.json({
        ok: true,
        timedOut: false,
        stopped: false,
        instruction: immediateInstruction,
        session: store.getSessionById(session.id),
      })
      return
    }

    store.markSessionStatus(session.id, 'WAITING_FOR_INSTRUCTION')
    const waitResult = await waitHub.wait(session.id, timeoutMs)

    const instruction = waitResult.instructionId
      ? store.consumeInstructionById(session.id, waitResult.instructionId) ?? store.getInstructionById(waitResult.instructionId)
      : store.consumeNextInstruction(session.id)
    const nextSession = store.getSessionById(session.id)
    response.json({
      ok: true,
      timedOut: !waitResult.notified && !instruction,
      stopped: nextSession?.status === 'STOPPED',
      instruction,
      session: nextSession,
    })
  })

  const clientIndexPath = path.join(process.cwd(), 'dist', 'index.html')
  if (nodeFs.existsSync(clientIndexPath)) {
    app.use(express.static(path.dirname(clientIndexPath)))
    app.use((request, response, next) => {
      if (request.path.startsWith('/api/')) {
        next()
        return
      }
      response.sendFile(clientIndexPath)
    })
  }

  app.use((_request, response) => {
    response.status(404).json({ ok: false, error: 'Not found' })
  })

  app.use(errorHandler)

  return {
    app,
    store,
    waitHub,
    dataRoot,
    sessionsRoot,
    close: () => {
      waitHub.close()
      store.close()
    },
  }
}

function assertQueueCapacity(store: CodexProMaxStore, sessionId: string): void {
  if (store.countQueuedInstructions(sessionId) >= MAX_QUEUED_INSTRUCTIONS) {
    throw new HttpError(409, `Instruction queue is full. A session can have up to ${MAX_QUEUED_INSTRUCTIONS} queued messages.`)
  }
}

export function getApiPort(): number {
  const raw = process.env.CODEX_PRO_MAX_NEXT_PORT || process.env.CODEX_PRO_MAX_API_PORT
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_PORT
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT
}

function getDefaultDataRoot(): string {
  return process.env.CODEX_PRO_MAX_NEXT_ROOT
    || process.env.CODEX_PRO_MAX_DATA_ROOT
    || path.join(os.homedir(), '.codex-pro-max-next')
}

async function createOrResumeSession(
  store: CodexProMaxStore,
  sessionsRoot: string,
  threadId: string,
  displayName = '',
): Promise<SessionRecord> {
  const rollout = await getRequiredRollout(threadId, sessionsRoot)
  return store.upsertSession({
    codexThreadId: threadId,
    rollout,
    displayName,
  })
}

async function ensureSessionForCodex(
  store: CodexProMaxStore,
  sessionsRoot: string,
  threadId: string,
): Promise<SessionRecord> {
  const existing = store.getSessionByThreadId(threadId)
  if (existing) return existing
  return createOrResumeSession(store, sessionsRoot, threadId)
}

async function getRequiredRollout(threadId: string, sessionsRoot: string): Promise<RolloutLookup> {
  const rollout = await findRolloutByCodexThreadId(threadId, sessionsRoot)
  if (!rollout) {
    throw new HttpError(404, `No rollout log found for Codex thread id '${threadId}'.`)
  }
  return rollout
}

async function readSessionLiveState(session: SessionRecord, latestUserMessageCreatedAt: string | null = null) {
  const empty = {
    usage: null,
    activity: {
      latestEventAt: null,
      latestRecordType: '',
      hasRolloutActivity: false,
    },
    thinkingRecords: [],
  }
  if (!session.rolloutPath) return empty
  try {
    return filterLiveThinkingAfterLatestUser(
      await readCodexLiveSessionState(session.rolloutPath),
      latestUserMessageCreatedAt,
    )
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return empty
    }
    throw error
  }
}

async function filterLiveThinkingAfterLatestUser(
  liveState: Awaited<ReturnType<typeof readCodexLiveSessionState>>,
  latestUserMessageCreatedAt: string | null,
) {
  const latestUserTimeMs = latestUserMessageCreatedAt ? Date.parse(latestUserMessageCreatedAt) : Number.NaN
  if (!Number.isFinite(latestUserTimeMs)) return liveState

  return {
    ...liveState,
    thinkingRecords: liveState.thinkingRecords.filter((record) => {
      const recordTimeMs = Date.parse(record.timestamp)
      return !Number.isFinite(recordTimeMs) || recordTimeMs >= latestUserTimeMs
    }),
  }
}

function sendRollout(response: express.Response, request: express.Request, rollout: RolloutLookup): void {
  if (wantsPathOnly(request)) {
    response.type('text/plain').send(`${rollout.rolloutPath}\n`)
    return
  }

  response.json({
    ok: true,
    codexThreadId: rollout.codexThreadId,
    rootPath: rollout.rootPath,
    rolloutPath: rollout.rolloutPath,
    codexLiveSessionId: rollout.codexLiveSessionId,
    session: {
      id: rollout.codexLiveSessionId,
      fileName: rollout.fileName,
      relativePath: rollout.relativePath,
      createdAtIso: rollout.createdAtIso,
      updatedAtIso: rollout.updatedAtIso,
      sizeBytes: rollout.sizeBytes,
    },
    matchCount: rollout.matchCount,
  })
}

async function saveAttachment(store: CodexProMaxStore, sessionId: string, file: Express.Multer.File) {
  const sessionAttachmentsRoot = store.getSessionAttachmentsRoot(sessionId)
  await fs.mkdir(sessionAttachmentsRoot, { recursive: true })
  const storedName = `${Date.now()}-${randomUUID()}${safeExtension(file.originalname)}`
  const storagePath = path.resolve(sessionAttachmentsRoot, storedName)
  const relative = path.relative(sessionAttachmentsRoot, storagePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'Unsafe attachment path.')
  }

  await fs.writeFile(storagePath, file.buffer)
  return store.createAttachment({
    sessionId,
    originalName: createAttachmentDisplayName(file.originalname || 'attachment'),
    storedName,
    mimeType: file.mimetype || 'application/octet-stream',
    sizeBytes: file.size,
    storagePath,
  })
}

function createAttachmentDisplayName(fileName: string, now = new Date()): string {
  const extension = safeExtension(fileName)
  const rawStem = path.basename(fileName || 'attachment', path.extname(fileName || ''))
  const stem = sanitizeAttachmentStem(rawStem) || 'attachment'
  return `${stem}-${formatAttachmentTimestamp(now)}${extension}`
}

function sanitizeAttachmentStem(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function formatAttachmentTimestamp(value: Date): string {
  return value.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, `-${String(value.getMilliseconds()).padStart(3, '0')}`)
}

function safeExtension(fileName: string): string {
  const extension = path.extname(fileName || '').toLowerCase()
  return /^[.][a-z0-9]{1,12}$/.test(extension) ? extension : ''
}

function getSessionOrThrow(store: CodexProMaxStore, sessionId: string | string[] | undefined): SessionRecord {
  const session = store.getSessionById(parseId(sessionId, 'Session id'))
  if (!session) {
    throw new HttpError(404, 'Session not found.')
  }
  return session
}

function getSessionByThreadOrThrow(store: CodexProMaxStore, threadId: string): SessionRecord {
  const session = store.getSessionByThreadId(threadId)
  if (!session) {
    throw new HttpError(404, 'Session not found.')
  }
  return session
}

function getSessionDetailOrThrow(store: CodexProMaxStore, sessionId: string | string[] | undefined) {
  const session = store.getSessionDetailById(parseId(sessionId, 'Session id'))
  if (!session) {
    throw new HttpError(404, 'Session not found.')
  }
  return session
}

function parseThreadId(value: string | string[] | undefined): string {
  try {
    return validateCodexThreadId(readParamString(value))
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : 'Invalid Codex thread id.')
  }
}

function parseId(value: string | string[] | undefined, label: string): string {
  const id = readParamString(value).trim()
  if (!id || id.length > 240 || /[\\/]/.test(id) || /[\u0000-\u001f]/.test(id)) {
    throw new HttpError(400, `${label} is invalid.`)
  }
  return id
}

function readParamString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? ''
  }
  return value ?? ''
}

function parseContent(value: unknown, label: string): string {
  if (!value || typeof value !== 'object') {
    throw new HttpError(400, `${label} body must be a JSON object.`)
  }
  const content = typeof (value as { content?: unknown }).content === 'string'
    ? (value as { content: string }).content.trim()
    : ''
  if (!content) {
    throw new HttpError(400, `${label} content is required.`)
  }
  return content
}

function readBodyString(value: unknown, key: string): string {
  if (!value || typeof value !== 'object') return ''
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' ? raw : ''
}

function readBodyNumber(value: unknown, key: string): number {
  if (!value || typeof value !== 'object') return 0
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
}

function readQueryString(value: unknown): string {
  if (Array.isArray(value)) {
    return readQueryString(value[0])
  }
  return typeof value === 'string' ? value : ''
}

function wantsPathOnly(request: express.Request): boolean {
  const format = readQueryString(request.query.format).toLowerCase()
  const pathOnly = readQueryString(request.query.pathOnly).toLowerCase()
  return format === 'path' || pathOnly === '1' || pathOnly === 'true' || pathOnly === 'yes'
}

function readWaitTimeout(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(Math.max(Math.trunc(value), 1), MAX_WAIT_TIMEOUT_MS)
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    response.status(413).json({ ok: false, error: 'Upload exceeds the 50MB file size limit.' })
    return
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({ ok: false, error: error.message })
    return
  }

  if (isNodeError(error) && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    response.status(409).json({ ok: false, error: 'Record already exists.' })
    return
  }

  console.error(error)
  response.status(500).json({ ok: false, error: 'Internal server error' })
}
