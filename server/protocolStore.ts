import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  AttachmentMeta,
  ChatMessage,
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
  MARKDOWN_FILES,
  MARKDOWN_RENDER_LIMIT_BYTES,
  MARKDOWN_WARN_BYTES,
  PROTOCOL_TEXT_FILES,
  RUNS_DIR_NAME,
  STATUS_DETAILS,
  isProtocolStatus,
} from '../src/shared/protocol'

export const DEFAULT_API_PORT = 53127
export const ATTACHMENTS_DIR_NAME = 'attachments'
export const RUN_METADATA_FILE = 'run.json'
export const SESSION_FILE = 'session.md'
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const OUTPUT_PREVIEW_BYTES = 4096

const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  '.7z': 'application/x-7z-compressed',
  '.aac': 'audio/aac',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.gz': 'application/gzip',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.md': 'text/markdown',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rar': 'application/vnd.rar',
  '.svg': 'image/svg+xml',
  '.tar': 'application/x-tar',
  '.ts': 'text/typescript',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
}

const CODE_ATTACHMENT_EXTENSIONS = new Set([
  '.c',
  '.cpp',
  '.cs',
  '.css',
  '.go',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.sh',
  '.sql',
  '.swift',
  '.ts',
  '.tsx',
  '.xml',
  '.yaml',
  '.yml',
])

const ARCHIVE_ATTACHMENT_EXTENSIONS = new Set(['.7z', '.gz', '.rar', '.tar', '.tgz', '.zip'])
const DOCUMENT_ATTACHMENT_EXTENSIONS = new Set(['.doc', '.docx', '.odt', '.rtf'])
const PRESENTATION_ATTACHMENT_EXTENSIONS = new Set(['.odp', '.ppt', '.pptx'])
const SPREADSHEET_ATTACHMENT_EXTENSIONS = new Set(['.csv', '.ods', '.xls', '.xlsx'])

type SessionMessageCacheEntry = {
  mtimeMs: number
  size: number
  messages: ChatMessage[]
}

const sessionMessageCache = new Map<string, SessionMessageCacheEntry>()

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

function createAttachmentMeta(
  runId: string,
  fileName: string,
  stats: { size: number, mtimeMs: number, mtime: Date },
  mimeType?: string,
): AttachmentMeta {
  const normalizedMimeType = normalizeAttachmentMimeType(mimeType, fileName)
  return {
    name: fileName,
    url: `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(fileName)}`,
    size: stats.size,
    mimeType: normalizedMimeType,
    kind: classifyAttachmentKind(fileName, normalizedMimeType),
    mtimeMs: stats.mtimeMs,
    mtimeIso: stats.mtime.toISOString(),
  }
}

function normalizeAttachmentMimeType(mimeType: string | undefined, fileName: string): string {
  const normalized = mimeType?.split(';')[0]?.trim().toLowerCase()
  if (normalized && normalized !== 'application/octet-stream') {
    return normalized
  }

  return inferAttachmentMimeType(fileName)
}

function inferAttachmentMimeType(fileName: string): string {
  return ATTACHMENT_MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

function classifyAttachmentKind(fileName: string, mimeType: string): AttachmentMeta['kind'] {
  const extension = path.extname(fileName).toLowerCase()

  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'
  if (ARCHIVE_ATTACHMENT_EXTENSIONS.has(extension) || mimeType.includes('zip') || mimeType.includes('compressed')) {
    return 'archive'
  }
  if (SPREADSHEET_ATTACHMENT_EXTENSIONS.has(extension) || mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return 'spreadsheet'
  }
  if (PRESENTATION_ATTACHMENT_EXTENSIONS.has(extension) || mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
    return 'presentation'
  }
  if (DOCUMENT_ATTACHMENT_EXTENSIONS.has(extension) || mimeType.includes('wordprocessingml') || mimeType === 'application/msword') {
    return 'document'
  }
  if (
    CODE_ATTACHMENT_EXTENSIONS.has(extension)
    || mimeType.includes('json')
    || mimeType.includes('javascript')
    || mimeType.includes('typescript')
    || mimeType.includes('xml')
  ) {
    return 'code'
  }
  if (mimeType.startsWith('text/')) return 'text'

  return 'file'
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
  const instruction = await readTextIfExists(getProtocolPath(runPath, 'instruction.txt'))
  const statusRaw = (await readTextIfExists(getProtocolPath(runPath, 'status.txt'))).trim()
  const status = readProtocolStatus(statusRaw)
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
    markdownSafety: {
      'output.md': markdownByFile['output.md'].safety,
    },
    instruction,
    files,
    attachments: await listAttachments(runPath, runId),
    messages: await readChatMessages(runPath, markdownByFile['output.md'].contents),
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
  runId: string,
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
        return createAttachmentMeta(runId, entry.name, stats)
      }),
  )

  return attachments.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

