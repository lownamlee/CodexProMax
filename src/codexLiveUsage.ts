import nodeFs from 'node:fs'
import fs from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type {
  CodexLiveActivity,
  CodexLiveContextUsage,
  CodexLiveRateLimitWindow,
  CodexLiveRateLimits,
  CodexLiveRecord,
  CodexLiveSessionState,
  CodexLiveTokenUsage,
} from './types'

const USAGE_TAIL_BYTES = 2 * 1024 * 1024
const USAGE_SCAN_BYTES = 32 * 1024 * 1024
const USAGE_SCAN_CHUNK_BYTES = 256 * 1024
const USAGE_RECORD_LIMIT = 220

export interface CodexLiveAssistantMessageExport {
  latestUserMessage: CodexLiveExportMessage | null
  assistantMessages: CodexLiveExportMessage[]
  toolCalls: CodexLiveExportToolCall[]
  editedFiles: CodexLiveEditedFile[]
  taskEvents: CodexLiveExportTaskEvent[]
}

export interface CodexLiveExportMessage {
  timestamp: string
  text: string
}

export interface CodexLiveExportToolCall {
  id: string
  index: number
  timestamp: string
  name: string
  kind: string
  status: string
  command: string
  workdir: string
  input: string
  output: string
}

export interface CodexLiveEditedFile {
  path: string
  type: string
  movePath: string | null
  unifiedDiffs: string[]
}

export interface CodexLiveExportTaskEvent {
  timestamp: string
  type: string
  status: string
  summary: string
}

export async function readCodexLiveUsage(rolloutPath: string): Promise<CodexLiveContextUsage | null> {
  return (await readCodexLiveSessionState(rolloutPath)).usage
}

export async function readCodexLiveSessionState(rolloutPath: string): Promise<CodexLiveSessionState> {
  const lines = await readRecentJsonlLines(rolloutPath, USAGE_RECORD_LIMIT)
  let latestUsage: CodexLiveContextUsage | null = null
  let latestActivity: CodexLiveActivity = {
    latestEventAt: null,
    latestRecordType: '',
    hasRolloutActivity: false,
  }
  let lastUserRecordIndex = -1
  const thinkingRecords: CodexLiveRecord[] = []

  lines.forEach((line, index) => {
    const activity = parseRolloutActivity(line)
    if (activity) {
      latestActivity = activity
    }
    const usage = parseCodexLiveContextUsage(line)
    if (usage) {
      latestUsage = usage
    }

    const liveRecord = parseCodexLiveRecord(line, index)
    if (!liveRecord) return

    if (isConversationUserRecord(liveRecord)) {
      lastUserRecordIndex = thinkingRecords.length
      thinkingRecords.push(liveRecord)
      return
    }

    if (isConversationThinkingRecord(liveRecord)) {
      thinkingRecords.push(liveRecord)
    }
  })

  return {
    usage: latestUsage,
    activity: latestActivity,
    thinkingRecords: thinkingRecords
      .slice(lastUserRecordIndex >= 0 ? lastUserRecordIndex + 1 : 0)
      .filter(isConversationThinkingRecord)
      .slice(-30),
  }
}

