import {
  useCallback,
  useEffect,
  Fragment,
  useLayoutEffect,
  memo,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ComponentProps,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  type UIEvent,
} from 'react'
import { createPortal } from 'react-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  clearConversationHistory as clearConversationHistoryRequest,
  createTeammate,
  deleteAttachment as deleteAttachmentRequest,
  deleteRun as deleteRunRequest,
  fetchCodexLiveHistory,
  fetchCodexLiveSessions,
  fetchProtocolFile,
  fetchRunSnapshot,
  fetchTeammates,
  requestSessionStop,
  submitInstruction,
  uploadAttachment,
} from './api'
import { useSnapshotStream } from './hooks/useSnapshotStream'
import type {
  AttachmentMeta,
  CodexLiveHistoryResponse,
  CodexLiveRateLimitWindow,
  CodexLiveRecord,
  CodexLiveSessionSummary,
  ChatMessage,
  ManagerSnapshot,
  MarkdownSafety,
  ProtocolStatus,
  ProtocolTextFile,
  RunSummary,
  Snapshot,
  Teammate,
} from './shared/protocol'
import { DEFAULT_TEAMMATES, MAX_TEAMMATES, PROTOCOL_TEXT_FILES, TEAMMATE_AVATAR_URLS } from './shared/protocol'

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

const ATTACHMENT_KIND_ICONS: Record<AttachmentMeta['kind'], string> = {
  image: 'ri-image-2-line',
  pdf: 'ri-file-pdf-2-line',
  text: 'ri-file-text-line',
  code: 'ri-file-code-line',
  audio: 'ri-file-music-line',
  video: 'ri-file-video-line',
  archive: 'ri-file-zip-line',
  document: 'ri-file-word-line',
  spreadsheet: 'ri-file-excel-line',
  presentation: 'ri-file-ppt-line',
  file: 'ri-file-line',
}

const ATTACHMENT_KIND_LABELS: Record<AttachmentMeta['kind'], string> = {
  image: 'Image',
  pdf: 'PDF',
  text: 'Text',
  code: 'Code',
  audio: 'Audio',
  video: 'Video',
  archive: 'Archive',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  presentation: 'Presentation',
  file: 'File',
}

const PROFILE_MENU_ITEMS = [
  { label: 'Add teammates', icon: 'ri-group-line', action: 'teammates' },
  { label: 'Workspace settings', icon: 'ri-building-2-line', action: 'workspace-settings' },
  { label: 'Skills', icon: 'ri-box-3-line', action: 'skills' },
  { label: 'Personalization', icon: 'ri-sparkling-2-line' },
  { label: 'Settings', icon: 'ri-settings-3-line', action: 'settings' },
  { label: 'Help', icon: 'ri-question-line', separated: true, chevron: true },
  { label: 'Log out', icon: 'ri-logout-box-r-line', action: 'logout' },
]
const LOGOUT_ERROR_STICKER = 'https://media.tenor.com/fTH4D95V-oQAAAAi/quby.gif'
const WORKSPACE_SETTINGS_STICKER = 'https://media.tenor.com/OY6bIk0asR4AAAAi/quby.gif'
const SKILLS_STICKER = 'https://media1.tenor.com/m/XFwbgqtJB98AAAAC/quby-quby-sticker.gif'

const RUN_STATUS_ICONS: Record<ProtocolStatus, string> = {
  RUNNING: 'ri-loader-4-line',
  WAITING_FOR_REVIEW: 'ri-question-answer-line',
  INSTRUCTION_RECEIVED: 'ri-inbox-archive-line',
  STOPPED: 'ri-stop-circle-line',
  BLOCKED: 'ri-forbid-2-line',
  ERROR: 'ri-error-warning-line',
}

const CHAT_BOTTOM_THRESHOLD_PX = 12
const QUEUED_SEND_POLL_INTERVAL_MS = 120
const QUEUED_SEND_BOTTOM_SETTLE_MS = 900
const USER_BUBBLE_TOP_ZONE_PX = 160
const USER_BUBBLE_TOP_TOLERANCE_PX = 24
const COMPOSER_TEXTAREA_MIN_HEIGHT_PX = 28
const COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 180
const CODEX_PROFILE_IMAGE = '/codex-color.png'
const USER_PROFILE_IMAGE = '/burger.png'
const LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY = 'codex-pro-max:left-sidebar-collapsed'
const RIGHT_SIDEBAR_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-collapsed'
const OUTLINES_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-outlines-collapsed'
const PROTOCOL_FILES_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-protocol-files-collapsed:v2'
const ATTACHMENTS_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-attachments-collapsed'
const QUEUED_INSTRUCTIONS_STORAGE_KEY = 'codex-pro-max:queued-instructions:v1'
const CTRL_ENTER_CONFIRM_STORAGE_KEY = 'codex-pro-max:confirm-ctrl-enter-send'
const MARKDOWN_REMARK_PLUGINS = [remarkGfm]
const MARKDOWN_COMPONENTS = {
  table({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
    return (
      <div className="markdown-table-scroll">
        <table {...props} />
      </div>
    )
  },
}

type PendingAction = 'send' | 'upload' | 'load' | 'clear' | 'stop'
type MentionRange = { start: number; end: number; query: string }
type ScrollDirection = 'up' | 'down' | 'none'
type UserMessageOutline = Pick<ChatMessage, 'id' | 'content' | 'createdAtIso'>
type QueuedInstruction = {
  id: string
  content: string
}
type CodexLiveContextUsage = NonNullable<CodexLiveHistoryResponse['context']>
type QueuedInstructionsByRun = Record<string, QueuedInstruction[]>
type QueuedInstructionIdsByRun = Record<string, string>
type ConfirmDialogTone = 'default' | 'danger'
type ConfirmDialogOptions = {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  tone?: ConfirmDialogTone
}
type ConfirmDialogState = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void
}
type ProtocolFilePreview = {
  fileName: ProtocolTextFile
  content: string
  loading: boolean
  error: string | null
  truncated: boolean
  size: number | null
}