export async function readChatMessages(runPath: string, fallbackOutput = ''): Promise<ChatMessage[]> {
  const sessionPath = path.join(runPath, SESSION_FILE)
  const sessionMeta = await getFileMeta(sessionPath)
  if (sessionMeta.exists && typeof sessionMeta.mtimeMs === 'number' && typeof sessionMeta.size === 'number') {
    const cached = sessionMessageCache.get(sessionPath)
    if (cached && cached.mtimeMs === sessionMeta.mtimeMs && cached.size === sessionMeta.size) {
      return cached.messages
    }

    const sessionMessages = parseSessionMessages(await readTextIfExists(sessionPath))
    sessionMessageCache.set(sessionPath, {
      mtimeMs: sessionMeta.mtimeMs,
      size: sessionMeta.size,
      messages: sessionMessages,
    })
    return sessionMessages
  }

  if (!fallbackOutput.trim()) {
    return []
  }

  return [{
    id: 'current-output',
    role: 'assistant',
    content: fallbackOutput.trim(),
    createdAtIso: new Date().toISOString(),
  }]
}

function parseSessionMessages(raw: string): ChatMessage[] {
  const marker = /<!-- codex-pro-max:message (\{[^\r\n]*\}) -->/g
  const matches = [...raw.matchAll(marker)]
  if (matches.length === 0) {
    return []
  }

  return matches
    .map((match, index): ChatMessage | null => {
      const next = matches[index + 1]
      const bodyStart = (match.index ?? 0) + match[0].length
      const bodyEnd = next?.index ?? raw.length
      const body = raw.slice(bodyStart, bodyEnd).trim()

      try {
        const metadata = JSON.parse(match[1]) as Partial<ChatMessage>
        if (metadata.role !== 'assistant' && metadata.role !== 'user') return null
        const content = body.replace(/^##[^\r\n]*(?:\r?\n)+/, '').trim()
        if (!content) return null

        return {
          id: typeof metadata.id === 'string' ? metadata.id : randomUUID(),
          role: metadata.role,
          content,
          createdAtIso: typeof metadata.createdAtIso === 'string'
            ? metadata.createdAtIso
            : new Date().toISOString(),
        }
      } catch {
        return null
      }
    })
    .filter((message): message is ChatMessage => Boolean(message))
}

function formatSessionMessage(message: ChatMessage): string {
  const title = message.role === 'assistant' ? 'Codex' : 'User'
  const metadata = JSON.stringify({
    id: message.id,
    role: message.role,
    createdAtIso: message.createdAtIso,
  })
  return `<!-- codex-pro-max:message ${metadata} -->\n## ${title} - ${message.createdAtIso}\n\n${message.content.trim()}\n\n`
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

export async function clearInstructionAndWriteStatus(
  runPath: string,
  status: ProtocolStatus,
  writer: AtomicTextWriter = atomicWriteTextFile,
): Promise<void> {
  await fs.mkdir(runPath, { recursive: true })
  await writer(getProtocolPath(runPath, 'instruction.txt'), '')
  await writer(getProtocolPath(runPath, 'status.txt'), `${status}\n`)
}

function readProtocolStatus(statusRaw: string): ProtocolStatus {
  if (!statusRaw) {
    return 'RUNNING'
  }
  return isProtocolStatus(statusRaw) ? statusRaw : 'ERROR'
}

export async function saveAttachment(
  runPath: string,
  runId: string,
  originalName: string,
  buffer: Buffer,
  mimeType?: string,
): Promise<AttachmentMeta> {
  const attachmentsPath = getAttachmentsPath(runPath)
  await fs.mkdir(attachmentsPath, { recursive: true })

  const safeName = createAttachmentFileName(originalName)
  const targetPath = path.join(attachmentsPath, safeName)
  await atomicWriteBuffer(targetPath, buffer)

  const stats = await fs.stat(targetPath)
  return createAttachmentMeta(runId, safeName, stats, mimeType)
}

export async function deleteAttachment(runPath: string, fileName: string): Promise<void> {
  const attachmentsPath = getAttachmentsPath(runPath)
  const targetPath = path.resolve(attachmentsPath, fileName)
  const relative = path.relative(attachmentsPath, targetPath)

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Attachment path escapes attachments directory: ${fileName}`)
  }

  await fs.rm(targetPath, { force: true })
}

export async function deleteRun(rootPath: string, runId: string): Promise<void> {
  const runPath = getRunPath(rootPath, runId)
  await fs.rm(runPath, { recursive: true, force: true })
}

export async function clearConversationHistory(runPath: string): Promise<void> {
  await fs.mkdir(runPath, { recursive: true })
  const sessionPath = path.join(runPath, SESSION_FILE)
  await atomicWriteTextFile(sessionPath, '')
  sessionMessageCache.delete(sessionPath)
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

export async function appendChatMessage(
  runPath: string,
  role: ChatMessage['role'],
  content: string,
): Promise<ChatMessage | null> {
  const trimmed = content.trim()
  if (!trimmed) return null

  await fs.mkdir(runPath, { recursive: true })
  const messages = await readChatMessages(runPath)
  const previous = messages[messages.length - 1]
  if (previous?.role === role && previous.content.trim() === trimmed) {
    return previous
  }

  const message: ChatMessage = {
    id: randomUUID(),
    role,
    content: trimmed,
    createdAtIso: new Date().toISOString(),
  }
  const sessionPath = path.join(runPath, SESSION_FILE)
  await fs.appendFile(sessionPath, formatSessionMessage(message), 'utf8')
  sessionMessageCache.delete(sessionPath)
  return message
}

export async function appendAssistantReviewMessage(runPath: string): Promise<ChatMessage | null> {
  const output = await readTextIfExists(getProtocolPath(runPath, 'output.md'))
  return appendChatMessage(runPath, 'assistant', output)
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
      if (entry.isDirectory() && isSafeRunId(entry.name) && await isProtocolRunDirectory(rootPath, entry.name)) {
        runIds.add(entry.name)
      }
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  return [...runIds]
}

async function isProtocolRunDirectory(rootPath: string, runId: string): Promise<boolean> {
  const runPath = getRunPath(rootPath, runId)
  const runFiles = [RUN_METADATA_FILE, ...PROTOCOL_TEXT_FILES]

  for (const fileName of runFiles) {
    if (await isFile(path.join(runPath, fileName))) {
      return true
    }
  }

  return false
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile()
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function getRunSummary(
  rootPath: string,
  runId: string,
  watcherReady: boolean,
): Promise<RunSummary> {
  const metadata = await readRunMetadata(rootPath, runId)
  const runPath = getRunPath(rootPath, runId)
  const fileEntries = await Promise.all(
    PROTOCOL_TEXT_FILES.map(async (fileName) => {
      const filePath = getProtocolPath(runPath, fileName)
      return [fileName, await getFileMeta(filePath)] as const
    }),
  )
  const files = Object.fromEntries(fileEntries) as Record<ProtocolTextFile, FileMeta>
  const instruction = await readTextIfExists(getProtocolPath(runPath, 'instruction.txt'))
  const statusRaw = (await readTextIfExists(getProtocolPath(runPath, 'status.txt'))).trim()
  const status = readProtocolStatus(statusRaw)
  const attachments = await listAttachments(runPath, runId)
  const updatedAtMs = getLatestUpdatedAtMs(files, attachments)

  return {
    runId,
    displayName: metadata.displayName,
    rootPath: runPath,
    status,
    owner: STATUS_DETAILS[status].owner,
    updatedAtIso: updatedAtMs ? new Date(updatedAtMs).toISOString() : metadata.updatedAtIso,
    updatedAtMs: updatedAtMs ?? Date.parse(metadata.updatedAtIso),
    outputPreview: createPreview(await readTextPreviewIfExists(getProtocolPath(runPath, 'output.md'))),
    attachmentCount: attachments.length,
    hasInstruction: instruction.trim().length > 0,
  }
}

async function readRunMetadata(rootPath: string, runId: string): Promise<RunMetadata> {
  const now = new Date().toISOString()
  const runPath = getRunPath(rootPath, runId)
  const metadataPath = path.join(runPath, RUN_METADATA_FILE)

  try {
    const raw = await fs.readFile(metadataPath, 'utf8')
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<RunMetadata>
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
  return runId
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

async function readTextPreviewIfExists(filePath: string, byteLimit = OUTPUT_PREVIEW_BYTES): Promise<string> {
  let file: Awaited<ReturnType<typeof fs.open>>
  try {
    file = await fs.open(filePath, 'r')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return ''
    }
    throw error
  }

  try {
    const buffer = Buffer.alloc(byteLimit)
    const { bytesRead } = await file.read(buffer, 0, byteLimit, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
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
