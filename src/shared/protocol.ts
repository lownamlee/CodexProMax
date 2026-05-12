export const VALID_STATUSES = [
  'RUNNING',
  'WAITING_FOR_REVIEW',
  'INSTRUCTION_RECEIVED',
  'STOPPED',
  'BLOCKED',
  'ERROR',
] as const

export type ProtocolStatus = (typeof VALID_STATUSES)[number]

export type ProtocolStatusOwner = 'agent' | 'ui'

export const STATUS_DETAILS: Record<
  ProtocolStatus,
  {
    owner: ProtocolStatusOwner
    help: string
  }
> = {
  RUNNING: {
    owner: 'agent',
    help: 'Agent-owned running state. Codex has consumed the instruction and is working.',
  },
  WAITING_FOR_REVIEW: {
    owner: 'agent',
    help: 'Agent-owned review state. The UI can send the next human instruction to the selected run.',
  },
  INSTRUCTION_RECEIVED: {
    owner: 'ui',
    help: 'UI-owned instruction state. The agent consumes instruction.txt, sets RUNNING, and continues unless told to stop.',
  },
  STOPPED: {
    owner: 'agent',
    help: 'Terminal state for a run closed from the Codex Pro Max UI.',
  },
  BLOCKED: {
    owner: 'agent',
    help: 'Agent-owned blocked state. The agent is waiting on an external dependency or human instruction.',
  },
  ERROR: {
    owner: 'agent',
    help: 'Agent-owned error state. The agent hit a failure and is waiting for human instruction.',
  },
}

export const PROTOCOL_TEXT_FILES = [
  'status.txt',
  'output.md',
  'instruction.txt',
  'session.md',
  'events.ndjson',
] as const

export type ProtocolTextFile = (typeof PROTOCOL_TEXT_FILES)[number]

export const MARKDOWN_WARN_BYTES = 500 * 1024
export const MARKDOWN_RENDER_LIMIT_BYTES = 1024 * 1024

export const MARKDOWN_FILES = ['output.md'] as const

export type MarkdownFile = (typeof MARKDOWN_FILES)[number]

export const RUNS_DIR_NAME = 'runs'

export interface FileMeta {
  exists: boolean
  mtimeMs: number | null
  mtimeIso: string | null
  size: number | null
}

export interface AttachmentMeta {
  name: string
  url: string
  size: number
  mtimeMs: number
  mtimeIso: string
}

export type ChatMessageRole = 'assistant' | 'user'

export interface ChatMessage {
  id: string
  role: ChatMessageRole
  content: string
  createdAtIso: string
}

export interface MarkdownSafety {
  fileName: MarkdownFile
  originalBytes: number
  renderedBytes: number
  warnBytes: number
  limitBytes: number
  warning: boolean
  truncated: boolean
}

export interface Snapshot {
  runId: string
  displayName: string
  rootPath: string
  status: ProtocolStatus
  outputMd: string
  markdownSafety: Record<MarkdownFile, MarkdownSafety>
  instruction: string
  files: Record<ProtocolTextFile, FileMeta>
  attachments: AttachmentMeta[]
  messages: ChatMessage[]
  health: {
    serverTimeIso: string
    rootExists: boolean
    watcherReady: boolean
  }
}

export interface RunMetadata {
  runId: string
  displayName: string
  workspacePath: string
  createdAtIso: string
  updatedAtIso: string
  codexThreadId: string | null
}

export interface RunSummary {
  runId: string
  displayName: string
  rootPath: string
  status: ProtocolStatus
  owner: ProtocolStatusOwner
  updatedAtIso: string | null
  updatedAtMs: number | null
  outputPreview: string
  attachmentCount: number
  hasInstruction: boolean
}

export interface ManagerSnapshot {
  rootPath: string
  runsPath: string
  runs: RunSummary[]
  selectedRunId: string | null
  health: {
    serverTimeIso: string
    rootExists: boolean
    watcherReady: boolean
  }
}

export interface Teammate {
  id: string
  name: string
  email: string
  avatarUrl: string
  role: string
  seat: string
  dateAdded: string
}