function App() {
  const { snapshot: managerSnapshot, error: streamError } = useSnapshotStream()
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runSnapshot, setRunSnapshot] = useState<Snapshot | null>(null)
  const [instruction, setInstruction] = useState('')
  const [queuedInstructionsByRun, setQueuedInstructionsByRun] = useState<QueuedInstructionsByRun>(() =>
    readStoredQueuedInstructions(),
  )
  const [draftAttachmentNames, setDraftAttachmentNames] = useState<string[]>([])
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [uploadingAttachmentName, setUploadingAttachmentName] = useState<string | null>(null)
  const [autoSendingQueuedInstructionIds, setAutoSendingQueuedInstructionIds] = useState<QueuedInstructionIdsByRun>({})
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [deletingAttachmentNames, setDeletingAttachmentNames] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [conversationLiveUsage, setConversationLiveUsage] = useState<CodexLiveContextUsage | null>(null)
  const [conversationThinkingRecords, setConversationThinkingRecords] = useState<CodexLiveRecord[]>([])
  const [ctrlEnterConfirmOpen, setCtrlEnterConfirmOpen] = useState(false)
  const [confirmCtrlEnterSend, setConfirmCtrlEnterSend] = useState(() =>
    readStoredBoolean(CTRL_ENTER_CONFIRM_STORAGE_KEY, true),
  )
  const [leftCollapsed, setLeftCollapsed] = useState(() =>
    readStoredBoolean(LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY, false),
  )
  const [rightCollapsed, setRightCollapsed] = useState(() =>
    readStoredBoolean(RIGHT_SIDEBAR_COLLAPSED_STORAGE_KEY, false),
  )
  const [attachmentDragDepth, setAttachmentDragDepth] = useState(0)
  const [chatAtBottom, setChatAtBottom] = useState(true)
  const [chatBottomSyncVersion, setChatBottomSyncVersion] = useState(0)
  const [activeUserMessageId, setActiveUserMessageId] = useState<string | null>(null)
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentMeta | null>(null)
  const [previewProtocolFile, setPreviewProtocolFile] = useState<ProtocolFilePreview | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const selectedRunIdRef = useRef<string | null>(null)
  const chatPinnedToBottomRef = useRef(true)
  const lastChatScrollTopRef = useRef(0)
  const activeMessageFrameRef = useRef<number | null>(null)
  const activeMessageScrollElementRef = useRef<HTMLDivElement | null>(null)
  const smoothScrollReleaseTimerRef = useRef<number | null>(null)
  const pinnedBottomCorrectionFrameRef = useRef<number | null>(null)
  const bottomScrollSettleUntilRef = useRef(0)
  const userMessageRefs = useRef(new Map<string, HTMLElement>())
  const chatContentRef = useRef<HTMLDivElement | null>(null)
  const queuedInstructionIdRef = useRef(0)
  const queuedInstructionsByRunRef = useRef<QueuedInstructionsByRun>({})
  const queuedSendInFlightRef = useRef<QueuedInstructionIdsByRun>({})
  const queuedSendDelayTimersRef = useRef<Record<string, number>>({})
  const delayedQueuedSendIdsRef = useRef<QueuedInstructionIdsByRun>({})
  const blockedQueuedSendRef = useRef<QueuedInstructionIdsByRun>({})
  const popupReturnFocusRef = useRef<HTMLElement | null>(null)
  const composerFocusTokenRef = useRef(0)
  const [composerFocusToken, setComposerFocusToken] = useState(0)

  const requestConfirmation = useCallback((options: ConfirmDialogOptions) =>
    new Promise<boolean>((resolve) => {
      rememberPopupReturnFocus()
      setConfirmDialog({
        cancelLabel: 'Cancel',
        tone: 'default',
        ...options,
        resolve,
      })
    }), [])

  const resolveConfirmation = useCallback((confirmed: boolean) => {
    setConfirmDialog((currentDialog) => {
      currentDialog?.resolve(confirmed)
      return null
    })
    restorePopupReturnFocus()
  }, [])

  const runs = managerSnapshot?.runs ?? []
  const selectedRun = runs.find((run) => run.runId === selectedRunId) ?? null
  const latestRunUserMessageCreatedAtIso = latestUserMessageCreatedAtIso(runSnapshot?.messages)

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId
  }, [selectedRunId])

  useEffect(() => {
    writeStoredQueuedInstructions(queuedInstructionsByRun)
    queuedInstructionsByRunRef.current = queuedInstructionsByRun
  }, [queuedInstructionsByRun])

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

  useEffect(() => {
    if (!selectedRunId || !isCodexRolloutRunId(selectedRunId)) {
      setConversationLiveUsage(null)
      setConversationThinkingRecords([])
      return
    }

    let ignore = false
    const currentRunId = selectedRunId

    async function loadConversationUsage() {
      try {
        const liveSessions = await fetchCodexLiveSessions()
        if (ignore) return
        const liveSession = findCodexLiveSessionForRun(liveSessions.sessions, currentRunId)
        if (!liveSession) {
          setConversationLiveUsage(null)
          setConversationThinkingRecords([])
          return
        }

        const liveHistory = await fetchCodexLiveHistory(liveSession.id)
        if (!ignore) {
          setConversationLiveUsage(liveHistory.context)
          setConversationThinkingRecords(
            conversationThinkingRecordsFromLiveHistory(liveHistory.records, latestRunUserMessageCreatedAtIso),
          )
        }
      } catch {
        if (!ignore) {
          setConversationLiveUsage(null)
          setConversationThinkingRecords([])
        }
      }
    }

    setConversationLiveUsage(null)
    setConversationThinkingRecords([])
    void loadConversationUsage()
    const timer = window.setInterval(() => void loadConversationUsage(), 5_000)
    return () => {
      ignore = true
      window.clearInterval(timer)
    }
  }, [latestRunUserMessageCreatedAtIso, selectedRunId])

  useEffect(() => {
    writeStoredBoolean(LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY, leftCollapsed)
  }, [leftCollapsed])

  useEffect(() => {
    writeStoredBoolean(RIGHT_SIDEBAR_COLLAPSED_STORAGE_KEY, rightCollapsed)
  }, [rightCollapsed])

  useEffect(() => {
    writeStoredBoolean(CTRL_ENTER_CONFIRM_STORAGE_KEY, confirmCtrlEnterSend)
  }, [confirmCtrlEnterSend])

  useEffect(() => {
    return () => {
      if (activeMessageFrameRef.current !== null) {
        window.cancelAnimationFrame(activeMessageFrameRef.current)
      }
      if (pinnedBottomCorrectionFrameRef.current !== null) {
        window.cancelAnimationFrame(pinnedBottomCorrectionFrameRef.current)
      }
      clearSmoothScrollReleaseTimer()
      clearAllQueuedSendDelays()
    }
  }, [])

  async function submitInstructionText(
    runId: string,
    content: string,
    options: { clearComposer: boolean },
  ) {
    setPending('send')
    setActionError(null)

    try {
      const response = await submitInstruction(runId, { instruction: content })
      if (selectedRunIdRef.current === runId) {
        setRunSnapshot(response.snapshot)
      }
      if (options.clearComposer) {
        setInstruction('')
        setDraftAttachmentNames([])
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed')
      throw error
    } finally {
      setPending(null)
    }
  }

  async function submitQueuedInstruction(
    runId: string,
    item: QueuedInstruction,
    options: { pinSelectedChat: boolean } = { pinSelectedChat: true },
  ) {
    clearQueuedSendDelay(runId)
    queuedSendInFlightRef.current = {
      ...queuedSendInFlightRef.current,
      [runId]: item.id,
    }
    setAutoSendingQueuedInstructionIds((itemsByRun) => ({
      ...itemsByRun,
      [runId]: item.id,
    }))

    try {
      const response = await submitInstruction(runId, { instruction: item.content })
      removeQueuedInstruction(runId, item.id)
      if (selectedRunIdRef.current === runId) {
        if (options.pinSelectedChat) {
          chatPinnedToBottomRef.current = true
          setChatAtBottom(true)
          setChatBottomSyncVersion((version) => version + 1)
        }
        setRunSnapshot(response.snapshot)
      }
    } catch (error) {
      blockedQueuedSendRef.current = {
        ...blockedQueuedSendRef.current,
        [runId]: item.id,
      }
      if (selectedRunIdRef.current === runId) {
        setActionError(error instanceof Error ? error.message : 'Queued instruction failed')
      }
    } finally {
      const nextInFlight = { ...queuedSendInFlightRef.current }
      delete nextInFlight[runId]
      queuedSendInFlightRef.current = nextInFlight
      setAutoSendingQueuedInstructionIds((itemsByRun) => {
        if (itemsByRun[runId] !== item.id) {
          return itemsByRun
        }

        const nextItemsByRun = { ...itemsByRun }
        delete nextItemsByRun[runId]
        return nextItemsByRun
      })
    }
  }

  async function sendInstruction() {
    if (!selectedRunId) {
      setActionError('Select a run before sending an instruction.')
      return
    }

    const content = instruction
    if (!content.trim()) {
      return
    }

    if (shouldQueueInstruction()) {
      enqueueInstruction(selectedRunId, content)
      setInstruction('')
      setDraftAttachmentNames([])
      setActionError(null)
      return
    }

    try {
      await submitInstructionText(selectedRunId, content, { clearComposer: true })
    } catch (error) {
      // submitInstructionText owns the user-facing error state.
    }
  }

  function handleComposerShortcutSend() {
    if (!canSendInstruction || ctrlEnterConfirmOpen) {
      return
    }

    if (!confirmCtrlEnterSend) {
      void sendInstruction()
      return
    }

    rememberPopupReturnFocus()
    setCtrlEnterConfirmOpen(true)
  }

  function cancelCtrlEnterSendConfirm() {
    setCtrlEnterConfirmOpen(false)
    restorePopupReturnFocus()
  }

  function handleCtrlEnterSendConfirm(dontShowAgain: boolean) {
    setCtrlEnterConfirmOpen(false)
    restorePopupReturnFocus()
    if (dontShowAgain) {
      setConfirmCtrlEnterSend(false)
    }
    void sendInstruction()
  }

  function rememberPopupReturnFocus() {
    const activeElement = document.activeElement
    popupReturnFocusRef.current = isTextEntryElement(activeElement) ? activeElement : null
  }

  function restorePopupReturnFocus() {
    const target = popupReturnFocusRef.current
    popupReturnFocusRef.current = null
    if (!target?.isConnected) {
      return
    }

    requestAnimationFrame(() => {
      if (target.isConnected) {
        target.focus()
      }
    })
  }

  async function handleClearConversationHistory() {
    if (!selectedRunId) {
      setActionError('Select a run before clearing conversation history.')
      return
    }

    const runLabel = selectedRun?.displayName ?? runSnapshot?.displayName ?? selectedRunId
    const confirmed = await requestConfirmation({
      title: 'Clear conversation history',
      message: `Clear conversation history for "${runLabel}"?\n\nThis keeps the session open and leaves the run files intact.`,
      confirmLabel: 'Clear history',
      tone: 'danger',
    })
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

    if (status !== 'WAITING_FOR_REVIEW') {
      setActionError('Stop is only available while the run is waiting for review.')
      return
    }

    const runLabel = selectedRun?.displayName ?? runSnapshot?.displayName ?? selectedRunId
    const confirmed = await requestConfirmation({
      title: 'Stop Codex',
      message: `Stop Codex for "${runLabel}"?\n\nThis sends a stop instruction through the current session.`,
      confirmLabel: 'Continue',
      tone: 'danger',
    })
    if (!confirmed) {
      return
    }

    const confirmedAgain = await requestConfirmation({
      title: 'Confirm stop',
      message: `Confirm stop for "${runLabel}"?\n\nCodex will receive the canonical stop instruction for this run.`,
      confirmLabel: 'Stop session',
      tone: 'danger',
    })
    if (!confirmedAgain) {
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
    setUploadingAttachmentName(file.name || 'attachment')
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
      setUploadingAttachmentName(null)
      setPending(null)
    }
  }

  async function handleDeleteAttachment(attachment: AttachmentMeta) {
    if (!selectedRunId) {
      setActionError('Select a run before deleting attachments.')
      return
    }

    const confirmed = await requestConfirmation({
      title: 'Delete attachment',
      message: `Delete attachment "${attachment.name}"?`,
      confirmLabel: 'Delete attachment',
      tone: 'danger',
    })
    if (!confirmed) {
      return
    }

    setDeletingAttachmentNames((names) => addUniqueNames(names, [attachment.name]))
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
      setDeletingAttachmentNames((names) => names.filter((name) => name !== attachment.name))
    }
  }

  async function handleDeleteAllAttachments() {
    if (!selectedRunId) {
      setActionError('Select a run before deleting attachments.')
      return
    }

    if (attachments.length === 0) {
      return
    }

    const confirmed = await requestConfirmation({
      title: 'Delete all attachments',
      message: `Delete all ${attachments.length} attachments?`,
      confirmLabel: 'Delete all',
      tone: 'danger',
    })
    if (!confirmed) {
      return
    }

    const attachmentNames = attachments.map((attachment) => attachment.name)
    setDeletingAttachmentNames((names) => addUniqueNames(names, attachmentNames))
    setActionError(null)

    try {
      for (const attachment of attachments) {
        const response = await deleteAttachmentRequest(selectedRunId, attachment.name)
        setRunSnapshot(response.snapshot)
        setDraftAttachmentNames((names) => names.filter((name) => name !== attachment.name))
        if (previewAttachment?.name === attachment.name) {
          setPreviewAttachment(null)
        }
        setDeletingAttachmentNames((names) => names.filter((name) => name !== attachment.name))
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Delete attachments failed')
    } finally {
      setDeletingAttachmentNames((names) => names.filter((name) => !attachmentNames.includes(name)))
    }
  }

  async function handleProtocolFilePreview(fileName: ProtocolTextFile) {
    if (!selectedRunId) {
      setActionError('Select a run before previewing files.')
      return
    }

    const meta = runSnapshot?.files[fileName]
    if (!meta?.exists) {
      return
    }

    setPreviewProtocolFile({
      fileName,
      content: '',
      loading: true,
      error: null,
      truncated: false,
      size: meta.size,
    })

    try {
      const response = await fetchProtocolFile(selectedRunId, fileName)
      setPreviewProtocolFile({
        fileName: response.fileName,
        content: response.content,
        loading: false,
        error: null,
        truncated: response.truncated,
        size: response.size,
      })
    } catch (error) {
      setPreviewProtocolFile({
        fileName,
        content: '',
        loading: false,
        error: error instanceof Error ? error.message : 'File preview failed',
        truncated: false,
        size: meta.size,
      })
    }
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>): Promise<AttachmentMeta | null> {
    const file = getPastedAttachmentFile(event.clipboardData)
    if (!file) {
      return null
    }

    event.preventDefault()
    return handleUpload(file)
  }

  function addDraftAttachment(name: string) {
    setDraftAttachmentNames((names) => (names.includes(name) ? names : [...names, name]))
  }

  function createQueuedInstruction(content: string): QueuedInstruction {
    queuedInstructionIdRef.current += 1
    return {
      id: `queued-${Date.now()}-${queuedInstructionIdRef.current}`,
      content,
    }
  }

  function enqueueInstruction(runId: string, content: string) {
    setQueuedInstructionsByRun((queues) => ({
      ...queues,
      [runId]: [...(queues[runId] ?? []), createQueuedInstruction(content)],
    }))
  }

  function removeQueuedInstruction(runId: string, instructionId: string) {
    if (delayedQueuedSendIdsRef.current[runId] === instructionId) {
      clearQueuedSendDelay(runId)
    }

    setQueuedInstructionsByRun((queues) => {
      const currentQueue = queues[runId] ?? []
      const nextQueue = currentQueue.filter((item) => item.id !== instructionId)
      if (nextQueue.length === currentQueue.length) {
        return queues
      }

      const nextQueues = { ...queues }
      if (nextQueue.length === 0) {
        delete nextQueues[runId]
      } else {
        nextQueues[runId] = nextQueue
      }
      return nextQueues
    })
  }

  function shouldQueueInstruction() {
    return !canReceiveInstruction(status)
      || selectedQueuedInstructions.length > 0
      || (selectedRunId !== null && Boolean(queuedSendInFlightRef.current[selectedRunId]))
  }

  function handleQueuedInstructionEdit(item: QueuedInstruction) {
    if (!selectedRunId || item.id === selectedAutoSendingQueuedInstructionId) {
      return
    }

    removeQueuedInstruction(selectedRunId, item.id)
    setInstruction(item.content)
    setDraftAttachmentNames(getMentionedAttachments(item.content, attachments).map((attachment) => attachment.name))
    setActionError(null)
    composerFocusTokenRef.current += 1
    setComposerFocusToken(composerFocusTokenRef.current)
  }

  function handleQueuedInstructionDelete(item: QueuedInstruction) {
    if (!selectedRunId || item.id === selectedAutoSendingQueuedInstructionId) {
      return
    }

    removeQueuedInstruction(selectedRunId, item.id)
  }

  function clearQueuedSendDelay(runId: string) {
    const timer = queuedSendDelayTimersRef.current[runId]
    if (timer !== undefined) {
      window.clearTimeout(timer)
      const nextTimers = { ...queuedSendDelayTimersRef.current }
      delete nextTimers[runId]
      queuedSendDelayTimersRef.current = nextTimers
    }

    if (delayedQueuedSendIdsRef.current[runId]) {
      const nextDelayedItems = { ...delayedQueuedSendIdsRef.current }
      delete nextDelayedItems[runId]
      delayedQueuedSendIdsRef.current = nextDelayedItems
    }
  }

  function clearAllQueuedSendDelays() {
    for (const timer of Object.values(queuedSendDelayTimersRef.current)) {
      window.clearTimeout(timer)
    }
    queuedSendDelayTimersRef.current = {}
    delayedQueuedSendIdsRef.current = {}
  }

  function scheduleSelectedQueuedInstructionAfterBottom(runId: string, item: QueuedInstruction) {
    if (delayedQueuedSendIdsRef.current[runId] === item.id) {
      return
    }

    clearQueuedSendDelay(runId)
    delayedQueuedSendIdsRef.current = {
      ...delayedQueuedSendIdsRef.current,
      [runId]: item.id,
    }

    const sendWhenReady = () => {
      const queuedItem = queuedInstructionsByRunRef.current[runId]?.[0]
      if (!queuedItem || queuedItem.id !== item.id || queuedSendInFlightRef.current[runId]) {
        clearQueuedSendDelay(runId)
        return
      }

      if (selectedRunIdRef.current !== runId || !chatPinnedToBottomRef.current) {
        clearQueuedSendDelay(runId)
        void submitQueuedInstruction(runId, item, { pinSelectedChat: false })
        return
      }

      const scrollElement = chatScrollRef.current
      if (!scrollElement) {
        clearQueuedSendDelay(runId)
        void submitQueuedInstruction(runId, item)
        return
      }

      const now = Date.now()
      const settleRemaining = bottomScrollSettleUntilRef.current - now
      if (isScrolledNearBottom(scrollElement) && settleRemaining <= 0) {
        clearQueuedSendDelay(runId)
        void submitQueuedInstruction(runId, item)
        return
      }

      if (settleRemaining <= 0) {
        scrollChatToBottom()
      }

      const nextDelay = Math.max(
        QUEUED_SEND_POLL_INTERVAL_MS,
        Math.min(settleRemaining, QUEUED_SEND_BOTTOM_SETTLE_MS),
      )
      queuedSendDelayTimersRef.current = {
        ...queuedSendDelayTimersRef.current,
        [runId]: window.setTimeout(sendWhenReady, nextDelay),
      }
    }

    queuedSendDelayTimersRef.current = {
      ...queuedSendDelayTimersRef.current,
      [runId]: window.setTimeout(sendWhenReady, QUEUED_SEND_POLL_INTERVAL_MS),
    }
  }

  function removeDraftAttachment(name: string) {
    setDraftAttachmentNames((names) => names.filter((item) => item !== name))
    setInstruction((value) => removeAttachmentMention(value, name))
  }

  function mentionSessionAttachment(name: string) {
    addDraftAttachment(name)
    setInstruction((value) => appendAttachmentMention(value, name))
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

    const file = Array.from(event.dataTransfer.files).find((item) => item.size > 0)
    if (!file) {
      setActionError('Drop a file to attach.')
      return
    }

    void handleUpload(file)
  }

  function handleChatScroll(event: UIEvent<HTMLDivElement>) {
    const atBottom = isScrolledNearBottom(event.currentTarget)
    if (smoothScrollReleaseTimerRef.current !== null) {
      chatPinnedToBottomRef.current = true
      setChatAtBottom(true)
      setLatestUserMessageActive()
      if (atBottom) {
        setChatBottomSyncVersion((version) => version + 1)
      }
      return
    }

    if (atBottom) {
      clearSmoothScrollReleaseTimer()
      setChatBottomSyncVersion((version) => version + 1)
    }

    chatPinnedToBottomRef.current = atBottom
    setChatAtBottom(atBottom)
    scheduleActiveUserMessageUpdate(event.currentTarget)
  }

  async function handleDeleteRun(run: RunSummary) {
    const confirmed = await requestConfirmation({
      title: 'Delete run',
      message: `Delete run "${run.displayName}"?\n\nThis removes runs/${run.runId}/ and its protocol files.`,
      confirmLabel: 'Delete run',
      tone: 'danger',
    })
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
      setQueuedInstructionsByRun((queues) => {
        if (!queues[run.runId]) {
          return queues
        }

        const nextQueues = { ...queues }
        delete nextQueues[run.runId]
        return nextQueues
      })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Delete failed')
    } finally {
      setDeletingRunId(null)
    }
  }

  const status: ProtocolStatus = runSnapshot?.status ?? selectedRun?.status ?? 'RUNNING'
  const aiWorking = isCodexWorking(status)
  const selectedQueuedInstructions = useMemo(
    () => (selectedRunId ? queuedInstructionsByRun[selectedRunId] ?? [] : []),
    [queuedInstructionsByRun, selectedRunId],
  )
  const selectedAutoSendingQueuedInstructionId =
    selectedRunId ? autoSendingQueuedInstructionIds[selectedRunId] ?? null : null
  const attachments = useMemo(() => runSnapshot?.attachments ?? [], [runSnapshot?.attachments])
  const draftAttachments = useMemo(
    () => attachments.filter((attachment) => draftAttachmentNames.includes(attachment.name)),
    [attachments, draftAttachmentNames],
  )
  const chatMessages = runSnapshot?.messages ?? []
  const userMessageOutlines = useMemo<UserMessageOutline[]>(
    () => chatMessages.filter((message) => message.role === 'user'),
    [chatMessages],
  )
  const latestUserMessageOutlineId = userMessageOutlines[userMessageOutlines.length - 1]?.id ?? null
  const hasSessionHistoryFile = Boolean(runSnapshot?.files['session.md']?.exists)
  const lastChatMessage = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null
  const conversationThinkingAnchor = conversationThinkingRecords
    .map((record) => `${record.id}:${record.text.length}`)
    .join('|')
  const conversationUsageAnchor = conversationLiveUsage
    ? [
        conversationLiveUsage.timestamp,
        conversationLiveUsage.contextWindow,
        conversationLiveUsage.usedTokens,
        conversationLiveUsage.rateLimits?.primary?.remainingPercent ?? 'none',
        conversationLiveUsage.rateLimits?.secondary?.remainingPercent ?? 'none',
      ].join(':')
    : 'no-usage'
  const chatScrollAnchor = [
    runSnapshot?.runId ?? selectedRunId ?? 'none',
    chatMessages.length,
    lastChatMessage?.id ?? 'none',
    lastChatMessage?.createdAtIso ?? 'none',
    lastChatMessage?.content.length ?? 0,
    conversationUsageAnchor,
    conversationThinkingAnchor,
    aiWorking ? 'ai-working' : 'ai-ready',
    pending === 'load' ? 'loading' : 'ready',
  ].join(':')
  const filesPresent = useMemo(() => {
    if (!runSnapshot) return 0
    return PROTOCOL_TEXT_FILES.filter((name) => runSnapshot.files[name]?.exists).length
  }, [runSnapshot])

  useLayoutEffect(() => {
    chatPinnedToBottomRef.current = true
    lastChatScrollTopRef.current = 0
    setChatAtBottom(true)
    setChatBottomSyncVersion((version) => version + 1)
    setActiveUserMessageId(null)
  }, [selectedRunId])

  useLayoutEffect(() => {
    if (!chatPinnedToBottomRef.current) {
      return
    }

    setActiveUserMessageId((currentId) => (
      currentId === latestUserMessageOutlineId ? currentId : latestUserMessageOutlineId
    ))
  }, [chatScrollAnchor, latestUserMessageOutlineId])

  useLayoutEffect(() => {
    if (chatPinnedToBottomRef.current) {
      scrollChatToBottom()
      return
    }

    updateActiveUserMessage()
  }, [chatScrollAnchor])

  useLayoutEffect(() => {
    if (chatPinnedToBottomRef.current) {
      scrollChatToBottom()
      return
    }

    updateActiveUserMessage()
  }, [instruction])

  useLayoutEffect(() => {
    const scrollElement = chatScrollRef.current
    if (!scrollElement || typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      if (chatPinnedToBottomRef.current) {
        queuePinnedBottomCorrection(scrollElement)
      }
    })
    observer.observe(scrollElement)
    if (chatContentRef.current) {
      observer.observe(chatContentRef.current)
    }

    return () => observer.disconnect()
  }, [selectedRunId])

  const handleDynamicChatContentChange = useCallback(() => {
    const scrollElement = chatScrollRef.current
    if (!scrollElement || !chatPinnedToBottomRef.current) {
      return
    }

    queuePinnedBottomCorrection(scrollElement)
  }, [])

  useEffect(() => {
    if (!previewAttachment) return
    const stillExists = attachments.some((attachment) => attachment.url === previewAttachment.url)
    if (!stillExists) setPreviewAttachment(null)
  }, [attachments, previewAttachment])

  useEffect(() => {
    const attachmentNames = new Set(attachments.map((attachment) => attachment.name))
    setDraftAttachmentNames((names) => names.filter((name) => attachmentNames.has(name)))
  }, [attachments])

  useEffect(() => {
    if (!managerSnapshot) {
      return
    }

    for (const run of managerSnapshot.runs) {
      const runStatus = run.runId === selectedRunId ? status : run.status
      if (!canReceiveInstruction(runStatus)) {
        if (blockedQueuedSendRef.current[run.runId]) {
          const nextBlockedItems = { ...blockedQueuedSendRef.current }
          delete nextBlockedItems[run.runId]
          blockedQueuedSendRef.current = nextBlockedItems
        }
        continue
      }

      const nextQueuedInstruction = queuedInstructionsByRun[run.runId]?.[0]
      if (!nextQueuedInstruction) {
        continue
      }

      const inFlightItemId = queuedSendInFlightRef.current[run.runId]
      const blockedItemId = blockedQueuedSendRef.current[run.runId]
      if (inFlightItemId === nextQueuedInstruction.id || blockedItemId === nextQueuedInstruction.id) {
        continue
      }

      const selectedQueuedRun = run.runId === selectedRunId
      if (selectedQueuedRun && chatPinnedToBottomRef.current) {
        scheduleSelectedQueuedInstructionAfterBottom(run.runId, nextQueuedInstruction)
        continue
      }

      clearQueuedSendDelay(run.runId)
      void submitQueuedInstruction(run.runId, nextQueuedInstruction, {
        pinSelectedChat: !selectedQueuedRun || chatPinnedToBottomRef.current,
      })
    }
  }, [managerSnapshot, queuedInstructionsByRun, selectedRunId, status])

  const busy = Boolean(pending)
  const canSendInstruction =
    Boolean(selectedRunId)
    && instruction.trim().length > 0
    && !busy
    && (canReceiveInstruction(status) || aiWorking)
  const queueingCurrentInstruction =
    Boolean(selectedRunId)
    && (!canReceiveInstruction(status)
      || selectedQueuedInstructions.length > 0
      || (selectedRunId !== null && Boolean(queuedSendInFlightRef.current[selectedRunId])))
  const selectedTitle = selectedRun?.displayName ?? runSnapshot?.displayName ?? 'No run selected'
  const draggingAttachment = attachmentDragDepth > 0

  function setUserMessageElement(messageId: string, element: HTMLElement | null) {
    if (element) {
      userMessageRefs.current.set(messageId, element.querySelector<HTMLElement>('.user-bubble') ?? element)
      return
    }

    userMessageRefs.current.delete(messageId)
  }

  function jumpToUserMessage(messageId: string) {
    const target = userMessageRefs.current.get(messageId)
    if (!target) {
      return
    }

    chatPinnedToBottomRef.current = false
    setChatAtBottom(false)
    setActiveUserMessageId(messageId)
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function latestUserMessageId() {
    return latestUserMessageOutlineId
  }

  function setLatestUserMessageActive() {
    const latestMessageId = latestUserMessageId()
    setActiveUserMessageId((currentId) => (currentId === latestMessageId ? currentId : latestMessageId))
  }

  function scheduleActiveUserMessageUpdate(scrollElement: HTMLDivElement) {
    activeMessageScrollElementRef.current = scrollElement
    if (activeMessageFrameRef.current !== null) {
      return
    }

    activeMessageFrameRef.current = window.requestAnimationFrame(() => {
      activeMessageFrameRef.current = null
      updateActiveUserMessage(activeMessageScrollElementRef.current)
    })
  }

  function updateActiveUserMessage(scrollElement = chatScrollRef.current) {
    if (!scrollElement || userMessageOutlines.length === 0) {
      setActiveUserMessageId(null)
      return
    }

    const scrollTop = scrollElement.scrollTop
    const scrollDirection: ScrollDirection =
      scrollTop < lastChatScrollTopRef.current
        ? 'up'
        : scrollTop > lastChatScrollTopRef.current
          ? 'down'
          : 'none'
    lastChatScrollTopRef.current = scrollTop
    if (isScrolledNearBottom(scrollElement)) {
      setLatestUserMessageActive()
      setChatBottomSyncVersion((version) => version + 1)
      return
    }

    const scrollRect = scrollElement.getBoundingClientRect()
    let firstMeasuredId: string | null = null

    if (scrollDirection === 'up') {
      const topZoneStartY = scrollRect.top - USER_BUBBLE_TOP_TOLERANCE_PX
      const topZoneEndY = scrollRect.top + USER_BUBBLE_TOP_ZONE_PX
      let topZoneMessageId: string | null = null

      for (const message of userMessageOutlines) {
        const element = userMessageRefs.current.get(message.id)
        if (!element) {
          continue
        }

        firstMeasuredId ??= message.id
        const messageTop = element.getBoundingClientRect().top
        if (messageTop < topZoneStartY) {
          continue
        }

        if (messageTop <= topZoneEndY) {
          topZoneMessageId = message.id
          continue
        }

        break
      }

      if (!firstMeasuredId) {
        if (chatPinnedToBottomRef.current) {
          setLatestUserMessageActive()
        } else {
          setActiveUserMessageId(null)
        }
        return
      }

      setActiveUserMessageId((currentId) => {
        const nextActiveId = topZoneMessageId ?? currentId ?? firstMeasuredId
        return currentId === nextActiveId ? currentId : nextActiveId
      })
      return
    }

    const activationOffset = Math.min(Math.max(scrollElement.clientHeight * 0.55, 96), 260)
    const activeThresholdY = scrollRect.top + activationOffset
    let nextActiveId: string | null = null

    for (const message of userMessageOutlines) {
      const element = userMessageRefs.current.get(message.id)
      if (!element) {
        continue
      }

      firstMeasuredId ??= message.id
      if (element.getBoundingClientRect().top <= activeThresholdY) {
        nextActiveId = message.id
      } else {
        break
      }
    }

    if (!firstMeasuredId) {
      if (chatPinnedToBottomRef.current) {
        setLatestUserMessageActive()
      } else {
        setActiveUserMessageId(null)
      }
      return
    }

    nextActiveId ??= firstMeasuredId
    setActiveUserMessageId((currentId) => (currentId === nextActiveId ? currentId : nextActiveId))
  }

  function clearSmoothScrollReleaseTimer() {
    if (smoothScrollReleaseTimerRef.current !== null) {
      window.clearTimeout(smoothScrollReleaseTimerRef.current)
      smoothScrollReleaseTimerRef.current = null
    }
    bottomScrollSettleUntilRef.current = 0
  }

  function guardProgrammaticBottomScroll() {
    clearSmoothScrollReleaseTimer()
    bottomScrollSettleUntilRef.current = Date.now() + QUEUED_SEND_BOTTOM_SETTLE_MS
    smoothScrollReleaseTimerRef.current = window.setTimeout(() => {
      smoothScrollReleaseTimerRef.current = null
      bottomScrollSettleUntilRef.current = 0
      const currentScrollElement = chatScrollRef.current
      if (!currentScrollElement) {
        return
      }

      if (chatPinnedToBottomRef.current) {
        currentScrollElement.scrollTop = currentScrollElement.scrollHeight
        setChatAtBottom(true)
        setChatBottomSyncVersion((version) => version + 1)
        updateActiveUserMessage(currentScrollElement)
        queuePinnedBottomCorrection(currentScrollElement)
        return
      }

      const atBottom = isScrolledNearBottom(currentScrollElement)
      chatPinnedToBottomRef.current = atBottom
      setChatAtBottom(atBottom)
      if (atBottom) {
        setChatBottomSyncVersion((version) => version + 1)
        updateActiveUserMessage(currentScrollElement)
      }
    }, QUEUED_SEND_BOTTOM_SETTLE_MS)
  }

  function queuePinnedBottomCorrection(scrollElement: HTMLDivElement) {
    if (pinnedBottomCorrectionFrameRef.current !== null) {
      window.cancelAnimationFrame(pinnedBottomCorrectionFrameRef.current)
    }

    pinnedBottomCorrectionFrameRef.current = window.requestAnimationFrame(() => {
      pinnedBottomCorrectionFrameRef.current = null
      if (!chatPinnedToBottomRef.current || chatScrollRef.current !== scrollElement) {
        return
      }

      scrollElement.scrollTop = scrollElement.scrollHeight
      setChatAtBottom(true)
      setChatBottomSyncVersion((version) => version + 1)
      updateActiveUserMessage(scrollElement)
    })
  }

  function scrollChatToBottom(behavior: ScrollBehavior = 'auto') {
    const scrollElement = chatScrollRef.current
    if (!scrollElement) {
      return
    }

    const shouldGuardScroll =
      behavior === 'smooth'
      || bottomScrollSettleUntilRef.current > Date.now()
      || !isScrolledNearBottom(scrollElement)
    if (shouldGuardScroll) {
      guardProgrammaticBottomScroll()
    } else {
      clearSmoothScrollReleaseTimer()
    }

    if (behavior === 'smooth' && typeof scrollElement.scrollTo === 'function') {
      scrollElement.scrollTo({
        top: scrollElement.scrollHeight,
        behavior,
      })
    } else {
      scrollElement.scrollTop = scrollElement.scrollHeight
    }

    chatPinnedToBottomRef.current = true
    setChatAtBottom(true)
    setChatBottomSyncVersion((version) => version + 1)
    setLatestUserMessageActive()
    updateActiveUserMessage(scrollElement)
    if (behavior !== 'smooth') {
      queuePinnedBottomCorrection(scrollElement)
    }
  }

  return (
    <div className={`app ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      <RunInbox
        runs={runs}
        selectedRunId={selectedRunId}
        deletingRunId={deletingRunId}
        collapsed={leftCollapsed}
        onSettingsOpen={() => setSettingsOpen(true)}
        onSelect={(runId) => {
          setInstruction('')
          setDraftAttachmentNames([])
          setRunSnapshot(null)
          setActionError(null)
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
            </div>
          </div>

          <div className="header-right">
            <button
              type="button"
              className="icon-btn danger"
              onClick={() => void handleStopSession()}
              disabled={!selectedRunId || busy || status !== 'WAITING_FOR_REVIEW'}
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

        {conversationLiveUsage && <ConversationUsageStrip usage={conversationLiveUsage} />}

        <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll} data-testid="chat-scroll">
          <div className="chat-scroll-content" ref={chatContentRef}>
            {runs.length === 0 ? (
              <EmptyInbox managerSnapshot={managerSnapshot} />
            ) : (
              chatMessages.length > 0 ? (
                chatMessages.map((message, index) => (
                  <Fragment key={message.id}>
                    <ChatMessageItem
                      message={message}
                      attachments={attachments}
                      onAttachmentPreview={setPreviewAttachment}
                      messageRef={
                        message.role === 'user'
                          ? (element) => setUserMessageElement(message.id, element)
                          : undefined
                      }
                    />
                    {aiWorking && index === chatMessages.length - 1 && message.role === 'user' && (
                      conversationThinkingRecords.length > 0 ? (
                        <AiThinkingMessage
                          records={conversationThinkingRecords}
                          onContentChange={handleDynamicChatContentChange}
                        />
                      ) : (
                        <AiLoadingMessage />
                      )
                    )}
                  </Fragment>
                ))
              ) : aiWorking && conversationThinkingRecords.length > 0 ? (
                <AiThinkingMessage
                  records={conversationThinkingRecords}
                  onContentChange={handleDynamicChatContentChange}
                />
              ) : hasSessionHistoryFile ? (
                <EmptyConversationHistory />
              ) : (
                <article className="message">
                  <ProfileAvatar type="bot" />
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
          {!chatAtBottom && (
            <div className="scroll-bottom-button-layer">
              <button
                type="button"
                className="scroll-bottom-button"
                onClick={() => scrollChatToBottom('smooth')}
                aria-label="Scroll to bottom"
                title="Scroll to bottom"
              >
                <i className="ri-arrow-down-line" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        <ReviewComposer
          instruction={instruction}
          onInstructionChange={setInstruction}
          attachments={attachments}
          draftAttachments={draftAttachments}
          pending={pending}
          uploadingAttachmentName={uploadingAttachmentName}
          canSend={canSendInstruction}
          queueing={queueingCurrentInstruction}
          queuedInstructions={selectedQueuedInstructions}
          autoSendingQueuedInstructionId={selectedAutoSendingQueuedInstructionId}
          composerFocusToken={composerFocusToken}
          onSend={() => void sendInstruction()}
          onShortcutSend={handleComposerShortcutSend}
          onQueuedInstructionEdit={handleQueuedInstructionEdit}
          onQueuedInstructionDelete={handleQueuedInstructionDelete}
          onUpload={(file) => void handleUpload(file)}
          onPasteAttachment={handleComposerPaste}
          onDraftAttachmentAdd={addDraftAttachment}
          onDraftAttachmentRemove={removeDraftAttachment}
          onAttachmentPreview={setPreviewAttachment}
          error={actionError ?? streamError ?? null}
        />
      </main>

      <ProtocolSidebar
        collapsed={rightCollapsed}
        snapshot={runSnapshot}
        attachments={attachments}
        onProtocolFilePreview={(fileName) => void handleProtocolFilePreview(fileName)}
        onAttachmentPreview={setPreviewAttachment}
        onAttachmentMention={mentionSessionAttachment}
        onAttachmentDelete={(attachment) => void handleDeleteAttachment(attachment)}
        onAttachmentsDeleteAll={() => void handleDeleteAllAttachments()}
        deletingAttachmentNames={deletingAttachmentNames}
        filesPresent={filesPresent}
        userMessageOutlines={userMessageOutlines}
        activeUserMessageId={activeUserMessageId}
        chatAtBottom={chatAtBottom}
        chatBottomSyncVersion={chatBottomSyncVersion}
        onUserMessageSelect={jumpToUserMessage}
      />

      {confirmDialog && (
        <ConfirmDialog dialog={confirmDialog} onResolve={resolveConfirmation} />
      )}

      {ctrlEnterConfirmOpen && (
        <CtrlEnterSendDialog
          onCancel={cancelCtrlEnterSendConfirm}
          onConfirm={handleCtrlEnterSendConfirm}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          confirmCtrlEnterSend={confirmCtrlEnterSend}
          onConfirmCtrlEnterSendChange={setConfirmCtrlEnterSend}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {previewAttachment && (
        <AttachmentPreview
          attachment={previewAttachment}
          attachments={attachments}
          onSelect={setPreviewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}

      {previewProtocolFile && (
        <ProtocolFilePreviewDialog
          preview={previewProtocolFile}
          onClose={() => setPreviewProtocolFile(null)}
        />
      )}
    </div>
  )
}

function RunInbox({
  runs,
  selectedRunId,
  deletingRunId,
  collapsed,
  onSettingsOpen,
  onSelect,
  onDelete,
}: {
  runs: RunSummary[]
  selectedRunId: string | null
  deletingRunId: string | null
  collapsed: boolean
  onSettingsOpen: () => void
  onSelect: (runId: string) => void
  onDelete: (run: RunSummary) => void
}) {
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [profileLogoutError, setProfileLogoutError] = useState(false)
  const [teammatesDialogOpen, setTeammatesDialogOpen] = useState(false)
  const [workspaceSettingsDialogOpen, setWorkspaceSettingsDialogOpen] = useState(false)
  const [skillsDialogOpen, setSkillsDialogOpen] = useState(false)
  const profileAreaRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!profileMenuOpen) {
      return
    }

    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target
      if (target instanceof Node && profileAreaRef.current?.contains(target)) {
        return
      }

      setProfileMenuOpen(false)
      setProfileLogoutError(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [profileMenuOpen])

  return (
    <aside id="left-sidebar" className={`sidebar left-sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Run inbox">
      <div className="sidebar-inner">
        <div className="brand-area">
          <div className="brand-icon" aria-hidden="true">
            <img src={CODEX_PROFILE_IMAGE} alt="" />
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
                  <RunStatusIcon status={run.status} />
                  <span className={`run-title run-${statusClassName(run.status)}`}>{run.displayName}</span>
                  <span className="run-meta">
                    {run.runId}
                    {run.attachmentCount > 0 ? ` - ${run.attachmentCount} attachments` : ''}
                  </span>
                  <span className="run-preview">
                    {run.outputPreview || 'No output yet.'}
                  </span>
                </button>

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
              </div>
            ))}
          </div>
        )}

        <div className="sidebar-profile-area" ref={profileAreaRef}>
          {profileMenuOpen && (
            <div className="profile-menu" role="menu" aria-label="Profile menu">
              <button type="button" className="profile-menu-account" role="menuitem">
                <span className="profile-menu-avatar">
                  <img src={USER_PROFILE_IMAGE} alt="" />
                </span>
                <span className="profile-menu-account-copy">
                  <span>Ramlyburger</span>
                  <span>Ultra Plan</span>
                </span>
                <i className="ri-arrow-right-s-line" aria-hidden="true" />
              </button>

              <div className="profile-menu-list">
                {PROFILE_MENU_ITEMS.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    className={`profile-menu-item ${item.separated ? 'separated' : ''}`}
                    role="menuitem"
                    onClick={() => {
                      if (item.action === 'logout') {
                        setProfileMenuOpen(false)
                        setProfileLogoutError(true)
                        return
                      }

                      if (item.action === 'settings') {
                        setProfileLogoutError(false)
                        setProfileMenuOpen(false)
                        onSettingsOpen()
                        return
                      }

                      if (item.action === 'teammates') {
                        setProfileLogoutError(false)
                        setProfileMenuOpen(false)
                        setTeammatesDialogOpen(true)
                        return
                      }

                      if (item.action === 'workspace-settings') {
                        setProfileLogoutError(false)
                        setProfileMenuOpen(false)
                        setWorkspaceSettingsDialogOpen(true)
                        return
                      }

                      if (item.action === 'skills') {
                        setProfileLogoutError(false)
                        setProfileMenuOpen(false)
                        setSkillsDialogOpen(true)
                        return
                      }

                      setProfileLogoutError(false)
                      setProfileMenuOpen(false)
                    }}
                  >
                    <i className={item.icon} aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.chevron && <i className="ri-arrow-right-s-line profile-menu-chevron" aria-hidden="true" />}
                  </button>
                ))}
              </div>

            </div>
          )}

          <button
            type="button"
            className="sidebar-profile-button"
            onClick={() => {
              setProfileMenuOpen((value) => {
                const nextValue = !value
                if (!nextValue) {
                  setProfileLogoutError(false)
                }
                return nextValue
              })
            }}
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
            aria-label="Open profile menu"
            title="Profile"
          >
            <span className="sidebar-profile-avatar">
              <img src={USER_PROFILE_IMAGE} alt="" />
            </span>
            <span className="sidebar-profile-copy">
              <span>Ramlyburger</span>
              <span>Ultra Plan</span>
            </span>
            <i className="ri-more-2-fill sidebar-profile-more" aria-hidden="true" />
          </button>
        </div>
      </div>
      {profileLogoutError && createPortal(
        <LogoutErrorDialog onClose={() => setProfileLogoutError(false)} />,
        document.body,
      )}
      {teammatesDialogOpen && createPortal(
        <TeammatesDialog onClose={() => setTeammatesDialogOpen(false)} />,
        document.body,
      )}
      {workspaceSettingsDialogOpen && createPortal(
        <WorkspaceSettingsDialog onClose={() => setWorkspaceSettingsDialogOpen(false)} />,
        document.body,
      )}
      {skillsDialogOpen && createPortal(
        <SkillsDialog onClose={() => setSkillsDialogOpen(false)} />,
        document.body,
      )}
    </aside>
  )
}

