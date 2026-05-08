export const VALID_STATUSES = [
  'IDLE',
  'WAITING_FOR_REVIEW',
  'APPROVED',
  'REVISION_REQUESTED',
  'INSTRUCTION_RECEIVED',
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
  IDLE: {
    owner: 'agent',
    help: 'Agent-owned idle state. The agent can resume work or prepare the next review packet.',
  },
  WAITING_FOR_REVIEW: {
    owner: 'agent',
    help: 'Agent-owned review state. The UI can send the next human instruction to the selected run.',
  },
  APPROVED: {
    owner: 'ui',
    help: 'UI-owned approval state. The agent must consume and clear instruction.txt, then continue waiting unless explicitly told to end.',
  },
  REVISION_REQUESTED: {
    owner: 'ui',
    help: 'UI-owned revision state. The agent must consume and clear instruction.txt, set IDLE, then continue.',
  },
  INSTRUCTION_RECEIVED: {
    owner: 'ui',
    help: 'UI-owned instruction state. The agent must consume and clear instruction.txt, set IDLE, then execute the new instruction.',
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
  'progress.md',
  'output.md',
  'instruction.txt',
  'events.ndjson',
] as const

export type ProtocolTextFile = (typeof PROTOCOL_TEXT_FILES)[number]

export const MARKDOWN_WARN_BYTES = 500 * 1024
export const MARKDOWN_RENDER_LIMIT_BYTES = 1024 * 1024

export const MARKDOWN_FILES = ['output.md', 'progress.md'] as const

export type MarkdownFile = (typeof MARKDOWN_FILES)[number]

export type ReviewAction = 'approve' | 'revision' | 'instruct'

export const RUNS_DIR_NAME = 'runs'
export const LEGACY_RUN_ID = 'legacy-root'

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
  progressMd: string
  markdownSafety: Record<MarkdownFile, MarkdownSafety>
  instruction: string
  files: Record<ProtocolTextFile, FileMeta>
  attachments: AttachmentMeta[]
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
  progressPreview: string
  attachmentCount: number
  hasInstruction: boolean
  isLegacy: boolean
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

export interface ActionRequest {
  action: ReviewAction
  instruction?: string
}

export interface ActionResponse {
  ok: true
  snapshot: Snapshot
}

export interface ManagerResponse {
  ok: true
  snapshot: ManagerSnapshot
}

export interface ApiErrorResponse {
  ok: false
  error: string
}

export function isProtocolStatus(value: string): value is ProtocolStatus {
  return (VALID_STATUSES as readonly string[]).includes(value)
}
