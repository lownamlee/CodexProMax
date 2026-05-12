import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CodexLiveContextUsage,
  CodexLiveHistoryResponse,
  CodexLiveRecord,
  CodexLiveSessionSummary,
  CodexLiveSessionsResponse,
} from '../src/shared/protocol'

const DEFAULT_SESSION_LIMIT = 100
const MAX_SESSION_LIMIT = 500
const DEFAULT_TAIL_BYTES = 384 * 1024
const MAX_TAIL_BYTES = 2 * 1024 * 1024
const DEFAULT_RECORD_LIMIT = 200
const MAX_RECORD_LIMIT = 500

export function getCodexSessionsRoot(): string {
  return process.env.CODEX_SESSIONS_ROOT || path.join(os.homedir(), '.codex', 'sessions')
}

export async function listCodexLiveSessions(limit = DEFAULT_SESSION_LIMIT): Promise<CodexLiveSessionsResponse> {
  const rootPath = getCodexSessionsRoot()
  const sessions: CodexLiveSessionSummary[] = []

  await walkJsonlFiles(rootPath, async (filePath) => {
    const stats = await fs.stat(filePath)
    if (!stats.isFile()) return
    sessions.push(toSessionSummary(rootPath, filePath, stats))
  })

  sessions.sort((left, right) => Date.parse(right.updatedAtIso) - Date.parse(left.updatedAtIso))

  return {
    ok: true,
    rootPath,
    sessions: sessions.slice(0, clampInt(limit, 1, MAX_SESSION_LIMIT, DEFAULT_SESSION_LIMIT)),
  }
}

export async function readCodexLiveHistory(
  id: string,
  options: { tailBytes?: number; records?: number } = {},
): Promise<CodexLiveHistoryResponse> {
  const rootPath = getCodexSessionsRoot()
  const filePath = resolveSessionPath(rootPath, id)
  const stats = await fs.stat(filePath)
  if (!stats.isFile()) {
    throw new Error('Codex session is not a file.')
  }

  const requestedTailBytes = clampInt(options.tailBytes, 16 * 1024, MAX_TAIL_BYTES, DEFAULT_TAIL_BYTES)
  const recordLimit = clampInt(options.records, 1, MAX_RECORD_LIMIT, DEFAULT_RECORD_LIMIT)
  const start = Math.max(0, stats.size - requestedTailBytes)
  const length = stats.size - start
  const file = await fs.open(filePath, 'r')
  let buffer: Buffer
  try {
    buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, start)
  } finally {
    await file.close()
  }

  let lines = buffer.toString('utf8').split(/\r?\n/)
  if (start > 0) {
    lines = lines.slice(1)
  }
  lines = lines.filter((line) => line.trim()).slice(-recordLimit)
  const records: CodexLiveRecord[] = []
  let context: CodexLiveContextUsage | null = null

  lines.forEach((line, index) => {
    const nextContext = parseCodexLiveContext(line)
    if (nextContext) {
      context = nextContext
    }

    const record = parseCodexLiveRecord(line, index)
    if (record) {
      records.push(record)
    }
  })

  return {
    ok: true,
    rootPath,
    session: toSessionSummary(rootPath, filePath, stats),
    records,
    context,
    tailBytes: length,
    totalSizeBytes: stats.size,
    truncated: start > 0,
  }
}

export function parseCodexLiveContext(line: string): CodexLiveContextUsage | null {
  let record: any
  try {
    record = JSON.parse(line)
  } catch {
    return null
  }

  const payload = record.payload || {}
  if (record.type !== 'event_msg' || payload.type !== 'token_count') return null

  const info = payload.info || {}
  const lastUsage = info.last_token_usage || {}
  const contextWindow = tokenNumber(info.model_context_window)
  const usedTokens = tokenNumber(lastUsage.total_tokens)

  if (contextWindow <= 0 && usedTokens <= 0) return null

  return {
    timestamp: String(record.timestamp || ''),
    contextWindow,
    usedTokens,
    inputTokens: tokenNumber(lastUsage.input_tokens),
    cachedInputTokens: tokenNumber(lastUsage.cached_input_tokens),
    outputTokens: tokenNumber(lastUsage.output_tokens),
    reasoningOutputTokens: tokenNumber(lastUsage.reasoning_output_tokens),
    percentUsed: contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0,
  }
}