function LogoutErrorDialog({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose)

  return (
    <div className="preview-backdrop logout-error-backdrop" role="presentation" onClick={onClose}>
      <section
        className="logout-error-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Unable to logout"
        onClick={(event) => event.stopPropagation()}
      >
        <img src={LOGOUT_ERROR_STICKER} alt="Unable to logout sticker" />
        <div className="logout-error-copy">
          <h2>Unable to logout</h2>
          <p>The current local profile cannot be signed out from this console.</p>
        </div>
        <button type="button" className="confirm-button primary" onClick={onClose} autoFocus>
          Close
        </button>
      </section>
    </div>
  )
}

function WorkspaceSettingsDialog({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose)

  return (
    <div className="preview-backdrop logout-error-backdrop" role="presentation" onClick={onClose}>
      <section
        className="logout-error-dialog construction-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace settings under construction"
        onClick={(event) => event.stopPropagation()}
      >
        <img src={WORKSPACE_SETTINGS_STICKER} alt="Workspace settings under construction sticker" />
        <div className="logout-error-copy">
          <h2>Workspace settings</h2>
          <p>This workspace settings panel is still under construction.</p>
        </div>
        <button type="button" className="confirm-button primary" onClick={onClose} autoFocus>
          Close
        </button>
      </section>
    </div>
  )
}

