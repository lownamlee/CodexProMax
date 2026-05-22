export const SESSION_STATUSES = ['RUNNING', 'WAITING_FOR_INSTRUCTION', 'STOPPED', 'ERROR'] as const

export type SessionStatus = typeof SESSION_STATUSES[number]

export type MessageRole = 'user' | 'codex' | 'system'

export interface RolloutLookup {
  codexThreadId: string
  rootPath: string
  rolloutPath: string
  codexLiveSessionId: string
  fileName: string
  relativePath: string
  createdAtIso: string
  updatedAtIso: string
  sizeBytes: number
  matchCount: number
}

export interface SessionRecord {
  id: string
  codexThreadId: string
  rolloutPath: string | null
  codexLiveSessionId: string | null
  displayName: string | null
  status: SessionStatus
  createdAt: string
  updatedAt: string
  lastSeenAt: string
}

export interface SessionSummary extends SessionRecord {
  latestConclusion: string
  attachmentCount: number
  queuedInstructionCount: number
  consumedInstructionCount: number
  messageCount: number
  hasQueuedInstruction: boolean
}

export interface MessageRecord {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  createdAt: string
}

export interface ConclusionRecord {
  id: string
  sessionId: string
  content: string
  createdAt: string
}

export interface InstructionRecord {
  id: string
  sessionId: string
  content: string
  consumedAt: string | null
  createdAt: string
}

export interface AttachmentRecord {
  id: string
  sessionId: string
  originalName: string
  storedName: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  createdAt: string
}

export type SkillOrigin = 'system' | 'user'

export interface SkillRecord {
  id: string
  name: string
  content: string
  origin: SkillOrigin
  createdAt: string
  updatedAt: string
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

export interface CodexLiveActivity {
  latestEventAt: string | null
  latestRecordType: string
  hasRolloutActivity: boolean
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

export interface CodexLiveSessionState {
  usage: CodexLiveContextUsage | null
  activity: CodexLiveActivity
  thinkingRecords: CodexLiveRecord[]
}

export interface SessionDetail extends SessionRecord {
  messages: MessageRecord[]
  conclusions: ConclusionRecord[]
  instructions: InstructionRecord[]
  attachments: AttachmentRecord[]
}
