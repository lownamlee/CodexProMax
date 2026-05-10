import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type SyntheticEvent,
  type UIEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import {
  clearConversationHistory as clearConversationHistoryRequest,
  deleteAttachment as deleteAttachmentRequest,
  deleteRun as deleteRunRequest,
  fetchRunSnapshot,
  requestSessionStop,
  submitInstruction,
  uploadAttachment,
} from './api'
import { useSnapshotStream } from './hooks/useSnapshotStream'
import type {
  AttachmentMeta,
  ChatMessage,
  ManagerSnapshot,
  MarkdownSafety,
  ProtocolStatus,
  ProtocolTextFile,
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
  'output.md': 'ri-article-line',
  'instruction.txt': 'ri-quill-pen-line',
  'session.md': 'ri-chat-history-line',
  'events.ndjson': 'ri-stack-line',
}

const CHAT_BOTTOM_THRESHOLD_PX = 12
const COMPOSER_TEXTAREA_MIN_HEIGHT_PX = 44
const COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 180

type PendingAction = 'send' | 'upload' | 'load' | 'clear' | 'stop'
type MentionRange = { start: number; end: number; query: string }

function App() {
  const { snapshot: managerSnapshot, connectionState, error: streamError } = useSnapshotStream()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runSnapshot, setRunSnapshot] = useState<Snapshot | null>(null)
  const [instruction, setInstruction] = useState('')
  const [draftAttachmentNames, setDraftAttachmentNames] = useState<string[]>([])
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [deletingAttachmentName, setDeletingAttachmentName] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const [attachmentDragDepth, setAttachmentDragDepth] = useState(0)
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentMeta | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const chatPinnedToBottomRef = useRef(true)

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

  async function sendInstruction() {
    if (!selectedRunId) {
      setActionError('Select a run before sending an instruction.')
      return
    }

    setPending('send')
    setActionError(null)

    try {
      const response = await submitInstruction(selectedRunId, { instruction })
      setRunSnapshot(response.snapshot)
      setInstruction('')
      setDraftAttachmentNames([])
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed')
    } finally {
      setPending(null)
    }
  }

  async function handleClearConversationHistory() {
    if (!selectedRunId) {
      setActionError('Select a run before clearing conversation history.')
      return
    }

    const runLabel = selectedRun?.displayName ?? runSnapshot?.displayName ?? selectedRunId
    const confirmed = window.confirm(
      `Clear conversation history for "${runLabel}"?\n\nThis keeps the session open and leaves the run files intact.`,
    )
    if (!confirmed) {
      return
    }

    setPending('clear')
    setActionError(null)

    try {
      const response = await clearConversationHistoryRequest(selectedRunId)
      chatPinnedToBottomRef.current = true
      setRunSnapshot(response.snapshot)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Clear history failed')
    } finally {
      setPending(null)
    }
  }

  async function handleStopSession() {
    if (!selectedRunId) {
      setActionError('Select a run before stopping the session.')
      return
    }

    const runLabel = selectedRun?.displayName ?? runSnapshot?.displayName ?? selectedRunId
    const confirmed = window.confirm(
      `Stop Codex for "${runLabel}"?\n\nThis sends a stop instruction through the current session.`,
    )
    if (!confirmed) {
      return
    }

    setPending('stop')
    setActionError(null)

    try {
      const response = await requestSessionStop(selectedRunId)
      setRunSnapshot(response.snapshot)
      setInstruction('')
      setDraftAttachmentNames([])
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Stop session failed')
    } finally {
      setPending(null)
    }
  }

  async function handleUpload(file: File | undefined): Promise<AttachmentMeta | null> {
    if (!file) {
      return null
    }

    if (!selectedRunId) {
      setActionError('Select a run before adding attachments.')
      return null
    }

    if (pending) {
      return null
    }

    setPending('upload')
    setActionError(null)

    try {
      const response = await uploadAttachment(selectedRunId, file)
      setRunSnapshot(response.snapshot)
      addDraftAttachment(response.attachment.name)
      return response.attachment
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Upload failed')
      return null
    } finally {
      setPending(null)
    }
  }

  async function handleDeleteAttachment(attachment: AttachmentMeta) {
    if (!selectedRunId) {
      setActionError('Select a run before deleting attachments.')
      return
    }

    const confirmed = window.confirm(`Delete attachment "${attachment.name}"?`)
    if (!confirmed) {
      return
    }

    setDeletingAttachmentName(attachment.name)
    setActionError(null)

    try {
      const response = await deleteAttachmentRequest(selectedRunId, attachment.name)
      setRunSnapshot(response.snapshot)
      setDraftAttachmentNames((names) => names.filter((name) => name !== attachment.name))
      if (previewAttachment?.name === attachment.name) {
        setPreviewAttachment(null)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Delete attachment failed')
    } finally {
      setDeletingAttachmentName(null)
    }
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>): Promise<AttachmentMeta | null> {
    const file = getPastedImageFile(event.clipboardData)
    if (!file) {
      return null
    }

    event.preventDefault()
    return handleUpload(file)
  }

  function addDraftAttachment(name: string) {
    setDraftAttachmentNames((names) => (names.includes(name) ? names : [...names, name]))
  }

  function removeDraftAttachment(name: string) {
    setDraftAttachmentNames((names) => names.filter((item) => item !== name))
    setInstruction((value) => removeAttachmentMention(value, name))
  }

  function handleAttachmentDragEnter(event: DragEvent<HTMLElement>) {
    if (!eventHasFiles(event)) {
      return
    }

    event.preventDefault()
    setAttachmentDragDepth((value) => value + 1)
  }

  function handleAttachmentDragOver(event: DragEvent<HTMLElement>) {
    if (!eventHasFiles(event)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = selectedRunId && !pending ? 'copy' : 'none'
  }

  function handleAttachmentDragLeave(event: DragEvent<HTMLElement>) {
    if (!eventHasFiles(event)) {
      return
    }

    event.preventDefault()
    setAttachmentDragDepth((value) => Math.max(0, value - 1))
  }

  function handleAttachmentDrop(event: DragEvent<HTMLElement>) {
    if (!eventHasFiles(event)) {
      return
    }

    event.preventDefault()
    setAttachmentDragDepth(0)

    if (!selectedRunId) {
      setActionError('Select a run before dropping attachments.')
      return
    }

    if (pending) {
      return
    }

    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'))
    if (!file) {
      setActionError('Only image attachments are supported.')
      return
    }

    void handleUpload(file)
  }

  function handleChatScroll(event: UIEvent<HTMLDivElement>) {
    chatPinnedToBottomRef.current = isScrolledNearBottom(event.currentTarget)
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
        setDraftAttachmentNames([])
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Delete failed')
    } finally {
      setDeletingRunId(null)
    }
  }

  const status: ProtocolStatus = runSnapshot?.status ?? selectedRun?.status ?? 'IDLE'
  const statusDetails = STATUS_DETAILS[status]
  const attachments = useMemo(() => runSnapshot?.attachments ?? [], [runSnapshot?.attachments])
  const draftAttachments = useMemo(
    () => attachments.filter((attachment) => draftAttachmentNames.includes(attachment.name)),
    [attachments, draftAttachmentNames],
  )
  const chatMessages = runSnapshot?.messages ?? []
  const hasSessionHistoryFile = Boolean(runSnapshot?.files['session.md']?.exists)
  const lastChatMessage = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null
  const chatScrollAnchor = [
    runSnapshot?.runId ?? selectedRunId ?? 'none',
    chatMessages.length,
    lastChatMessage?.id ?? 'none',
    lastChatMessage?.createdAtIso ?? 'none',
    lastChatMessage?.content.length ?? 0,
    pending === 'load' ? 'loading' : 'ready',
  ].join(':')
  const filesPresent = useMemo(() => {
    if (!runSnapshot) return 0
    return PROTOCOL_TEXT_FILES.filter((name) => runSnapshot.files[name]?.exists).length
  }, [runSnapshot])

  useLayoutEffect(() => {
    chatPinnedToBottomRef.current = true
  }, [selectedRunId])

  useLayoutEffect(() => {
    const scrollElement = chatScrollRef.current
    if (!scrollElement || !chatPinnedToBottomRef.current) {
      return
    }

    scrollElement.scrollTop = scrollElement.scrollHeight
  }, [chatScrollAnchor])

  useEffect(() => {
    if (!previewAttachment) return
    const stillExists = attachments.some((attachment) => attachment.url === previewAttachment.url)
    if (!stillExists) setPreviewAttachment(null)
  }, [attachments, previewAttachment])

  useEffect(() => {
    const attachmentNames = new Set(attachments.map((attachment) => attachment.name))
    setDraftAttachmentNames((names) => names.filter((name) => attachmentNames.has(name)))
  }, [attachments])

  const busy = Boolean(pending)
  const selectedTitle = selectedRun?.displayName ?? runSnapshot?.displayName ?? 'No run selected'
  const managerRoot = managerSnapshot?.rootPath ?? 'Loading workspace...'
  const draggingAttachment = attachmentDragDepth > 0

  return (
    <div className={`app ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      <RunInbox
        runs={runs}
        selectedRunId={selectedRunId}
        deletingRunId={deletingRunId}
        collapsed={leftCollapsed}
        onSelect={(runId) => {
          setInstruction('')
          setDraftAttachmentNames([])
          setRunSnapshot(null)
          setSelectedRunId(runId)
        }}
        onDelete={(run) => void handleDeleteRun(run)}
      />

      <main
        className={`chat-container ${draggingAttachment ? 'dragging-attachment' : ''}`}
        onDragEnter={handleAttachmentDragEnter}
        onDragOver={handleAttachmentDragOver}
        onDragLeave={handleAttachmentDragLeave}
        onDrop={handleAttachmentDrop}
      >
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
              className="icon-btn danger"
              onClick={() => void handleStopSession()}
              disabled={!selectedRunId || busy}
              aria-label="Stop session"
              title="Stop session"
            >
              <i className={pending === 'stop' ? 'ri-loader-4-line' : 'ri-stop-circle-line'} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void handleClearConversationHistory()}
              disabled={!selectedRunId || busy}
              aria-label="Clear conversation history"
              title="Clear conversation history"
            >
              <i className={pending === 'clear' ? 'ri-loader-4-line' : 'ri-chat-delete-line'} aria-hidden="true" />
            </button>
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

        {draggingAttachment && (
          <div className="drop-overlay" aria-hidden="true">
            <i className="ri-image-add-line" />
            <span>Drop image to attach</span>
          </div>
        )}

        <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll} data-testid="chat-scroll">
          {runs.length === 0 ? (
            <EmptyInbox managerSnapshot={managerSnapshot} />
          ) : (
            chatMessages.length > 0 ? (
              chatMessages.map((message) => <ChatMessageItem key={message.id} message={message} />)
            ) : hasSessionHistoryFile ? (
              <EmptyConversationHistory />
            ) : (
              <article className="message">
                <div className="avatar" aria-hidden="true">
                  <i className="ri-robot-2-fill" />
                </div>
                <div className="message-content">
                  <MarkdownPanel
                    markdown={pending === 'load' ? '' : runSnapshot?.outputMd ?? ''}
                    safety={runSnapshot?.markdownSafety['output.md'] ?? null}
                    emptyIcon="ri-file-paper-2-line"
                    emptyText={pending === 'load' ? 'Loading run output...' : 'No output draft yet.'}
                  />
                </div>
              </article>
            )
          )}
        </div>

        <ReviewComposer
          instruction={instruction}
          onInstructionChange={setInstruction}
          attachments={attachments}
          draftAttachments={draftAttachments}
          pending={pending}
          canSend={Boolean(selectedRunId) && instruction.trim().length > 0 && !busy}
          onSend={() => void sendInstruction()}
          onUpload={(file) => void handleUpload(file)}
          onPasteAttachment={handleComposerPaste}
          onDraftAttachmentAdd={addDraftAttachment}
          onDraftAttachmentRemove={removeDraftAttachment}
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
        onAttachmentPreview={setPreviewAttachment}
        onAttachmentDelete={(attachment) => void handleDeleteAttachment(attachment)}
        deletingAttachmentName={deletingAttachmentName}
        filesPresent={filesPresent}
      />

      {previewAttachment && (
        <AttachmentPreview attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
      )}
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
                    {run.outputPreview || 'No output yet.'}
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

function ChatMessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <article className={`message chat-message ${isUser ? 'user-message' : 'assistant-message'}`}>
      {!isUser && (
        <div className="avatar" aria-hidden="true">
          <i className="ri-robot-2-fill" />
        </div>
      )}

      <div className="message-content">
        <div className="label-row message-label-row">
          <span className="label-super">{isUser ? 'You' : 'Codex'}</span>
          <span className="section-meta">{formatMessageTime(message.createdAtIso)}</span>
        </div>
        <div className={isUser ? 'user-bubble' : undefined}>
          <MarkdownPanel
            markdown={message.content}
            safety={null}
            emptyIcon={isUser ? 'ri-user-3-line' : 'ri-file-paper-2-line'}
            emptyText={isUser ? 'Empty message.' : 'No output draft yet.'}
          />
        </div>
      </div>

      {isUser && (
        <div className="avatar user-avatar" aria-hidden="true">
          <i className="ri-user-3-fill" />
        </div>
      )}
    </article>
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
  attachments,
  draftAttachments,
  pending,
  canSend,
  onSend,
  onUpload,
  onPasteAttachment,
  onDraftAttachmentAdd,
  onDraftAttachmentRemove,
  error,
}: {
  instruction: string
  onInstructionChange: (value: string) => void
  attachments: AttachmentMeta[]
  draftAttachments: AttachmentMeta[]
  pending: PendingAction | null
  canSend: boolean
  onSend: () => void
  onUpload: (file: File | undefined) => void
  onPasteAttachment: (event: ClipboardEvent<HTMLTextAreaElement>) => Promise<AttachmentMeta | null>
  onDraftAttachmentAdd: (name: string) => void
  onDraftAttachmentRemove: (name: string) => void
  error: string | null
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const mentionOptions = useMemo(() => {
    if (!mentionRange) {
      return []
    }

    const query = mentionRange.query.toLowerCase()
    return attachments
      .filter((attachment) => attachment.name.toLowerCase().includes(query))
      .slice(0, 6)
  }, [attachments, mentionRange])
  const showMentionMenu = mentionOptions.length > 0

  useLayoutEffect(() => {
    resizeComposerTextarea(textareaRef.current)
  }, [instruction])

  useEffect(() => {
    setActiveMentionIndex(0)
  }, [mentionRange?.query])

  useEffect(() => {
    if (activeMentionIndex >= mentionOptions.length) {
      setActiveMentionIndex(0)
    }
  }, [activeMentionIndex, mentionOptions.length])

  function updateMentionRange(value: string, caret: number | null) {
    setMentionRange(caret === null ? null : findMentionRange(value, caret))
  }

  function handleInstructionChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onInstructionChange(event.target.value)
    updateMentionRange(event.target.value, event.target.selectionStart)
  }

  function handleTextareaCursor(event: SyntheticEvent<HTMLTextAreaElement>) {
    updateMentionRange(event.currentTarget.value, event.currentTarget.selectionStart)
  }

  function insertAttachmentMention(attachmentName: string, range = mentionRange) {
    const textarea = textareaRef.current
    const value = textarea?.value ?? instruction
    const fallbackStart = textarea?.selectionStart ?? value.length
    const fallbackEnd = textarea?.selectionEnd ?? fallbackStart
    const start = range?.start ?? fallbackStart
    const end = range?.end ?? fallbackEnd
    const leading = start > 0 && !/\s/.test(value[start - 1]) ? ' ' : ''
    const trailing = end >= value.length || !/\s/.test(value[end]) ? ' ' : ''
    const inserted = `${leading}@${attachmentName}${trailing}`
    const next = `${value.slice(0, start)}${inserted}${value.slice(end)}`
    const cursor = start + inserted.length

    onInstructionChange(next)
    onDraftAttachmentAdd(attachmentName)
    setMentionRange(null)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(cursor, cursor)
    })
  }

  async function handleTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const attachment = await onPasteAttachment(event)
    if (attachment) {
      insertAttachmentMention(attachment.name)
    }
  }

  function handleTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault()
      setMentionRange(null)
      if (canSend) {
        onSend()
      }
      return
    }

    if (!showMentionMenu) {
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveMentionIndex((value) => (value + 1) % mentionOptions.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveMentionIndex((value) => (value - 1 + mentionOptions.length) % mentionOptions.length)
      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      insertAttachmentMention(mentionOptions[activeMentionIndex].name)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setMentionRange(null)
    }
  }

  return (
    <section className="composer-wrapper" aria-label="Review">
      <label className="sr-only" htmlFor="instruction">
        Instruction
      </label>
      {showMentionMenu && (
        <div className="mention-menu" role="listbox" aria-label="Attachment mentions">
          {mentionOptions.map((attachment, index) => (
            <button
              key={attachment.name}
              type="button"
              className={`mention-option ${index === activeMentionIndex ? 'active' : ''}`}
              role="option"
              aria-selected={index === activeMentionIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertAttachmentMention(attachment.name)}
            >
              <i className="ri-attachment-2" aria-hidden="true" />
              <span className="mention-name">{attachment.name}</span>
              <span className="mention-size">{formatBytes(attachment.size)}</span>
            </button>
          ))}
        </div>
      )}
      {draftAttachments.length > 0 && (
        <div className="composer-attachment-tray" aria-label="Message attachments">
          {draftAttachments.map((attachment) => (
            <div className="composer-attachment-chip" key={attachment.name}>
              <button
                type="button"
                className="composer-attachment-main"
                onClick={() => insertAttachmentMention(attachment.name)}
                title={`Mention ${attachment.name}`}
                aria-label={`Mention attachment ${attachment.name}`}
              >
                <AttachmentThumbnail attachment={attachment} />
                <span>{attachment.name}</span>
              </button>
              <button
                type="button"
                className="composer-attachment-remove"
                onClick={() => onDraftAttachmentRemove(attachment.name)}
                aria-label={`Remove attachment ${attachment.name}`}
                title={`Remove ${attachment.name}`}
              >
                <i className="ri-close-line" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
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
          ref={textareaRef}
          id="instruction"
          value={instruction}
          onChange={handleInstructionChange}
          onClick={handleTextareaCursor}
          onKeyUp={handleTextareaCursor}
          onKeyDown={handleTextareaKeyDown}
          onPaste={(event) => void handleTextareaPaste(event)}
          onBlur={() => setMentionRange(null)}
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
          <i className={pending === 'send' ? 'ri-loader-4-line' : 'ri-send-plane-fill'} aria-hidden="true" />
          <span className="sr-only">{pending === 'send' ? 'Sending...' : 'Send to Codex'}</span>
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

function getPastedImageFile(data: DataTransfer): File | null {
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) {
      continue
    }

    const file = item.getAsFile()
    if (file) {
      return nameClipboardImage(file)
    }
  }

  return null
}

function nameClipboardImage(file: File): File {
  if (file.name) {
    return file
  }

  const extension = imageFileExtension(file.type)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return new File([file], `pasted-image-${stamp}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  })
}

function imageFileExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/bmp':
      return 'bmp'
    case 'image/avif':
      return 'avif'
    default:
      return 'png'
  }
}

function findMentionRange(value: string, caret: number): MentionRange | null {
  const beforeCaret = value.slice(0, caret)
  const match = /(^|\s)@([a-zA-Z0-9._-]*)$/.exec(beforeCaret)
  if (!match) {
    return null
  }

  return {
    start: beforeCaret.length - match[2].length - 1,
    end: caret,
    query: match[2],
  }
}

function removeAttachmentMention(value: string, attachmentName: string): string {
  const escapedName = escapeRegExp(attachmentName)
  const withoutMention = value
    .replace(new RegExp(`(^|\\s)@${escapedName}(?=\\s|$)`, 'g'), '$1')
    .replace(/[ \t]{2,}/g, ' ')
  return withoutMention.trimStart()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) {
    return
  }

  textarea.style.height = `${COMPOSER_TEXTAREA_MIN_HEIGHT_PX}px`
  const nextHeight = Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT_PX)
  textarea.style.height = `${Math.max(nextHeight, COMPOSER_TEXTAREA_MIN_HEIGHT_PX)}px`
  textarea.style.overflowY = textarea.scrollHeight > COMPOSER_TEXTAREA_MAX_HEIGHT_PX ? 'auto' : 'hidden'
}

function eventHasFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function isScrolledNearBottom(element: HTMLElement) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX
}

function ProtocolSidebar({
  collapsed,
  managerRoot,
  status,
  statusDetails,
  snapshot,
  attachments,
  onAttachmentPreview,
  onAttachmentDelete,
  deletingAttachmentName,
  filesPresent,
}: {
  collapsed: boolean
  managerRoot: string
  status: ProtocolStatus
  statusDetails: (typeof STATUS_DETAILS)[ProtocolStatus]
  snapshot: Snapshot | null
  attachments: AttachmentMeta[]
  onAttachmentPreview: (attachment: AttachmentMeta) => void
  onAttachmentDelete: (attachment: AttachmentMeta) => void
  deletingAttachmentName: string | null
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
          <AttachmentList
            attachments={attachments}
            deletingAttachmentName={deletingAttachmentName}
            onPreview={onAttachmentPreview}
            onDelete={onAttachmentDelete}
          />
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

function AttachmentThumbnail({ attachment }: { attachment: AttachmentMeta }) {
  const [failed, setFailed] = useState(false)

  if (failed) {
    return (
      <span className="attachment-thumb fallback" aria-hidden="true">
        <i className="ri-image-2-line" />
      </span>
    )
  }

  return (
    <span className="attachment-thumb">
      <img src={attachment.url} alt={attachment.name} loading="lazy" onError={() => setFailed(true)} />
    </span>
  )
}

function AttachmentList({
  attachments,
  deletingAttachmentName,
  onPreview,
  onDelete,
}: {
  attachments: AttachmentMeta[]
  deletingAttachmentName: string | null
  onPreview: (attachment: AttachmentMeta) => void
  onDelete: (attachment: AttachmentMeta) => void
}) {
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
        <li key={attachment.name} className="file-card attachment-card exists">
          <button
            type="button"
            className="attachment-thumb-button"
            onClick={() => onPreview(attachment)}
            aria-label={`Preview ${attachment.name}`}
            title={`Preview ${attachment.name}`}
          >
            <AttachmentThumbnail attachment={attachment} />
          </button>
          <div className="file-copy">
            <button
              type="button"
              className="file-name attachment-preview-button"
              onClick={() => onPreview(attachment)}
            >
              {attachment.name}
            </button>
            <div className="file-meta">{formatBytes(attachment.size)}</div>
          </div>
          <button
            type="button"
            className="attachment-delete-button"
            onClick={() => onDelete(attachment)}
            disabled={deletingAttachmentName === attachment.name}
            aria-label={`Delete attachment ${attachment.name}`}
            title={`Delete ${attachment.name}`}
          >
            <i className={deletingAttachmentName === attachment.name ? 'ri-loader-4-line' : 'ri-delete-bin-6-line'} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  )
}

function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: AttachmentMeta
  onClose: () => void
}) {
  return (
    <div className="preview-backdrop" role="presentation" onClick={onClose}>
      <section
        className="attachment-preview"
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="preview-header">
          <div className="preview-title">
            <span>{attachment.name}</span>
            <small>{formatBytes(attachment.size)}</small>
          </div>
          <div className="preview-actions">
            <a href={attachment.url} target="_blank" rel="noreferrer" className="icon-btn" aria-label="Open image">
              <i className="ri-external-link-line" aria-hidden="true" />
            </a>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview">
              <i className="ri-close-line" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="preview-stage">
          <img src={attachment.url} alt={attachment.name} />
        </div>
      </section>
    </div>
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

function EmptyConversationHistory() {
  return (
    <article className="message empty-message" aria-label="Empty conversation history">
      <div className="avatar" aria-hidden="true">
        <i className="ri-chat-history-line" />
      </div>
      <div className="message-content">
        <span className="label-super">Conversation</span>
        <div className="empty-state large">
          <h2>No conversation history</h2>
          <p>This session is still open.</p>
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

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return dateFormatter.format(date)
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