function SkillsDialog({ onClose }: { onClose: () => void }) {
  useEscapeToClose(onClose)

  return (
    <div className="preview-backdrop logout-error-backdrop" role="presentation" onClick={onClose}>
      <section
        className="logout-error-dialog construction-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Skills under construction"
        onClick={(event) => event.stopPropagation()}
      >
        <img src={SKILLS_STICKER} alt="Skills under construction sticker" />
        <div className="logout-error-copy">
          <h2>Skills are marinating</h2>
          <p>The skill oven is preheating. Please do not tap the glass.</p>
        </div>
        <button type="button" className="confirm-button primary" onClick={onClose} autoFocus>
          Close
        </button>
      </section>
    </div>
  )
}

function createFallbackInvitedTeammate(email: string, count: number, teammates: Teammate[]): Teammate {
  return {
    id: `local-invited-${Date.now()}-${count}`,
    name: `Invited Burger ${Math.max(1, count - DEFAULT_TEAMMATES.length + 1)}`,
    email,
    avatarUrl: pickUnusedLocalTeammateAvatar(teammates),
    role: 'Member',
    seat: 'Codex Pro Max',
    dateAdded: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date()),
  }
}

function pickUnusedLocalTeammateAvatar(teammates: Teammate[]) {
  const usedAvatars = new Set(teammates.map((teammate) => teammate.avatarUrl))
  const availableAvatars = TEAMMATE_AVATAR_URLS.filter((avatarUrl) => !usedAvatars.has(avatarUrl))
  return availableAvatars[Math.floor(Math.random() * availableAvatars.length)] ?? TEAMMATE_AVATAR_URLS[0]
}

