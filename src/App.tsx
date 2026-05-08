import { useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import {
  deleteRun as deleteRunRequest,
  fetchRunSnapshot,
  submitAction,
  uploadAttachment,
} from './api'
import { useSnapshotStream } from './hooks/useSnapshotStream'
import type {
  AttachmentMeta,
  ManagerSnapshot,
  MarkdownSafety,
  ProtocolStatus,
  ProtocolTextFile,
  ReviewAction,
  RunSummary,
  Snapshot,
} from './shared/protocol'
import { PROTOCOL_TEXT_FILES, STATUS_DETAILS } from './shared/protocol'

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const FILE_ICONS: Record<ProtocolTextFile, string> = {
  'status.txt': 'ri-flag-2-line',
  'progress.md': 'ri-list-check-3',
  'output.md': 'ri-article-line',
  'instruction.txt': 'ri-quill-pen-line',
  'events.ndjson': 'ri-stack-line',
}

function App() {
  const { snapshot: managerSnapshot, connectionState, error: streamError } = useSnapshotStream()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runSnapshot, setRunSnapshot] = useState<Snapshot | null>(null)
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState<ReviewAction | 'upload' | 'load' | null>(null)
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)

  const runs = managerSnapshot?.runs ?? []
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null

  useEffect(() => {
    if (!managerSnapshot) {
      return
    }

    const selectedStillExists = runs.some((run) => run.runId === selectedRunId)
    if (!selectedRunId || !selectedStillExists) {
      setSelectedRunId(managerSnapshot.selectedRunId)
    }
  }, [managerSnapshot, runs, selectedRunId])

  useEffect(() => {
    if (!selectedRunId) {
      setRunSnapshot(null)
      return
    }

    let ignore = false
    setPending((value) => value ?? 'load')
    setActionError(null)

    fetchRunSnapshot(selectedRunId)
      .then((nextSnapshot) => {
        if (!ignore) {
          setRunSnapshot(nextSnapshot)
        }
      })
      .catch((error: unknown) => {
        if (!ignore) {
          setActionError(error instanceof Error ? error.message : 'Run snapshot request failed')
        }
      })
      .finally(() => {
        if (!ignore) {
          setPending((value) => (value === 'load' ? null : value))
        }
      })

    return () => {
      ignore = true
    }
  }, [selectedRunId, managerSnapshot?.health.serverTimeIso])

  async function runAction(action: ReviewAction) {
    if (!selectedRunId) {
      setActionError('Select a run before sending a review action.')
      return
    }

    setPending(action)
    setActionError(null)

    try {
      const response = await submitAction(selectedRunId, { action, instruction })
      setRunSnapshot(response.snapshot)
      setInstruction('')
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed')
    } finally {
      setPending(null)
    }
  }

  async function handleUpload(file: File | undefined) {
    if (!file || !selectedRunId) {
      return
    }

    setPending('upload')
    setActionError(null)

    try {
      const response = await uploadAttachment(selectedRunId, file)
      setRunSnapshot(response.snapshot)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Upload failed')
    } finally {
      setPending(null)
    }
  }

  async function handleDeleteRun(run: RunSummary) {
    if (run.isLegacy) {
      return
    }

    const confirmed = window.confirm(
      `Delete run "${run.displayName}"?\n\nThis removes runs/${run.runId}/ and its protocol files.`,
    )
    if (!confirmed) {
      return
    }

    setDeletingRunId(run.runId)
    setActionError(null)

    try {
      await deleteRunRequest(run.runId)
      if (selectedRunId === run.runId) {
        setSelectedRunId(null)
        setRunSnapshot(null)
        setInstruction('')
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Delete failed')
    } finally {
      setDeletingRunId(null)
    }
  }

  const status: ProtocolStatus = runSnapshot?.status ?? selectedRun?.status ?? 'IDLE'
  const statusDetails = STATUS_DETAILS[status]
  const attachments = runSnapshot?.attachments ?? []
  const filesPresent = useMemo(() => {
    if (!runSnapshot) return 0
    return PROTOCOL_TEXT_FILES.filter((name) => runSnapshot.files[name]?.exists).length
  }, [runSnapshot])

  const busy = Boolean(pending)
  const selectedTitle = selectedRun?.displayName ?? runSnapshot?.displayName ?? 'No run selected'
  const managerRoot = managerSnapshot?.rootPath ?? 'Loading workspace...'

  return (
    <div className={`app ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      <RunInbox
        runs={runs}
        selectedRunId={selectedRunId}
        deletingRunId={deletingRunId}
        collapsed={leftCollapsed}
        onSelect={(runId) => {
          setInstruction('')
          setRunSnapshot(null)
          setSelectedRunId(runId)
        }}
        onDelete={(run) => void handleDeleteRun(run)}
      />

      <main className="chat-container">
        <header className="chat-header">
          <div className="header-left">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setLeftCollapsed((value) => !value)}
              aria-label="Toggle runs"
              title="Toggle runs"
            >
              <i className="ri-menu-4-line" aria-hidden="true" />
            </button>

            <div className="chat-title-wrapper">
              <span className="chat-title" title={selectedTitle}>
                {selectedTitle}
              </span>
              <StatusBadge status={status} />
            </div>
          </div>

          <div className="header-right">
            <ConnectionPill state={connectionState} />
            <span className="run-count-pill">
              {runs.length} {runs.length === 1 ? 'run' : 'runs'}
            </span>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setRightCollapsed((value) => !value)}
              aria-label="Toggle protocol details"
              title="Toggle protocol details"
            >
              <i className="ri-layout-right-2-line" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="chat-scroll">
          {runs.length === 0 ? (
            <EmptyInbox managerSnapshot={managerSnapshot} />
          ) : (
            <article className="message">
              <div className="avatar" aria-hidden="true">
                <i className="ri-robot-2-fill" />
              </div>

              <div className="message-content">
                <StatusSummary
                  managerSnapshot={managerSnapshot}
                  runSnapshot={runSnapshot}
                  selectedRun={selectedRun}
                  filesPresent={filesPresent}
                />

                <MarkdownMessageBlock
                  label="Output"
                  meta={runSnapshot ? fileMeta(runSnapshot, 'output.md') : null}
                  markdown={runSnapshot?.outputMd ?? ''}
                  safety={runSnapshot?.markdownSafety['output.md'] ?? null}
                  emptyIcon="ri-file-paper-2-line"
                  emptyText={pending === 'load' ? 'Loading run output...' : 'No output draft yet.'}
                />

                <MarkdownMessageBlock
                  label="Progress Notes"
                  meta={runSnapshot ? fileMeta(runSnapshot, 'progress.md') : null}
                  markdown={runSnapshot?.progressMd ?? ''}
                  safety={runSnapshot?.markdownSafety['progress.md'] ?? null}
                  emptyIcon="ri-quill-pen-line"
                  emptyText={pending === 'load' ? 'Loading run progress...' : 'No progress notes yet.'}
                />
              </div>
            </article>
          )}
        </div>

        <ReviewComposer
          instruction={instruction}
          onInstructionChange={setInstruction}
          pending={pending}
          canSend={Boolean(selectedRunId) && instruction.trim().length > 0 && !busy}
          onSend={() => void runAction('instruct')}
          onUpload={(file) => void handleUpload(file)}
          error={actionError ?? streamError ?? null}
        />
      </main>

      <ProtocolSidebar
        collapsed={rightCollapsed}
        managerRoot={managerRoot}
        status={status}
        statusDetails={statusDetails}
        snapshot={runSnapshot}
        attachments={attachments}
        filesPresent={filesPresent}
      />
    </div>
  )
}

function RunInbox({
  runs,
  selectedRunId,
  deletingRunId,
  collapsed,
  onSelect,
  onDelete,
}: {
  runs: RunSummary[]
  selectedRunId: string | null
  deletingRunId: string | null
  collapsed: boolean
  onSelect: (runId: string) => void
  onDelete: (run: RunSummary) => void
}) {
  return (
    <aside id="left-sidebar" className={`sidebar left-sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Run inbox">
      <div className="sidebar-inner">
        <div className="brand-area">
          <div className="brand-icon" aria-hidden="true">
            <i className="ri-shield-check-fill" />
          </div>
          <div className="brand-text">Codex Pro Max</div>
        </div>

        {runs.length === 0 ? (
          <div className="run-empty">
            <i className="ri-folder-3-line" aria-hidden="true" />
            <p>No runs yet.</p>
            <code>runs/&lt;runId&gt;/</code>
          </div>
        ) : (
          <div className="run-list">
            {runs.map((run) => (
              <div
                key={run.runId}
                className={`run-item ${run.runId === selectedRunId ? 'active' : ''}`}
                aria-current={run.runId === selectedRunId ? 'true' : undefined}
              >
                <button
                  type="button"
                  className="run-select-button"
                  onClick={() => onSelect(run.runId)}
                  aria-current={run.runId === selectedRunId ? 'true' : undefined}
                  title={`${run.displayName} - ${run.status}`}
                >
                  <i
                    className={`${run.runId === selectedRunId ? 'ri-chat-3-line' : 'ri-history-line'} run-icon`}
                    aria-hidden="true"
                  />
                  <span className="run-title">{run.displayName}</span>
                  <span className="run-meta">
                    {run.isLegacy ? 'Legacy root' : run.runId}
                    {run.attachmentCount > 0 ? ` - ${run.attachmentCount} attachments` : ''}
                  </span>
                  <span className="run-preview">
                    {run.outputPreview || run.progressPreview || 'No output yet.'}
                  </span>
                </button>

                {!run.isLegacy && (
                  <button
                    type="button"
                    className="run-delete-button"
                    onClick={() => onDelete(run)}
                    disabled={deletingRunId === run.runId}
                    aria-label={`Delete ${run.runId}`}
                    title={`Delete ${run.displayName}`}
                  >
                    <i className="ri-delete-bin-6-line" aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}

function StatusSummary({
  managerSnapshot,
  runSnapshot,
  selectedRun,
  filesPresent,
}: {
  managerSnapshot: ManagerSnapshot | null
  runSnapshot: Snapshot | null
  selectedRun: RunSummary | null
  filesPresent: number
}) {
  const status = runSnapshot?.status ?? selectedRun?.status ?? 'IDLE'
  const detail = STATUS_DETAILS[status]
  const runCount = managerSnapshot?.runs.length ?? 0
  const activeCount =
    managerSnapshot?.runs.filter((run) => run.status === 'WAITING_FOR_REVIEW' || run.owner === 'ui').length ?? 0

  return (
    <section className="summary-strip" aria-label="Protocol summary">
      <MetricPill icon="ri-inbox-line" value={`${runCount}`} label="Runs" />
      <MetricPill icon="ri-pulse-line" value={`${activeCount}`} label="Needs review" />
      <MetricPill
        icon={detail.owner === 'ui' ? 'ri-user-3-line' : 'ri-robot-2-line'}
        value={detail.owner === 'ui' ? 'Human' : 'Agent'}
        label="Owner"
      />
      <MetricPill icon="ri-file-list-3-line" value={`${filesPresent}/${PROTOCOL_TEXT_FILES.length}`} label="Files" />
      <p className="status-help">
        {selectedRun
          ? `${selectedRun.displayName}: ${detail.help}`
          : 'No run selected. Create runs/<runId>/ or start a Codex session with the HITL skill.'}
      </p>
    </section>
  )
}

function MetricPill({ icon, value, label }: { icon: string; value: string; label: string }) {
  return (
    <div className="metric-pill">
      <i className={icon} aria-hidden="true" />
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  )
}

function MarkdownMessageBlock({
  label,
  meta,
  markdown,
  safety,
  emptyIcon,
  emptyText,
}: {
  label: string
  meta?: ReactNode
  markdown: string
  safety: MarkdownSafety | null
  emptyIcon?: string
  emptyText: string
}) {
  return (
    <section className="message-block" aria-label={label}>
      <div className="label-row">
        <span className="label-super">{label}</span>
        {meta && <span className="section-meta">{meta}</span>}
      </div>
      <MarkdownPanel markdown={markdown} safety={safety} emptyIcon={emptyIcon} emptyText={emptyText} />
    </section>
  )
}

function MarkdownPanel({
  markdown,
  safety,
  emptyIcon,
  emptyText,
}: {
  markdown: string
  safety: MarkdownSafety | null
  emptyIcon?: string
  emptyText: string
}) {
  const warning = safety?.warning ? <MarkdownWarning safety={safety} /> : null

  if (!markdown.trim()) {
    return (
      <>
        {warning}
        <div className="empty-state">
          {emptyIcon && <i className={emptyIcon} aria-hidden="true" />}
          <p>{emptyText}</p>
        </div>
      </>
    )
  }

  return (
    <>
      {warning}
      <div className="prose markdown-body">
        <ReactMarkdown>{markdown}</ReactMarkdown>
      </div>
    </>
  )
}

function MarkdownWarning({ safety }: { safety: MarkdownSafety }) {
  return (
    <p className="warning-banner" data-testid={`${safety.fileName}-markdown-warning`}>
      <i className="ri-error-warning-line" aria-hidden="true" />
      <span>
        {safety.truncated
          ? `${safety.fileName} is ${formatBytes(safety.originalBytes)}. Rendering first ${formatBytes(
              safety.renderedBytes,
            )}.`
          : `${safety.fileName} is ${formatBytes(safety.originalBytes)}.`}
      </span>
    </p>
  )
}

function ReviewComposer({
  instruction,
  onInstructionChange,
  pending,
  canSend,
  onSend,
  onUpload,
  error,
}: {
  instruction: string
  onInstructionChange: (value: string) => void
  pending: ReviewAction | 'upload' | 'load' | null
  canSend: boolean
  onSend: () => void
  onUpload: (file: File | undefined) => void
  error: string | null
}) {
  return (
    <section className="composer-wrapper" aria-label="Review">
      <label className="sr-only" htmlFor="instruction">
        Instruction
      </label>
      <div className="composer">
        <label className="composer-btn" title={pending === 'upload' ? 'Uploading...' : 'Attach review image'}>
          <i className={pending === 'upload' ? 'ri-loader-4-line' : 'ri-attachment-2'} aria-hidden="true" />
          <span className="sr-only">{pending === 'upload' ? 'Uploading...' : 'Attach review image'}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp,image/avif"
            disabled={Boolean(pending)}
            onChange={(event) => {
              onUpload(event.target.files?.[0])
              event.currentTarget.value = ''
            }}
          />
        </label>

        <textarea
          id="instruction"
          value={instruction}
          onChange={(event) => onInstructionChange(event.target.value)}
          rows={1}
          placeholder="Write your instructions to Codex..."
          spellCheck
        />

        <button
          type="button"
          className="send-btn"
          disabled={!canSend}
          onClick={onSend}
          title="Send to Codex"
        >
          <i className={pending === 'instruct' ? 'ri-loader-4-line' : 'ri-send-plane-fill'} aria-hidden="true" />
          <span className="sr-only">{pending === 'instruct' ? 'Sending...' : 'Send to Codex'}</span>
        </button>
      </div>

      {error && (
        <p className="error-message" role="alert">
          <i className="ri-error-warning-line" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </section>
  )
}

function ProtocolSidebar({
  collapsed,
  managerRoot,
  status,
  statusDetails,
  snapshot,
  attachments,
  filesPresent,
}: {
  collapsed: boolean
  managerRoot: string
  status: ProtocolStatus
  statusDetails: (typeof STATUS_DETAILS)[ProtocolStatus]
  snapshot: Snapshot | null
  attachments: AttachmentMeta[]
  filesPresent: number
}) {
  return (
    <aside
      id="right-sidebar"
      className={`sidebar right-sidebar ${collapsed ? 'collapsed' : ''}`}
      aria-label="Protocol details"
    >
      <div className="sidebar-inner">
        <div className="meta-group">
          <h4>Workspace</h4>
          <p className="root-path" title={managerRoot}>
            {managerRoot}
          </p>
        </div>

        <div className="meta-group">
          <h4>Current Status</h4>
          <div className="status-card">
            <span data-testid="current-status">{status}</span>
            <small data-testid="status-owner">{statusDetails.owner}</small>
            <p>{statusDetails.help}</p>
          </div>
        </div>

        <div className="meta-group">
          <h4>Protocol Files</h4>
          <div className="file-count">
            {filesPresent}
            <span> / {PROTOCOL_TEXT_FILES.length} present</span>
          </div>
          <div className="file-card-list">
            {PROTOCOL_TEXT_FILES.map((fileName) => (
              <FileCard key={fileName} fileName={fileName} snapshot={snapshot} />
            ))}
          </div>
        </div>

        <div className="meta-group">
          <h4>Attachments</h4>
          <AttachmentList attachments={attachments} />
        </div>
      </div>
    </aside>
  )
}

function FileCard({
  fileName,
  snapshot,
}: {
  fileName: ProtocolTextFile
  snapshot: Snapshot | null
}) {
  const meta = snapshot?.files[fileName]
  const exists = Boolean(snapshot && meta?.exists)

  return (
    <div className={`file-card ${exists ? 'exists' : 'missing'}`} title={exists && snapshot ? fileMeta(snapshot, fileName) : 'missing'}>
      <div className="file-icon" aria-hidden="true">
        <i className={FILE_ICONS[fileName]} />
      </div>
      <div className="file-copy">
        <div className="file-name">{fileName}</div>
        <div className="file-meta">{snapshot && meta?.exists ? fileMeta(snapshot, fileName) : 'missing'}</div>
      </div>
    </div>
  )
}

function AttachmentList({ attachments }: { attachments: AttachmentMeta[] }) {
  if (attachments.length === 0) {
    return (
      <p className="empty-state compact">
        <i className="ri-image-line" aria-hidden="true" />
        No attachments yet.
      </p>
    )
  }

  return (
    <ul className="attachment-list">
      {attachments.map((attachment) => (
        <li key={attachment.name} className="file-card exists">
          <div className="file-icon" aria-hidden="true">
            <i className="ri-image-2-line" />
          </div>
          <div className="file-copy">
            <a className="file-name" href={attachment.url} target="_blank" rel="noreferrer">
              {attachment.name}
            </a>
            <div className="file-meta">{formatBytes(attachment.size)}</div>
          </div>
        </li>
      ))}
    </ul>
  )
}

function EmptyInbox({ managerSnapshot }: { managerSnapshot: ManagerSnapshot | null }) {
  return (
    <article className="message empty-message" aria-label="Empty inbox">
      <div className="avatar" aria-hidden="true">
        <i className="ri-inbox-2-line" />
      </div>
      <div className="message-content">
        <span className="label-super">Inbox</span>
        <div className="empty-state large">
          <h2>No Codex runs found</h2>
          <p>
            Start a Codex session with the HITL skill, or create a run folder under{' '}
            <code>{managerSnapshot?.runsPath ?? 'runs/<runId>/'}</code>.
          </p>
        </div>
      </div>
    </article>
  )
}

function StatusBadge({ status }: { status: ProtocolStatus }) {
  const className = `status-badge status-${status.toLowerCase().replaceAll('_', '-')}`
  return <span className={className}>{status}</span>
}

function ConnectionPill({ state }: { state: string }) {
  return (
    <span className={`connection-pill connection-${state}`} title={`SSE ${state}`}>
      <span aria-hidden="true">{state}</span>
      <span className="sr-only">SSE {state}</span>
    </span>
  )
}

function fileMeta(snapshot: Snapshot, fileName: ProtocolTextFile): string {
  const meta = snapshot.files[fileName]
  if (!meta.exists || !meta.mtimeIso || meta.size === null) {
    return 'missing'
  }

  return `${formatBytes(meta.size)} - ${dateFormatter.format(new Date(meta.mtimeIso))}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}

export default App