export async function readCodexLiveAssistantMessagesSinceLastUser(
  rolloutPath: string,
  latestSessionUserMessage: CodexLiveExportMessage | null = null,
): Promise<CodexLiveAssistantMessageExport> {
  const lineReader = createInterface({
    input: nodeFs.createReadStream(rolloutPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })
  const latestSessionUserTimeMs = latestSessionUserMessage?.timestamp
    ? Date.parse(latestSessionUserMessage.timestamp)
    : Number.NaN
  const useSessionUserCutoff = Boolean(latestSessionUserMessage)
  let latestUserMessage: CodexLiveExportMessage | null = latestSessionUserMessage
  let assistantMessages: CodexLiveExportMessage[] = []
  let toolCalls: CodexLiveExportToolCall[] = []
  let taskEvents: CodexLiveExportTaskEvent[] = []
  let toolCallsById = new Map<string, CodexLiveExportToolCall>()
  let editedFilesByPath = new Map<string, CodexLiveEditedFile>()
  let index = 0

  try {
    for await (const line of lineReader) {
      const record = safeJson(line)
      const payload = readRecord(record?.payload)
      const timestamp = readString(record?.timestamp) || readString(record?.time)
      if (useSessionUserCutoff && Number.isFinite(latestSessionUserTimeMs)) {
        const recordTimeMs = Date.parse(timestamp)
        if (Number.isFinite(recordTimeMs) && recordTimeMs < latestSessionUserTimeMs) {
          index += 1
          continue
        }
      }

      const recordIndex = index
      const liveRecord = record ? parseCodexLiveRecordFromRecord(record, recordIndex) : null
      index += 1

      if (!useSessionUserCutoff && liveRecord && isConversationUserRecord(liveRecord)) {
        latestUserMessage = {
          timestamp: liveRecord.timestamp,
          text: liveRecord.text,
        }
        assistantMessages = []
        toolCalls = []
        taskEvents = []
        toolCallsById = new Map<string, CodexLiveExportToolCall>()
        editedFilesByPath = new Map<string, CodexLiveEditedFile>()
        continue
      }

      if (latestUserMessage && payload) {
        collectCodexLiveExportContext(
          payload,
          timestamp,
          recordIndex,
          toolCalls,
          toolCallsById,
          editedFilesByPath,
          taskEvents,
        )
      }

      if (latestUserMessage && liveRecord && isConversationThinkingRecord(liveRecord)) {
        assistantMessages.push({
          timestamp: liveRecord.timestamp,
          text: liveRecord.text,
        })
      }
    }
  } finally {
    lineReader.close()
  }

  return {
    latestUserMessage,
    assistantMessages,
    toolCalls,
    editedFiles: Array.from(editedFilesByPath.values()),
    taskEvents,
  }
}

export function parseCodexLiveContextUsage(line: string): CodexLiveContextUsage | null {
  const record = safeJson(line)
  if (!record || readString(record.type) !== 'event_msg') return null

  const payload = readRecord(record.payload)
  if (!payload || readString(payload.type) !== 'token_count') return null

  const info = readRecord(payload.info)
  const lastUsage = parseTokenUsage(info?.last_token_usage)
  const totalUsage = parseTokenUsage(info?.total_token_usage)
  const contextWindow = readNumber(info?.model_context_window)
  const currentUsage = lastUsage.totalTokens > 0 ? lastUsage : totalUsage
  const usedTokens = currentUsage.totalTokens
  const remainingTokens = Math.max(0, contextWindow - usedTokens)
  const percentUsed = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0

  if (contextWindow <= 0 && usedTokens <= 0) return null

  return {
    timestamp: readString(record.timestamp) || new Date().toISOString(),
    contextWindow,
    usedTokens,
    remainingTokens,
    inputTokens: currentUsage.inputTokens,
    cachedInputTokens: currentUsage.cachedInputTokens,
    outputTokens: currentUsage.outputTokens,
    reasoningOutputTokens: currentUsage.reasoningOutputTokens,
    percentUsed,
    percentRemaining: Math.max(0, 100 - percentUsed),
    totalUsage,
    rateLimits: parseRateLimits(payload.rate_limits),
  }
}

export function parseRolloutActivity(line: string): CodexLiveActivity | null {
  const record = safeJson(line)
  if (!record) return null

  return {
    latestEventAt: readString(record.timestamp) || null,
    latestRecordType: readString(record.type),
    hasRolloutActivity: true,
  }
}

export function parseCodexLiveRecord(line: string, index: number): CodexLiveRecord | null {
  const record = safeJson(line)
  if (!record) return null

  return parseCodexLiveRecordFromRecord(record, index)
}

function parseCodexLiveRecordFromRecord(record: Record<string, unknown>, index: number): CodexLiveRecord | null {
  const timestamp = readString(record.timestamp) || readString(record.time)
  const payload = readRecord(record.payload)
  const fallbackId = `${timestamp || 'record'}-${index}`

  if (readString(record.type) === 'response_item' && payload) {
    if (readString(payload.type) === 'message') {
      const text = responseMessageText(payload.content)
      return makeLiveRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, text),
        index,
        timestamp,
        kind: 'message',
        title: humanize(readString(payload.role) || 'message'),
        text,
        status: 'completed',
      })
    }

    if (readString(payload.type) === 'reasoning') {
      const text = reasoningText(payload.summary)
      if (!text.trim()) return null
      return makeLiveRecord({
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

  if (readString(record.type) === 'event_msg' && payload) {
    if (readString(payload.type) === 'user_message') {
      const text = readString(payload.message)
      return makeLiveRecord({
        id: stableRecordId(record, payload, timestamp, fallbackId, text),
        index,
        timestamp,
        kind: 'message',
        title: 'User',
        text,
        status: 'completed',
      })
    }
  }

  return null
}

function collectCodexLiveExportContext(
  payload: Record<string, unknown>,
  timestamp: string,
  index: number,
  toolCalls: CodexLiveExportToolCall[],
  toolCallsById: Map<string, CodexLiveExportToolCall>,
  editedFilesByPath: Map<string, CodexLiveEditedFile>,
  taskEvents: CodexLiveExportTaskEvent[],
): void {
  const payloadType = readString(payload.type)
  const callId = readString(payload.call_id)

  if (payloadType === 'function_call' || payloadType === 'custom_tool_call') {
    const toolCall = makeExportToolCall(payload, timestamp, index)
    toolCalls.push(toolCall)
    if (toolCall.id) {
      toolCallsById.set(toolCall.id, toolCall)
    }
    return
  }

  if (payloadType === 'function_call_output' || payloadType === 'custom_tool_call_output') {
    const toolCall = toolCallsById.get(callId)
    if (toolCall) {
      toolCall.output = readString(payload.output)
    }
    return
  }

  if (payloadType === 'patch_apply_end') {
    const toolCall = toolCallsById.get(callId)
    if (toolCall) {
      toolCall.status = readString(payload.status) || (readBoolean(payload.success) ? 'completed' : 'failed')
      const output = [readString(payload.stdout), readString(payload.stderr)].filter(Boolean).join('\n')
      if (output.trim()) {
        toolCall.output = output
      }
    }
    collectEditedFiles(payload.changes, editedFilesByPath)
    return
  }

  if (payloadType === 'task_complete') {
    taskEvents.push({
      timestamp,
      type: payloadType,
      status: 'completed',
      summary: taskSummary(payload),
    })
  }
}

function makeExportToolCall(payload: Record<string, unknown>, timestamp: string, index: number): CodexLiveExportToolCall {
  const name = readString(payload.name)
  const parsedArguments = readArguments(payload.arguments)
  const command = readString(parsedArguments?.command)
  const workdir = readString(parsedArguments?.workdir)
  const input = readString(payload.input) || (parsedArguments ? JSON.stringify(parsedArguments, null, 2) : readString(payload.arguments))

  return {
    id: readString(payload.call_id),
    index,
    timestamp,
    name,
    kind: readString(payload.type),
    status: readString(payload.status),
    command,
    workdir,
    input,
    output: '',
  }
}

function collectEditedFiles(value: unknown, editedFilesByPath: Map<string, CodexLiveEditedFile>): void {
  const changes = readRecord(value)
  if (!changes) return

  Object.entries(changes).forEach(([filePath, changeValue]) => {
    const change = readRecord(changeValue)
    if (!change) return

    const existing = editedFilesByPath.get(filePath) ?? {
      path: filePath,
      type: readString(change.type) || 'update',
      movePath: readNullableString(change.move_path),
      unifiedDiffs: [],
    }
    const diff = readString(change.unified_diff)
    if (diff.trim()) {
      existing.unifiedDiffs.push(diff)
    }
    existing.type = readString(change.type) || existing.type
    existing.movePath = readNullableString(change.move_path) ?? existing.movePath
    editedFilesByPath.set(filePath, existing)
  })
}

function readArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return readRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  return readRecord(value)
}

function taskSummary(payload: Record<string, unknown>): string {
  const durationMs = readNumber(payload.duration_ms)
  const completedAt = readNumber(payload.completed_at)
  const parts = [
    completedAt > 0 ? `completed_at=${new Date(completedAt * 1000).toISOString()}` : '',
    durationMs > 0 ? `duration_ms=${durationMs}` : '',
  ].filter(Boolean)
  return parts.join(', ')
}

async function readRecentJsonlLines(filePath: string, limit: number): Promise<string[]> {
  const file = await fs.open(filePath, 'r')
  try {
    const stats = await file.stat()
    if (stats.size <= 0 || limit <= 0) return []

    const maxScanBytes = Math.min(stats.size, USAGE_SCAN_BYTES)
    const linesReversed: string[] = []
    let position = stats.size
    let bytesRead = 0
    let currentLineSegments: Buffer[] = []
    let currentLineBytes = 0
    let skippingOversizedLine = false

    function addCurrentLineSegment(segment: Buffer): void {
      if (segment.length === 0 || skippingOversizedLine) return
      currentLineBytes += segment.length
      if (currentLineBytes > USAGE_TAIL_BYTES) {
        currentLineSegments = []
        skippingOversizedLine = true
        return
      }
      currentLineSegments.unshift(segment)
    }

    function finishCurrentLine(): void {
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

    while (position > 0 && bytesRead < maxScanBytes && linesReversed.length < limit) {
      const readLength = Math.min(USAGE_SCAN_CHUNK_BYTES, position, maxScanBytes - bytesRead)
      const readStart = position - readLength
      const buffer = Buffer.alloc(readLength)
      await file.read(buffer, 0, readLength, readStart)
      position = readStart
      bytesRead += readLength

      let segmentEnd = readLength
      for (let index = readLength - 1; index >= 0 && linesReversed.length < limit; index -= 1) {
        if (buffer[index] !== 0x0a) continue
        addCurrentLineSegment(buffer.subarray(index + 1, segmentEnd))
        finishCurrentLine()
        segmentEnd = index
      }

      if (segmentEnd > 0 && linesReversed.length < limit) {
        addCurrentLineSegment(buffer.subarray(0, segmentEnd))
      }
    }

    if (position === 0 && linesReversed.length < limit) {
      finishCurrentLine()
    }

    return linesReversed.reverse()
  } finally {
    await file.close()
  }
}

function parseTokenUsage(value: unknown): CodexLiveTokenUsage {
  const record = readRecord(value)
  return {
    inputTokens: readNumber(record?.input_tokens),
    cachedInputTokens: readNumber(record?.cached_input_tokens),
    outputTokens: readNumber(record?.output_tokens),
    reasoningOutputTokens: readNumber(record?.reasoning_output_tokens),
    totalTokens: readNumber(record?.total_tokens),
  }
}

function isConversationThinkingRecord(record: CodexLiveRecord): boolean {
  return record.kind === 'message'
    && record.title.toLowerCase() === 'assistant'
    && record.text.trim().length > 0
}

function isConversationUserRecord(record: CodexLiveRecord): boolean {
  return record.kind === 'message' && record.title.toLowerCase() === 'user'
}

function makeLiveRecord(record: Omit<CodexLiveRecord, 'callId'> & Partial<Pick<CodexLiveRecord, 'callId'>>): CodexLiveRecord {
  return {
    callId: '',
    ...record,
  }
}

function responseMessageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const record = readRecord(part)
      return readString(record?.text)
    })
    .filter(Boolean)
    .join('\n\n')
}

