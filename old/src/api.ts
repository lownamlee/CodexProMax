import type {
  ApiErrorResponse,
  CodexLiveHistoryResponse,
  CodexLiveSessionsResponse,
  CreateTeammateRequest,
  InstructionRequest,
  ManagerResponse,
  ManagerSnapshot,
  ProtocolFileContentResponse,
  ProtocolTextFile,
  RunSnapshotResponse,
  Snapshot,
  TeammatesResponse,
  UploadAttachmentResponse,
} from './shared/protocol'

export async function fetchSnapshot(): Promise<ManagerSnapshot> {
  const response = await fetch('/api/snapshot')
  return parseJsonResponse<ManagerSnapshot>(response)
}

export async function fetchRunSnapshot(runId: string): Promise<Snapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/snapshot`)
  return parseJsonResponse<Snapshot>(response)
}

export async function fetchProtocolFile(
  runId: string,
  fileName: ProtocolTextFile,
): Promise<ProtocolFileContentResponse> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(fileName)}`,
  )
  return parseJsonResponse<ProtocolFileContentResponse>(response)
}

export async function submitInstruction(
  runId: string,
  request: InstructionRequest,
): Promise<RunSnapshotResponse> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/action`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  return parseJsonResponse<RunSnapshotResponse>(response)
}

export async function uploadAttachment(runId: string, file: File): Promise<UploadAttachmentResponse> {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/upload`, {
    method: 'POST',
    body: formData,
  })

  return parseJsonResponse<UploadAttachmentResponse>(response)
}

export async function deleteAttachment(runId: string, fileName: string): Promise<RunSnapshotResponse> {
  const response = await fetch(
    `/api/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(fileName)}`,
    {
      method: 'DELETE',
    },
  )

  return parseJsonResponse<RunSnapshotResponse>(response)
}

export async function clearConversationHistory(runId: string): Promise<RunSnapshotResponse> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/messages`, {
    method: 'DELETE',
  })

  return parseJsonResponse<RunSnapshotResponse>(response)
}

export async function requestSessionStop(runId: string): Promise<RunSnapshotResponse> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
  })

  return parseJsonResponse<RunSnapshotResponse>(response)
}

export async function deleteRun(runId: string): Promise<ManagerResponse> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  })

  return parseJsonResponse<ManagerResponse>(response)
}

export async function fetchTeammates(): Promise<TeammatesResponse> {
  const response = await fetch('/api/teammates')
  return parseJsonResponse<TeammatesResponse>(response)
}

export async function createTeammate(request: CreateTeammateRequest): Promise<TeammatesResponse> {
  const response = await fetch('/api/teammates', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  return parseJsonResponse<TeammatesResponse>(response)
}

export async function fetchCodexLiveSessions(): Promise<CodexLiveSessionsResponse> {
  const response = await fetch('/api/codex-live/sessions?limit=100')
  return parseJsonResponse<CodexLiveSessionsResponse>(response)
}

export const CODEX_LIVE_HISTORY_RECORD_LIMIT = 500
export const CODEX_LIVE_HISTORY_TAIL_BYTES = 2 * 1024 * 1024

export async function fetchCodexLiveHistory(
  sessionId: string,
  records = CODEX_LIVE_HISTORY_RECORD_LIMIT,
  tailBytes = CODEX_LIVE_HISTORY_TAIL_BYTES,
): Promise<CodexLiveHistoryResponse> {
  const response = await fetch(`/api/codex-live/sessions/${encodeURIComponent(sessionId)}?${new URLSearchParams({
    records: String(records),
    tailBytes: String(tailBytes),
  })}`)
  return parseJsonResponse<CodexLiveHistoryResponse>(response)
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message =
      isApiErrorResponse(payload) ? payload.error : 'Request failed'
    throw new Error(message)
  }

  return payload as T
}

function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return value !== null && typeof value === 'object' && 'error' in value
}