export const MAX_TEAMMATES = 7
export const TEAMMATE_AVATAR_URLS = [
  'https://media.tenor.com/zj5uslovBGsAAAAi/quby-pentol.gif',
  'https://media.tenor.com/RsEw4m8_9m0AAAAi/rexx.gif',
  'https://media.tenor.com/RwFun47b8usAAAAi/quby-judge-quby.gif',
  'https://media.tenor.com/1qQsH1Hs31MAAAAj/tkthao219-quby-sticker.gif',
  'https://media.tenor.com/ZA2fRCPlnIYAAAAi/tkthao219-quby.gif',
  'https://media.tenor.com/i4XqnAqNA3sAAAAi/quby-cute.gif',
  'https://media.tenor.com/iysHH4JLrg0AAAAi/quby-pentol.gif',
] as const

export const DEFAULT_TEAMMATES: Teammate[] = [
  'Cheeseburger',
  'Double Burger',
  'Chicken Burger',
  'Fish Burger',
  'Veggie Burger',
].map((name, index) => ({
  id: `burger-${index + 1}`,
  name,
  email: `${name.toLowerCase().replace(/\s+/g, '')}@codexpromax.com`,
  avatarUrl: TEAMMATE_AVATAR_URLS[index],
  role: index === 0 ? 'Owner' : 'Member',
  seat: 'Codex Pro Max',
  dateAdded: 'May 10, 2026',
}))

export interface InstructionRequest {
  instruction: string
}

export interface CreateTeammateRequest {
  email: string
}

export interface RunSnapshotResponse {
  ok: true
  snapshot: Snapshot
}

export interface UploadAttachmentResponse extends RunSnapshotResponse {
  attachment: AttachmentMeta
}

export interface ProtocolFileContentResponse {
  ok: true
  fileName: ProtocolTextFile
  content: string
  truncated: boolean
  size: number
}

export interface ManagerResponse {
  ok: true
  snapshot: ManagerSnapshot
}

export interface TeammatesResponse {
  ok: true
  teammates: Teammate[]
}

export interface CodexLiveSessionSummary {
  id: string
  fileName: string
  relativePath: string
  createdAtIso: string
  updatedAtIso: string
  sizeBytes: number
}

export type CodexLiveRecordKind = 'message' | 'tool-call' | 'tool-output' | 'reasoning' | 'event' | 'action-group'

export interface CodexLiveRecord {
  id: string
  index: number
  timestamp: string
  kind: CodexLiveRecordKind
  title: string
  text: string
  callId: string
  status: 'completed' | 'failed' | 'running' | 'waiting' | 'unknown'
  children?: CodexLiveRecord[]
}

export interface CodexLiveContextUsage {
  timestamp: string
  contextWindow: number
  usedTokens: number
  remainingTokens: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  percentUsed: number
  percentRemaining: number
  totalUsage: CodexLiveTokenUsage
  rateLimits: CodexLiveRateLimits | null
}

export interface CodexLiveTokenUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export interface CodexLiveRateLimits {
  limitId: string
  limitName: string | null
  planType: string
  rateLimitReachedType: string | null
  primary: CodexLiveRateLimitWindow | null
  secondary: CodexLiveRateLimitWindow | null
  credits: {
    hasCredits: boolean
    unlimited: boolean
    balance: number | null
  }
}

export interface CodexLiveRateLimitWindow {
  usedPercent: number
  remainingPercent: number
  windowMinutes: number
  resetsAt: number
  resetsAtIso: string
}

export interface CodexLiveSessionsResponse {
  ok: true
  rootPath: string
  sessions: CodexLiveSessionSummary[]
}

export interface CodexLiveHistoryResponse {
  ok: true
  rootPath: string
  session: CodexLiveSessionSummary
  records: CodexLiveRecord[]
  context: CodexLiveContextUsage | null
  tailBytes: number
  totalSizeBytes: number
  truncated: boolean
}

export interface ApiErrorResponse {
  ok: false
  error: string
}

export function isProtocolStatus(value: string): value is ProtocolStatus {
  return (VALID_STATUSES as readonly string[]).includes(value)
}