function reasoningText(summary: unknown): string {
  if (!Array.isArray(summary)) return ''
  return summary
    .map((item) => typeof item === 'string' ? item : JSON.stringify(item))
    .join('\n')
}

function stableRecordId(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  timestamp: string,
  fallbackId: string,
  text: string,
): string {
  const nativeId = readString(payload.id) || readString(record.id)
  if (nativeId) return `${timestamp || 'record'}-${nativeId}`

  const callId = readString(payload.call_id)
  if (callId) return `${timestamp || 'record'}-${callId}`

  const type = readString(payload.type) || readString(record.type) || 'record'
  const role = readString(payload.role)
  if ((type === 'message' || type === 'user_message' || type === 'reasoning') && text.trim()) {
    return `${timestamp || 'record'}-${type}-${role}-${stableTextHash(text)}`
  }

  return fallbackId
}

function stableTextHash(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function humanize(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function parseRateLimits(value: unknown): CodexLiveRateLimits | null {
  const record = readRecord(value)
  if (!record) return null

  return {
    limitId: readString(record.limit_id),
    limitName: readNullableString(record.limit_name),
    planType: readString(record.plan_type),
    rateLimitReachedType: readNullableString(record.rate_limit_reached_type),
    primary: parseRateLimitWindow(record.primary),
    secondary: parseRateLimitWindow(record.secondary),
    credits: parseCredits(record.credits),
  }
}

function parseRateLimitWindow(value: unknown): CodexLiveRateLimitWindow | null {
  const record = readRecord(value)
  if (!record) return null

  const usedPercent = clampPercent(readNumber(record.used_percent))
  const resetsAt = readNumber(record.resets_at)

  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowMinutes: readNumber(record.window_minutes),
    resetsAt,
    resetsAtIso: resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : '',
  }
}

function parseCredits(value: unknown): CodexLiveRateLimits['credits'] {
  const record = readRecord(value)
  return {
    hasCredits: readBoolean(record?.has_credits),
    unlimited: readBoolean(record?.unlimited),
    balance: typeof record?.balance === 'number' ? record.balance : null,
  }
}

function safeJson(value: string): Record<string, unknown> | null {
  if (!value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return readRecord(parsed)
  } catch {
    return null
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readBoolean(value: unknown): boolean {
  return value === true
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}
