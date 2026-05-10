import type {
  ApiErrorResponse,
  InstructionRequest,
  ManagerResponse,
  ManagerSnapshot,
  RunSnapshotResponse,
  Snapshot,
} from './shared/protocol'

export async function fetchSnapshot(): Promise<ManagerSnapshot> {
  const response = await fetch('/api/snapshot')
  return parseJsonResponse<ManagerSnapshot>(response)
}

export async function fetchRunSnapshot(runId: string): Promise<Snapshot> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/snapshot`)
  return parseJsonResponse<Snapshot>(response)
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

export async function uploadAttachment(runId: string, file: File): Promise<RunSnapshotResponse> {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/upload`, {
    method: 'POST',
    body: formData,
  })

  return parseJsonResponse<RunSnapshotResponse>(response)
}

export async function clearConversationHistory(runId: string): Promise<RunSnapshotResponse> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/messages`, {
    method: 'DELETE',
  })

  return parseJsonResponse<RunSnapshotResponse>(response)
}

export async function deleteRun(runId: string): Promise<ManagerResponse> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  })

  return parseJsonResponse<ManagerResponse>(response)
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
