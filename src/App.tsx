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
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  type UIEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import {
  clearConversationHistory as clearConversationHistoryRequest,
  deleteAttachment as deleteAttachmentRequest,
  deleteRun as deleteRunRequest,
  fetchProtocolFile,
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
import { PROTOCOL_TEXT_FILES } from './shared/protocol'

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

const PROFILE_MENU_ITEMS = [
  { label: 'Add teammates', icon: 'ri-group-line' },
  { label: 'Workspace settings', icon: 'ri-building-2-line' },
  { label: 'Skills', icon: 'ri-box-3-line' },
  { label: 'Personalization', icon: 'ri-sparkling-2-line' },
  { label: 'Settings', icon: 'ri-settings-3-line' },
  { label: 'Help', icon: 'ri-question-line', separated: true, chevron: true },
  { label: 'Log out', icon: 'ri-logout-box-r-line', chevron: true },
]

const RUN_STATUS_ICONS: Record<ProtocolStatus, string> = {
  RUNNING: 'ri-loader-4-line',
  WAITING_FOR_REVIEW: 'ri-question-answer-line',
  INSTRUCTION_RECEIVED: 'ri-inbox-archive-line',
  BLOCKED: 'ri-forbid-2-line',
  ERROR: 'ri-error-warning-line',
}

const CHAT_BOTTOM_THRESHOLD_PX = 12
const USER_BUBBLE_TOP_ZONE_PX = 160
const USER_BUBBLE_TOP_TOLERANCE_PX = 24
const COMPOSER_TEXTAREA_MIN_HEIGHT_PX = 44
const COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 180
const CODEX_PROFILE_IMAGE = '/codex-color.png'
const USER_PROFILE_IMAGE = '/burger.png'
const RESPONSE_SHUFFLE_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+-=<>?'
const LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY = 'codex-pro-max:left-sidebar-collapsed'
const RIGHT_SIDEBAR_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-collapsed'
const OUTLINES_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-outlines-collapsed'
const PROTOCOL_FILES_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-protocol-files-collapsed:v2'
const ATTACHMENTS_COLLAPSED_STORAGE_KEY = 'codex-pro-max:right-sidebar-attachments-collapsed'

type PendingAction = 'send' | 'upload' | 'load' | 'clear' | 'stop'
type MentionRange = { start: number; end: number; query: string }
type ScrollDirection = 'up' | 'down' | 'none'
type UserMessageOutline = Pick<ChatMessage, 'id' | 'content' | 'createdAtIso'>
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
  const [draftAttachmentNames, setDraftAttachmentNames] = useState<string[]>([])
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null)
  const [deletingAttachmentNames, setDeletingAttachmentNames] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(() =>
    readStoredBoolean(LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY, false),
  )
  const [rightCollapsed, setRightCollapsed] = useState(() =>
    readStoredBoolean(RIGHT_SIDEBAR_COLLAPSED_STORAGE_KEY, false),
  )
  const [attachmentDragDepth, setAttachmentDragDepth] = useState(0)
  const [chatAtBottom, setChatAtBottom] = useState(true)
  const [activeUserMessageId, setActiveUserMessageId] = useState<string | null>(null)
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentMeta | null>(null)
  const [previewProtocolFile, setPreviewProtocolFile] = useState<ProtocolFilePreview | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const chatPinnedToBottomRef = useRef(true)
  const lastChatScrollTopRef = useRef(0)
  const activeMessageFrameRef = useRef<number | null>(null)
  const activeMessageScrollElementRef = useRef<HTMLDivElement | null>(null)
  const smoothScrollReleaseTimerRef = useRef<number | null>(null)
  const userMessageRefs = useRef(new Map<string, HTMLElement>())
  const revealedAssistantMessageIdsRef = useRef(new Set<string>())
  const loadedRunIdRef = useRef<string | null>(null)

  const markAssistantRevealComplete = useCallback((messageId: string) => {
    revealedAssistantMessageIdsRef.current.add(messageId)
  }, [])

  const markAssistantMessagesRevealed = useCallback((messages: ChatMessage[]) => {
    for (const message of messages) {
      if (message.role === 'assistant') {
        revealedAssistantMessageIdsRef.current.add(message.id)
      }
    }
  }, [])

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
      loadedRunIdRef.current = null
      return
    }

    let ignore = false
    setPending((value) => value ?? 'load')
    setActionError(null)

    fetchRunSnapshot(selectedRunId)
      .then((nextSnapshot) => {
        if (!ignore) {
          if (loadedRunIdRef.current !== nextSnapshot.runId) {
            markAssistantMessagesRevealed(nextSnapshot.messages)
            loadedRunIdRef.current = nextSnapshot.runId
          }
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
  }, [markAssistantMessagesRevealed, selectedRunId, managerSnapshot?.health.serverTimeIso])

  useEffect(() => {
    writeStoredBoolean(LEFT_SIDEBAR_COLLAPSED_STORAGE_KEY, leftCollapsed)
  }, [leftCollapsed])

  useEffect(() => {
    writeStoredBoolean(RIGHT_SIDEBAR_COLLAPSED_STORAGE_KEY, rightCollapsed)
  }, [rightCollapsed])

  useEffect(() => {
    return () => {
      if (activeMessageFrameRef.current !== null) {
        window.cancelAnimationFrame(activeMessageFrameRef.current)
      }
      clearSmoothScrollReleaseTimer()
    }
  }, [])

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

    if (status !== 'WAITING_FOR_REVIEW') {
      setActionError('Stop is only available while the run is waiting for review.')
      return
    }

    const runLabel = selectedRun?.displayName ?? runSnapshot?.displayName ?? selectedRunId
    const confirmed = window.confirm(
      `Stop Codex for "${runLabel}"?\n\nThis sends a stop instruction through the current session.`,
    )
    if (!confirmed) {
      return
    }

    const confirmedAgain = window.confirm(
      `Confirm stop for "${runLabel}"?\n\nCodex will receive the canonical stop instruction for this run.`,
    )
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

    const confirmed = window.confirm(`Delete all ${attachments.length} attachments?`)
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

    const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'))
    if (!file) {
      setActionError('Only image attachments are supported.')
      return
    }

    void handleUpload(file)
  }

  function handleChatScroll(event: UIEvent<HTMLDivElement>) {
    const atBottom = isScrolledNearBottom(event.currentTarget)
    if (smoothScrollReleaseTimerRef.current !== null && !atBottom) {
      chatPinnedToBottomRef.current = true
      setChatAtBottom(true)
      scheduleActiveUserMessageUpdate(event.currentTarget)
      return
    }

    if (atBottom) {
      clearSmoothScrollReleaseTimer()
    }

    chatPinnedToBottomRef.current = atBottom
    setChatAtBottom(atBottom)
    scheduleActiveUserMessageUpdate(event.currentTarget)
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

  const status: ProtocolStatus = runSnapshot?.status ?? selectedRun?.status ?? 'RUNNING'
  const aiWorking = isCodexWorking(status)
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
  const hasSessionHistoryFile = Boolean(runSnapshot?.files['session.md']?.exists)
  const lastChatMessage = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null
  const chatScrollAnchor = [
    runSnapshot?.runId ?? selectedRunId ?? 'none',
    chatMessages.length,
    lastChatMessage?.id ?? 'none',
    lastChatMessage?.createdAtIso ?? 'none',
    lastChatMessage?.content.length ?? 0,
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
    revealedAssistantMessageIdsRef.current.clear()
    loadedRunIdRef.current = null
    setChatAtBottom(true)
    setActiveUserMessageId(null)
  }, [selectedRunId])

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
  const canSendInstruction =
    Boolean(selectedRunId) && instruction.trim().length > 0 && !busy && status === 'WAITING_FOR_REVIEW'
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
    const latestUserMessageId = userMessageOutlines[userMessageOutlines.length - 1]?.id ?? null
    const scrollDirection: ScrollDirection =
      scrollTop < lastChatScrollTopRef.current
        ? 'up'
        : scrollTop > lastChatScrollTopRef.current
          ? 'down'
          : 'none'
    lastChatScrollTopRef.current = scrollTop
    if (isScrolledNearBottom(scrollElement)) {
      setActiveUserMessageId((currentId) => (currentId === latestUserMessageId ? currentId : latestUserMessageId))
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
        setActiveUserMessageId(null)
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
      setActiveUserMessageId(null)
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
  }

  function scrollChatToBottom(behavior: ScrollBehavior = 'auto') {
    const scrollElement = chatScrollRef.current
    if (!scrollElement) {
      return
    }

    if (behavior === 'smooth' && typeof scrollElement.scrollTo === 'function') {
      clearSmoothScrollReleaseTimer()
      smoothScrollReleaseTimerRef.current = window.setTimeout(() => {
        smoothScrollReleaseTimerRef.current = null
        const currentScrollElement = chatScrollRef.current
        if (!currentScrollElement) {
          return
        }

        const atBottom = isScrolledNearBottom(currentScrollElement)
        chatPinnedToBottomRef.current = atBottom
        setChatAtBottom(atBottom)
        if (atBottom) {
          updateActiveUserMessage(currentScrollElement)
        }
      }, 900)
      scrollElement.scrollTo({
        top: scrollElement.scrollHeight,
        behavior,
      })
    } else {
      clearSmoothScrollReleaseTimer()
      scrollElement.scrollTop = scrollElement.scrollHeight
    }

    chatPinnedToBottomRef.current = true
    setChatAtBottom(true)
    updateActiveUserMessage(scrollElement)
  }

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

        <div className="chat-scroll" ref={chatScrollRef} onScroll={handleChatScroll} data-testid="chat-scroll">
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
                    animateReveal={
                      message.role === 'assistant'
                      && message.id === lastChatMessage?.id
                      && !revealedAssistantMessageIdsRef.current.has(message.id)
                      && pending !== 'load'
                    }
                    onAssistantRevealComplete={markAssistantRevealComplete}
                    messageRef={
                      message.role === 'user'
                        ? (element) => setUserMessageElement(message.id, element)
                        : undefined
                    }
                  />
                  {aiWorking && index === chatMessages.length - 1 && message.role === 'user' && (
                    <AiLoadingMessage />
                  )}
                </Fragment>
              ))
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
          canSend={canSendInstruction}
          codexRunning={aiWorking}
          onSend={() => void sendInstruction()}
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
        onUserMessageSelect={jumpToUserMessage}
      />

      {previewAttachment && (
        <AttachmentPreview attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
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
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
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

        <div className="sidebar-profile-area" ref={profileAreaRef}>
          {profileMenuOpen && (
            <div className="profile-menu" role="menu" aria-label="Profile menu">
              <button type="button" className="profile-menu-account" role="menuitem">
                <span className="profile-menu-avatar">
                  <img src={USER_PROFILE_IMAGE} alt="" />
                </span>
                <span className="profile-menu-account-copy">
                  <span>Ramlyburger</span>
                  <span>Business</span>
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
                    onClick={() => setProfileMenuOpen(false)}
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
            onClick={() => setProfileMenuOpen((value) => !value)}
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
              <span>Business</span>
            </span>
            <i className="ri-more-2-fill sidebar-profile-more" aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
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
  animateReveal = false,
  onAssistantRevealComplete,
  messageRef,
}: {
  message: ChatMessage
  attachments: AttachmentMeta[]
  onAttachmentPreview: (attachment: AttachmentMeta) => void
  animateReveal?: boolean
  onAssistantRevealComplete?: (messageId: string) => void
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
          {!isUser && animateReveal ? (
            <ShuffledMarkdownReveal
              messageId={message.id}
              markdown={message.content}
              onRevealComplete={onAssistantRevealComplete}
            />
          ) : (
            <MarkdownPanel
              markdown={message.content}
              safety={null}
              emptyIcon={isUser ? 'ri-user-3-line' : 'ri-file-paper-2-line'}
              emptyText={isUser ? 'Empty message.' : 'No output draft yet.'}
            />
          )}
        </div>
      </div>

      {isUser && (
        <ProfileAvatar type="user" />
      )}
    </article>
  )
}, (previousProps, nextProps) =>
  previousProps.message === nextProps.message
  && previousProps.attachments === nextProps.attachments
  && previousProps.animateReveal === nextProps.animateReveal)

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

const MarkdownPanel = memo(function MarkdownPanel({
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
})

function ShuffledMarkdownReveal({
  messageId,
  markdown,
  onRevealComplete,
}: {
  messageId: string
  markdown: string
  onRevealComplete?: (messageId: string) => void
}) {
  const [displayText, setDisplayText] = useState(() => createShuffledResponse(markdown, 0))
  const [complete, setComplete] = useState(false)

  useEffect(() => {
    if (!markdown.trim() || prefersReducedMotion()) {
      setDisplayText(markdown)
      setComplete(true)
      onRevealComplete?.(messageId)
      return
    }

    setComplete(false)
    setDisplayText(createShuffledResponse(markdown, 0))

    let frame = 0
    const totalFrames = Math.min(34, Math.max(20, Math.ceil(markdown.length / 80)))
    const timer = window.setInterval(() => {
      frame += 1
      const revealedCharacters = Math.floor((markdown.length * frame) / totalFrames)

      if (frame >= totalFrames) {
        window.clearInterval(timer)
        setDisplayText(markdown)
        setComplete(true)
        onRevealComplete?.(messageId)
        return
      }

      setDisplayText(createShuffledResponse(markdown, revealedCharacters))
    }, 40)

    return () => window.clearInterval(timer)
  }, [markdown, messageId, onRevealComplete])

  if (complete) {
    return (
      <MarkdownPanel
        markdown={markdown}
        safety={null}
        emptyIcon="ri-file-paper-2-line"
        emptyText="No output draft yet."
      />
    )
  }

  return (
    <div className="prose markdown-body response-shuffle" aria-label="Codex response is resolving">
      {displayText}
    </div>
  )
}

function createShuffledResponse(value: string, revealedCharacters: number): string {
  let output = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (index < revealedCharacters || /\s/.test(character)) {
      output += character
      continue
    }

    const shuffleIndex = Math.floor(Math.random() * RESPONSE_SHUFFLE_CHARACTERS.length)
    output += RESPONSE_SHUFFLE_CHARACTERS[shuffleIndex]
  }
  return output
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
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
  codexRunning,
  onSend,
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
  canSend: boolean
  codexRunning: boolean
  onSend: () => void
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
    : codexRunning
      ? 'ri-loader-4-line'
      : canSend
        ? 'ri-send-plane-fill'
        : 'ri-send-plane-line'
  const sendLabel = pending === 'send'
    ? 'Sending...'
    : codexRunning
      ? 'Codex is running'
      : 'Send to Codex'

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
    const trailing = end < value.length && !/\s/.test(value[end]) ? ' ' : ''
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
          className={`send-btn ${codexRunning ? 'running' : ''}`}
          disabled={!canSend}
          onClick={onSend}
          title={sendLabel}
        >
          <i className={sendIcon} aria-hidden="true" />
          <span className="sr-only">{sendLabel}</span>
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

function getMentionedAttachments(content: string, attachments: AttachmentMeta[]): AttachmentMeta[] {
  return attachments.filter((attachment) => hasAttachmentMention(content, attachment.name))
}

function hasAttachmentMention(value: string, attachmentName: string): boolean {
  const mention = `@${attachmentName}`
  return new RegExp(`(^|\\s)${escapeRegExp(mention)}(?=\\s|$)`).test(value)
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
  onSelect,
}: {
  outlines: UserMessageOutline[]
  activeMessageId: string | null
  onSelect: (messageId: string) => void
}) {
  const outlineListRef = useRef<HTMLOListElement | null>(null)
  const outlineButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const outlinePinnedToBottomRef = useRef(true)
  const [visibleActiveMessageId, setVisibleActiveMessageId] = useState<string | null>(activeMessageId)
  const latestOutline = outlines.length > 0 ? outlines[outlines.length - 1] : null
  const outlineScrollAnchor = latestOutline ? `${outlines.length}:${latestOutline.id}` : 'empty'
  const lastOutlineScrollAnchorRef = useRef(outlineScrollAnchor)

  useLayoutEffect(() => {
    if (!activeMessageId) {
      setVisibleActiveMessageId(null)
      return
    }

    const outlineList = outlineListRef.current
    const activeButton = outlineButtonRefs.current.get(activeMessageId)
    if (!outlineList || !activeButton) {
      setVisibleActiveMessageId(activeMessageId)
      return
    }

    if (lastOutlineScrollAnchorRef.current !== outlineScrollAnchor) {
      setVisibleActiveMessageId(activeMessageId)
      return
    }

    if (activeMessageId === latestOutline?.id) {
      setVisibleActiveMessageId(activeMessageId)
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
    setVisibleActiveMessageId(activeMessageId)
  }, [activeMessageId, latestOutline?.id])

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
        <i className="ri-image-line" aria-hidden="true" />
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
              <div className="file-meta">{deleting ? 'deleting...' : formatBytes(attachment.size)}</div>
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

  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

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
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close preview">
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
      <ProfileAvatar type="bot" />
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
