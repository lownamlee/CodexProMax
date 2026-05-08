import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AttachmentMeta,
  FileMeta,
  ManagerSnapshot,
  MarkdownFile,
  MarkdownSafety,
  ProtocolStatus,
  ProtocolTextFile,
  RunMetadata,
  RunSummary,
  Snapshot,
} from '../src/shared/protocol'
import {
  LEGACY_RUN_ID,
  MARKDOWN_FILES,
  MARKDOWN_RENDER_LIMIT_BYTES,
  MARKDOWN_WARN_BYTES,
  PROTOCOL_TEXT_FILES,
  RUNS_DIR_NAME,
  STATUS_DETAILS,
  isProtocolStatus,
} from '../src/shared/protocol'

export const DEFAULT_API_PORT = 5127
export const ATTACHMENTS_DIR_NAME = 'attachments'
export const RUN_METADATA_FILE = 'run.json'
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/avif',
])

export type AtomicTextWriter = (filePath: string, contents: string) => Promise<void>

export function resolveProtocolRoot(rootPath = process.env.CODEX_PRO_MAX_ROOT): string {
  return path.resolve(rootPath || process.cwd())
}

export function getRunsPath(rootPath: string): string {
  return path.join(rootPath, RUNS_DIR_NAME)
}

export function isSafeRunId(runId: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId) && runId !== '.' && runId !== '..'
}

export function sanitizeRunId(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 128)

  return isSafeRunId(sanitized) ? sanitized : `run-${Date.now()}-${randomUUID().slice(0, 8)}`
}

