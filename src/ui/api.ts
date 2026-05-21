import type {
  AttachmentRecord,
  CodexLiveActivity,
  CodexLiveContextUsage,
  CodexLiveRecord,
  ConclusionRecord,
  InstructionRecord,
  MessageRecord,
  SessionDetail,
  SessionRecord,
  SessionSummary,
} from '../types'

export interface HealthResponse {
  ok: true
  service: string
  dataRoot: string
  dbPath: string
  sessionsRoot: string
  serverTimeIso: string
}

export interface SessionsResponse {
  ok: true
  sessions: SessionSummary[]
}

export interface SessionResponse {
  ok: true
  session: SessionDetail
}

export interface SessionUsageResponse {
  ok: true
  usage: CodexLiveContextUsage | null
  activity: CodexLiveActivity
  thinkingRecords: CodexLiveRecord[]
}

export interface CreateSessionResponse {
  ok: true
  session: SessionRecord
}

export interface InstructionResponse {
  ok: true
  instruction: InstructionRecord
  session: SessionRecord
}

export interface InstructionDetailResponse {
  ok: true
  instruction: InstructionRecord
  session: SessionDetail
}

export interface DeleteInstructionResponse {
  ok: true
  deleted: boolean
  deletedInstruction: InstructionRecord | null
  session: SessionDetail
}

export interface ConclusionResponse {
  ok: true
  conclusion: ConclusionRecord
  session: SessionRecord
}

export interface AttachmentResponse {
  ok: true
  attachment: AttachmentRecord
}

export interface DeleteAttachmentResponse {
  ok: true
  deletedAttachment: AttachmentRecord
  session: SessionDetail
}

export interface DeleteSessionResponse {
  ok: true
  deleted: boolean
  sessions: SessionSummary[]
}

export interface StopSessionResponse {
  ok: true
  session: SessionRecord
}

export interface ApiErrorResponse {
  ok: false
  error: string
}

export async function fetchHealth(): Promise<HealthResponse> {
  return parseJsonResponse(await fetch('/api/health'))
}

export async function fetchSessions(): Promise<SessionsResponse> {
  return parseJsonResponse(await fetch('/api/sessions'))
}

export async function fetchSession(sessionId: string): Promise<SessionResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`))
}

export async function fetchSessionUsage(sessionId: string): Promise<SessionUsageResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/usage`, { cache: 'no-store' }))
}

export async function createSessionByThread(codexThreadId: string, displayName = ''): Promise<CreateSessionResponse> {
  return parseJsonResponse(await fetch(`/api/codex/sessions/by-thread/${encodeURIComponent(codexThreadId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  }))
}

export async function sendInstruction(sessionId: string, content: string): Promise<InstructionResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/instructions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }))
}

export async function updateInstruction(sessionId: string, instructionId: string, content: string): Promise<InstructionDetailResponse> {
  return parseJsonResponse(await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/instructions/${encodeURIComponent(instructionId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    },
  ))
}

export async function deleteInstruction(sessionId: string, instructionId: string): Promise<DeleteInstructionResponse> {
  return parseJsonResponse(await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/instructions/${encodeURIComponent(instructionId)}`,
    { method: 'DELETE' },
  ))
}

export async function clearConversation(sessionId: string): Promise<SessionResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'DELETE',
  }))
}

export async function stopSession(sessionId: string): Promise<StopSessionResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  }))
}

export async function deleteSession(sessionId: string): Promise<DeleteSessionResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  }))
}

export async function uploadAttachment(sessionId: string, file: File): Promise<AttachmentResponse> {
  const formData = new FormData()
  formData.append('file', file)

  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    body: formData,
  }))
}

export async function deleteAttachment(sessionId: string, attachmentId: string): Promise<DeleteAttachmentResponse> {
  return parseJsonResponse(await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  ))
}

export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as unknown
  if (!response.ok) {
    throw new Error(isApiErrorResponse(payload) ? payload.error : 'Request failed')
  }
  return payload as T
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return value !== null && typeof value === 'object' && 'error' in value
}
