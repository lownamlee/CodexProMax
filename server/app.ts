import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import multer from 'multer'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { CreateTeammateRequest, InstructionRequest, ProtocolTextFile, Teammate } from '../src/shared/protocol'
import {
  DEFAULT_TEAMMATES,
  MAX_TEAMMATES,
  PROTOCOL_TEXT_FILES,
  TEAMMATE_AVATAR_URLS,
} from '../src/shared/protocol'
import { HttpError } from './errors'
import { listCodexLiveSessions, readCodexLiveHistory } from './codexLiveView'
import { MultiRunSnapshotHub } from './snapshotHub'
import {
  DEFAULT_API_PORT,
  MAX_UPLOAD_BYTES,
  appendAuditEvent,
  appendChatMessage,
  clearConversationHistory,
  clearInstructionAndWriteStatus,
  deleteAttachment,
  deleteRun,
  ensureRunMetadata,
  getAttachmentsPath,
  getProtocolPath,
  getRunPath,
  isSafeRunId,
  resolveProtocolRoot,
  saveAttachment,
  writeInstructionAndStatus,
} from './protocolStore'

export interface CodexProMaxApp {
  app: express.Express
  close: () => Promise<void>
  hub: MultiRunSnapshotHub
  rootPath: string
}

export interface CreateAppOptions {
  rootPath?: string
  startWatcher?: boolean
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
})

const STOP_SESSION_INSTRUCTION = 'Stop this Codex Pro Max session now.'
const PROTOCOL_FILE_PREVIEW_BYTES = 1024 * 1024
const TEAMMATES_FILE_NAME = 'teammates.json'

export function createApp(options: CreateAppOptions = {}): CodexProMaxApp {
  const rootPath = resolveProtocolRoot(options.rootPath)
  const hub = new MultiRunSnapshotHub(rootPath)
  const app = express()

  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.get('/api/snapshot', async (_request, response) => {
    response.json(await hub.readSnapshot())
  })

  app.get('/api/events', (_request, response) => {
    hub.connect(response)
  })

  app.get('/api/teammates', async (_request, response) => {
    response.json({
      ok: true,
      teammates: await readTeammates(rootPath),
    })
  })

  app.get('/api/codex-live/sessions', async (request, response) => {
    response.json(await listCodexLiveSessions(Number(request.query.limit || 100)))
  })

  app.get('/api/codex-live/sessions/:sessionId', async (request, response) => {
    response.json(await readCodexLiveHistory(request.params.sessionId, {
      records: Number(request.query.records || 0) || undefined,
      tailBytes: Number(request.query.tailBytes || 0) || undefined,
    }))
  })

  app.post('/api/teammates', async (request, response) => {
    const teammates = await addTeammate(rootPath, request.body)
    response.status(201).json({
      ok: true,
      teammates,
    })
  })

  app.get('/api/runs/:runId/snapshot', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    response.json(await hub.readRunSnapshot(runId))
  })

  app.get('/api/runs/:runId/files/:fileName', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    const fileName = parseProtocolFileName(request.params.fileName)
    const runPath = getRunPath(rootPath, runId)
    const file = await readProtocolFilePreview(getProtocolPath(runPath, fileName))

    response.json({
      ok: true,
      fileName,
      ...file,
    })
  })

  app.post('/api/runs/:runId/action', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    response.json(await handleInstruction(rootPath, hub, runId, request.body))
  })

  app.delete('/api/runs/:runId', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    await deleteRun(rootPath, runId)
    await hub.broadcastSnapshot()
    response.json({
      ok: true,
      snapshot: await hub.readSnapshot(),
    })
  })

  app.delete('/api/runs/:runId/messages', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    const runPath = getRunPath(rootPath, runId)

    await ensureRunMetadata(rootPath, runId)
    await clearConversationHistory(runPath)
    await appendAuditEvent(runPath, 'conversation.cleared')
    await hub.broadcastSnapshot()

    response.json({
      ok: true,
      snapshot: await hub.readRunSnapshot(runId),
    })
  })

  app.post('/api/runs/:runId/stop', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    response.json(await stopRun(rootPath, hub, runId))
  })

  app.post('/api/runs/:runId/upload', upload.single('file'), uploadHandler(rootPath, hub))

  app.delete('/api/runs/:runId/attachments/:fileName', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    const rawFileName = Array.isArray(request.params.fileName)
      ? request.params.fileName[0]
      : request.params.fileName
    const fileName = parseAttachmentName(rawFileName)
    const runPath = getRunPath(rootPath, runId)

    await deleteAttachment(runPath, fileName)
    await appendAuditEvent(runPath, 'attachment.deleted', { fileName })
    await hub.broadcastSnapshot()

    response.json({
      ok: true,
      snapshot: await hub.readRunSnapshot(runId),
    })
  })

  app.get('/api/runs/:runId/attachments/:fileName', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    const rawFileName = Array.isArray(request.params.fileName)
      ? request.params.fileName[0]
      : request.params.fileName
    const fileName = parseAttachmentName(rawFileName)
    const attachmentPath = path.join(getAttachmentsPath(getRunPath(rootPath, runId)), fileName)
    response.sendFile(attachmentPath, { dotfiles: 'allow' })
  })

  app.use((_request, response) => {
    response.status(404).json({ ok: false, error: 'Not found' })
  })

  app.use(errorHandler)

  if (options.startWatcher !== false) {
    hub.start()
  }

  return {
    app,
    hub,
    rootPath,
    close: () => hub.close(),
  }
}