export function parseCodexLiveRecord(line: string, index: number): CodexLiveRecord | null {
  let record: any
  try {
    record = JSON.parse(line)
  } catch {
    return makeRecord({
      id: `raw-${index}`,
      index,
      kind: 'event',
      title: 'Unparsed record',
      text: line.slice(0, 4000),
      status: 'unknown',
    })
  }

  const timestamp = String(record.timestamp || record.time || '')
  const payload = record.payload || {}
  const id = `${timestamp || 'record'}-${index}`

  if (record.type === 'response_item') {
    if (payload.type === 'message') {
      return makeRecord({
        id,
        index,
        timestamp,
        kind: 'message',
        title: humanize(String(payload.role || 'message')),
        text: responseMessageText(payload.content),
        status: 'completed',
      })
    }

    if (payload.type === 'function_call') {
      const args = safeJson(payload.arguments)
      return makeRecord({
        id,
        index,
        timestamp,
        kind: 'tool-call',
        title: payload.name === 'shell_command' ? 'Shell command' : humanize(String(payload.name || 'tool call')),
        text: typeof args?.command === 'string' ? args.command : String(payload.arguments || ''),
        callId: String(payload.call_id || ''),
        status: 'running',
      })
    }

    if (payload.type === 'function_call_output') {
      const text = String(payload.output || '')
      return makeRecord({
        id,
        index,
        timestamp,
        kind: 'tool-output',
        title: 'Tool output',
        text,
        callId: String(payload.call_id || ''),
        status: outputStatus(text),
      })
    }

    if (payload.type === 'custom_tool_call') {
      return makeRecord({
        id,
        index,
        timestamp,
        kind: 'tool-call',
        title: humanize(String(payload.name || 'tool call')),
        text: String(payload.input || ''),
        callId: String(payload.call_id || ''),
        status: String(payload.status || '') === 'completed' ? 'completed' : 'running',
      })
    }

    if (payload.type === 'custom_tool_call_output') {
      const text = String(payload.output || '')
      return makeRecord({
        id,
        index,
        timestamp,
        kind: 'tool-output',
        title: 'Tool output',
        text,
        callId: String(payload.call_id || ''),
        status: outputStatus(text),
      })
    }

    if (payload.type === 'reasoning') {
      return makeRecord({
        id,
        index,
        timestamp,
        kind: 'reasoning',
        title: 'Thinking',
        text: reasoningText(payload.summary),
        status: 'running',
      })
    }
  }

  if (record.type === 'event_msg') {
    if (payload.type === 'agent_message' || payload.type === 'token_count') return null
    return makeRecord({
      id,
      index,
      timestamp,
      kind: 'event',
      title: humanize(String(payload.type || 'event')),
      text: JSON.stringify(payload, null, 2),
      status: 'completed',
    })
  }

  if (record.type === 'session_meta' || record.type === 'turn_context') return null

  return makeRecord({
    id,
    index,
    timestamp,
    kind: 'event',
    title: humanize(String(record.type || 'record')),
    text: JSON.stringify(record, null, 2),
    status: 'completed',
  })
}

async function walkJsonlFiles(rootPath: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return
      throw error
    }

    for (const entry of entries) {
      const filePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(filePath)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        await onFile(filePath)
      }
    }
  }
}

function toSessionSummary(rootPath: string, filePath: string, stats: { birthtime: Date; mtime: Date; size: number }): CodexLiveSessionSummary {
  const relativePath = path.relative(rootPath, filePath).split(path.sep).join('/')
  return {
    id: Buffer.from(relativePath, 'utf8').toString('base64url'),
    fileName: path.basename(filePath),
    relativePath,
    createdAtIso: parseCreatedAt(filePath) || stats.birthtime.toISOString(),
    updatedAtIso: stats.mtime.toISOString(),
    sizeBytes: stats.size,
  }
}

function resolveSessionPath(rootPath: string, id: string) {
  let relativePath = ''
  try {
    relativePath = Buffer.from(id, 'base64url').toString('utf8')
  } catch {
    throw new Error('Invalid Codex session id.')
  }

  if (!relativePath || path.isAbsolute(relativePath) || !relativePath.endsWith('.jsonl')) {
    throw new Error('Invalid Codex session id.')
  }

  const filePath = path.resolve(rootPath, relativePath)
  const relative = path.relative(rootPath, filePath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Codex session path escapes the sessions directory.')
  }
  return filePath
}

function parseCreatedAt(filePath: string) {
  const match = path.basename(filePath).match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!match) return ''
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function makeRecord(record: Omit<CodexLiveRecord, 'timestamp' | 'callId'> & Partial<Pick<CodexLiveRecord, 'timestamp' | 'callId'>>): CodexLiveRecord {
  return {
    timestamp: '',
    callId: '',
    ...record,
  }
}

function responseMessageText(content: unknown) {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const value = part as Record<string, unknown>
      return typeof value.text === 'string' ? value.text : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function reasoningText(summary: unknown) {
  if (!Array.isArray(summary)) return ''
  return summary.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
}

function safeJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function outputStatus(output: string): CodexLiveRecord['status'] {
  const match = output.match(/Exit code:\s*(\d+)/i)
  if (!match) return 'unknown'
  return Number(match[1]) === 0 ? 'completed' : 'failed'
}

function clampInt(value: unknown, min: number, max: number, fallback: number) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}

function tokenNumber(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
