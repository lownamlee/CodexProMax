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
  SkillRecord,
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

export interface SkillsResponse {
  ok: true
  skills: SkillRecord[]
}

export interface SkillMutationResponse extends SkillsResponse {
  skill: SkillRecord
}

export interface DeleteSkillResponse extends SkillsResponse {
  deletedSkill: SkillRecord
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

export async function fetchSkills(): Promise<SkillsResponse> {
  return parseJsonResponse(await fetch('/api/skills'))
}

export async function fetchSession(sessionId: string): Promise<SessionResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`))
}

export async function fetchSessionUsage(sessionId: string): Promise<SessionUsageResponse> {
  return parseJsonResponse(await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/usage`, { cache: 'no-store' }))
}

export async function downloadLatestAiMessagesExport(sessionId: string): Promise<string> {
  const response = await fetch(latestAiMessagesExportUrl(sessionId), { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(await readResponseError(response))
  }

  const blob = await response.blob()
  const fileName = readContentDispositionFileName(response.headers.get('content-disposition'))
    || 'codex-latest-ai-chat.md'
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return fileName
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

export async function createSkill(name: string, content: string): Promise<SkillMutationResponse> {
  return parseJsonResponse(await fetch('/api/skills', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  }))
}

export async function updateSkill(skillId: string, name: string, content: string): Promise<SkillMutationResponse> {
  return parseJsonResponse(await fetch(`/api/skills/${encodeURIComponent(skillId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, content }),
  }))
}

export async function deleteSkill(skillId: string): Promise<DeleteSkillResponse> {
  return parseJsonResponse(await fetch(`/api/skills/${encodeURIComponent(skillId)}`, {
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

export function latestAiMessagesExportUrl(sessionId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/exports/latest-ai-messages`
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

async function readResponseError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as unknown
    return isApiErrorResponse(payload) ? payload.error : 'Request failed'
  } catch {
    return 'Request failed'
  }
}

function readContentDispositionFileName(value: string | null): string {
  if (!value) return ''

  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1])
    } catch {
      return encodedMatch[1]
    }
  }

  const quotedMatch = value.match(/filename="([^"]+)"/i)
  if (quotedMatch?.[1]) return quotedMatch[1]

  const bareMatch = value.match(/filename=([^;]+)/i)
  return bareMatch?.[1]?.trim() ?? ''
}