async function handleInstruction(
  rootPath: string,
  hub: MultiRunSnapshotHub,
  runId: string,
  rawBody: unknown,
) {
  const body = parseInstructionRequest(rawBody)
  const instruction = body.instruction

  return writeRunInstruction(rootPath, hub, runId, instruction, 'instruction.sent')
}

async function writeRunInstruction(
  rootPath: string,
  hub: MultiRunSnapshotHub,
  runId: string,
  instruction: string,
  auditEventType: 'instruction.sent' | 'session.stop.requested',
) {
  const runPath = getRunPath(rootPath, runId)

  validateInstruction(instruction)
  await ensureRunMetadata(rootPath, runId)
  await appendChatMessage(runPath, 'user', instruction)
  await writeInstructionAndStatus(runPath, instruction, 'INSTRUCTION_RECEIVED')
  await appendAuditEvent(runPath, 'user.message', {
    status: 'INSTRUCTION_RECEIVED',
    instruction,
    instructionBytes: Buffer.byteLength(instruction, 'utf8'),
  })
  await appendAuditEvent(runPath, auditEventType, {
    status: 'INSTRUCTION_RECEIVED',
    instructionPreview: createPreview(instruction),
    instructionBytes: Buffer.byteLength(instruction, 'utf8'),
    hasInstruction: instruction.trim().length > 0,
  })

  await hub.broadcastSnapshot()
  return {
    ok: true,
    snapshot: await hub.readRunSnapshot(runId),
  }
}

async function stopRun(
  rootPath: string,
  hub: MultiRunSnapshotHub,
  runId: string,
) {
  const runPath = getRunPath(rootPath, runId)

  await ensureRunMetadata(rootPath, runId)
  await clearInstructionAndWriteStatus(runPath, 'STOPPED')
  await appendChatMessage(runPath, 'user', STOP_SESSION_INSTRUCTION)
  await appendAuditEvent(runPath, 'user.message', {
    status: 'STOPPED',
    instruction: STOP_SESSION_INSTRUCTION,
    instructionBytes: Buffer.byteLength(STOP_SESSION_INSTRUCTION, 'utf8'),
  })
  await appendAuditEvent(runPath, 'session.stop.requested', {
    status: 'STOPPED',
    instructionPreview: createPreview(STOP_SESSION_INSTRUCTION),
    instructionBytes: Buffer.byteLength(STOP_SESSION_INSTRUCTION, 'utf8'),
    hasInstruction: false,
  })

  await hub.broadcastSnapshot()
  return {
    ok: true,
    snapshot: await hub.readRunSnapshot(runId),
  }
}