function TeammatesDialog({ onClose }: { onClose: () => void }) {
  const [teammates, setTeammates] = useState<Teammate[]>(DEFAULT_TEAMMATES)
  const [email, setEmail] = useState('')
  const [pendingInvite, setPendingInvite] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const maxTeammatesReached = teammates.length >= MAX_TEAMMATES
  useEscapeToClose(onClose)

  useEffect(() => {
    let ignore = false

    fetchTeammates()
      .then((response) => {
        if (!ignore) {
          setTeammates(response.teammates)
          setInviteError(null)
        }
      })
      .catch(() => {
        if (!ignore) {
          setInviteError(null)
        }
      })

    return () => {
      ignore = true
    }
  }, [])

  async function handleInviteSubmit(event: SyntheticEvent) {
    event.preventDefault()
    const inviteEmail = email.trim()
    if (!inviteEmail || maxTeammatesReached) {
      return
    }

    setPendingInvite(true)
    setInviteError(null)
    try {
      const response = await createTeammate({ email: inviteEmail })
      setTeammates(response.teammates)
      setEmail('')
    } catch {
      setTeammates((currentTeammates) => [
        ...currentTeammates,
        createFallbackInvitedTeammate(inviteEmail, currentTeammates.length, currentTeammates),
      ])
      setEmail('')
      setInviteError(null)
    } finally {
      setPendingInvite(false)
    }
  }

  return (
    <div className="preview-backdrop teammates-backdrop" role="presentation" onClick={onClose}>
      <section
        className="teammates-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Invite members to the Ramlyburger workspace"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="teammates-header">
          <div>
            <h2>Invite members to the Ramlyburger workspace</h2>
            <p>This workspace is private. Only selected burgers can enter this very serious business console.</p>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close teammates dialog" autoFocus>
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </header>

        <form className="teammates-invite-row" onSubmit={handleInviteSubmit}>
          <label>
            <span>Email</span>
            <input
              type="email"
              placeholder="Email"
              value={email}
              disabled={pendingInvite || maxTeammatesReached}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button type="button" className="confirm-button secondary">
            <i className="ri-add-line" aria-hidden="true" />
            Add more
          </button>
          <button
            type="submit"
            className="confirm-button primary"
            disabled={pendingInvite || !email.trim() || maxTeammatesReached}
          >
            {maxTeammatesReached ? 'Team full' : pendingInvite ? 'Sending...' : 'Send invites'}
          </button>
          {inviteError && <p className="teammates-error">{inviteError}</p>}
        </form>

        <div className="teammates-table-wrap">
          <table className="teammates-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Seat type</th>
                <th>Date added</th>
              </tr>
            </thead>
            <tbody>
              {teammates.map((teammate) => (
                <tr key={teammate.id}>
                  <td>
                    <span className="teammate-person">
                      <span className="teammate-avatar">
                        <img src={teammate.avatarUrl} alt={`${teammate.name} avatar`} />
                      </span>
                      <span>
                        <strong>{teammate.name}</strong>
                        <small>{teammate.email}</small>
                      </span>
                    </span>
                  </td>
                  <td>{teammate.role}</td>
                  <td>{teammate.seat}</td>
                  <td>{teammate.dateAdded}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function RunStatusIcon({ status }: { status: ProtocolStatus }) {
  const statusClass = `run-${statusClassName(status)}`
  if (status === 'RUNNING') {
    return (
      <svg
        className={`run-icon run-status-icon run-status-spinner ${statusClass}`}
        viewBox="0 0 50 50"
        aria-hidden="true"
      >
        <circle cx="25" cy="25" r="20" />
      </svg>
    )
  }

  if (status === 'WAITING_FOR_REVIEW') {
    return (
      <span
        className={`run-icon run-status-icon run-status-review-orb ${statusClass}`}
        aria-hidden="true"
      />
    )
  }

  if (status === 'INSTRUCTION_RECEIVED') {
    return (
      <span
        className={`run-icon run-status-icon run-status-success-wrapper ${statusClass}`}
        aria-hidden="true"
      >
        <svg className="run-status-success-svg" viewBox="0 0 50 50">
          <circle className="run-status-success-circle" cx="25" cy="25" r="20" />
          <path className="run-status-success-check" d="M16 26 L22 32 L34 18" />
        </svg>
      </span>
    )
  }

  return (
    <i
      className={`${RUN_STATUS_ICONS[status]} run-icon run-status-icon ${statusClass}`}
      aria-hidden="true"
    />
  )
}

const ChatMessageItem = memo(function ChatMessageItem({
  message,
  attachments,
  onAttachmentPreview,
  messageRef,
}: {
  message: ChatMessage
  attachments: AttachmentMeta[]
  onAttachmentPreview: (attachment: AttachmentMeta) => void
  messageRef?: (element: HTMLElement | null) => void
}) {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)
  const messageAttachments = useMemo(
    () => (isUser ? getMentionedAttachments(message.content, attachments) : []),
    [attachments, isUser, message.content],
  )

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <article
      ref={messageRef}
      className={`message chat-message ${isUser ? 'user-message' : 'assistant-message'}`}
    >
      {!isUser && (
        <ProfileAvatar type="bot" />
      )}

      <div className="message-content">
        <div className="label-row message-label-row">
          {!isUser && <span className="label-super">Codex</span>}
          <span className="message-actions">
            <span className="section-meta">{formatMessageTime(message.createdAtIso)}</span>
            <button
              type="button"
              className="message-copy-button"
              onClick={() => void copyMessage()}
              aria-label={`Copy ${isUser ? 'user' : 'Codex'} message`}
              title="Copy message"
            >
              <i className={copied ? 'ri-check-line' : 'ri-file-copy-line'} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className={isUser ? 'user-bubble' : undefined}>
          {messageAttachments.length > 0 && (
            <div className="message-attachment-preview-list">
              {messageAttachments.map((attachment) => (
                <button
                  key={attachment.name}
                  type="button"
                  className="message-attachment-preview-button"
                  onClick={() => onAttachmentPreview(attachment)}
                  aria-label={`Preview message attachment ${attachment.name}`}
                  title={`Preview ${attachment.name}`}
                >
                  <AttachmentThumbnail attachment={attachment} />
                  <span>{attachment.name}</span>
                </button>
              ))}
            </div>
          )}
          <MarkdownPanel
            markdown={message.content}
            safety={null}
            preserveSoftBreaks={isUser}
            emptyIcon={isUser ? 'ri-user-3-line' : 'ri-file-paper-2-line'}
            emptyText={isUser ? 'Empty message.' : 'No output draft yet.'}
          />
        </div>
      </div>

      {isUser && (
        <ProfileAvatar type="user" />
      )}
    </article>
  )
}, (previousProps, nextProps) =>
  previousProps.message === nextProps.message
  && previousProps.attachments === nextProps.attachments)

function AiLoadingMessage() {
  return (
    <article
      className="message chat-message assistant-message ai-loading-message"
      aria-label="Codex is working"
      data-testid="ai-loading-indicator"
    >
      <ProfileAvatar type="bot" />
      <div className="message-content">
        <div className="ai-loading-bubble" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </div>
    </article>
  )
}

function AiThinkingMessage({
  records,
  onContentChange,
}: {
  records: CodexLiveRecord[]
  onContentChange?: () => void
}) {
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const [typingState, setTypingState] = useState<{ id: string; text: string } | null>(null)
  const typingStateRef = useRef<{ id: string; text: string } | null>(null)
  const recordAnchor = records
    .map((record) => `${record.id}:${record.text.length}`)
    .join('|')
  const latestRecord = records.length > 0 ? records[records.length - 1] : null
  const latestRecordText = latestRecord?.text.trim() ?? ''
  const latestTypingText = latestRecord && typingState && (
    typingState.id === latestRecord.id
    || typingState.text === latestRecordText
    || (typingState.text.length > 0 && latestRecordText.startsWith(typingState.text))
  )
    ? typingState.text
    : ''
  const thinkingMarkdown = records
    .map((record, index) => {
      if (
        index === records.length - 1
        && latestRecord
        && record.text.trim() === latestRecordText
      ) {
        return latestTypingText
      }
      return record.text.trim()
    })
    .filter(Boolean)
    .join('\n\n')

  useEffect(() => {
    typingStateRef.current = typingState
  }, [typingState])

  useEffect(() => {
    function updateTypingState(nextState: { id: string; text: string } | null) {
      typingStateRef.current = nextState
      setTypingState(nextState)
    }

    if (!latestRecord || !latestRecordText) {
      updateTypingState(null)
      return
    }

    const latestRecordId = latestRecord.id
    const currentState = typingStateRef.current
    const currentText = currentState && (
      currentState.id === latestRecordId
      || currentState.text === latestRecordText
      || (currentState.text.length > 0 && latestRecordText.startsWith(currentState.text))
    )
      ? currentState.text
      : ''

    if (currentText === latestRecordText) {
      if (currentState?.id !== latestRecordId) {
        updateTypingState({ id: latestRecordId, text: latestRecordText })
      }
      return
    }

    if (currentText && !latestRecordText.startsWith(currentText)) {
      updateTypingState({ id: latestRecordId, text: latestRecordText })
      return
    }

    const startLength = currentText && latestRecordText.startsWith(currentText)
      ? currentText.length
      : 0
    if (startLength >= latestRecordText.length) {
      updateTypingState({ id: latestRecordId, text: latestRecordText })
      return
    }

    const stepSize = Math.max(1, Math.ceil(latestRecordText.length / 12))
    let visibleLength = startLength

    function tick() {
      visibleLength = Math.min(latestRecordText.length, visibleLength + stepSize)
      updateTypingState({
        id: latestRecordId,
        text: latestRecordText.slice(0, visibleLength),
      })
      if (visibleLength >= latestRecordText.length) {
        window.clearInterval(timer)
      }
    }

    updateTypingState({ id: latestRecordId, text: latestRecordText.slice(0, startLength) })
    const timer = window.setInterval(tick, 16)
    tick()

    return () => window.clearInterval(timer)
  }, [latestRecord?.id, latestRecordText])

  useLayoutEffect(() => {
    const bubble = bubbleRef.current
    if (!bubble) return
    bubble.scrollTop = bubble.scrollHeight
    onContentChange?.()
  }, [onContentChange, recordAnchor, thinkingMarkdown.length])

  return (
    <article
      className="message chat-message assistant-message ai-thinking-message"
      aria-label="Codex thinking process"
      data-testid="ai-thinking-process"
    >
      <ProfileAvatar type="bot" />
      <div className="message-content">
        <div className="label-row message-label-row">
          <span className="label-super ai-thinking-label" aria-label="Thinking">
            Thinking
            <span className="ai-thinking-label-dots" aria-hidden="true">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </span>
        </div>
        <div className="ai-thinking-bubble" ref={bubbleRef}>
          <MarkdownPanel
            markdown={thinkingMarkdown}
            safety={null}
            emptyIcon="ri-brain-line"
            emptyText="Thinking..."
          />
        </div>
      </div>
    </article>
  )
}

function ProfileAvatar({ type }: { type: 'bot' | 'user' }) {
  const src = type === 'bot' ? CODEX_PROFILE_IMAGE : USER_PROFILE_IMAGE
  const label = type === 'bot' ? 'Codex' : 'You'

  return (
    <div className={`avatar profile-avatar ${type === 'user' ? 'user-avatar' : 'bot-avatar'}`} aria-hidden="true">
      <img src={src} alt={label} />
    </div>
  )
}

function isCodexWorking(status: ProtocolStatus) {
  return status === 'RUNNING' || status === 'INSTRUCTION_RECEIVED'
}

function canReceiveInstruction(status: ProtocolStatus) {
  return status === 'WAITING_FOR_REVIEW' || status === 'STOPPED'
}

function isConversationThinkingRecord(record: CodexLiveRecord) {
  return record.kind === 'message'
    && record.title.toLowerCase() === 'assistant'
    && record.text.trim().length > 0
}

function isConversationUserRecord(record: CodexLiveRecord) {
  return record.kind === 'message' && record.title.toLowerCase() === 'user'
}

function latestUserMessageCreatedAtIso(messages: ChatMessage[] | undefined) {
  if (!messages) return null

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') {
      return message.createdAtIso
    }
  }

  return null
}

function conversationThinkingRecordsFromLiveHistory(
  records: CodexLiveRecord[],
  latestUserMessageCreatedAtIsoValue?: string | null,
) {
  let lastUserIndex = -1
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isConversationUserRecord(records[index])) {
      lastUserIndex = index
      break
    }
  }

  let currentTurnRecords = lastUserIndex >= 0 ? records.slice(lastUserIndex + 1) : records
  const latestUserMessageTimeMs = latestUserMessageCreatedAtIsoValue
    ? Date.parse(latestUserMessageCreatedAtIsoValue)
    : Number.NaN
  if (Number.isFinite(latestUserMessageTimeMs)) {
    currentTurnRecords = currentTurnRecords.filter((record) => {
      const recordTimeMs = Date.parse(record.timestamp)
      return !Number.isFinite(recordTimeMs) || recordTimeMs >= latestUserMessageTimeMs
    })
  }

  return currentTurnRecords.filter(isConversationThinkingRecord).slice(-30)
}

