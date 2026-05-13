import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type {
  CodexLiveContextUsage,
  CodexLiveHistoryResponse,
  CodexLiveRateLimits,
  CodexLiveRateLimitWindow,
  CodexLiveRecord,
  CodexLiveSessionSummary,
  CodexLiveSessionsResponse,
} from '../src/shared/protocol'

const DEFAULT_SESSION_LIMIT = 100
const MAX_SESSION_LIMIT = 500
const MAX_TAIL_BYTES = 2 * 1024 * 1024
const DEFAULT_TAIL_BYTES = MAX_TAIL_BYTES
const MAX_HISTORY_SCAN_BYTES = 32 * 1024 * 1024
const HISTORY_SCAN_CHUNK_BYTES = 256 * 1024
const MAX_JSONL_RECORD_BYTES = MAX_TAIL_BYTES
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
  const recentLines = await readRecentJsonlLines(filePath, stats.size, recordLimit, requestedTailBytes)
  const lines = recentLines.lines
  const records: CodexLiveRecord[] = []
  const callsById = new Map<string, CodexLiveRecord>()
  let context: CodexLiveContextUsage | null = null

  lines.forEach((line, index) => {
    const nextContext = parseCodexLiveContext(line)
    if (nextContext) {
      context = nextContext
    }

    let record = parseCodexLiveRecord(line, index)
    if (record) {
      if (record.kind === 'tool-call' && record.callId) {
        callsById.set(record.callId, record)
        if (isPatchCall(record)) return
        records.push(record)
        return
      }
      if (record.kind === 'tool-output' && record.callId) {
        const call = callsById.get(record.callId)
        if (call) {
          if (isPatchCall(call)) {
            records.push(enrichToolOutput(record, call))
          } else {
            mergeToolOutputIntoCall(call, record)
          }
          return
        }
      }
      records.push(record)
    }
  })

  return {
    ok: true,
    rootPath,
    session: toSessionSummary(rootPath, filePath, stats),
    records: groupActionRuns(records),
    context,
    tailBytes: recentLines.bytesRead,
    totalSizeBytes: stats.size,
    truncated: recentLines.truncated,
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
  const totalUsage = info.total_token_usage || {}
  const contextWindow = tokenNumber(info.model_context_window)
  const usedTokens = tokenNumber(lastUsage.total_tokens)
  const remainingTokens = Math.max(0, contextWindow - usedTokens)
  const percentUsed = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0

  if (contextWindow <= 0 && usedTokens <= 0) return null

  return {
    timestamp: String(record.timestamp || ''),
    contextWindow,
    usedTokens,
    remainingTokens,
    inputTokens: tokenNumber(lastUsage.input_tokens),
    cachedInputTokens: tokenNumber(lastUsage.cached_input_tokens),
    outputTokens: tokenNumber(lastUsage.output_tokens),
    reasoningOutputTokens: tokenNumber(lastUsage.reasoning_output_tokens),
    percentUsed,
    percentRemaining: Math.max(0, 100 - percentUsed),
    totalUsage: {
      inputTokens: tokenNumber(totalUsage.input_tokens),
      cachedInputTokens: tokenNumber(totalUsage.cached_input_tokens),
      outputTokens: tokenNumber(totalUsage.output_tokens),
      reasoningOutputTokens: tokenNumber(totalUsage.reasoning_output_tokens),
      totalTokens: tokenNumber(totalUsage.total_tokens),
    },
    rateLimits: parseRateLimits(payload.rate_limits),
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
  const fallbackId = `${timestamp || 'record'}-${index}`

  if (record.type === 'response_item') {
    if (payload.type === 'message') {
      const text = responseMessageText(payload.content)
      return makeRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, text),
        index,
        timestamp,
        kind: 'message',
        title: humanize(String(payload.role || 'message')),
        text,
        status: 'completed',
      })
    }

    if (payload.type === 'function_call') {
      const args = safeJson(payload.arguments)
      const command = typeof args?.command === 'string' ? args.command : String(payload.arguments || '')
      return makeRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, command),
        index,
        timestamp,
        kind: 'tool-call',
        title: payload.name === 'shell_command'
          ? shellCommandTitle(command)
          : humanize(String(payload.name || 'tool call')),
        text: command,
        callId: String(payload.call_id || ''),
        status: 'running',
      })
    }

    if (payload.type === 'function_call_output') {
      const text = String(payload.output || '')
      return makeRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, text),
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
      const name = String(payload.name || 'tool call')
      return makeRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, String(payload.input || '')),
        index,
        timestamp,
        kind: 'tool-call',
        title: name === 'apply_patch' ? 'Edit files' : humanize(name),
        text: String(payload.input || ''),
        callId: String(payload.call_id || ''),
        status: String(payload.status || '') === 'completed' ? 'completed' : 'running',
      })
    }

    if (payload.type === 'custom_tool_call_output') {
      const text = customToolOutputText(payload.output)
      return makeRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, text),
        index,
        timestamp,
        kind: 'tool-output',
        title: 'Tool output',
        text,
        callId: String(payload.call_id || ''),
        status: outputStatus(payload.output),
      })
    }

    if (payload.type === 'reasoning') {
      const text = reasoningText(payload.summary)
      if (!text.trim()) return null
      return makeRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, text),
        index,
        timestamp,
        kind: 'reasoning',
        title: 'Thinking',
        text,
        status: 'running',
      })
    }
  }

  if (record.type === 'event_msg') {
    if (payload.type === 'agent_message' || payload.type === 'token_count' || payload.type === 'patch_apply_end') {
      return null
    }
    if (payload.type === 'user_message') {
      const text = String(payload.message || '')
      return makeRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, text),
        index,
        timestamp,
        kind: 'message',
        title: 'User',
        text,
        status: 'completed',
      })
    }
    const text = JSON.stringify(payload, null, 2)
    return makeRecord({
      id: stableRecordId(record, payload, timestamp, fallbackId, text),
      index,
      timestamp,
      kind: 'event',
      title: humanize(String(payload.type || 'event')),
      text,
      status: 'completed',
    })
  }

  if (record.type === 'session_meta' || record.type === 'turn_context') return null

  return makeRecord({
    id: stableRecordId(record, payload, timestamp, fallbackId, JSON.stringify(record)),
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

async function readRecentJsonlLines(
  filePath: string,
  fileSize: number,
  lineLimit: number,
  requestedTailBytes: number,
) {
  if (fileSize <= 0 || lineLimit <= 0) {
    return { lines: [], bytesRead: 0, truncated: false }
  }

  const maxScanBytes = Math.min(fileSize, Math.max(requestedTailBytes, MAX_HISTORY_SCAN_BYTES))
  const linesReversed: string[] = []
  const file = await fs.open(filePath, 'r')
  let position = fileSize
  let bytesRead = 0
  let currentLineSegments: Buffer[] = []
  let currentLineBytes = 0
  let skippingOversizedLine = false
  let skippedOversizedLine = false

  function addCurrentLineSegment(segment: Buffer) {
    if (segment.length === 0 || skippingOversizedLine) return
    currentLineBytes += segment.length
    if (currentLineBytes > MAX_JSONL_RECORD_BYTES) {
      currentLineSegments = []
      skippingOversizedLine = true
      skippedOversizedLine = true
      return
    }
    currentLineSegments.unshift(segment)
  }

  function finishCurrentLine() {
    if (!skippingOversizedLine && currentLineBytes > 0) {
      const line = Buffer.concat(currentLineSegments, currentLineBytes).toString('utf8').replace(/\r$/, '')
      if (line.trim()) {
        linesReversed.push(line)
      }
    }
    currentLineSegments = []
    currentLineBytes = 0
    skippingOversizedLine = false
  }

  try {
    while (position > 0 && bytesRead < maxScanBytes && linesReversed.length < lineLimit) {
      const readLength = Math.min(HISTORY_SCAN_CHUNK_BYTES, position, maxScanBytes - bytesRead)
      const readStart = position - readLength
      const buffer = Buffer.alloc(readLength)
      await file.read(buffer, 0, readLength, readStart)
      position = readStart
      bytesRead += readLength

      let segmentEnd = readLength
      for (let index = readLength - 1; index >= 0 && linesReversed.length < lineLimit; index -= 1) {
        if (buffer[index] !== 0x0a) {
          continue
        }

        addCurrentLineSegment(buffer.subarray(index + 1, segmentEnd))
        finishCurrentLine()
        segmentEnd = index
      }

      if (segmentEnd > 0 && linesReversed.length < lineLimit) {
        addCurrentLineSegment(buffer.subarray(0, segmentEnd))
      }
    }

    if (position === 0 && linesReversed.length < lineLimit) {
      finishCurrentLine()
    }

    return {
      lines: linesReversed.reverse(),
      bytesRead,
      truncated: position > 0 || skippedOversizedLine || currentLineBytes > 0 || skippingOversizedLine,
    }
  } finally {
    await file.close()
  }
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

function stableRecordId(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  timestamp: string,
  fallbackId: string,
  text: string,
) {
  const nativeId = typeof payload.id === 'string'
    ? payload.id
    : typeof record.id === 'string'
      ? record.id
      : ''
  if (nativeId) {
    return `${timestamp || 'record'}-${nativeId}`
  }

  const callId = typeof payload.call_id === 'string' ? payload.call_id : ''
  if (callId) {
    return `${timestamp || 'record'}-${callId}`
  }

  const type = typeof payload.type === 'string' ? payload.type : String(record.type || 'record')
  const role = typeof payload.role === 'string' ? payload.role : ''
  if ((type === 'message' || type === 'user_message' || type === 'reasoning') && text.trim()) {
    return `${timestamp || 'record'}-${type}-${role}-${stableTextHash(text)}`
  }

  return fallbackId
}

function stableTextHash(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function isPatchCall(record: CodexLiveRecord) {
  return record.kind === 'tool-call' && record.title === 'Edit files'
}

function enrichToolOutput(record: CodexLiveRecord, call: CodexLiveRecord): CodexLiveRecord {
  if (isPatchCall(call)) {
    const patchSummary = summarizePatchChange(call.text, record.text)
    return {
      ...record,
      title: record.status === 'completed' ? patchSummary.title : 'Patch failed',
      text: [patchSummary.files.join('\n'), record.text].filter(Boolean).join('\n\n'),
    }
  }

  if (call.kind === 'tool-call') {
    return {
      ...record,
      title: `${call.title} result`,
    }
  }

  return record
}

function mergeToolOutputIntoCall(call: CodexLiveRecord, output: CodexLiveRecord) {
  call.status = isWaitForReviewTimeout(call, output) || isWaitForReviewIdleReturn(call, output)
    ? 'waiting'
    : output.status
  call.text = `${call.text.trim()}\n\nResult:\n${output.text.trim()}`
}

function groupActionRuns(records: CodexLiveRecord[]) {
  const grouped: CodexLiveRecord[] = []
  let actions: CodexLiveRecord[] = []

  function flushActions() {
    if (actions.length === 0) return
    if (actions.length === 1) {
      grouped.push(actions[0])
    } else {
      grouped.push(makeRecord({
        id: `actions-${actions[0].id}-${actions.length}`,
        index: actions[0].index,
        timestamp: actions[0].timestamp,
        kind: 'action-group',
        title: `${actions.length} action${actions.length === 1 ? '' : 's'}`,
        text: actions.map((action) => action.title).join('\n'),
        status: actionGroupStatus(actions),
        children: actions,
      }))
    }
    actions = []
  }

  for (const record of records) {
    if (isActionRecord(record)) {
      actions.push(record)
    } else {
      flushActions()
      grouped.push(record)
    }
  }

  flushActions()
  return grouped
}

function isActionRecord(record: CodexLiveRecord) {
  return record.kind === 'tool-call' || record.kind === 'tool-output'
}

function actionGroupStatus(actions: CodexLiveRecord[]): CodexLiveRecord['status'] {
  if (actions.some((action) => action.status === 'failed')) return 'failed'
  if (actions.some((action) => action.status === 'running')) return 'running'
  if (actions.some((action) => action.status === 'waiting')) return 'waiting'
  if (actions.every((action) => action.status === 'completed')) return 'completed'
  return 'unknown'
}

function summarizePatchChange(input: string, output: string) {
  const files = patchFilesFromText(input)
  if (files.length === 0) {
    files.push(...patchFilesFromText(output))
  }

  const counts = files.reduce((nextCounts, item) => {
    nextCounts[item.action] += 1
    return nextCounts
  }, { add: 0, delete: 0, update: 0 })
  const total = counts.add + counts.delete + counts.update
  const uniqueFiles = Array.from(new Set(files.map((item) => compactFilePath(item.file))))

  if (total === 0) {
    return { title: 'Edited files', files: uniqueFiles }
  }

  if (counts.add === 0 && counts.delete === 0) {
    return { title: pluralize('Edited file', counts.update), files: uniqueFiles }
  }
  if (counts.update === 0 && counts.delete === 0) {
    return { title: pluralize('Added file', counts.add), files: uniqueFiles }
  }
  if (counts.update === 0 && counts.add === 0) {
    return { title: pluralize('Deleted file', counts.delete), files: uniqueFiles }
  }

  return { title: pluralize('Changed file', total), files: uniqueFiles }
}

function patchFilesFromText(value: string) {
  const files: Array<{ action: 'add' | 'delete' | 'update'; file: string }> = []
  const patchPattern = /^\*\*\* (Add|Delete|Update) File:\s*(.+)$/gm
  let patchMatch
  while ((patchMatch = patchPattern.exec(value)) !== null) {
    const action = patchMatch[1] === 'Add' ? 'add' : patchMatch[1] === 'Delete' ? 'delete' : 'update'
    files.push({ action, file: patchMatch[2].trim() })
  }

  const outputPattern = /^[ \t]*([AMD])\s+(.+)$/gm
  let outputMatch
  while ((outputMatch = outputPattern.exec(value)) !== null) {
    const action = outputMatch[1] === 'A' ? 'add' : outputMatch[1] === 'D' ? 'delete' : 'update'
    files.push({ action, file: outputMatch[2].trim() })
  }

  return files
}

function compactFilePath(value: string) {
  const normalized = value.replace(/\\/g, '/')
  const marker = '/CodexProMax/'
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length)
  const backgroundMarker = '/Background Checker/'
  const backgroundIndex = normalized.lastIndexOf(backgroundMarker)
  if (backgroundIndex >= 0) return normalized.slice(backgroundIndex + backgroundMarker.length)
  return normalized
}

function pluralize(singular: string, count: number) {
  const [verb, noun] = singular.split(' ')
  return `${verb} ${count} ${noun}${count === 1 ? '' : 's'}`
}

function shellCommandTitle(command: string) {
  const normalized = command.trim().toLowerCase()
  if (normalized.includes('wait_for_review.ps1')) return 'Wait for review'
  if (normalized.startsWith('npm test')) return 'Run tests'
  if (normalized.startsWith('npm run build')) return 'Build app'
  if (normalized.startsWith('git ')) return 'Git command'
  if (normalized.includes('select-string') || normalized.startsWith('rg ')) return 'Search code'
  if (normalized.includes('get-content')) return 'Read file'
  if (normalized.includes('invoke-restmethod')) return 'Check API'
  if (
    normalized.includes('start-process')
    || normalized.includes('stop-process')
    || normalized.includes('get-nettcpconnection')
    || normalized.includes('get-ciminstance')
  ) {
    return 'Manage server'
  }
  return 'Shell command'
}

function isWaitForReviewCommand(record: CodexLiveRecord) {
  return record.kind === 'tool-call' && /wait_for_review\.ps1/i.test(record.text)
}

function isWaitForReviewTimeout(call: CodexLiveRecord, output: CodexLiveRecord) {
  return isWaitForReviewCommand(call)
    && /Exit code:\s*124/i.test(output.text)
    && /command timed out after/i.test(output.text)
}

function isWaitForReviewIdleReturn(call: CodexLiveRecord, output: CodexLiveRecord) {
  if (!isWaitForReviewCommand(call)) return false
  const body = outputBody(output.text)
  const parsed = safeJson(body.trim())
  return parsed?.idleTimeout === true
}

function outputBody(value: string) {
  const marker = value.match(/Output:\s*\n([\s\S]*)/i)
  return marker ? marker[1] : value
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

function customToolOutputText(value: unknown) {
  const parsed = safeJson(value)
  if (typeof parsed?.output === 'string') return parsed.output
  return String(value || '')
}

function outputStatus(output: unknown): CodexLiveRecord['status'] {
  const parsed = safeJson(output)
  const exitCode = parsed?.metadata
    && typeof parsed.metadata === 'object'
    && !Array.isArray(parsed.metadata)
    && 'exit_code' in parsed.metadata
      ? Number((parsed.metadata as Record<string, unknown>).exit_code)
      : null
  if (exitCode !== null && Number.isFinite(exitCode)) {
    return exitCode === 0 ? 'completed' : 'failed'
  }

  const outputText = typeof parsed?.output === 'string' ? parsed.output : String(output || '')
  if (/apply_patch verification failed|failed to find expected lines/i.test(outputText)) return 'failed'
  const match = outputText.match(/Exit code:\s*(\d+)/i)
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

function percentNumber(value: unknown) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(100, numeric))
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function parseRateLimits(value: unknown): CodexLiveRateLimits | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const credits = record.credits && typeof record.credits === 'object' && !Array.isArray(record.credits)
    ? record.credits as Record<string, unknown>
    : {}

  return {
    limitId: typeof record.limit_id === 'string' ? record.limit_id : '',
    limitName: nullableString(record.limit_name),
    planType: typeof record.plan_type === 'string' ? record.plan_type : '',
    rateLimitReachedType: nullableString(record.rate_limit_reached_type),
    primary: parseRateLimitWindow(record.primary),
    secondary: parseRateLimitWindow(record.secondary),
    credits: {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: typeof credits.balance === 'number' && Number.isFinite(credits.balance) ? credits.balance : null,
    },
  }
}

function parseRateLimitWindow(value: unknown): CodexLiveRateLimitWindow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const usedPercent = percentNumber(record.used_percent)
  const windowMinutes = tokenNumber(record.window_minutes)
  const resetsAt = tokenNumber(record.resets_at)

  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt,
    resetsAtIso: resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : '',
  }
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