function uploadHandler(rootPath: string, hub: MultiRunSnapshotHub): RequestHandler {
  return async (request, response) => {
    const rawRunId = Array.isArray(request.params.runId)
      ? request.params.runId[0]
      : request.params.runId
    const runId = parseRunId(rawRunId)
    const runPath = getRunPath(rootPath, runId)
    const file = request.file
    if (!file) {
      throw new HttpError(400, 'Upload requires a file field named "file".')
    }

    await ensureRunMetadata(rootPath, runId)
    const attachment = await saveAttachment(runPath, runId, file.originalname, file.buffer, file.mimetype)
    await appendAuditEvent(runPath, 'upload.attachment', {
      originalName: file.originalname,
      mimeType: file.mimetype,
      kind: attachment.kind,
      name: attachment.name,
      size: attachment.size,
    })

    await hub.broadcastSnapshot()
    response.status(201).json({
      ok: true,
      attachment,
      snapshot: await hub.readRunSnapshot(runId),
    })
  }
}

async function readTeammates(rootPath: string): Promise<Teammate[]> {
  try {
    const content = await fs.readFile(getTeammatesPath(rootPath), 'utf8')
    const parsed = JSON.parse(content) as unknown
    const teammates = normalizeTeammates(parsed)
    if (teammates) {
      return teammates
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, 'ENOENT')) {
      throw error
    }
  }

  return DEFAULT_TEAMMATES
}