const MarkdownPanel = memo(function MarkdownPanel({
  markdown,
  safety,
  preserveSoftBreaks = false,
  emptyIcon,
  emptyText,
}: {
  markdown: string
  safety: MarkdownSafety | null
  preserveSoftBreaks?: boolean
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
      <div className={`prose markdown-body${preserveSoftBreaks ? ' preserve-soft-breaks' : ''}`}>
        <ReactMarkdown components={MARKDOWN_COMPONENTS} remarkPlugins={MARKDOWN_REMARK_PLUGINS}>{markdown}</ReactMarkdown>
      </div>
    </>
  )
})

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
  uploadingAttachmentName,
  canSend,
  queueing,
  queuedInstructions,
  autoSendingQueuedInstructionId,
  composerFocusToken,
  onSend,
  onShortcutSend,
  onQueuedInstructionEdit,
  onQueuedInstructionDelete,
  onUpload,
  onPasteAttachment,
  onDraftAttachmentAdd,
  onDraftAttachmentRemove,
  onAttachmentPreview,
  error,
}: {
  instruction: string
  onInstructionChange: (value: string) => void
  attachments: AttachmentMeta[]
  draftAttachments: AttachmentMeta[]
  pending: PendingAction | null
  uploadingAttachmentName: string | null
  canSend: boolean
  queueing: boolean
  queuedInstructions: QueuedInstruction[]
  autoSendingQueuedInstructionId: string | null
  composerFocusToken: number
  onSend: () => void
  onShortcutSend: () => void
  onQueuedInstructionEdit: (item: QueuedInstruction) => void
  onQueuedInstructionDelete: (item: QueuedInstruction) => void
  onUpload: (file: File | undefined) => void
  onPasteAttachment: (event: ClipboardEvent<HTMLTextAreaElement>) => Promise<AttachmentMeta | null>
  onDraftAttachmentAdd: (name: string) => void
  onDraftAttachmentRemove: (name: string) => void
  onAttachmentPreview: (attachment: AttachmentMeta) => void
  error: string | null
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const highlightRef = useRef<HTMLDivElement | null>(null)
  const [mentionRange, setMentionRange] = useState<MentionRange | null>(null)
  const [activeMentionIndex, setActiveMentionIndex] = useState(0)
  const attachmentNameSet = useMemo(
    () => new Set(attachments.map((attachment) => attachment.name)),
    [attachments],
  )
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
  const sendIcon = pending === 'send'
    ? 'ri-loader-4-line'
    : queueing
      ? 'ri-list-check-2'
      : canSend
        ? 'ri-send-plane-fill'
        : 'ri-send-plane-line'
  const sendLabel = pending === 'send'
    ? 'Sending...'
    : queueing
      ? 'Queue for review'
      : 'Send to Codex'

  useLayoutEffect(() => {
    resizeComposerTextarea(textareaRef.current)
  }, [instruction])

  useEffect(() => {
    setActiveMentionIndex(0)
  }, [mentionRange?.query])

  useEffect(() => {
    if (composerFocusToken > 0) {
      textareaRef.current?.focus()
    }
  }, [composerFocusToken])

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
    if (selectMentionTokenAtCaret(event.currentTarget)) {
      return
    }

    updateMentionRange(event.currentTarget.value, event.currentTarget.selectionStart)
  }

  function selectMentionTokenAtCaret(textarea: HTMLTextAreaElement): boolean {
    if (textarea.selectionStart !== textarea.selectionEnd) {
      return false
    }

    const caret = textarea.selectionStart
    const tokenRange = findAttachmentMentionToken(textarea.value, caret, attachmentNameSet)
    if (!tokenRange || caret <= tokenRange.start || caret >= tokenRange.end) {
      return false
    }

    setMentionRange(null)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(tokenRange.start, tokenRange.end)
    })
    return true
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
    const textarea = event.currentTarget
    if (event.key === 'Enter' && event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault()
      setMentionRange(null)
      if (canSend) {
        onShortcutSend()
      }
      return
    }

    if (
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      && !event.altKey
      && !event.ctrlKey
      && !event.metaKey
      && textarea.selectionStart === textarea.selectionEnd
    ) {
      const caret = textarea.selectionStart
      const tokenRange = findAttachmentMentionToken(textarea.value, caret, attachmentNameSet)
      if (tokenRange && event.key === 'ArrowLeft' && caret > tokenRange.start && caret <= tokenRange.end) {
        event.preventDefault()
        setMentionRange(null)
        textarea.setSelectionRange(tokenRange.start, tokenRange.start)
        return
      }

      if (tokenRange && event.key === 'ArrowRight' && caret >= tokenRange.start && caret < tokenRange.end) {
        event.preventDefault()
        setMentionRange(null)
        textarea.setSelectionRange(tokenRange.end, tokenRange.end)
        return
      }
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
      {uploadingAttachmentName && (
        <div
          className="composer-upload-progress"
          role="progressbar"
          aria-label={`Uploading ${uploadingAttachmentName}`}
          aria-valuetext="Uploading"
        >
          <div className="composer-upload-copy">
            <i className="ri-loader-4-line" aria-hidden="true" />
            <span>{uploadingAttachmentName}</span>
          </div>
          <div className="composer-upload-track" aria-hidden="true">
            <span />
          </div>
        </div>
      )}
      {draftAttachments.length > 0 && (
        <div className="composer-attachment-tray" aria-label="Message attachments">
          {draftAttachments.map((attachment) => (
            <div className="composer-attachment-chip" key={attachment.name}>
              <button
                type="button"
                className="composer-attachment-preview"
                onClick={() => onAttachmentPreview(attachment)}
                title={`Preview ${attachment.name}`}
                aria-label={`Preview attachment ${attachment.name}`}
              >
                <AttachmentThumbnail attachment={attachment} />
              </button>
              <button
                type="button"
                className="composer-attachment-name"
                onClick={() => insertAttachmentMention(attachment.name)}
                title={`Mention ${attachment.name}`}
                aria-label={`Mention attachment ${attachment.name}`}
              >
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
      <QueuedInstructionList
        items={queuedInstructions}
        autoSendingItemId={autoSendingQueuedInstructionId}
        onEdit={onQueuedInstructionEdit}
        onDelete={onQueuedInstructionDelete}
      />
      <div className="composer">
        <div className="composer-inner">
          <label className="composer-btn" title={pending === 'upload' ? 'Uploading...' : 'Attach file'}>
            <i className={pending === 'upload' ? 'ri-loader-4-line' : 'ri-attachment-2'} aria-hidden="true" />
            <span className="sr-only">{pending === 'upload' ? 'Uploading...' : 'Attach file'}</span>
            <input
              type="file"
              disabled={Boolean(pending)}
              onChange={(event) => {
                onUpload(event.target.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </label>

          <div className="composer-input-shell">
            <div className="composer-highlight" ref={highlightRef} aria-hidden="true">
              {renderComposerHighlights(instruction)}
            </div>
            <textarea
              ref={textareaRef}
              id="instruction"
              value={instruction}
              onChange={handleInstructionChange}
              onClick={handleTextareaCursor}
              onKeyUp={handleTextareaCursor}
              onKeyDown={handleTextareaKeyDown}
              onPaste={(event) => void handleTextareaPaste(event)}
              onScroll={(event) => syncComposerHighlightScroll(highlightRef.current, event.currentTarget)}
              onBlur={() => setMentionRange(null)}
              rows={1}
              placeholder="Write your instructions to Codex..."
              spellCheck
            />
          </div>

          <button
            type="button"
            className={`send-btn ${pending === 'send' ? 'running' : ''}`}
            disabled={!canSend}
            onClick={onSend}
            title={sendLabel}
          >
            <i className={sendIcon} aria-hidden="true" />
            <span className="sr-only">{sendLabel}</span>
          </button>
        </div>
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

function QueuedInstructionList({
  items,
  autoSendingItemId,
  onEdit,
  onDelete,
}: {
  items: QueuedInstruction[]
  autoSendingItemId: string | null
  onEdit: (item: QueuedInstruction) => void
  onDelete: (item: QueuedInstruction) => void
}) {
  if (items.length === 0) {
    return null
  }

  return (
    <div className="queued-instructions" aria-label="Queued messages">
      <div className="queued-instructions-header">
        <i className="ri-list-check-2" aria-hidden="true" />
        <span>{items.length === 1 ? '1 message queued' : `${items.length} messages queued`}</span>
      </div>
      <div className="queued-instruction-list">
        {items.map((item, index) => {
          const isAutoSending = item.id === autoSendingItemId
          return (
            <article
              className={`queued-instruction ${isAutoSending ? 'auto-sending' : ''}`}
              key={item.id}
              aria-label={`Queued message ${index + 1}`}
            >
              <span className="queued-instruction-order">{index + 1}</span>
              <p>{item.content}</p>
              <div className="queued-instruction-actions">
                {isAutoSending && (
                  <span className="queued-instruction-sending" aria-label="Sending queued message">
                    <i className="ri-loader-4-line" aria-hidden="true" />
                  </span>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => onEdit(item)}
                  disabled={isAutoSending}
                  aria-label={`Edit queued message ${index + 1}`}
                  title="Edit queued message"
                >
                  <i className="ri-edit-line" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => onDelete(item)}
                  disabled={isAutoSending}
                  aria-label={`Delete queued message ${index + 1}`}
                  title="Delete queued message"
                >
                  <i className="ri-delete-bin-line" aria-hidden="true" />
                </button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

function getPastedAttachmentFile(data: DataTransfer): File | null {
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') {
      continue
    }

    const file = item.getAsFile()
    if (file) {
      return nameClipboardAttachment(file)
    }
  }

  return null
}

function nameClipboardAttachment(file: File): File {
  if (file.name) {
    return file
  }

  const extension = attachmentFileExtension(file.type)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return new File([file], `pasted-attachment-${stamp}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified || Date.now(),
  })
}

function attachmentFileExtension(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return 'jpg'
    case 'image/png':
      return 'png'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/bmp':
      return 'bmp'
    case 'image/avif':
      return 'avif'
    case 'application/pdf':
      return 'pdf'
    case 'application/json':
      return 'json'
    case 'application/msword':
      return 'doc'
    case 'application/vnd.ms-excel':
      return 'xls'
    case 'application/vnd.ms-powerpoint':
      return 'ppt'
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx'
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx'
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx'
    case 'application/zip':
      return 'zip'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/wav':
      return 'wav'
    case 'video/mp4':
      return 'mp4'
    case 'video/quicktime':
      return 'mov'
    case 'video/webm':
      return 'webm'
    case 'text/csv':
      return 'csv'
    case 'text/markdown':
      return 'md'
    case 'text/plain':
      return 'txt'
    default:
      return mimeType.startsWith('text/') ? 'txt' : 'bin'
  }
}

function isAttachmentKind(value: unknown): value is AttachmentMeta['kind'] {
  return typeof value === 'string' && value in ATTACHMENT_KIND_ICONS
}

function getAttachmentExtension(fileName: string): string {
  const match = /\.([a-zA-Z0-9]+)$/.exec(fileName)
  return match ? `.${match[1].toLowerCase()}` : ''
}

function inferAttachmentMimeType(fileName: string): string {
  switch (getAttachmentExtension(fileName)) {
    case '.avif':
      return 'image/avif'
    case '.bmp':
      return 'image/bmp'
    case '.csv':
      return 'text/csv'
    case '.doc':
      return 'application/msword'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.gif':
      return 'image/gif'
    case '.html':
    case '.htm':
      return 'text/html'
    case '.jpeg':
    case '.jpg':
      return 'image/jpeg'
    case '.js':
      return 'text/javascript'
    case '.json':
      return 'application/json'
    case '.md':
      return 'text/markdown'
    case '.m4a':
      return 'audio/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.mp3':
      return 'audio/mpeg'
    case '.mp4':
      return 'video/mp4'
    case '.pdf':
      return 'application/pdf'
    case '.png':
      return 'image/png'
    case '.ppt':
      return 'application/vnd.ms-powerpoint'
    case '.pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case '.svg':
      return 'image/svg+xml'
    case '.txt':
      return 'text/plain'
    case '.wav':
      return 'audio/wav'
    case '.webm':
      return 'video/webm'
    case '.webp':
      return 'image/webp'
    case '.xls':
      return 'application/vnd.ms-excel'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.xml':
      return 'application/xml'
    case '.zip':
      return 'application/zip'
    default:
      return 'application/octet-stream'
  }
}

function getAttachmentMimeType(attachment: AttachmentMeta): string {
  const mimeType = (attachment as Partial<AttachmentMeta>).mimeType?.trim().toLowerCase()
  return mimeType && mimeType !== 'application/octet-stream'
    ? mimeType
    : inferAttachmentMimeType(attachment.name)
}

function getAttachmentKind(attachment: AttachmentMeta): AttachmentMeta['kind'] {
  const providedKind = (attachment as Partial<AttachmentMeta>).kind
  if (isAttachmentKind(providedKind)) {
    return providedKind
  }

  const mimeType = getAttachmentMimeType(attachment)
  const extension = getAttachmentExtension(attachment.name)

  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'
  if (['.7z', '.gz', '.rar', '.tar', '.tgz', '.zip'].includes(extension)) return 'archive'
  if (['.csv', '.ods', '.xls', '.xlsx'].includes(extension)) return 'spreadsheet'
  if (['.odp', '.ppt', '.pptx'].includes(extension)) return 'presentation'
  if (['.doc', '.docx', '.odt', '.rtf'].includes(extension)) return 'document'
  if (
    ['.c', '.cpp', '.cs', '.css', '.go', '.java', '.js', '.json', '.jsx', '.php', '.py', '.rb', '.rs', '.sh', '.sql', '.ts', '.tsx', '.xml', '.yaml', '.yml'].includes(extension)
    || mimeType.includes('json')
    || mimeType.includes('javascript')
    || mimeType.includes('typescript')
    || mimeType.includes('xml')
  ) {
    return 'code'
  }
  if (mimeType.startsWith('text/')) return 'text'

  return 'file'
}

function getAttachmentIcon(attachment: AttachmentMeta): string {
  return ATTACHMENT_KIND_ICONS[getAttachmentKind(attachment)]
}

function getAttachmentKindLabel(attachment: AttachmentMeta): string {
  return ATTACHMENT_KIND_LABELS[getAttachmentKind(attachment)]
}

function isImageAttachment(attachment: AttachmentMeta): boolean {
  return getAttachmentKind(attachment) === 'image'
}

function canInlinePreviewAttachment(attachment: AttachmentMeta): boolean {
  const kind = getAttachmentKind(attachment)
  return kind === 'pdf' || kind === 'text' || kind === 'code'
}

function formatAttachmentMeta(attachment: AttachmentMeta): string {
  return `${getAttachmentKindLabel(attachment)} / ${formatBytes(attachment.size)}`
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

function findAttachmentMentionToken(
  value: string,
  caret: number,
  attachmentNames: ReadonlySet<string>,
): MentionRange | null {
  const matcher = /(^|\s)@([a-zA-Z0-9._-]+)(?=\s|$)/g
  for (const match of value.matchAll(matcher)) {
    const name = match[2]
    if (!attachmentNames.has(name)) {
      continue
    }

    const start = (match.index ?? 0) + match[1].length
    const end = start + name.length + 1
    if (caret >= start && caret <= end) {
      return {
        start,
        end,
        query: name,
      }
    }
  }

  return null
}

function removeAttachmentMention(value: string, attachmentName: string): string {
  const escapedName = escapeRegExp(attachmentName)
  const withoutMention = value
    .replace(new RegExp(`(^|\\s)@${escapedName}(?=\\s|$)`, 'g'), '$1')
    .replace(/[ \t]{2,}/g, ' ')
  return withoutMention.trimStart()
}

function getMentionedAttachments(content: string, attachments: AttachmentMeta[]): AttachmentMeta[] {
  return attachments.filter((attachment) => hasAttachmentMention(content, attachment.name))
}

function hasAttachmentMention(value: string, attachmentName: string): boolean {
  const mention = `@${attachmentName}`
  return new RegExp(`(^|\\s)${escapeRegExp(mention)}(?=\\s|$)`).test(value)
}

function isTextEntryElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) {
    return false
  }

  if (element instanceof HTMLTextAreaElement) {
    return true
  }

  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(
      element.type,
    )
  }

  return element.isContentEditable
}

function appendAttachmentMention(value: string, attachmentName: string): string {
  const mention = `@${attachmentName}`
  if (hasAttachmentMention(value, attachmentName)) {
    return value
  }

  const separator = value.trim().length > 0 && !/\s$/.test(value) ? ' ' : ''
  return `${value}${separator}${mention}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key)
    return stored === null ? fallback : stored === 'true'
  } catch {
    return fallback
  }
}

function writeStoredBoolean(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // Ignore storage failures so browser privacy settings do not break the UI.
  }
}

function readStoredQueuedInstructions(): QueuedInstructionsByRun {
  try {
    const stored = window.localStorage.getItem(QUEUED_INSTRUCTIONS_STORAGE_KEY)
    if (!stored) {
      return {}
    }

    return parseQueuedInstructionsByRun(JSON.parse(stored) as unknown)
  } catch {
    return {}
  }
}

function writeStoredQueuedInstructions(queues: QueuedInstructionsByRun) {
  try {
    const entries = Object.entries(queues).filter(([, items]) => items.length > 0)
    if (entries.length === 0) {
      window.localStorage.removeItem(QUEUED_INSTRUCTIONS_STORAGE_KEY)
      return
    }

    window.localStorage.setItem(QUEUED_INSTRUCTIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // Ignore storage failures so queued draft state never blocks the UI.
  }
}

function parseQueuedInstructionsByRun(value: unknown): QueuedInstructionsByRun {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const parsedQueues: QueuedInstructionsByRun = {}
  for (const [runId, items] of Object.entries(value)) {
    if (!Array.isArray(items)) {
      continue
    }

    const parsedItems = items.filter(isQueuedInstruction)
    if (parsedItems.length > 0) {
      parsedQueues[runId] = parsedItems
    }
  }

  return parsedQueues
}

function isQueuedInstruction(value: unknown): value is QueuedInstruction {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as QueuedInstruction).id === 'string'
    && typeof (value as QueuedInstruction).content === 'string'
}

function addUniqueNames(currentNames: string[], nextNames: string[]): string[] {
  return Array.from(new Set([...currentNames, ...nextNames]))
}

function renderComposerHighlights(value: string) {
  if (!value) {
    return null
  }

  const segments: ReactNode[] = []
  const matcher = /@[a-zA-Z0-9._-]+/g
  let lastIndex = 0
  for (const match of value.matchAll(matcher)) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      segments.push(value.slice(lastIndex, index))
    }
    segments.push(
      <span className="composer-mention-highlight" key={`${match[0]}-${index}`}>
        {match[0]}
      </span>,
    )
    lastIndex = index + match[0].length
  }

  if (lastIndex < value.length) {
    segments.push(value.slice(lastIndex))
  }

  if (value.endsWith('\n')) {
    segments.push('\u200b')
  }

  return segments
}

function syncComposerHighlightScroll(highlight: HTMLDivElement | null, textarea: HTMLTextAreaElement) {
  if (highlight) {
    highlight.scrollTop = textarea.scrollTop
  }
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

function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') {
        return
      }

      event.preventDefault()
      onClose()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
}

function ProtocolSidebar({
  collapsed,
  snapshot,
  attachments,
  onProtocolFilePreview,
  onAttachmentPreview,
  onAttachmentMention,
  onAttachmentDelete,
  onAttachmentsDeleteAll,
  deletingAttachmentNames,
  filesPresent,
  userMessageOutlines,
  activeUserMessageId,
  chatAtBottom,
  chatBottomSyncVersion,
  onUserMessageSelect,
}: {
  collapsed: boolean
  snapshot: Snapshot | null
  attachments: AttachmentMeta[]
  onProtocolFilePreview: (fileName: ProtocolTextFile) => void
  onAttachmentPreview: (attachment: AttachmentMeta) => void
  onAttachmentMention: (name: string) => void
  onAttachmentDelete: (attachment: AttachmentMeta) => void
  onAttachmentsDeleteAll: () => void
  deletingAttachmentNames: string[]
  filesPresent: number
  userMessageOutlines: UserMessageOutline[]
  activeUserMessageId: string | null
  chatAtBottom: boolean
  chatBottomSyncVersion: number
  onUserMessageSelect: (messageId: string) => void
}) {
  const [outlinesCollapsed, setOutlinesCollapsed] = useState(() =>
    readStoredBoolean(OUTLINES_COLLAPSED_STORAGE_KEY, false),
  )
  const [protocolFilesCollapsed, setProtocolFilesCollapsed] = useState(() =>
    readStoredBoolean(PROTOCOL_FILES_COLLAPSED_STORAGE_KEY, true),
  )
  const [attachmentsCollapsed, setAttachmentsCollapsed] = useState(() =>
    readStoredBoolean(ATTACHMENTS_COLLAPSED_STORAGE_KEY, false),
  )

  useEffect(() => {
    writeStoredBoolean(OUTLINES_COLLAPSED_STORAGE_KEY, outlinesCollapsed)
  }, [outlinesCollapsed])

  useEffect(() => {
    writeStoredBoolean(PROTOCOL_FILES_COLLAPSED_STORAGE_KEY, protocolFilesCollapsed)
  }, [protocolFilesCollapsed])

  useEffect(() => {
    writeStoredBoolean(ATTACHMENTS_COLLAPSED_STORAGE_KEY, attachmentsCollapsed)
  }, [attachmentsCollapsed])

  return (
    <aside
      id="right-sidebar"
      className={`sidebar right-sidebar ${collapsed ? 'collapsed' : ''}`}
      aria-label="Protocol details"
    >
      <div className="sidebar-inner">
        <SidebarMetaGroup
          title="Outlines"
          className="outline-group"
          collapsed={outlinesCollapsed}
          onToggle={() => setOutlinesCollapsed((value) => !value)}
        >
          <UserMessageOutlineList
            outlines={userMessageOutlines}
            activeMessageId={activeUserMessageId}
            chatAtBottom={chatAtBottom}
            chatBottomSyncVersion={chatBottomSyncVersion}
            onSelect={onUserMessageSelect}
          />
        </SidebarMetaGroup>

        <SidebarMetaGroup
          title="Protocol Files"
          className="protocol-files-group"
          collapsed={protocolFilesCollapsed}
          onToggle={() => setProtocolFilesCollapsed((value) => !value)}
        >
          <div className="file-count">
            {filesPresent}
            <span> / {PROTOCOL_TEXT_FILES.length} present</span>
          </div>
          <div className="file-card-list">
            {PROTOCOL_TEXT_FILES.map((fileName) => (
              <FileCard
                key={fileName}
                fileName={fileName}
                snapshot={snapshot}
                onPreview={onProtocolFilePreview}
              />
            ))}
          </div>
        </SidebarMetaGroup>

        <SidebarMetaGroup
          title="Attachments"
          className="attachments-group"
          collapsed={attachmentsCollapsed}
          onToggle={() => setAttachmentsCollapsed((value) => !value)}
          action={(
            <button
              type="button"
              className="meta-group-icon-action danger"
              onClick={onAttachmentsDeleteAll}
              disabled={attachments.length === 0 || deletingAttachmentNames.length > 0}
              aria-label="Delete all attachments"
              title="Delete all attachments"
            >
              <i className={deletingAttachmentNames.length > 0 ? 'ri-loader-4-line' : 'ri-delete-bin-6-line'} aria-hidden="true" />
            </button>
          )}
        >
          <AttachmentList
            attachments={attachments}
            deletingAttachmentNames={deletingAttachmentNames}
            onPreview={onAttachmentPreview}
            onMention={onAttachmentMention}
            onDelete={onAttachmentDelete}
          />
        </SidebarMetaGroup>
      </div>
    </aside>
  )
}

function SidebarMetaGroup({
  title,
  className = '',
  collapsed,
  onToggle,
  action,
  children,
}: {
  title: string
  className?: string
  collapsed: boolean
  onToggle: () => void
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={`meta-group ${className} ${collapsed ? 'collapsed' : ''}`}>
      <h4 className="meta-group-heading">
        <span className="meta-group-heading-row">
          <button type="button" className="meta-group-toggle" onClick={onToggle} aria-expanded={!collapsed}>
            <span>{title}</span>
          </button>
          {action}
          <button
            type="button"
            className="meta-group-collapse-button"
            onClick={onToggle}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          >
            <i className={collapsed ? 'ri-arrow-down-s-line' : 'ri-arrow-up-s-line'} aria-hidden="true" />
          </button>
        </span>
      </h4>
      {!collapsed && <div className="meta-group-content">{children}</div>}
    </div>
  )
}

function UserMessageOutlineList({
  outlines,
  activeMessageId,
  chatAtBottom,
  chatBottomSyncVersion,
  onSelect,
}: {
  outlines: UserMessageOutline[]
  activeMessageId: string | null
  chatAtBottom: boolean
  chatBottomSyncVersion: number
  onSelect: (messageId: string) => void
}) {
  const outlineListRef = useRef<HTMLOListElement | null>(null)
  const outlineButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const outlinePinnedToBottomRef = useRef(true)
  const latestOutline = outlines.length > 0 ? outlines[outlines.length - 1] : null
  const effectiveActiveMessageId = activeMessageId ?? (chatAtBottom ? latestOutline?.id ?? null : null)
  const [visibleActiveMessageId, setVisibleActiveMessageId] = useState<string | null>(effectiveActiveMessageId)
  const outlineScrollAnchor = latestOutline ? `${outlines.length}:${latestOutline.id}` : 'empty'
  const lastOutlineScrollAnchorRef = useRef(outlineScrollAnchor)

  useLayoutEffect(() => {
    if (!effectiveActiveMessageId) {
      setVisibleActiveMessageId(null)
      return
    }

    const outlineList = outlineListRef.current
    const activeButton = outlineButtonRefs.current.get(effectiveActiveMessageId)
    if (!outlineList || !activeButton) {
      setVisibleActiveMessageId(effectiveActiveMessageId)
      return
    }

    if (effectiveActiveMessageId === latestOutline?.id) {
      if (chatAtBottom || outlinePinnedToBottomRef.current) {
        outlineList.scrollTop = outlineList.scrollHeight
        outlinePinnedToBottomRef.current = true
        lastOutlineScrollAnchorRef.current = outlineScrollAnchor
      }
      setVisibleActiveMessageId(effectiveActiveMessageId)
      return
    }

    if (lastOutlineScrollAnchorRef.current !== outlineScrollAnchor) {
      setVisibleActiveMessageId(effectiveActiveMessageId)
      return
    }

    const outlineRect = outlineList.getBoundingClientRect()
    const activeRect = activeButton.getBoundingClientRect()

    if (activeRect.top < outlineRect.top) {
      outlineList.scrollTop += activeRect.top - outlineRect.top
    } else if (activeRect.bottom > outlineRect.bottom) {
      outlineList.scrollTop += activeRect.bottom - outlineRect.bottom
    }

    outlinePinnedToBottomRef.current = isScrolledNearBottom(outlineList)
    setVisibleActiveMessageId(effectiveActiveMessageId)
  }, [effectiveActiveMessageId, chatAtBottom, chatBottomSyncVersion, latestOutline?.id, outlineScrollAnchor])

  useLayoutEffect(() => {
    const outlineList = outlineListRef.current
    if (!outlineList) {
      lastOutlineScrollAnchorRef.current = outlineScrollAnchor
      return
    }

    if (!outlinePinnedToBottomRef.current) {
      lastOutlineScrollAnchorRef.current = outlineScrollAnchor
      return
    }

    outlineList.scrollTop = outlineList.scrollHeight
    lastOutlineScrollAnchorRef.current = outlineScrollAnchor
  }, [outlineScrollAnchor])

  function handleOutlineScroll(event: UIEvent<HTMLOListElement>) {
    outlinePinnedToBottomRef.current = isScrolledNearBottom(event.currentTarget)
  }

  function setOutlineButtonElement(messageId: string, element: HTMLButtonElement | null) {
    if (element) {
      outlineButtonRefs.current.set(messageId, element)
      return
    }

    outlineButtonRefs.current.delete(messageId)
  }

  if (outlines.length === 0) {
    return (
      <p className="empty-state compact">
        <i className="ri-list-check-2" aria-hidden="true" />
        No user messages yet.
      </p>
    )
  }

  return (
    <ol className="outline-list" ref={outlineListRef} onScroll={handleOutlineScroll} data-testid="outline-list">
      {outlines.map((message) => {
        const active = message.id === visibleActiveMessageId
        return (
          <li key={message.id} className="outline-item">
            <button
              ref={(element) => setOutlineButtonElement(message.id, element)}
              type="button"
              className={`outline-button ${active ? 'active' : ''}`}
              onClick={() => onSelect(message.id)}
              aria-current={active ? 'true' : undefined}
              title={getMessageOutlineText(message.content, 160)}
            >
              <span className="outline-text">{getMessageOutlineText(message.content, 72)}</span>
              <span className="outline-time">{formatMessageTime(message.createdAtIso)}</span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function FileCard({
  fileName,
  snapshot,
  onPreview,
}: {
  fileName: ProtocolTextFile
  snapshot: Snapshot | null
  onPreview: (fileName: ProtocolTextFile) => void
}) {
  const meta = snapshot?.files[fileName]
  const exists = Boolean(snapshot && meta?.exists)

  return (
    <button
      type="button"
      className={`file-card protocol-file-card ${exists ? 'exists' : 'missing'}`}
      title={exists && snapshot ? fileMeta(snapshot, fileName) : 'missing'}
      aria-label={`Preview ${fileName}`}
      disabled={!exists}
      onClick={() => onPreview(fileName)}
    >
      <div className="file-icon" aria-hidden="true">
        <i className={FILE_ICONS[fileName]} />
      </div>
      <div className="file-copy">
        <div className="file-name">{fileName}</div>
        <div className="file-meta">{snapshot && meta?.exists ? fileMeta(snapshot, fileName) : 'missing'}</div>
      </div>
    </button>
  )
}

function AttachmentThumbnail({ attachment }: { attachment: AttachmentMeta }) {
  const [failed, setFailed] = useState(false)
  const imageAttachment = isImageAttachment(attachment)
  const fallbackIcon = failed ? 'ri-file-warning-line' : getAttachmentIcon(attachment)

  if (!imageAttachment || failed) {
    return (
      <span className={`attachment-thumb fallback attachment-kind-${getAttachmentKind(attachment)}`} aria-hidden="true">
        <i className={fallbackIcon} />
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
  deletingAttachmentNames,
  onPreview,
  onMention,
  onDelete,
}: {
  attachments: AttachmentMeta[]
  deletingAttachmentNames: string[]
  onPreview: (attachment: AttachmentMeta) => void
  onMention: (name: string) => void
  onDelete: (attachment: AttachmentMeta) => void
}) {
  if (attachments.length === 0) {
    return (
      <p className="empty-state compact">
        <i className="ri-attachment-2" aria-hidden="true" />
        No attachments yet.
      </p>
    )
  }

  return (
    <ul className="attachment-list">
      {attachments.map((attachment) => {
        const deleting = deletingAttachmentNames.includes(attachment.name)
        return (
          <li
            key={attachment.name}
            className={`file-card attachment-card exists ${deleting ? 'deleting' : ''}`}
            aria-busy={deleting || undefined}
          >
            <button
              type="button"
              className="attachment-thumb-button"
              onClick={() => onPreview(attachment)}
              aria-label={`Preview thumbnail ${attachment.name}`}
              title={`Preview thumbnail ${attachment.name}`}
              disabled={deleting}
            >
              <AttachmentThumbnail attachment={attachment} />
            </button>
            <div className="file-copy">
              <button
                type="button"
                className="file-name attachment-preview-button"
                onClick={() => onPreview(attachment)}
                aria-label={`Preview ${attachment.name}`}
                title={`Preview ${attachment.name}`}
                disabled={deleting}
              >
                {attachment.name}
              </button>
              <div className="file-meta">{deleting ? 'deleting...' : formatAttachmentMeta(attachment)}</div>
            </div>
            <button
              type="button"
              className="attachment-mention-button"
              onClick={() => onMention(attachment.name)}
              disabled={deleting}
              aria-label={`Add attachment mention ${attachment.name}`}
              title={`Add mention ${attachment.name}`}
            >
              <i className="ri-at-line" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="attachment-delete-button"
              onClick={() => onDelete(attachment)}
              disabled={deleting}
              aria-label={`Delete attachment ${attachment.name}`}
              title={`Delete ${attachment.name}`}
            >
              <i className={deleting ? 'ri-loader-4-line' : 'ri-delete-bin-6-line'} aria-hidden="true" />
            </button>
            {deleting && (
              <span
                className="attachment-delete-progress"
                role="progressbar"
                aria-label={`Deleting ${attachment.name}`}
              >
                <span />
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ConfirmDialog({
  dialog,
  onResolve,
}: {
  dialog: ConfirmDialogState
  onResolve: (confirmed: boolean) => void
}) {
  const tone = dialog.tone ?? 'default'
  const messageParagraphs = dialog.message.split(/\n{2,}/)
  useEscapeToClose(() => onResolve(false))

  return (
    <div className="preview-backdrop confirm-backdrop" role="presentation" onClick={() => onResolve(false)}>
      <section
        className={`confirm-dialog ${tone === 'danger' ? 'danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-icon" aria-hidden="true">
          <i className={tone === 'danger' ? 'ri-error-warning-line' : 'ri-question-line'} />
        </div>
        <div className="confirm-copy">
          <h2>{dialog.title}</h2>
          {messageParagraphs.map((paragraph, index) => (
            <p key={`${paragraph}-${index}`}>{paragraph}</p>
          ))}
        </div>
        <div className="confirm-actions">
          <button type="button" className="confirm-button secondary" onClick={() => onResolve(false)}>
            {dialog.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={`confirm-button ${tone === 'danger' ? 'danger' : 'primary'}`}
            onClick={() => onResolve(true)}
            autoFocus
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

function CtrlEnterSendDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: (dontShowAgain: boolean) => void
}) {
  const [dontShowAgain, setDontShowAgain] = useState(false)
  useEscapeToClose(onCancel)

  return (
    <div className="preview-backdrop confirm-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="confirm-dialog shortcut-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Send with Ctrl Enter"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shortcut-key-row" aria-hidden="true">
          <kbd>Ctrl</kbd>
          <span>+</span>
          <kbd>Enter</kbd>
        </div>
        <div className="confirm-copy">
          <h2>Send with Ctrl+Enter?</h2>
          <p>This shortcut will send now, or queue the message while Codex is working.</p>
        </div>
        <div className="shortcut-confirm-footer">
          <label className="confirm-checkbox">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => setDontShowAgain(event.target.checked)}
            />
            <span>Do not show again</span>
          </label>
          <div className="confirm-actions">
            <button type="button" className="confirm-button secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="confirm-button primary"
              onClick={() => onConfirm(dontShowAgain)}
              autoFocus
            >
              Send
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

function SettingsDialog({
  confirmCtrlEnterSend,
  onConfirmCtrlEnterSendChange,
  onClose,
}: {
  confirmCtrlEnterSend: boolean
  onConfirmCtrlEnterSendChange: (enabled: boolean) => void
  onClose: () => void
}) {
  useEscapeToClose(onClose)

  return (
    <div className="preview-backdrop settings-backdrop" role="presentation" onClick={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div>
            <span className="label-super">Settings</span>
            <h2>Preferences</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close settings" autoFocus>
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </header>
        <div className="settings-list">
          <label className="settings-row">
            <span className="settings-row-icon" aria-hidden="true">
              <i className="ri-keyboard-line" />
            </span>
            <span className="settings-row-copy">
              <span>Confirm Ctrl+Enter send</span>
              <small>Warn before sending or queueing from the composer.</small>
            </span>
            <input
              type="checkbox"
              checked={confirmCtrlEnterSend}
              onChange={(event) => onConfirmCtrlEnterSendChange(event.target.checked)}
              aria-label="Confirm Ctrl Enter send"
            />
          </label>
        </div>
      </section>
    </div>
  )
}

function ConversationUsageStrip({ usage }: { usage: CodexLiveContextUsage }) {
  const contextPercent = Math.max(0, Math.min(100, usage.percentUsed))
  const rateLimits = codexRateLimitGauges(usage)
  const columnCount = Math.min(3, Math.max(1, rateLimits.length + 1))

  return (
    <section
      className={`conversation-usage conversation-usage-columns-${columnCount}`}
      aria-label="Conversation usage limits"
    >
      <div className="conversation-context-limit" aria-label="Conversation context limit">
        <div className="conversation-context-copy">
          <div className="conversation-usage-heading">
            <span>Context</span>
            <strong>{formatPercent(contextPercent)}</strong>
          </div>
          <div className="conversation-context-track" aria-hidden="true">
            <span className="liquid-bar" style={{ width: `${contextPercent}%`, animationDuration: '2.5s' }} />
          </div>
          <small>{formatTokenCount(usage.usedTokens)}/{formatTokenCount(usage.contextWindow)}</small>
        </div>
      </div>

      {rateLimits.map((limit) => (
        <div className="conversation-rate-limit" key={limit.key}>
          <div className="conversation-usage-heading">
            <span>{limit.label}</span>
            <strong>{limit.value}</strong>
          </div>
          <div className="conversation-rate-track" aria-hidden="true">
            <span
              className="liquid-bar"
              style={{ width: `${Math.max(0, Math.min(100, limit.percent))}%`, animationDuration: '2.5s' }}
            />
          </div>
          {limit.detail && <small>{limit.detail}</small>}
        </div>
      ))}
    </section>
  )
}

function findCodexLiveSessionForRun(sessions: CodexLiveSessionSummary[], runId: string) {
  const normalizedRunId = runId.trim()
  if (!normalizedRunId) return null
  return sessions.find((session) =>
    session.fileName === normalizedRunId
    || session.fileName === `${normalizedRunId}.jsonl`
    || session.fileName.endsWith(`-${normalizedRunId}.jsonl`),
  ) ?? null
}

function isCodexRolloutRunId(runId: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId.trim())
}

function codexRateLimitGauges(usage: CodexLiveContextUsage) {
  const primaryLimit = usage.rateLimits?.primary ?? null
  const secondaryLimit = usage.rateLimits?.secondary ?? null
  return [
    primaryLimit && {
      key: 'primary',
      label: formatLimitName(primaryLimit, '5h'),
      percent: primaryLimit.usedPercent,
      value: `${formatPercent(primaryLimit.remainingPercent)} left`,
      detail: formatResetDateTime(primaryLimit.resetsAtIso),
    },
    secondaryLimit && {
      key: 'secondary',
      label: formatLimitName(secondaryLimit, 'Weekly'),
      percent: secondaryLimit.usedPercent,
      value: `${formatPercent(secondaryLimit.remainingPercent)} left`,
      detail: formatResetDateTime(secondaryLimit.resetsAtIso),
    },
  ].filter(Boolean) as Array<{ key: string; label: string; percent: number; value: string; detail: string }>
}

function formatTokenCount(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(Math.round(value))
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return '0%'
  return `${Math.round(Math.max(0, Math.min(100, value)))}%`
}

function formatLimitName(limit: CodexLiveRateLimitWindow, fallback: string) {
  if (limit.windowMinutes === 300) return '5h'
  if (limit.windowMinutes === 10_080) return 'Weekly'
  return formatWindowMinutes(limit.windowMinutes) || fallback
}

function formatWindowMinutes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value % 10_080 === 0) return `${value / 10_080}w limit`
  if (value % 1_440 === 0) return `${value / 1_440}d limit`
  if (value % 60 === 0) return `${value / 60}h limit`
  return `${Math.round(value)}m limit`
}

function formatResetDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return dateFormatter.format(date)
}

function ProtocolFilePreviewDialog({
  preview,
  onClose,
}: {
  preview: ProtocolFilePreview
  onClose: () => void
}) {
  const [wrapContent, setWrapContent] = useState(true)
  const [copied, setCopied] = useState(false)
  const content = preview.content || ''
  const lines = content.replace(/\r\n/g, '\n').split('\n')
  const language = detectViewerLanguage(preview.fileName, content)
  const canCopy = !preview.loading && !preview.error && content.length > 0

  useEscapeToClose(onClose)

  async function copyContent() {
    if (!canCopy) {
      return
    }

    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="preview-backdrop document-preview-backdrop" role="presentation" onClick={onClose}>
      <section
        className="document-preview"
        role="dialog"
        aria-modal="true"
        aria-label={preview.fileName}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="preview-header document-preview-header">
          <div className="preview-title">
            <span>
              <i className={FILE_ICONS[preview.fileName]} aria-hidden="true" />
              {preview.fileName}
            </span>
            <small>
              {preview.size === null ? 'Loading file' : formatBytes(preview.size)}
              {preview.truncated ? ' - truncated preview' : ''}
            </small>
          </div>
          <div className="preview-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setWrapContent((value) => !value)}
              aria-label={wrapContent ? 'Disable wrap' : 'Wrap content'}
              title={wrapContent ? 'Disable wrap' : 'Wrap content'}
              disabled={preview.loading}
            >
              <i className={wrapContent ? 'ri-text-wrap' : 'ri-text'} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`icon-btn ${copied ? 'is-copied' : ''}`}
              onClick={() => void copyContent()}
              aria-label="Copy file content"
              title="Copy file content"
              disabled={!canCopy}
            >
              <i className={copied ? 'ri-check-line' : 'ri-clipboard-line'} aria-hidden="true" />
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview" autoFocus>
              <i className="ri-close-line" aria-hidden="true" />
            </button>
          </div>
        </div>

        {preview.loading ? (
          <div className="document-preview-state">
            <i className="ri-loader-4-line" aria-hidden="true" />
            Loading file preview...
          </div>
        ) : preview.error ? (
          <div className="document-preview-state error-message" role="alert">
            <i className="ri-error-warning-line" aria-hidden="true" />
            <span>{preview.error}</span>
          </div>
        ) : (
          <>
            {preview.truncated && (
              <div className="document-warning">
                <i className="ri-alert-line" aria-hidden="true" />
                Rendering the first {formatBytes(content.length)} of {formatBytes(preview.size ?? content.length)}.
              </div>
            )}
            <div className={`document-viewer language-${language} ${wrapContent ? 'is-wrapped' : ''}`}>
              {lines.map((line, index) => (
                <div className="document-row" key={index}>
                  <span className="document-line-number">
                    {index + 1}
                  </span>
                  <pre className="document-code"><code>{highlightViewerLine(line, language)}</code></pre>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function AttachmentPreview({
  attachment,
  attachments,
  onSelect,
  onClose,
}: {
  attachment: AttachmentMeta
  attachments: AttachmentMeta[]
  onSelect: (attachment: AttachmentMeta) => void
  onClose: () => void
}) {
  useEscapeToClose(onClose)
  const currentIndex = attachments.findIndex((item) => item.url === attachment.url)
  const showGalleryControls = attachments.length > 1 && currentIndex >= 0
  const attachmentKind = getAttachmentKind(attachment)
  const imageAttachment = attachmentKind === 'image'
  const videoAttachment = attachmentKind === 'video'
  const audioAttachment = attachmentKind === 'audio'
  const inlinePreview = canInlinePreviewAttachment(attachment)
  const previewClassName = [
    'attachment-preview',
    `attachment-${attachmentKind}-preview`,
    showGalleryControls ? 'has-gallery-controls' : '',
  ].filter(Boolean).join(' ')

  function selectRelativeAttachment(offset: number) {
    if (!showGalleryControls) {
      return
    }

    const nextIndex = (currentIndex + offset + attachments.length) % attachments.length
    onSelect(attachments[nextIndex])
  }

  function closeFromEmptyPreviewArea(event: SyntheticEvent<HTMLElement>) {
    event.stopPropagation()
    onClose()
  }

  function keepPreviewOpen(event: SyntheticEvent<HTMLElement>) {
    event.stopPropagation()
  }

  return (
    <div className="preview-backdrop" role="presentation" onClick={onClose}>
      <section
        className={previewClassName}
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
        onClick={closeFromEmptyPreviewArea}
      >
        <div className="preview-header" onClick={keepPreviewOpen}>
          <div className="preview-title">
            <span>{attachment.name}</span>
            <small>{formatBytes(attachment.size)}</small>
          </div>
          <div className="preview-actions">
            <a href={attachment.url} target="_blank" rel="noreferrer" className="icon-btn" aria-label="Open file" title="Open file">
              <i className="ri-external-link-line" aria-hidden="true" />
            </a>
            <a href={attachment.url} download={attachment.name} className="icon-btn" aria-label="Download file" title="Download file">
              <i className="ri-download-line" aria-hidden="true" />
            </a>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview" autoFocus>
              <i className="ri-close-line" aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className={`attachment-preview-main ${showGalleryControls ? 'has-gallery-controls' : ''}`}>
          {showGalleryControls && (
            <button
              type="button"
              className="attachment-preview-nav previous"
              onClick={(event) => {
                event.stopPropagation()
                selectRelativeAttachment(-1)
              }}
              aria-label="Previous attachment"
              title="Previous attachment"
            >
              <i className="ri-arrow-left-s-line" aria-hidden="true" />
            </button>
          )}
          <div className="preview-stage" onClick={keepPreviewOpen}>
            {imageAttachment ? (
              <img src={attachment.url} alt={attachment.name} />
            ) : videoAttachment ? (
              <video src={attachment.url} controls playsInline preload="metadata" />
            ) : audioAttachment ? (
              <audio src={attachment.url} controls preload="metadata" />
            ) : inlinePreview ? (
              <iframe src={attachment.url} title={`Preview ${attachment.name}`} />
            ) : (
              <div className="attachment-file-preview">
                <span className={`attachment-file-icon attachment-kind-${attachmentKind}`} aria-hidden="true">
                  <i className={getAttachmentIcon(attachment)} />
                </span>
                <div className="attachment-file-details">
                  <strong>{getAttachmentKindLabel(attachment)}</strong>
                  <span>{formatBytes(attachment.size)}</span>
                </div>
                <div className="attachment-file-actions">
                  <a href={attachment.url} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <a href={attachment.url} download={attachment.name}>
                    Download
                  </a>
                </div>
              </div>
            )}
          </div>
          {showGalleryControls && (
            <button
              type="button"
              className="attachment-preview-nav next"
              onClick={(event) => {
                event.stopPropagation()
                selectRelativeAttachment(1)
              }}
              aria-label="Next attachment"
              title="Next attachment"
            >
              <i className="ri-arrow-right-s-line" aria-hidden="true" />
            </button>
          )}
        </div>
        {showGalleryControls && (
          <div className="attachment-preview-strip" aria-label="Attachment list" onClick={keepPreviewOpen}>
            {attachments.map((item, index) => {
              const active = item.url === attachment.url
              return (
                <button
                  type="button"
                  className={`attachment-preview-strip-item ${active ? 'active' : ''}`}
                  onClick={() => onSelect(item)}
                  aria-label={`Preview attachment ${index + 1}: ${item.name}`}
                  aria-current={active ? 'true' : undefined}
                  title={item.name}
                  key={item.url}
                >
                  <AttachmentThumbnail attachment={item} />
                  <span className="attachment-preview-strip-label">{item.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

function EmptyInbox({ managerSnapshot }: { managerSnapshot: ManagerSnapshot | null }) {
  return (
    <article className="message empty-message" aria-label="Empty inbox">
      <ProfileAvatar type="bot" />
      <div className="message-content">
        <span className="label-super">Inbox</span>
        <div className="empty-state large">
          <h2>No Codex runs found</h2>
          <p>
            Start a Codex session with Codex Pro Max, or create a run folder under{' '}
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
      <ProfileAvatar type="bot" />
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

function statusClassName(status: ProtocolStatus) {
  return `status-${status.toLowerCase().replaceAll('_', '-')}`
}

function fileMeta(snapshot: Snapshot, fileName: ProtocolTextFile): string {
  const meta = snapshot.files[fileName]
  if (!meta.exists || !meta.mtimeIso || meta.size === null) {
    return 'missing'
  }

  return `${formatBytes(meta.size)} - ${dateFormatter.format(new Date(meta.mtimeIso))}`
}

function detectViewerLanguage(title: string, content: string): 'json' | 'markdown' | 'text' {
  const label = `${title} ${content.slice(0, 120)}`.toLowerCase()
  if (/json|payload|data|ndjson/.test(label)) {
    return 'json'
  }
  if (/^\s*[\[{]/.test(content)) {
    return 'json'
  }
  if (/(^\s*#|\n\s*[-*]\s+|\n\s*\d+\.\s+|^\s*>|\*\*[^*]+\*\*)/.test(content)) {
    return 'markdown'
  }
  return 'text'
}

function highlightViewerLine(line: string, language: 'json' | 'markdown' | 'text') {
  if (language === 'json') return highlightJsonLine(line)
  if (language === 'markdown') return highlightMarkdownLine(line)
  return highlightTextLine(line)
}

function highlightJsonLine(line: string) {
  const nodes: ReactNode[] = []
  const pattern = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|[{}\[\],:]/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(line))) {
    if (match.index > lastIndex) nodes.push(line.slice(lastIndex, match.index))
    const value = match[0]
    const className = match[1]
      ? 'viewer-token property'
      : match[2]
        ? 'viewer-token string'
        : /^(true|false|null)$/i.test(value)
          ? 'viewer-token boolean'
          : /^-?\d/.test(value)
            ? 'viewer-token number'
            : 'viewer-token punctuation'
    nodes.push(<span className={className} key={`${match.index}-${value}`}>{value}</span>)
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex))
  return nodes.length ? nodes : line
}

function highlightMarkdownLine(line: string) {
  if (/^#{1,6}\s+/.test(line)) {
    return <span className="viewer-token heading">{line}</span>
  }
  if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
    return <span className="viewer-token list">{line}</span>
  }
  return highlightTextLine(line)
}

function highlightTextLine(line: string) {
  const nodes: ReactNode[] = []
  const pattern = /(https?:\/\/[^\s)]+)|\b(error|failed|failure|success|completed|running|warning|true|false|null|waiting_for_review|instruction_received|blocked)\b/gi
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(line))) {
    if (match.index > lastIndex) nodes.push(line.slice(lastIndex, match.index))
    const value = match[0]
    nodes.push(
      <span className={/^https?:/i.test(value) ? 'viewer-token url' : 'viewer-token keyword'} key={`${match.index}-${value}`}>
        {value}
      </span>,
    )
    lastIndex = pattern.lastIndex
  }

  if (lastIndex < line.length) nodes.push(line.slice(lastIndex))
  return nodes.length ? nodes : line
}

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return dateFormatter.format(date)
}

function getMessageOutlineText(content: string, maxLength: number): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return 'Empty message'
  }

  if (normalized.length <= maxLength) {
    return normalized
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
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
