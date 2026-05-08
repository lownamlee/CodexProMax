import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import multer from 'multer'
import path from 'node:path'
import type { ActionRequest, ProtocolStatus } from '../src/shared/protocol'
import { LEGACY_RUN_ID } from '../src/shared/protocol'
import { HttpError } from './errors'
import { MultiRunSnapshotHub } from './snapshotHub'
import {
  ALLOWED_IMAGE_MIME_TYPES,
  DEFAULT_API_PORT,
  MAX_UPLOAD_BYTES,
  appendAuditEvent,
  deleteRun,
  ensureRunMetadata,
  getAttachmentsPath,
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

  app.get('/api/runs/:runId/snapshot', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    response.json(await hub.readRunSnapshot(runId))
  })

  app.post('/api/runs/:runId/action', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    response.json(await handleAction(rootPath, hub, runId, request.body))
  })

  app.delete('/api/runs/:runId', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    if (runId === LEGACY_RUN_ID) {
      throw new HttpError(400, 'Legacy root cannot be deleted from the runs inbox.')
    }

    await deleteRun(rootPath, runId)
    await hub.broadcastSnapshot()
    response.json({
      ok: true,
      snapshot: await hub.readSnapshot(),
    })
  })

  app.post('/api/runs/:runId/upload', upload.single('file'), uploadHandler(rootPath, hub))

  app.get('/api/runs/:runId/attachments/:fileName', async (request, response) => {
    const runId = parseRunId(request.params.runId)
    const rawFileName = Array.isArray(request.params.fileName)
      ? request.params.fileName[0]
      : request.params.fileName
    const fileName = parseAttachmentName(rawFileName)
    const attachmentPath = path.join(getAttachmentsPath(getRunPath(rootPath, runId)), fileName)
    response.sendFile(attachmentPath)
  })

  app.post('/api/action', async (request, response) => {
    response.json(await handleAction(rootPath, hub, LEGACY_RUN_ID, request.body))
  })

  app.post('/api/upload', upload.single('file'), uploadHandler(rootPath, hub, LEGACY_RUN_ID))

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

async function handleAction(
  rootPath: string,
  hub: MultiRunSnapshotHub,
  runId: string,
  rawBody: unknown,
) {
  const runPath = getRunPath(rootPath, runId)
  const body = parseActionRequest(rawBody)
  const instruction = typeof body.instruction === 'string' ? body.instruction : ''
  const nextStatus = statusForAction(body.action)

  validateInstruction(body.action, instruction)
  await ensureRunMetadata(rootPath, runId)
  await writeInstructionAndStatus(runPath, instruction, nextStatus)
  await appendAuditEvent(runPath, 'user.message', {
    action: body.action,
    status: nextStatus,
    instruction,
    instructionBytes: Buffer.byteLength(instruction, 'utf8'),
  })
  await appendAuditEvent(runPath, `action.${body.action}`, {
    status: nextStatus,
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

function uploadHandler(
  rootPath: string,
  hub: MultiRunSnapshotHub,
  forcedRunId?: string,
): RequestHandler {
  return async (request, response) => {
    const rawRunId = Array.isArray(request.params.runId)
      ? request.params.runId[0]
      : request.params.runId
    const runId = forcedRunId ?? parseRunId(rawRunId)
    const runPath = getRunPath(rootPath, runId)
    const file = request.file
    if (!file) {
      throw new HttpError(400, 'Upload requires a file field named "file".')
    }

    if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      throw new HttpError(400, 'Only raster image uploads are allowed.')
    }

    await ensureRunMetadata(rootPath, runId)
    const attachment = await saveAttachment(runPath, runId, file.originalname, file.buffer)
    await appendAuditEvent(runPath, 'upload.image', {
      originalName: file.originalname,
      mimeType: file.mimetype,
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

function parseActionRequest(value: unknown): ActionRequest {
  if (!value || typeof value !== 'object') {
    throw new HttpError(400, 'Request body must be a JSON object.')
  }

  const action = (value as Partial<ActionRequest>).action
  if (action !== 'approve' && action !== 'revision' && action !== 'instruct') {
    throw new HttpError(400, 'Action must be "approve", "revision", or "instruct".')
  }

  const instruction = (value as Partial<ActionRequest>).instruction
  if (instruction !== undefined && typeof instruction !== 'string') {
    throw new HttpError(400, 'Instruction must be a string.')
  }

  return { action, instruction }
}

function parseRunId(value: string | undefined): string {
  const runId = value ?? ''
  if (runId === LEGACY_RUN_ID) {
    return runId
  }

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

function statusForAction(action: ActionRequest['action']): ProtocolStatus {
  return action === 'approve'
    ? 'APPROVED'
    : action === 'revision'
      ? 'REVISION_REQUESTED'
      : 'INSTRUCTION_RECEIVED'
}

function validateInstruction(action: ActionRequest['action'], instruction: string): void {
  if (action === 'revision' && instruction.trim().length === 0) {
    throw new HttpError(400, 'Revision requests require an instruction.')
  }

  if (action === 'instruct' && instruction.trim().length === 0) {
    throw new HttpError(400, 'New instructions require instruction text.')
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

export function getApiPort(): number {
  const rawPort = process.env.CODEX_PRO_MAX_API_PORT
  const parsed = rawPort ? Number.parseInt(rawPort, 10) : DEFAULT_API_PORT
  return Number.isFinite(parsed) ? parsed : DEFAULT_API_PORT
}