async function addTeammate(rootPath: string, rawBody: unknown): Promise<Teammate[]> {
  const body = parseCreateTeammateRequest(rawBody)
  const teammates = await readTeammates(rootPath)
  if (teammates.length >= MAX_TEAMMATES) {
    throw new HttpError(400, 'Maximum prank teammates reached.')
  }

  const nextTeammates = [
    ...teammates,
    {
      id: `invited-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: createInvitedBurgerName(teammates.length),
      email: body.email,
      avatarUrl: pickUnusedTeammateAvatar(teammates),
      role: 'Member',
      seat: 'Codex Pro Max',
      dateAdded: formatTeammateDate(new Date()),
    },
  ]

  await fs.mkdir(rootPath, { recursive: true })
  await fs.writeFile(getTeammatesPath(rootPath), `${JSON.stringify(nextTeammates, null, 2)}\n`, 'utf8')
  return nextTeammates
}

function parseCreateTeammateRequest(value: unknown): CreateTeammateRequest {
  if (value === null || typeof value !== 'object') {
    throw new HttpError(400, 'Invite requires an email.')
  }

  const email = typeof (value as CreateTeammateRequest).email === 'string'
    ? (value as CreateTeammateRequest).email.trim()
    : ''
  if (!isValidInviteEmail(email)) {
    throw new HttpError(400, 'Invite requires a valid email.')
  }

  return { email }
}

function getTeammatesPath(rootPath: string) {
  return path.join(rootPath, TEAMMATES_FILE_NAME)
}

function createInvitedBurgerName(count: number) {
  return `Invited Burger ${Math.max(1, count - DEFAULT_TEAMMATES.length + 1)}`
}

function formatTeammateDate(date: Date) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function isValidInviteEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function normalizeTeammates(value: unknown): Teammate[] | null {
  if (!Array.isArray(value)) {
    return null
  }

  const usedAvatars = new Set<string>()
  const teammates: Teammate[] = []
  for (const item of value.slice(0, MAX_TEAMMATES)) {
    if (!isTeammateLike(item)) {
      return null
    }

    const avatarUrl = typeof item.avatarUrl === 'string'
      && isAllowedTeammateAvatar(item.avatarUrl)
      && !usedAvatars.has(item.avatarUrl)
      ? item.avatarUrl
      : pickUnusedTeammateAvatar(teammates)
    usedAvatars.add(avatarUrl)

    teammates.push({
      id: item.id,
      name: item.name,
      email: normalizeTeammateEmail(item),
      avatarUrl,
      role: item.role,
      seat: item.seat,
      dateAdded: item.dateAdded,
    })
  }

  return teammates
}

function isTeammateLike(value: unknown): value is Omit<Teammate, 'avatarUrl'> & { avatarUrl?: unknown } {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const teammate = value as Teammate
  return typeof teammate.id === 'string'
    && typeof teammate.name === 'string'
    && typeof teammate.email === 'string'
    && typeof teammate.role === 'string'
    && typeof teammate.seat === 'string'
    && typeof teammate.dateAdded === 'string'
}

function pickUnusedTeammateAvatar(teammates: Teammate[]) {
  const usedAvatars = new Set(teammates.map((teammate) => teammate.avatarUrl))
  const availableAvatars = TEAMMATE_AVATAR_URLS.filter((avatarUrl) => !usedAvatars.has(avatarUrl))
  if (availableAvatars.length === 0) {
    throw new HttpError(400, 'No teammate avatars are available.')
  }

  const avatarIndex = Math.floor(Math.random() * availableAvatars.length)
  return availableAvatars[avatarIndex]
}

function isAllowedTeammateAvatar(avatarUrl: string) {
  return (TEAMMATE_AVATAR_URLS as readonly string[]).includes(avatarUrl)
}

function normalizeTeammateEmail(teammate: { id: string; email: string }) {
  return DEFAULT_TEAMMATES.find((defaultTeammate) => defaultTeammate.id === teammate.id)?.email ?? teammate.email
}

function isNodeErrorWithCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}

function parseInstructionRequest(value: unknown): InstructionRequest {
  if (!value || typeof value !== 'object') {
    throw new HttpError(400, 'Request body must be a JSON object.')
  }

  const instruction = (value as Partial<InstructionRequest>).instruction
  if (typeof instruction !== 'string') {
    throw new HttpError(400, 'Instruction must be a string.')
  }

  return { instruction }
}

function parseRunId(value: string | undefined): string {
  const runId = value ?? ''
  if (!isSafeRunId(runId)) {
    throw new HttpError(400, 'Unsafe run id.')
  }

  return runId
}

function parseAttachmentName(value: string | undefined): string {
  const fileName = value ?? ''
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,220}$/.test(fileName)) {
    throw new HttpError(400, 'Unsafe attachment name.')
  }

  return fileName
}

function parseProtocolFileName(value: string | undefined): ProtocolTextFile {
  const fileName = value ?? ''
  if (!PROTOCOL_TEXT_FILES.includes(fileName as ProtocolTextFile)) {
    throw new HttpError(400, 'Unknown protocol file.')
  }

  return fileName as ProtocolTextFile
}

async function readProtocolFilePreview(filePath: string): Promise<{
  content: string
  truncated: boolean
  size: number
}> {
  let stats
  try {
    stats = await fs.stat(filePath)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new HttpError(404, 'Protocol file not found.')
    }
    throw error
  }

  if (stats.size <= PROTOCOL_FILE_PREVIEW_BYTES) {
    return {
      content: await fs.readFile(filePath, 'utf8'),
      truncated: false,
      size: stats.size,
    }
  }

  const file = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(PROTOCOL_FILE_PREVIEW_BYTES)
    const { bytesRead } = await file.read(buffer, 0, PROTOCOL_FILE_PREVIEW_BYTES, 0)
    return {
      content: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: true,
      size: stats.size,
    }
  } finally {
    await file.close()
  }
}

function validateInstruction(instruction: string): void {
  if (instruction.trim().length === 0) {
    throw new HttpError(400, 'Instructions require instruction text.')
  }
}

function createPreview(contents: string): string {
  return contents.replace(/\s+/g, ' ').trim().slice(0, 180)
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    response.status(413).json({ ok: false, error: 'Upload exceeds the 10MB file size limit.' })
    return
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({ ok: false, error: error.message })
    return
  }

  console.error(error)
  response.status(500).json({ ok: false, error: 'Internal server error' })
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export function getApiPort(): number {
  const rawPort = process.env.CODEX_PRO_MAX_API_PORT
  const parsed = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_API_PORT
  return Number.isFinite(parsed) ? parsed : DEFAULT_API_PORT
}