export function getRunPath(rootPath: string, runId: string): string {
  if (runId === LEGACY_RUN_ID) {
    return rootPath
  }

  if (!isSafeRunId(runId)) {
    throw new Error(`Unsafe run id: ${runId}`)
  }

  const runsPath = getRunsPath(rootPath)
  const runPath = path.resolve(runsPath, runId)
  const relative = path.relative(runsPath, runPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Run path escapes runs directory: ${runId}`)
  }

  return runPath
}

export function getProtocolPath(runPath: string, fileName: ProtocolTextFile): string {
  return path.join(runPath, fileName)
}

export function getAttachmentsPath(runPath: string): string {
  return path.join(runPath, ATTACHMENTS_DIR_NAME)
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function getManagerSnapshot(
  rootPath: string,
  watcherReady: boolean,
): Promise<ManagerSnapshot> {
  const resolvedRoot = resolveProtocolRoot(rootPath)
  const runIds = await listRunIds(resolvedRoot)
  const runs = await Promise.all(
    runIds.map((runId) => getRunSummary(resolvedRoot, runId, watcherReady)),
  )
  runs.sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0))

  return {
    rootPath: resolvedRoot,
    runsPath: getRunsPath(resolvedRoot),
    runs,
    selectedRunId: runs[0]?.runId ?? null,
    health: {
      serverTimeIso: new Date().toISOString(),
      rootExists: await pathExists(resolvedRoot),
      watcherReady,
    },
  }
}

export async function getRunSnapshot(
  rootPath: string,
  runId: string,
  watcherReady: boolean,
): Promise<Snapshot> {
  const resolvedRoot = resolveProtocolRoot(rootPath)
  const runPath = getRunPath(resolvedRoot, runId)
  const rootExists = await pathExists(runPath)
  const metadata = await readRunMetadata(resolvedRoot, runId)
  const fileEntries = await Promise.all(
    PROTOCOL_TEXT_FILES.map(async (fileName) => {
      const filePath = getProtocolPath(runPath, fileName)
      return [fileName, await getFileMeta(filePath)] as const
    }),
  )
  const files = Object.fromEntries(fileEntries) as Record<ProtocolTextFile, FileMeta>
  const statusRaw = (await readTextIfExists(getProtocolPath(runPath, 'status.txt'))).trim()
  const status: ProtocolStatus = isProtocolStatus(statusRaw) ? statusRaw : 'IDLE'
  const markdownEntries = await Promise.all(
    MARKDOWN_FILES.map(async (fileName) => {
      const result = await readMarkdownFile(runPath, fileName)
      return [fileName, result] as const
    }),
  )
  const markdownByFile = Object.fromEntries(markdownEntries) as Record<
    MarkdownFile,
    { contents: string; safety: MarkdownSafety }
  >

  return {
    runId,
    displayName: metadata.displayName,
    rootPath: runPath,
    status,
    outputMd: markdownByFile['output.md'].contents,
    progressMd: markdownByFile['progress.md'].contents,
    markdownSafety: {
      'output.md': markdownByFile['output.md'].safety,
      'progress.md': markdownByFile['progress.md'].safety,
    },
    instruction: await readTextIfExists(getProtocolPath(runPath, 'instruction.txt')),
    files,
    attachments: await listAttachments(runPath, runId),
    health: {
      serverTimeIso: new Date().toISOString(),
      rootExists,
      watcherReady,
    },
  }
}

export async function ensureRunMetadata(
  rootPath: string,
  runId: string,
  updates: Partial<Pick<RunMetadata, 'displayName' | 'workspacePath' | 'codexThreadId'>> = {},
): Promise<RunMetadata> {
  if (runId === LEGACY_RUN_ID) {
    return readRunMetadata(rootPath, runId)
  }

  const runPath = getRunPath(rootPath, runId)
  await fs.mkdir(runPath, { recursive: true })

  const existing = await readRunMetadata(rootPath, runId)
  const now = new Date().toISOString()
  const next: RunMetadata = {
    ...existing,
    displayName: updates.displayName ?? existing.displayName,
    workspacePath: updates.workspacePath ?? existing.workspacePath,
    codexThreadId: updates.codexThreadId ?? existing.codexThreadId,
    updatedAtIso: now,
  }

  await atomicWriteTextFile(path.join(runPath, RUN_METADATA_FILE), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export async function listAttachments(
  runPath: string,
  runId: string = LEGACY_RUN_ID,
): Promise<AttachmentMeta[]> {
  const attachmentsPath = getAttachmentsPath(runPath)
  let entries

  try {
    entries = await fs.readdir(attachmentsPath, { withFileTypes: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return []
    }
    throw error
  }

  const attachments = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const filePath = path.join(attachmentsPath, entry.name)
        const stats = await fs.stat(filePath)
        return {
          name: entry.name,
          url: `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(entry.name)}`,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          mtimeIso: stats.mtime.toISOString(),
        }
      }),
  )

  return attachments.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

export async function writeInstructionAndStatus(
  runPath: string,
  instruction: string,
  status: ProtocolStatus,
  writer: AtomicTextWriter = atomicWriteTextFile,
): Promise<void> {
  await fs.mkdir(runPath, { recursive: true })
  await writer(getProtocolPath(runPath, 'instruction.txt'), `${instruction.trimEnd()}\n`)
  await writer(getProtocolPath(runPath, 'status.txt'), `${status}\n`)
}

export async function saveAttachment(
  runPath: string,
  runId: string,
  originalName: string,
  buffer: Buffer,
): Promise<AttachmentMeta> {
  const attachmentsPath = getAttachmentsPath(runPath)
  await fs.mkdir(attachmentsPath, { recursive: true })

  const safeName = createAttachmentFileName(originalName)
  const targetPath = path.join(attachmentsPath, safeName)
  await atomicWriteBuffer(targetPath, buffer)

  const stats = await fs.stat(targetPath)
  return {
    name: safeName,
    url: `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(safeName)}`,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    mtimeIso: stats.mtime.toISOString(),
  }
}

export async function deleteRun(rootPath: string, runId: string): Promise<void> {
  if (runId === LEGACY_RUN_ID) {
    throw new Error('Legacy root cannot be deleted as a run.')
  }

  const runPath = getRunPath(rootPath, runId)
  await fs.rm(runPath, { recursive: true, force: true })
}

export async function appendAuditEvent(
  runPath: string,
  eventType: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(runPath, { recursive: true })
  const event = {
    time: new Date().toISOString(),
    type: eventType,
    ...payload,
  }
  await fs.appendFile(getProtocolPath(runPath, 'events.ndjson'), `${JSON.stringify(event)}\n`, 'utf8')
}

export async function atomicWriteTextFile(filePath: string, contents: string): Promise<void> {
  await writeAtomic(filePath, Buffer.from(contents, 'utf8'))
}

export async function atomicWriteBuffer(filePath: string, contents: Buffer): Promise<void> {
  await writeAtomic(filePath, contents)
}

export function createAttachmentFileName(originalName: string): string {
  const parsed = path.parse(originalName)
  const rawBase = parsed.name || 'upload'
  const rawExt = parsed.ext || ''
  const cleanBase = rawBase
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'upload'
  const cleanExt = rawExt.replace(/[^a-zA-Z0-9.]+/g, '').slice(0, 16)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  return `${stamp}-${randomUUID()}-${cleanBase}${cleanExt}`
}

async function listRunIds(rootPath: string): Promise<string[]> {
  const runIds = new Set<string>()
  const runsPath = getRunsPath(rootPath)

  try {
    const entries = await fs.readdir(runsPath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && isSafeRunId(entry.name)) {
        runIds.add(entry.name)
      }
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  if (await hasLegacyProtocolFiles(rootPath)) {
    runIds.add(LEGACY_RUN_ID)
  }

  return [...runIds]
}

async function hasLegacyProtocolFiles(rootPath: string): Promise<boolean> {
  const results = await Promise.all(
    PROTOCOL_TEXT_FILES.map((fileName) => pathExists(getProtocolPath(rootPath, fileName))),
  )
  return results.some(Boolean)
}

async function getRunSummary(
  rootPath: string,
  runId: string,
  watcherReady: boolean,
): Promise<RunSummary> {
  const snapshot = await getRunSnapshot(rootPath, runId, watcherReady)
  const metadata = await readRunMetadata(rootPath, runId)
  const attachments = snapshot.attachments
  const updatedAtMs = getLatestUpdatedAtMs(snapshot.files, attachments)

  return {
    runId,
    displayName: metadata.displayName,
    rootPath: snapshot.rootPath,
    status: snapshot.status,
    owner: STATUS_DETAILS[snapshot.status].owner,
    updatedAtIso: updatedAtMs ? new Date(updatedAtMs).toISOString() : metadata.updatedAtIso,
    updatedAtMs: updatedAtMs ?? Date.parse(metadata.updatedAtIso),
    outputPreview: createPreview(snapshot.outputMd),
    progressPreview: createPreview(snapshot.progressMd),
    attachmentCount: attachments.length,
    hasInstruction: snapshot.instruction.trim().length > 0,
    isLegacy: runId === LEGACY_RUN_ID,
  }
}

async function readRunMetadata(rootPath: string, runId: string): Promise<RunMetadata> {
  const now = new Date().toISOString()
  const runPath = getRunPath(rootPath, runId)
  const metadataPath = path.join(runPath, RUN_METADATA_FILE)

  try {
    const raw = await fs.readFile(metadataPath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RunMetadata>
    return {
      runId,
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : defaultDisplayName(runId),
      workspacePath: typeof parsed.workspacePath === 'string' ? parsed.workspacePath : rootPath,
      createdAtIso: typeof parsed.createdAtIso === 'string' ? parsed.createdAtIso : now,
      updatedAtIso: typeof parsed.updatedAtIso === 'string' ? parsed.updatedAtIso : now,
      codexThreadId: typeof parsed.codexThreadId === 'string' ? parsed.codexThreadId : null,
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        runId,
        displayName: defaultDisplayName(runId),
        workspacePath: rootPath,
        createdAtIso: now,
        updatedAtIso: now,
        codexThreadId: null,
      }
    }
    throw error
  }
}

function defaultDisplayName(runId: string): string {
  return runId === LEGACY_RUN_ID ? 'Legacy Root' : runId
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

async function readMarkdownFile(
  runPath: string,
  fileName: MarkdownFile,
): Promise<{ contents: string; safety: MarkdownSafety }> {
  const filePath = getProtocolPath(runPath, fileName)
  const meta = await getFileMeta(filePath)

  if (!meta.exists || meta.size === null) {
    return {
      contents: '',
      safety: createMarkdownSafety(fileName, 0, 0, false, false),
    }
  }

  const truncated = meta.size > MARKDOWN_RENDER_LIMIT_BYTES
  if (!truncated) {
    const contents = await readTextIfExists(filePath)
    return {
      contents,
      safety: createMarkdownSafety(fileName, meta.size, meta.size, meta.size > MARKDOWN_WARN_BYTES, false),
    }
  }

  const file = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(MARKDOWN_RENDER_LIMIT_BYTES)
    const { bytesRead } = await file.read(buffer, 0, MARKDOWN_RENDER_LIMIT_BYTES, 0)
    return {
      contents: buffer.subarray(0, bytesRead).toString('utf8'),
      safety: createMarkdownSafety(fileName, meta.size, bytesRead, true, true),
    }
  } finally {
    await file.close()
  }
}

async function getFileMeta(filePath: string): Promise<FileMeta> {
  try {
    const stats = await fs.stat(filePath)
    return {
      exists: true,
      mtimeMs: stats.mtimeMs,
      mtimeIso: stats.mtime.toISOString(),
      size: stats.size,
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return {
        exists: false,
        mtimeMs: null,
        mtimeIso: null,
        size: null,
      }
    }
    throw error
  }
}

async function writeAtomic(filePath: string, contents: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  )
  await fs.writeFile(tempPath, contents)
  await fs.rename(tempPath, filePath)
}

function createMarkdownSafety(
  fileName: MarkdownFile,
  originalBytes: number,
  renderedBytes: number,
  warning: boolean,
  truncated: boolean,
): MarkdownSafety {
  return {
    fileName,
    originalBytes,
    renderedBytes,
    warnBytes: MARKDOWN_WARN_BYTES,
    limitBytes: MARKDOWN_RENDER_LIMIT_BYTES,
    warning,
    truncated,
  }
}

function getLatestUpdatedAtMs(
  files: Record<ProtocolTextFile, FileMeta>,
  attachments: AttachmentMeta[],
): number | null {
  const fileTimes = Object.values(files)
    .map((file) => file.mtimeMs)
    .filter((value): value is number => typeof value === 'number')
  const attachmentTimes = attachments.map((attachment) => attachment.mtimeMs)
  const allTimes = [...fileTimes, ...attachmentTimes]
  return allTimes.length > 0 ? Math.max(...allTimes) : null
}

function createPreview(contents: string): string {
  return contents.replace(/\s+/g, ' ').trim().slice(0, 180)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
