import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ClipboardEvent,
  type MutableRefObject,
  type ReactNode,
  type UIEvent,
} from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import PhotoSwipeLightbox from 'photoswipe/lightbox'
import { Toaster, toast } from 'sonner'
import 'katex/dist/katex.min.css'
import 'photoswipe/style.css'
import type {
  AttachmentRecord,
  CodexLiveActivity,
  CodexLiveContextUsage,
  CodexLiveRecord,
  InstructionRecord,
  MessageRecord,
  SessionDetail,
  SessionRecord,
  SessionStatus,
  SessionSummary,
} from '../types'
import {
  attachmentUrl,
  clearConversation,
  deleteAttachment,
  deleteInstruction,
  deleteSession,
  fetchHealth,
  fetchSession,
  fetchSessionUsage,
  fetchSessions,
  sendInstruction,
  stopSession,
  updateInstruction,
  uploadAttachment,
  type HealthResponse,
} from './api'

const SESSION_POLL_MS = 3500
const CHAT_BOTTOM_THRESHOLD_PX = 12
const USER_MESSAGE_TOP_ZONE_PX = 140
const ATTACHMENT_PROGRESS_MIN_MS = 650
const QUEUED_INSTRUCTION_VISIBLE_LIMIT = 5
const LEFT_COLLAPSED_KEY = 'codex-pro-max-next:left-sidebar-collapsed'
const RIGHT_COLLAPSED_KEY = 'codex-pro-max-next:right-sidebar-collapsed'
const OUTLINES_COLLAPSED_KEY = 'codex-pro-max-next:right-outlines-collapsed'
const ATTACHMENTS_COLLAPSED_KEY = 'codex-pro-max-next:right-attachments-collapsed'
const CONFIRM_RUNNING_SEND_KEY = 'codex-pro-max-next:confirm-running-send'
const DRAFT_STORAGE_PREFIX = 'codex-pro-max-next:draft:'

const EMPTY_ACTIVITY: CodexLiveActivity = {
  latestEventAt: null,
  latestRecordType: '',
  hasRolloutActivity: false,
}

const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath]
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex]

type PendingAction =
  | 'refresh'
  | 'send'
  | 'upload'
  | 'clear'
  | 'stop'
  | 'delete-session'
  | 'delete-attachment'
  | 'update-instruction'
  | 'delete-instruction'

type MentionRange = {
  start: number
  end: number
  query: string
}

type ConfirmDialogTone = 'default' | 'danger' | 'warning'

type ConfirmDialogOptions = {
  title: string
  message: string
  confirmLabel: string
  cancelLabel?: string
  tone?: ConfirmDialogTone
  shortcutKeys?: string[]
  dontAskAgainLabel?: string
  onDontAskAgainConfirm?: () => void
}

type ConfirmDialogState = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void
  restoreComposerFocusOnCancel: boolean
}

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [conversationUsage, setConversationUsage] = useState<CodexLiveContextUsage | null>(null)
  const [conversationActivity, setConversationActivity] = useState<CodexLiveActivity>(EMPTY_ACTIVITY)
  const [conversationThinkingRecords, setConversationThinkingRecords] = useState<CodexLiveRecord[]>([])
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uploadingAttachmentName, setUploadingAttachmentName] = useState<string | null>(null)
  const [deletingAttachmentIds, setDeletingAttachmentIds] = useState<string[]>([])
  const [previewAttachment, setPreviewAttachment] = useState<AttachmentRecord | null>(null)
  const [leftCollapsed, setLeftCollapsed] = useState(() => readStoredBoolean(LEFT_COLLAPSED_KEY, false))
  const [rightCollapsed, setRightCollapsed] = useState(() => readStoredBoolean(RIGHT_COLLAPSED_KEY, false))
  const [outlinesCollapsed, setOutlinesCollapsed] = useState(() => readStoredBoolean(OUTLINES_COLLAPSED_KEY, false))
  const [attachmentsCollapsed, setAttachmentsCollapsed] = useState(() => readStoredBoolean(ATTACHMENTS_COLLAPSED_KEY, false))
  const [chatAtBottom, setChatAtBottom] = useState(true)
  const [composerHeight, setComposerHeight] = useState(86)
  const [activeUserMessageId, setActiveUserMessageId] = useState<string | null>(null)
  const [editingInstructionId, setEditingInstructionId] = useState<string | null>(null)
  const [deletingInstructionIds, setDeletingInstructionIds] = useState<string[]>([])
  const [composerFocusSignal, setComposerFocusSignal] = useState(0)
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false)
  const [teammatesOpen, setTeammatesOpen] = useState(false)
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [logoutErrorOpen, setLogoutErrorOpen] = useState(false)
  const [confirmRunningSend, setConfirmRunningSend] = useState(() => readStoredBoolean(CONFIRM_RUNNING_SEND_KEY, true))
  const chatScrollRef = useRef<HTMLElement | null>(null)
  const chatAtBottomRef = useRef(true)
  const skipDraftSaveRef = useRef(false)
  const messageRefs = useRef(new Map<string, HTMLElement>())
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? null,
    [selectedSessionId, sessions],
  )

  const attachments = sessionDetail?.attachments ?? []
  const attachmentSignature = useMemo(
    () => attachments.map((attachment) => attachment.id).join('|'),
    [attachments],
  )
  const queuedInstructions = useMemo(
    () => (sessionDetail?.instructions ?? []).filter((item) => !item.consumedAt),
    [sessionDetail?.instructions],
  )
  const queueLimitReached = queuedInstructions.length >= 10
  const editingInstruction = useMemo(
    () => queuedInstructions.find((item) => item.id === editingInstructionId) ?? null,
    [editingInstructionId, queuedInstructions],
  )
  const userMessages = useMemo(
    () => (sessionDetail?.messages ?? []).filter((message) => message.role === 'user'),
    [sessionDetail?.messages],
  )
  const messageSignature = useMemo(
    () => (sessionDetail?.messages ?? []).map((message) => message.id).join('|'),
    [sessionDetail?.messages],
  )
  const thinkingSignature = useMemo(
    () => codexThinkingSignature(conversationThinkingRecords),
    [conversationThinkingRecords],
  )
  const codexRunning = sessionDetail?.status === 'RUNNING'

  const loadSessions = useCallback(async (options: { keepSelection?: boolean } = {}) => {
    const response = await fetchSessions()
    setSessions((current) => (
      sessionSummariesSignature(current) === sessionSummariesSignature(response.sessions)
        ? current
        : response.sessions
    ))
    setSelectedSessionId((current) => {
      if (options.keepSelection && current && response.sessions.some((session) => session.id === current)) {
        return current
      }
      return response.sessions[0]?.id ?? null
    })
  }, [])

  const loadSelectedSession = useCallback(async (sessionId: string | null) => {
    if (!sessionId) {
      setSessionDetail(null)
      setConversationUsage(null)
      setConversationActivity(EMPTY_ACTIVITY)
      setConversationThinkingRecords([])
      return
    }
    const [response, usageResponse] = await Promise.all([
      fetchSession(sessionId),
      fetchSessionUsage(sessionId).catch(() => ({
        ok: true as const,
        usage: null,
        activity: EMPTY_ACTIVITY,
        thinkingRecords: [],
      })),
    ])
    setSessionDetail((current) => (
      current && sessionDetailSignature(current) === sessionDetailSignature(response.session)
        ? current
        : response.session
    ))
    setConversationUsage((current) => (
      codexUsageSignature(current) === codexUsageSignature(usageResponse.usage)
        ? current
        : usageResponse.usage
    ))
    setConversationActivity((current) => (
      codexActivitySignature(current) === codexActivitySignature(usageResponse.activity)
        ? current
        : usageResponse.activity
    ))
    setConversationThinkingRecords((current) => (
      codexThinkingSignature(current) === codexThinkingSignature(usageResponse.thinkingRecords)
        ? current
        : usageResponse.thinkingRecords
    ))
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = chatScrollRef.current
    if (!element) return
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    })
    chatAtBottomRef.current = true
    setChatAtBottom(true)
  }, [])

  const keepTimelinePinnedToBottom = useCallback(() => {
    scrollToBottom('auto')
  }, [scrollToBottom])

  const requestConfirmation = useCallback((options: ConfirmDialogOptions) =>
    new Promise<boolean>((resolve) => {
      setConfirmDialog({
        ...options,
        resolve,
        restoreComposerFocusOnCancel: isComposerTextareaFocused(),
      })
    }), [])

  const resolveConfirmation = useCallback((confirmed: boolean) => {
    const shouldRestoreComposerFocus = !confirmed && confirmDialog?.restoreComposerFocusOnCancel
    confirmDialog?.resolve(confirmed)
    setConfirmDialog(null)
    if (shouldRestoreComposerFocus) {
      window.requestAnimationFrame(() => setComposerFocusSignal((value) => value + 1))
    }
  }, [confirmDialog])

  const updateActiveUserMessage = useCallback(() => {
    const container = chatScrollRef.current
    if (!container) return

    const containerTop = container.getBoundingClientRect().top
    const userElements = Array.from(container.querySelectorAll<HTMLElement>('[data-message-role="user"]'))
    if (chatAtBottomRef.current && userElements.length > 0) {
      setActiveUserMessageId(userElements[userElements.length - 1].dataset.messageId ?? null)
      return
    }
    let activeId = userElements[0]?.dataset.messageId ?? null

    for (const element of userElements) {
      const offset = element.getBoundingClientRect().top - containerTop
      if (offset <= USER_MESSAGE_TOP_ZONE_PX) {
        activeId = element.dataset.messageId ?? activeId
      }
    }

    setActiveUserMessageId(activeId)
  }, [])

  const setMessageRef = useCallback((messageId: string, node: HTMLElement | null) => {
    if (node) {
      messageRefs.current.set(messageId, node)
      return
    }
    messageRefs.current.delete(messageId)
  }, [])

  function handleTimelineScroll(event: UIEvent<HTMLElement>) {
    const element = event.currentTarget
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    const pinned = distanceFromBottom <= CHAT_BOTTOM_THRESHOLD_PX
    chatAtBottomRef.current = pinned
    setChatAtBottom(pinned)
    updateActiveUserMessage()
  }

  function handleOutlineSelect(messageId: string) {
    const element = messageRefs.current.get(messageId)
    if (!element) return
    element.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setActiveUserMessageId(messageId)
  }

  function handleComposerHeightChange(height: number) {
    setComposerHeight(height)
    if (chatAtBottomRef.current) {
      window.requestAnimationFrame(() => scrollToBottom('auto'))
    }
  }

  useEffect(() => {
    let cancelled = false

    async function loadInitialState() {
      try {
        const [healthResponse, sessionsResponse] = await Promise.all([fetchHealth(), fetchSessions()])
        if (cancelled) return
        setHealth(healthResponse)
        setSessions(sessionsResponse.sessions)
        setSelectedSessionId(sessionsResponse.sessions[0]?.id ?? null)
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load Codex Pro Max.')
        }
      }
    }

    void loadInitialState()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setChatAtBottom(true)
    chatAtBottomRef.current = true
    setActiveUserMessageId(null)
    messageRefs.current.clear()
    setEditingInstructionId(null)
    skipDraftSaveRef.current = true
    setInstruction(readStoredDraft(selectedSessionId))
  }, [selectedSessionId])

  useEffect(() => {
    if (!selectedSessionId || editingInstructionId) return
    if (skipDraftSaveRef.current) {
      skipDraftSaveRef.current = false
      return
    }
    writeStoredDraft(selectedSessionId, instruction)
  }, [editingInstructionId, instruction, selectedSessionId])

  useEffect(() => {
    writeStoredBoolean(LEFT_COLLAPSED_KEY, leftCollapsed)
  }, [leftCollapsed])

  useEffect(() => {
    writeStoredBoolean(RIGHT_COLLAPSED_KEY, rightCollapsed)
  }, [rightCollapsed])

  useEffect(() => {
    writeStoredBoolean(OUTLINES_COLLAPSED_KEY, outlinesCollapsed)
  }, [outlinesCollapsed])

  useEffect(() => {
    writeStoredBoolean(ATTACHMENTS_COLLAPSED_KEY, attachmentsCollapsed)
  }, [attachmentsCollapsed])

  useEffect(() => {
    writeStoredBoolean(CONFIRM_RUNNING_SEND_KEY, confirmRunningSend)
  }, [confirmRunningSend])

  useEffect(() => {
    if (error) {
      toast.error(error)
    }
  }, [error])

  useEffect(() => {
    if (notice) {
      toast.success(notice)
    }
  }, [notice])

  useEffect(() => {
    const lightbox = new PhotoSwipeLightbox({
      gallery: '.attachment-list',
      children: 'a.attachment-main',
      pswpModule: () => import('photoswipe'),
    })
    lightbox.init()
    return () => {
      lightbox.destroy()
    }
  }, [selectedSessionId, attachmentSignature])

  useEffect(() => {
    if (editingInstructionId && !editingInstruction) {
      setEditingInstructionId(null)
    }
  }, [editingInstruction, editingInstructionId])

  useEffect(() => {
    void loadSelectedSession(selectedSessionId).catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load session.')
    })
  }, [loadSelectedSession, selectedSessionId])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadSessions({ keepSelection: true }).catch(() => undefined)
      void loadSelectedSession(selectedSessionId).catch(() => undefined)
    }, SESSION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [loadSelectedSession, loadSessions, selectedSessionId])

  useLayoutEffect(() => {
    if (chatAtBottom) {
      scrollToBottom('auto')
    }
    updateActiveUserMessage()
  }, [chatAtBottom, messageSignature, scrollToBottom, sessionDetail?.status, thinkingSignature, updateActiveUserMessage])

  async function handleRefresh() {
    setPending('refresh')
    setError('')
    try {
      const healthResponse = await fetchHealth()
      setHealth(healthResponse)
      await loadSessions({ keepSelection: true })
      await loadSelectedSession(selectedSessionId)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Refresh failed.')
    } finally {
      setPending(null)
    }
  }

  async function handleSendInstruction() {
    if (!selectedSessionId) {
      setError('Select a session before sending an instruction.')
      return
    }
    const content = instruction.trim()
    if (!content) {
      setError('Write an instruction first.')
      setComposerFocusSignal((value) => value + 1)
      return
    }

    if (!editingInstructionId && confirmRunningSend) {
      const confirmed = await requestConfirmation({
        title: codexRunning ? 'Queue message while Codex is running?' : 'Send message to Codex?',
        message: codexRunning
          ? 'Codex is still working on the current instruction. This message will be queued and delivered when Codex asks for the next instruction.'
          : 'This will send the current message to Codex.',
        confirmLabel: codexRunning ? 'Queue message' : 'Send message',
        tone: 'warning',
        shortcutKeys: ['Ctrl', 'Enter'],
        dontAskAgainLabel: 'Do not ask again',
        onDontAskAgainConfirm: () => setConfirmRunningSend(false),
      })
      if (!confirmed) return
    }

    setPending('send')
    setError('')
    setNotice('')
    try {
      if (editingInstructionId) {
        const response = await updateInstruction(selectedSessionId, editingInstructionId, content)
        setSessionDetail(response.session)
        setEditingInstructionId(null)
        setInstruction(readStoredDraft(selectedSessionId))
        await loadSessions({ keepSelection: true })
        setComposerFocusSignal((value) => value + 1)
        return
      }

      await sendInstruction(selectedSessionId, content)
      clearStoredDraft(selectedSessionId)
      setInstruction('')
      await loadSelectedSession(selectedSessionId)
      await loadSessions({ keepSelection: true })
      setComposerFocusSignal((value) => value + 1)
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Instruction failed.')
      setComposerFocusSignal((value) => value + 1)
    } finally {
      setPending(null)
    }
  }

  function handleEditQueuedInstruction(nextInstruction: InstructionRecord) {
    setEditingInstructionId(nextInstruction.id)
    setInstruction(nextInstruction.content)
    setError('')
    setNotice('')
    setComposerFocusSignal((value) => value + 1)
  }

  function handleCancelEditQueuedInstruction() {
    setEditingInstructionId(null)
    setInstruction(readStoredDraft(selectedSessionId))
    setComposerFocusSignal((value) => value + 1)
  }

  async function handleDeleteQueuedInstruction(nextInstruction: InstructionRecord) {
    if (!selectedSessionId) return

    setPending('delete-instruction')
    setDeletingInstructionIds((ids) => ids.includes(nextInstruction.id) ? ids : [...ids, nextInstruction.id])
    setError('')
    setNotice('')
    try {
      const response = await deleteInstruction(selectedSessionId, nextInstruction.id)
      setSessionDetail(response.session)
      if (editingInstructionId === nextInstruction.id) {
        setEditingInstructionId(null)
        setInstruction(readStoredDraft(selectedSessionId))
      }
      await loadSessions({ keepSelection: true })
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Delete queued instruction failed.')
      await loadSelectedSession(selectedSessionId).catch(() => undefined)
    } finally {
      setDeletingInstructionIds((ids) => ids.filter((id) => id !== nextInstruction.id))
      setPending(null)
    }
  }

  async function handleClearConversation() {
    if (!selectedSessionId || !sessionDetail) return
    const confirmed = await requestConfirmation({
      title: 'Clear conversation?',
      message: `Clear conversation messages for "${sessionLabel(sessionDetail)}"? Queued instructions and attachments stay in this session.`,
      confirmLabel: 'Clear',
      tone: 'danger',
    })
    if (!confirmed) return

    setPending('clear')
    setError('')
    try {
      const response = await clearConversation(selectedSessionId)
      setSessionDetail(response.session)
      await loadSessions({ keepSelection: true })
      setNotice('Conversation cleared.')
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Clear conversation failed.')
    } finally {
      setPending(null)
    }
  }

  async function handleStopSession() {
    if (!selectedSessionId || !sessionDetail) return
    const confirmed = await requestConfirmation({
      title: 'Stop session?',
      message: `Stop "${sessionLabel(sessionDetail)}"? Waiting Codex callers will be released without receiving a new instruction.`,
      confirmLabel: 'Stop',
      tone: 'danger',
    })
    if (!confirmed) return

    setPending('stop')
    setError('')
    try {
      await stopSession(selectedSessionId)
      await loadSelectedSession(selectedSessionId)
      await loadSessions({ keepSelection: true })
      setNotice('Session stopped.')
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Stop failed.')
    } finally {
      setPending(null)
    }
  }

  async function handleDeleteSession(session: SessionRecord) {
    const confirmed = await requestConfirmation({
      title: 'Delete session?',
      message: `Delete "${sessionLabel(session)}" and all attachments stored for this session?`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return

    setPending('delete-session')
    setError('')
    try {
      const response = await deleteSession(session.id)
      setSessions(response.sessions)
      setSelectedSessionId((current) => current === session.id ? response.sessions[0]?.id ?? null : current)
      setNotice('Session deleted.')
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Delete session failed.')
    } finally {
      setPending(null)
    }
  }

  async function handleFileSelected(file: File | undefined): Promise<AttachmentRecord | null> {
    if (!selectedSessionId || !file) return null

    setPending('upload')
    setUploadingAttachmentName(file.name || 'attachment')
    setError('')
    const progressStartedAt = Date.now()
    try {
      const response = await uploadAttachment(selectedSessionId, file)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await loadSelectedSession(selectedSessionId)
      await loadSessions({ keepSelection: true })
      return response.attachment
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed.')
      return null
    } finally {
      await waitForMinimumElapsed(progressStartedAt, ATTACHMENT_PROGRESS_MIN_MS)
      setUploadingAttachmentName(null)
      setPending(null)
    }
  }

  async function handleDeleteAttachment(attachment: AttachmentRecord) {
    if (!selectedSessionId) return
    const confirmed = await requestConfirmation({
      title: 'Delete attachment?',
      message: `Delete "${attachment.originalName}" from this session? This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!confirmed) return

    setPending('delete-attachment')
    setDeletingAttachmentIds((ids) => ids.includes(attachment.id) ? ids : [...ids, attachment.id])
    setError('')
    const progressStartedAt = Date.now()
    try {
      const response = await deleteAttachment(selectedSessionId, attachment.id)
      setSessionDetail(response.session)
      setPreviewAttachment((current) => current?.id === attachment.id ? null : current)
      await loadSessions({ keepSelection: true })
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Delete attachment failed.')
    } finally {
      await waitForMinimumElapsed(progressStartedAt, ATTACHMENT_PROGRESS_MIN_MS)
      setDeletingAttachmentIds((ids) => ids.filter((id) => id !== attachment.id))
      setPending(null)
    }
  }

  async function handleDeleteAllAttachments() {
    if (!selectedSessionId || attachments.length === 0) return
    const confirmed = await requestConfirmation({
      title: 'Delete all attachments?',
      message: `Delete ${attachments.length} attachment${attachments.length === 1 ? '' : 's'} from this session? This cannot be undone.`,
      confirmLabel: 'Delete all',
      tone: 'danger',
    })
    if (!confirmed) return

    const ids = attachments.map((attachment) => attachment.id)
    setPending('delete-attachment')
    setDeletingAttachmentIds(ids)
    setError('')
    const progressStartedAt = Date.now()

    try {
      for (const attachment of attachments) {
        await deleteAttachment(selectedSessionId, attachment.id)
      }
      setPreviewAttachment(null)
      await loadSelectedSession(selectedSessionId)
      await loadSessions({ keepSelection: true })
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Delete attachments failed.')
    } finally {
      await waitForMinimumElapsed(progressStartedAt, ATTACHMENT_PROGRESS_MIN_MS)
      setDeletingAttachmentIds([])
      setPending(null)
    }
  }

  function handleAttachmentMention(attachment: AttachmentRecord) {
    setInstruction((currentValue) => appendAttachmentMention(currentValue, attachment.originalName))
    setComposerFocusSignal((value) => value + 1)
  }

  function handleInstructionChange(nextInstruction: string) {
    setInstruction(nextInstruction)
    if (selectedSessionId && !editingInstructionId) {
      writeStoredDraft(selectedSessionId, nextInstruction)
    }
  }

  return (
    <div
      className={`app-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}
      style={{ '--composer-height': `${composerHeight}px` } as CSSProperties}
    >
      <aside className={`run-inbox ${leftCollapsed ? 'collapsed' : ''}`}>
        <header className="inbox-header">
          <div className="brand-mark" aria-hidden="true">
            <img src="/codex-color.png" alt="" />
          </div>
          <div className="brand-copy">
            <h1>Codex Pro Max</h1>
            <p>{health ? 'Connected' : 'Connecting'}</p>
          </div>
          <div className="inbox-actions">
            <button
              className="icon-button rail-toggle"
              type="button"
              onClick={() => setLeftCollapsed((value) => !value)}
              aria-label={leftCollapsed ? 'Expand left sidebar' : 'Collapse left sidebar'}
              title={leftCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              <i className={leftCollapsed ? 'ri-sidebar-unfold-line' : 'ri-sidebar-fold-line'} aria-hidden="true" />
            </button>
          </div>
        </header>

        <SessionList
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          pendingDelete={pending === 'delete-session'}
          onSelect={setSelectedSessionId}
          onDelete={(session) => void handleDeleteSession(session)}
        />

        <SidebarProfile
          menuOpen={profileMenuOpen}
          onMenuOpenChange={setProfileMenuOpen}
          onSettingsOpen={() => setSettingsOpen(true)}
          onTeammatesOpen={() => setTeammatesOpen(true)}
          onWorkspaceSettingsOpen={() => setWorkspaceSettingsOpen(true)}
          onSkillsOpen={() => setSkillsOpen(true)}
          onLogoutErrorOpen={() => setLogoutErrorOpen(true)}
        />
      </aside>

      <main className="chat-shell">
        <header className="chat-header">
          <div>
            <p className="eyebrow">Current session</p>
            <h2>{sessionDetail ? sessionLabel(sessionDetail) : 'No active session'}</h2>
          </div>
          <div className="toolbar">
            <button type="button" onClick={() => void handleStopSession()} disabled={!sessionDetail || pending === 'stop'} title="Stop session">
              <i className={pending === 'stop' ? 'ri-loader-4-line spinning' : 'ri-stop-circle-line'} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => void handleClearConversation()} disabled={!sessionDetail || pending === 'clear'} title="Clear conversation">
              <i className={pending === 'clear' ? 'ri-loader-4-line spinning' : 'ri-chat-delete-line'} aria-hidden="true" />
            </button>
            {selectedSession && (
              <button
                type="button"
                className="danger-button"
                onClick={() => void handleDeleteSession(selectedSession)}
                disabled={pending === 'delete-session'}
                title="Delete session"
              >
                <i className={pending === 'delete-session' ? 'ri-loader-4-line spinning' : 'ri-delete-bin-6-line'} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setRightCollapsed((value) => !value)}
              aria-label={rightCollapsed ? 'Expand right sidebar' : 'Collapse right sidebar'}
              title={rightCollapsed ? 'Expand right sidebar' : 'Collapse right sidebar'}
            >
              <i className={rightCollapsed ? 'ri-sidebar-unfold-line' : 'ri-sidebar-fold-line'} aria-hidden="true" />
            </button>
          </div>
        </header>

        <Toaster position="top-right" richColors closeButton duration={3500} />

        {sessionDetail ? (
          <>
            <ConversationUsageStrip usage={conversationUsage} />
            <MessageTimeline
              messages={sessionDetail.messages}
              sessionStatus={sessionDetail.status}
              activity={conversationActivity}
              thinkingRecords={conversationThinkingRecords}
              scrollRef={chatScrollRef}
              pinnedToBottom={chatAtBottom}
              keepPinnedToBottom={keepTimelinePinnedToBottom}
              onScroll={handleTimelineScroll}
              setMessageRef={setMessageRef}
            />
            {!chatAtBottom && (
              <button className="scroll-bottom-button" type="button" onClick={() => scrollToBottom()} title="Scroll to bottom">
                <i className="ri-arrow-down-line" aria-hidden="true" />
              </button>
            )}
            <Composer
              value={instruction}
              pending={pending === 'send'}
              disabled={sessionDetail.status === 'STOPPED' || (queueLimitReached && !editingInstructionId)}
              queueMode={sessionDetail.status === 'RUNNING'}
              queueLimitReached={queueLimitReached}
              editingInstruction={editingInstruction}
              attachments={attachments}
              queuedInstructions={queuedInstructions}
              deletingInstructionIds={deletingInstructionIds}
              focusSignal={composerFocusSignal}
              onHeightChange={handleComposerHeightChange}
              onChange={handleInstructionChange}
              onSend={() => void handleSendInstruction()}
              onCancelEdit={handleCancelEditQueuedInstruction}
              onEditQueuedInstruction={handleEditQueuedInstruction}
              onDeleteQueuedInstruction={(nextInstruction) => void handleDeleteQueuedInstruction(nextInstruction)}
              onPreviewAttachment={setPreviewAttachment}
              onUpload={handleFileSelected}
            />
          </>
        ) : (
          <EmptyConversation />
        )}
      </main>

      <aside className={`protocol-sidebar ${rightCollapsed ? 'collapsed' : ''}`}>
        {!rightCollapsed && (
          <>
            <SidebarSection
              title="Outlines"
              className="outline-section"
              collapsed={outlinesCollapsed}
              onToggle={() => setOutlinesCollapsed((value) => !value)}
            >
              <ConversationOutline
                messages={userMessages}
                activeMessageId={activeUserMessageId}
                chatAtBottom={chatAtBottom}
                onSelect={handleOutlineSelect}
              />
            </SidebarSection>

            <SidebarSection
              title="Attachments"
              className="attachments-section"
              collapsed={attachmentsCollapsed}
              onToggle={() => setAttachmentsCollapsed((value) => !value)}
              action={(
                <div className="attachment-header-actions">
                  {attachments.length > 0 && (
                    <button
                      className="icon-button danger-icon"
                      type="button"
                      disabled={pending === 'delete-attachment'}
                      onClick={() => void handleDeleteAllAttachments()}
                      title="Delete all attachments"
                    >
                      <i className={pending === 'delete-attachment' ? 'ri-loader-4-line spinning' : 'ri-delete-bin-2-line'} aria-hidden="true" />
                    </button>
                  )}
                  <label className="file-button">
                    <i className={pending === 'upload' ? 'ri-loader-4-line spinning' : 'ri-attachment-2'} aria-hidden="true" />
                    <span className="sr-only">Upload</span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      disabled={!selectedSessionId || pending === 'upload'}
                      onChange={(event) => void handleFileSelected(event.target.files?.[0])}
                    />
                  </label>
                </div>
              )}
            >
              <AttachmentList
                sessionId={selectedSessionId}
                attachments={attachments}
                uploadingName={uploadingAttachmentName}
                deletingAttachmentIds={deletingAttachmentIds}
                onPreview={setPreviewAttachment}
                onMention={handleAttachmentMention}
                onDelete={(attachment) => void handleDeleteAttachment(attachment)}
              />
            </SidebarSection>
          </>
        )}
      </aside>

      {previewAttachment && selectedSessionId && (
        <AttachmentPreview
          sessionId={selectedSessionId}
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
      {confirmDialog && <ConfirmDialog dialog={confirmDialog} onResolve={resolveConfirmation} />}
      {settingsOpen && (
        <SettingsDialog
          confirmRunningSend={confirmRunningSend}
          onConfirmRunningSendChange={setConfirmRunningSend}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {teammatesOpen && <SimpleProfileDialog title="Invite teammates" icon="ri-team-line" message="Team invitations are managed from this local Codex Pro Max workspace." onClose={() => setTeammatesOpen(false)} />}
      {workspaceSettingsOpen && (
        <SimpleProfileDialog
          title="Workspace settings"
          icon="ri-settings-3-line"
          message={`Data root: ${health?.dataRoot ?? 'Not connected'}\nCodex sessions root: ${health?.sessionsRoot ?? 'Not connected'}`}
          onClose={() => setWorkspaceSettingsOpen(false)}
        />
      )}
      {skillsOpen && <SimpleProfileDialog title="Skills" icon="ri-brain-line" message="Codex skills are configured from the local Codex environment." onClose={() => setSkillsOpen(false)} />}
      {logoutErrorOpen && <SimpleProfileDialog title="Cannot sign out" icon="ri-error-warning-line" message="This is a local development build. There is no remote account session to sign out from." onClose={() => setLogoutErrorOpen(false)} tone="danger" />}
    </div>
  )
}

function SessionList({
  sessions,
  selectedSessionId,
  pendingDelete,
  onSelect,
  onDelete,
}: {
  sessions: SessionSummary[]
  selectedSessionId: string | null
  pendingDelete: boolean
  onSelect: (sessionId: string) => void
  onDelete: (session: SessionSummary) => void
}) {
  if (sessions.length === 0) {
    return (
      <div className="empty-inbox">
        <strong>No Codex sessions</strong>
        <span>Sessions appear here after Codex creates one through the backend endpoint.</span>
      </div>
    )
  }

  return (
    <nav className="session-list" aria-label="Sessions">
      {sessions.map((session) => (
        <article className={`session-card ${session.id === selectedSessionId ? 'active' : ''}`} key={session.id}>
          <button type="button" className="session-select" onClick={() => onSelect(session.id)} title={sessionLabel(session)}>
            <SessionStatusIcon status={session.status} />
            <span className="session-card-copy">
              <strong>{sessionLabel(session)}</strong>
              <small>{session.latestConclusion || shortThreadId(session.codexThreadId)}</small>
              <span className="session-card-meta">
                {formatStatus(session.status)}
                {session.attachmentCount > 0 ? ` / ${session.attachmentCount} attachments` : ''}
                {session.hasQueuedInstruction ? ` / ${session.queuedInstructionCount} queued` : ''}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="icon-button danger-icon"
            disabled={pendingDelete}
            onClick={() => onDelete(session)}
            title="Delete session"
          >
            <i className="ri-delete-bin-6-line" aria-hidden="true" />
          </button>
        </article>
      ))}
    </nav>
  )
}

const PROFILE_MENU_ITEMS = [
  { label: 'Settings', icon: 'ri-settings-4-line', action: 'settings', chevron: false, separated: false },
  { label: 'Invite teammates', icon: 'ri-team-line', action: 'teammates', chevron: true, separated: false },
  { label: 'Workspace settings', icon: 'ri-building-4-line', action: 'workspace-settings', chevron: true, separated: false },
  { label: 'Skills', icon: 'ri-brain-line', action: 'skills', chevron: true, separated: false },
  { label: 'Log out', icon: 'ri-logout-box-r-line', action: 'logout', chevron: false, separated: true },
] as const

function SidebarProfile({
  menuOpen,
  onMenuOpenChange,
  onSettingsOpen,
  onTeammatesOpen,
  onWorkspaceSettingsOpen,
  onSkillsOpen,
  onLogoutErrorOpen,
}: {
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  onSettingsOpen: () => void
  onTeammatesOpen: () => void
  onWorkspaceSettingsOpen: () => void
  onSkillsOpen: () => void
  onLogoutErrorOpen: () => void
}) {
  const profileAreaRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return

    function handlePointerDown(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && profileAreaRef.current?.contains(target)) return
      onMenuOpenChange(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [menuOpen, onMenuOpenChange])

  function handleMenuAction(action: typeof PROFILE_MENU_ITEMS[number]['action']) {
    onMenuOpenChange(false)
    if (action === 'settings') {
      onSettingsOpen()
    } else if (action === 'teammates') {
      onTeammatesOpen()
    } else if (action === 'workspace-settings') {
      onWorkspaceSettingsOpen()
    } else if (action === 'skills') {
      onSkillsOpen()
    } else if (action === 'logout') {
      onLogoutErrorOpen()
    }
  }

  return (
    <div className="sidebar-profile-area" ref={profileAreaRef}>
      {menuOpen && (
        <div className="profile-menu" role="menu" aria-label="Profile menu">
          <button type="button" className="profile-menu-account" role="menuitem">
            <span className="profile-menu-avatar">
              <img src="/burger.png" alt="" />
            </span>
            <span className="profile-menu-account-copy">
              <span>Ramlyburger</span>
              <span>Local workspace</span>
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
                onClick={() => handleMenuAction(item.action)}
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
        onClick={() => onMenuOpenChange(!menuOpen)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Open profile menu"
        title="Profile"
      >
        <span className="sidebar-profile-avatar">
          <img src="/burger.png" alt="" />
        </span>
        <span className="sidebar-profile-copy">
          <span>Ramlyburger</span>
          <span>Local workspace</span>
        </span>
        <i className="ri-more-2-fill sidebar-profile-more" aria-hidden="true" />
      </button>
    </div>
  )
}

function EmptyConversation() {
  return (
    <section className="empty-conversation">
      <h2>No session selected</h2>
      <p>Codex will create a session when it detects the backend and starts work with its current thread id.</p>
    </section>
  )
}

function ConversationUsageStrip({ usage }: { usage: CodexLiveContextUsage | null }) {
  const limits = usage ? usageLimitCards(usage) : [
    { key: 'primary', label: '5h', value: '...', detail: 'Waiting for limit data', percent: 0 },
    { key: 'secondary', label: 'Weekly', value: '...', detail: 'Waiting for limit data', percent: 0 },
  ]

  return (
    <section className="conversation-usage-strip" aria-label="Conversation usage limits">
      <UsageLimitCard
        tone="context"
        label="Context"
        value={usage ? formatPercent(usage.percentUsed) : '...'}
        detail={usage ? `${formatTokenCount(usage.usedTokens)}/${formatTokenCount(usage.contextWindow)}` : 'Waiting for Codex usage'}
        percent={usage?.percentUsed ?? 0}
      />
      {limits.map((limit) => (
        <UsageLimitCard
          key={limit.key}
          tone={limit.key === 'primary' ? 'five-hour' : 'weekly'}
          label={limit.label}
          value={limit.value}
          detail={limit.detail}
          percent={limit.percent}
        />
      ))}
    </section>
  )
}

function UsageLimitCard({
  tone,
  label,
  value,
  detail,
  percent,
}: {
  tone: 'context' | 'five-hour' | 'weekly'
  label: string
  value: string
  detail: string
  percent: number
}) {
  return (
    <div className={`usage-limit-card usage-limit-${tone}`}>
      <div className="usage-limit-heading">
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
      <div className="usage-limit-track" aria-hidden="true">
        <span style={{ width: `${clampPercent(percent)}%` }} />
      </div>
      <small>{detail}</small>
    </div>
  )
}

function SessionStatusIcon({ status }: { status: SessionStatus }) {
  if (status === 'RUNNING') {
    return (
      <span className="session-status-animated session-status-running" aria-hidden="true">
        <img src="/codex-thinking.webp" alt="" />
      </span>
    )
  }

  if (status === 'WAITING_FOR_INSTRUCTION') {
    return (
      <span className="session-status-animated session-status-waiting" aria-hidden="true">
        <img src="/codex-stopped.webp" alt="" />
      </span>
    )
  }

  if (status === 'STOPPED') {
    return (
      <span className="session-status-animated session-status-stopped" aria-hidden="true">
        <img src="/codex-stopped.webp" alt="" />
      </span>
    )
  }

  return (
    <span className="session-status-fallback session-status-error" aria-hidden="true">
      <i className="ri-error-warning-line" />
    </span>
  )
}

function SidebarSection({
  title,
  className,
  collapsed = false,
  onToggle,
  action,
  children,
}: {
  title: string
  className?: string
  collapsed?: boolean
  onToggle?: () => void
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={`sidebar-section ${className ?? ''} ${collapsed ? 'collapsed' : ''}`}>
      <header>
        {onToggle ? (
          <button
            type="button"
            className="sidebar-section-toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          >
            <span>{title}</span>
          </button>
        ) : (
          <h2>{title}</h2>
        )}
        {action}
        {onToggle && (
          <button
            type="button"
            className="sidebar-section-collapse"
            onClick={onToggle}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
            aria-expanded={!collapsed}
            title={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
          >
            <i className={collapsed ? 'ri-arrow-down-s-line' : 'ri-arrow-up-s-line'} aria-hidden="true" />
          </button>
        )}
      </header>
      {!collapsed && children}
    </section>
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
  const shortcutKeys = dialog.shortcutKeys ?? []
  const hasShortcut = shortcutKeys.length > 0
  const messageParagraphs = dialog.message.split(/\n{1,}/).filter(Boolean)
  const [dontAskAgain, setDontAskAgain] = useState(false)
  useEscapeToClose(() => onResolve(false))
  const actions = (
    <div className="confirm-actions">
      <button type="button" className="confirm-button secondary" onClick={() => onResolve(false)}>
        {dialog.cancelLabel ?? 'Cancel'}
      </button>
      <button
        type="button"
        className={`confirm-button ${tone === 'danger' ? 'danger' : 'primary'}`}
        onClick={() => {
          if (dontAskAgain) {
            dialog.onDontAskAgainConfirm?.()
          }
          onResolve(true)
        }}
        autoFocus
      >
        {dialog.confirmLabel}
      </button>
    </div>
  )

  return (
    <div className="preview-backdrop confirm-backdrop" role="presentation" onClick={() => onResolve(false)}>
      <section
        className={`confirm-dialog ${tone} ${hasShortcut ? 'shortcut-confirm-dialog' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        onClick={(event) => event.stopPropagation()}
      >
        {hasShortcut ? (
          <div className="shortcut-key-row" aria-hidden="true">
            {shortcutKeys.map((key, index) => (
              <Fragment key={`${key}-${index}`}>
                {index > 0 && <span>+</span>}
                <kbd>{key}</kbd>
              </Fragment>
            ))}
          </div>
        ) : (
          <div className={`confirm-icon ${tone}`} aria-hidden="true">
            <i className={tone === 'danger' ? 'ri-error-warning-line' : tone === 'warning' ? 'ri-question-line' : 'ri-information-line'} />
          </div>
        )}
        <div className="confirm-copy">
          <h2>{dialog.title}</h2>
          {messageParagraphs.map((paragraph, index) => (
            <p key={`${paragraph}-${index}`}>{paragraph}</p>
          ))}
        </div>
        {dialog.dontAskAgainLabel ? (
          <div className="shortcut-confirm-footer">
            <label className="confirm-checkbox">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(event) => setDontAskAgain(event.target.checked)}
              />
              <span>{dialog.dontAskAgainLabel}</span>
            </label>
            {actions}
          </div>
        ) : actions}
      </section>
    </div>
  )
}

function SettingsDialog({
  confirmRunningSend,
  onConfirmRunningSendChange,
  onClose,
}: {
  confirmRunningSend: boolean
  onConfirmRunningSendChange: (value: boolean) => void
  onClose: () => void
}) {
  useEscapeToClose(onClose)

  return (
    <div className="preview-backdrop settings-backdrop" role="presentation" onClick={onClose}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-label="Settings" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <p className="eyebrow">Profile</p>
            <h2>Settings</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title="Close settings" autoFocus>
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </header>
        <div className="settings-list">
          <label className="settings-toggle">
            <span>
              <strong>Confirm message send</strong>
              <small>Ask before a new message is sent or queued.</small>
            </span>
            <input
              type="checkbox"
              checked={confirmRunningSend}
              onChange={(event) => onConfirmRunningSendChange(event.target.checked)}
            />
          </label>
        </div>
      </section>
    </div>
  )
}

function SimpleProfileDialog({
  title,
  icon,
  message,
  tone = 'default',
  onClose,
}: {
  title: string
  icon: string
  message: string
  tone?: ConfirmDialogTone
  onClose: () => void
}) {
  useEscapeToClose(onClose)
  return (
    <div className="preview-backdrop settings-backdrop" role="presentation" onClick={onClose}>
      <section className={`profile-info-dialog ${tone}`} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className={`confirm-icon ${tone}`} aria-hidden="true">
          <i className={icon} />
        </div>
        <div className="confirm-copy">
          <h2>{title}</h2>
          {message.split(/\n/).map((line, index) => (
            <p key={`${index}-${line.slice(0, 20)}`}>{line}</p>
          ))}
        </div>
        <div className="confirm-actions">
          <button type="button" className="confirm-button primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </section>
    </div>
  )
}

function ConversationOutline({
  messages,
  activeMessageId,
  chatAtBottom,
  onSelect,
}: {
  messages: MessageRecord[]
  activeMessageId: string | null
  chatAtBottom: boolean
  onSelect: (messageId: string) => void
}) {
  const outlineListRef = useRef<HTMLOListElement | null>(null)
  const outlineButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const outlinePinnedToBottomRef = useRef(true)
  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null
  const effectiveActiveMessageId = activeMessageId ?? (chatAtBottom ? latestMessage?.id ?? null : null)
  const [visibleActiveMessageId, setVisibleActiveMessageId] = useState<string | null>(effectiveActiveMessageId)
  const outlineScrollAnchor = latestMessage ? `${messages.length}:${latestMessage.id}` : 'empty'
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

    if (effectiveActiveMessageId === latestMessage?.id) {
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
  }, [chatAtBottom, effectiveActiveMessageId, latestMessage?.id, outlineScrollAnchor])

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

  function setOutlineButtonRef(messageId: string, node: HTMLButtonElement | null) {
    if (node) {
      outlineButtonRefs.current.set(messageId, node)
      return
    }
    outlineButtonRefs.current.delete(messageId)
  }

  if (messages.length === 0) {
    return <p className="muted-copy">No user messages yet.</p>
  }

  return (
    <ol className="outline-list" ref={outlineListRef} onScroll={handleOutlineScroll}>
      {messages.map((message) => (
        <li key={message.id}>
          <button
            type="button"
            ref={(node) => setOutlineButtonRef(message.id, node)}
            className={message.id === visibleActiveMessageId ? 'active' : ''}
            aria-current={message.id === visibleActiveMessageId ? 'true' : undefined}
            onClick={() => onSelect(message.id)}
          >
            <span>{formatDateTime(message.createdAt)}</span>
            <p>{messagePreview(message.content)}</p>
          </button>
        </li>
      ))}
    </ol>
  )
}

function MessageTimeline({
  messages,
  sessionStatus,
  activity,
  thinkingRecords,
  scrollRef,
  pinnedToBottom,
  keepPinnedToBottom,
  onScroll,
  setMessageRef,
}: {
  messages: MessageRecord[]
  sessionStatus: SessionStatus
  activity: CodexLiveActivity
  thinkingRecords: CodexLiveRecord[]
  scrollRef: MutableRefObject<HTMLElement | null>
  pinnedToBottom: boolean
  keepPinnedToBottom: () => void
  onScroll: (event: UIEvent<HTMLElement>) => void
  setMessageRef: (messageId: string, node: HTMLElement | null) => void
}) {
  const showThinking = sessionStatus === 'RUNNING'
  const contentRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(() => {
      if (!pinnedToBottom) return
      window.requestAnimationFrame(keepPinnedToBottom)
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [keepPinnedToBottom, pinnedToBottom])

  if (messages.length === 0 && !showThinking) {
    return (
      <section className="message-timeline empty-timeline" ref={scrollRef}>
        <h2>No conversation history</h2>
        <p>This session is still open.</p>
      </section>
    )
  }

  return (
    <section className="message-timeline" aria-label="Conversation" ref={scrollRef} onScroll={onScroll}>
      <div className="message-timeline-content" ref={contentRef}>
        {messages.map((message) => (
          <MessageArticle message={message} setMessageRef={setMessageRef} key={message.id} />
        ))}

        {showThinking && (
          <AiThinkingMessage
            records={thinkingRecords}
            status={sessionStatus}
            activity={activity}
          />
        )}
      </div>
    </section>
  )
}

const MessageArticle = memo(function MessageArticle({
  message,
  setMessageRef,
}: {
  message: MessageRecord
  setMessageRef: (messageId: string, node: HTMLElement | null) => void
}) {
  return (
    <article
      className={`message message-${message.role}`}
      data-message-id={message.id}
      data-message-role={message.role}
      ref={(node) => setMessageRef(message.id, node)}
    >
      {message.role === 'user' ? (
        <>
          <div className="message-body">
            <MessageHeader label="User" createdAt={message.createdAt} copyText={message.content} />
            <MarkdownMessage content={message.content} preserveSoftBreaks />
          </div>
          <UserAvatar />
        </>
      ) : (
        <>
          <HistoricalBotAvatar />
          <div className="message-body">
            <MessageHeader label="Codex" createdAt={message.createdAt} copyText={message.content} />
            <MarkdownMessage content={message.content} />
          </div>
        </>
      )}
    </article>
  )
}, (previous, next) =>
  previous.setMessageRef === next.setMessageRef
  && previous.message.id === next.message.id
  && previous.message.role === next.message.role
  && previous.message.content === next.message.content
  && previous.message.createdAt === next.message.createdAt)

function MessageHeader({
  label,
  createdAt,
  copyText,
}: {
  label: string
  createdAt: string
  copyText: string
}) {
  return (
    <header>
      <strong>{label}</strong>
      <span className="message-header-actions">
        <MessageCopyButton content={copyText} />
        <time>{formatDateTime(createdAt)}</time>
      </span>
    </header>
  )
}

function MessageCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    try {
      await copyText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <button
      type="button"
      className={`message-copy-button ${copied ? 'copied' : ''}`}
      onClick={() => void handleCopy()}
      title={copied ? 'Copied' : 'Copy message'}
      aria-label={copied ? 'Copied message' : 'Copy message'}
    >
      <i className={copied ? 'ri-check-line' : 'ri-file-copy-line'} aria-hidden="true" />
    </button>
  )
}

const MarkdownMessage = memo(function MarkdownMessage({
  content,
  compact = false,
  preserveSoftBreaks = false,
}: {
  content: string
  compact?: boolean
  preserveSoftBreaks?: boolean
}) {
  return (
    <div className={`markdown-message ${compact ? 'compact' : ''} ${preserveSoftBreaks ? 'preserve-soft-breaks' : ''}`}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

function AiThinkingMessage({
  records,
  status,
  activity,
}: {
  records: CodexLiveRecord[]
  status: SessionStatus
  activity: CodexLiveActivity
}) {
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  const thinkingText = records
    .map((record) => record.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const [visibleThinkingText, setVisibleThinkingText] = useState(thinkingText)
  const visibleThinkingTextRef = useRef(thinkingText)
  const recordAnchor = records.map((record) => `${record.id}:${record.text.length}`).join('|')

  useEffect(() => {
    visibleThinkingTextRef.current = visibleThinkingText
  }, [visibleThinkingText])

  useEffect(() => {
    const currentVisibleText = visibleThinkingTextRef.current
    if (!thinkingText) {
      setVisibleThinkingText('')
      return
    }

    if (!thinkingText.startsWith(currentVisibleText) || thinkingText.length < currentVisibleText.length) {
      setVisibleThinkingText(thinkingText)
      return
    }

    if (thinkingText.length === currentVisibleText.length) return

    let nextLength = currentVisibleText.length
    const timer = window.setInterval(() => {
      nextLength = Math.min(thinkingText.length, nextLength + 4)
      const nextText = thinkingText.slice(0, nextLength)
      visibleThinkingTextRef.current = nextText
      setVisibleThinkingText(nextText)
      if (nextLength >= thinkingText.length) {
        window.clearInterval(timer)
      }
    }, 18)

    return () => window.clearInterval(timer)
  }, [thinkingText])

  useLayoutEffect(() => {
    const bubble = bubbleRef.current
    if (!bubble) return
    bubble.scrollTop = bubble.scrollHeight
  }, [recordAnchor, visibleThinkingText.length])

  return (
    <article className="message message-codex message-thinking" aria-label="Codex thinking process" aria-live="polite">
      <BotAvatar status={status} activity={activity} />
      <div className="message-body thinking-body">
        <header>
          <strong>Thinking<span className="thinking-label-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></strong>
          <span className="message-header-actions">
            {thinkingText && <MessageCopyButton content={thinkingText} />}
            <time>{activity.latestEventAt ? formatDateTime(activity.latestEventAt) : 'Running'}</time>
          </span>
        </header>
        {thinkingText ? (
          <div className="thinking-box" ref={bubbleRef}>
            <MarkdownMessage content={visibleThinkingText} compact />
          </div>
        ) : (
          <div className="thinking-line" aria-label="Codex is running">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
    </article>
  )
}

function BotAvatar({ status, activity }: { status: SessionStatus; activity: CodexLiveActivity }) {
  const visualState = botVisualState(status, activity)
  if (visualState === 'error') {
    return (
      <div className="message-avatar bot-avatar bot-avatar-error" aria-hidden="true">
        <i className="ri-error-warning-line" />
      </div>
    )
  }

  return (
    <div className={`message-avatar bot-avatar bot-avatar-${visualState}`} aria-hidden="true">
      <img src={visualState === 'thinking' ? '/codex-thinking.webp' : '/codex-stopped.webp'} alt="" />
    </div>
  )
}

function HistoricalBotAvatar() {
  return (
    <div className="message-avatar bot-avatar bot-avatar-static" aria-hidden="true">
      <img src="/codex-stopped.webp" alt="" />
    </div>
  )
}

function UserAvatar() {
  return (
    <div className="message-avatar user-avatar" aria-hidden="true">
      <img src="/burger.png" alt="" />
    </div>
  )
}

function Composer({
  value,
  pending,
  disabled,
  queueMode,
  queueLimitReached,
  editingInstruction,
  attachments,
  queuedInstructions,
  deletingInstructionIds,
  focusSignal,
  onHeightChange,
  onChange,
  onSend,
  onCancelEdit,
  onEditQueuedInstruction,
  onDeleteQueuedInstruction,
  onPreviewAttachment,
  onUpload,
}: {
  value: string
  pending: boolean
  disabled: boolean
  queueMode: boolean
  queueLimitReached: boolean
  editingInstruction: InstructionRecord | null
  attachments: AttachmentRecord[]
  queuedInstructions: InstructionRecord[]
  deletingInstructionIds: string[]
  focusSignal: number
  onHeightChange: (height: number) => void
  onChange: (value: string) => void
  onSend: () => void
  onCancelEdit: () => void
  onEditQueuedInstruction: (instruction: InstructionRecord) => void
  onDeleteQueuedInstruction: (instruction: InstructionRecord) => void
  onPreviewAttachment: (attachment: AttachmentRecord) => void
  onUpload: (file: File | undefined) => Promise<AttachmentRecord | null>
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composerRef = useRef<HTMLElement | null>(null)
  const [caretIndex, setCaretIndex] = useState(value.length)
  const uniqueAttachments = useMemo(() => uniqueAttachmentsByName(attachments), [attachments])
  const mentionRange = useMemo(() => findMentionRange(value, caretIndex), [caretIndex, value])
  const mentionSuggestions = useMemo(() => {
    if (!mentionRange) return []
    const query = mentionRange.query.toLowerCase()
    return uniqueAttachments
      .filter((attachment) => attachment.originalName.toLowerCase().includes(query))
      .slice(0, 6)
  }, [mentionRange, uniqueAttachments])
  const mentionedAttachments = useMemo(
    () => uniqueAttachments.filter((attachment) => hasAttachmentMention(value, attachment.originalName)),
    [uniqueAttachments, value],
  )

  useLayoutEffect(() => {
    resizeTextarea(textareaRef.current)
    reportComposerHeight()
  }, [editingInstruction, value, queuedInstructions.length])

  useEffect(() => {
    if (focusSignal > 0) {
      textareaRef.current?.focus()
    }
  }, [focusSignal])

  function reportComposerHeight() {
    const height = composerRef.current?.offsetHeight ?? 0
    if (height > 0) {
      onHeightChange(height)
    }
  }

  function rememberCaret(target: HTMLTextAreaElement) {
    setCaretIndex(target.selectionStart ?? target.value.length)
  }

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    onChange(event.target.value)
    rememberCaret(event.target)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault()
      onSend()
    }
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = clipboardFiles(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    for (const file of files.slice(0, 10)) {
      const attachment = await onUpload(file)
      if (attachment) {
        insertAttachmentMentionName(attachment.originalName)
      }
    }
  }

  function insertAttachmentMention(attachment: AttachmentRecord) {
    insertAttachmentMentionName(attachment.originalName)
  }

  function insertAttachmentMentionName(attachmentName: string) {
    const textarea = textareaRef.current
    const range = mentionRange ?? {
      start: value.length,
      end: value.length,
      query: '',
    }
    const leading = range.start > 0 && !/\s/.test(value[range.start - 1] ?? '') ? ' ' : ''
    const trailing = range.end < value.length && !/\s/.test(value[range.end] ?? '') ? ' ' : ' '
    const mention = `${leading}@${attachmentName}${trailing}`
    const nextValue = `${value.slice(0, range.start)}${mention}${value.slice(range.end)}`
    const nextCaret = range.start + mention.length
    onChange(nextValue)
    setCaretIndex(nextCaret)
    window.requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(nextCaret, nextCaret)
      resizeTextarea(textarea)
    })
  }

  function handleRemoveAttachmentMention(attachment: AttachmentRecord) {
    const textarea = textareaRef.current
    const nextValue = removeAttachmentMention(value, attachment.originalName)
    const nextCaret = Math.min(caretIndex, nextValue.length)
    onChange(nextValue)
    setCaretIndex(nextCaret)
    window.requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(nextCaret, nextCaret)
      resizeTextarea(textarea)
    })
  }

  return (
    <section className={`composer ${queueMode ? 'queue-mode' : ''} ${editingInstruction ? 'editing-mode' : ''}`} aria-label="Instruction composer" ref={composerRef}>
      {queuedInstructions.length > 0 && (
        <QueuedInstructionTray
          instructions={queuedInstructions}
          editingInstructionId={editingInstruction?.id ?? null}
          deletingInstructionIds={deletingInstructionIds}
          onEdit={onEditQueuedInstruction}
          onDelete={onDeleteQueuedInstruction}
        />
      )}
      {editingInstruction && (
        <div className="composer-editing-bar" aria-label="Queued instruction edit controls">
          <button type="button" onClick={onCancelEdit} title="Cancel edit">
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </div>
      )}
      {mentionedAttachments.length > 0 && (
        <div className="composer-attachment-tray" aria-label="Mentioned attachments">
          {mentionedAttachments.map((attachment) => (
            <div
              className="composer-attachment-chip"
              key={attachment.id}
              title={attachment.originalName}
            >
              <button
                type="button"
                className="composer-attachment-chip-preview"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPreviewAttachment(attachment)}
                title={`Preview ${attachment.originalName}`}
                aria-label={`Preview attachment ${attachment.originalName}`}
              >
                {attachment.mimeType.startsWith('image/') ? (
                  <img className="composer-attachment-chip-thumb" src={attachmentUrl(attachment.sessionId, attachment.id)} alt="" />
                ) : (
                  <span className="composer-attachment-chip-kind">{attachmentKind(attachment)}</span>
                )}
              </button>
              <span className="composer-attachment-chip-name">@{attachment.originalName}</span>
              <button
                type="button"
                className="composer-attachment-chip-remove"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleRemoveAttachmentMention(attachment)}
                title={`Remove ${attachment.originalName} mention`}
                aria-label={`Remove attachment mention ${attachment.originalName}`}
              >
                <i className="ri-close-line" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        <label className="composer-upload-button" title="Attach file">
          <i className="ri-attachment-2" aria-hidden="true" />
          <span className="sr-only">Attach</span>
          <input type="file" disabled={disabled} onChange={(event) => onUpload(event.target.files?.[0])} />
        </label>
        <div className="composer-text-wrap">
          <textarea
            ref={textareaRef}
            value={value}
            disabled={disabled}
            onBlur={(event) => rememberCaret(event.currentTarget)}
            onChange={handleChange}
            onClick={(event) => rememberCaret(event.currentTarget)}
            onKeyDown={handleKeyDown}
            onKeyUp={(event) => rememberCaret(event.currentTarget)}
            onPaste={(event) => void handlePaste(event)}
            placeholder={queueLimitReached ? 'Instruction queue is full.' : disabled ? 'Session is stopped.' : queueMode ? 'Queue the next instruction...' : 'Message Codex Pro Max...'}
          />
          {mentionSuggestions.length > 0 && (
            <div className="mention-popover">
              {mentionSuggestions.map((attachment) => (
                <button type="button" key={attachment.id} onMouseDown={(event) => event.preventDefault()} onClick={() => insertAttachmentMention(attachment)}>
                  <span>{attachmentKind(attachment)}</span>
                  <strong>{attachment.originalName}</strong>
                  <small>{formatBytes(attachment.sizeBytes)}</small>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="send-button" disabled={disabled || pending || !value.trim()} onClick={onSend} title={editingInstruction ? 'Save queued instruction' : queueMode ? 'Queue instruction' : 'Send instruction'}>
          <i className={pending ? 'ri-loader-4-line spinning' : editingInstruction ? 'ri-check-line' : queueMode ? 'ri-inbox-archive-line' : 'ri-arrow-up-line'} aria-hidden="true" />
          <span className="sr-only">{pending ? 'Saving' : editingInstruction ? 'Save' : queueMode ? 'Queue' : 'Send'}</span>
        </button>
      </div>
    </section>
  )
}

function QueuedInstructionTray({
  instructions,
  editingInstructionId,
  deletingInstructionIds,
  onEdit,
  onDelete,
}: {
  instructions: InstructionRecord[]
  editingInstructionId: string | null
  deletingInstructionIds: string[]
  onEdit: (instruction: InstructionRecord) => void
  onDelete: (instruction: InstructionRecord) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const instructionIds = instructions.map((instruction) => instruction.id).join('|')
  const hasCollapsedInstructions = instructions.length > QUEUED_INSTRUCTION_VISIBLE_LIMIT
  const visibleInstructions = expanded
    ? instructions
    : instructions.slice(0, QUEUED_INSTRUCTION_VISIBLE_LIMIT)
  const collapsedCount = Math.max(0, instructions.length - QUEUED_INSTRUCTION_VISIBLE_LIMIT)

  useEffect(() => {
    setExpanded(false)
  }, [instructionIds])

  return (
    <div className={`queued-instruction-tray ${expanded ? 'is-expanded' : ''}`} aria-label="Queued instructions">
      {visibleInstructions.map((instruction, index) => (
        <article className={instruction.id === editingInstructionId ? 'is-editing' : ''} key={instruction.id}>
          <span className="queued-instruction-index">{index + 1}</span>
          <p>{messagePreview(instruction.content)}</p>
          <div className="queued-instruction-actions">
            <button type="button" onClick={() => onEdit(instruction)} disabled={deletingInstructionIds.includes(instruction.id)} title="Edit queued instruction">
              <i className="ri-edit-line" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => onDelete(instruction)} disabled={deletingInstructionIds.includes(instruction.id)} title="Delete queued instruction">
              <i className={deletingInstructionIds.includes(instruction.id) ? 'ri-loader-4-line spinning' : 'ri-delete-bin-6-line'} aria-hidden="true" />
            </button>
          </div>
        </article>
      ))}
      {hasCollapsedInstructions && (
        <button
          type="button"
          className="queued-instruction-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer queued messages' : `Show ${collapsedCount} more queued message${collapsedCount === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  )
}

function AttachmentList({
  sessionId,
  attachments,
  uploadingName,
  deletingAttachmentIds,
  onPreview,
  onMention,
  onDelete,
}: {
  sessionId: string | null
  attachments: AttachmentRecord[]
  uploadingName: string | null
  deletingAttachmentIds: string[]
  onPreview: (attachment: AttachmentRecord) => void
  onMention: (attachment: AttachmentRecord) => void
  onDelete: (attachment: AttachmentRecord) => void
}) {
  if (!sessionId) {
    return <p className="muted-copy">Select a session to manage attachments.</p>
  }
  if (attachments.length === 0 && !uploadingName) {
    return <p className="muted-copy">No attachments yet.</p>
  }

  return (
    <ul className="attachment-list">
      {uploadingName && (
        <li className="attachment-progress uploading" aria-busy="true">
          <span className="file-kind">
            <i className="ri-upload-cloud-2-line" aria-hidden="true" />
          </span>
          <span>
            <strong>{uploadingName}</strong>
            <small>Uploading</small>
          </span>
          <div className="attachment-inline-progress" role="progressbar" aria-label={`Uploading ${uploadingName}`} aria-valuetext="Uploading">
            <span />
          </div>
        </li>
      )}
      {attachments.map((attachment) => {
        const deleting = deletingAttachmentIds.includes(attachment.id)
        return (
          <li className={deleting ? 'is-deleting' : ''} key={attachment.id} aria-busy={deleting || undefined}>
            <AttachmentListItemMain
              sessionId={sessionId}
              attachment={attachment}
              deleting={deleting}
              onPreview={onPreview}
            />
            <button type="button" className="attachment-mention-button" disabled={deleting} onClick={() => onMention(attachment)} title={`Add mention ${attachment.originalName}`} aria-label={`Add attachment mention ${attachment.originalName}`}>
              <i className="ri-at-line" aria-hidden="true" />
            </button>
            <button type="button" className="attachment-delete-button" disabled={deleting} onClick={() => onDelete(attachment)} title={`Delete ${attachment.originalName}`} aria-label={`Delete attachment ${attachment.originalName}`}>
              <i className={deleting ? 'ri-loader-4-line spinning' : 'ri-delete-bin-6-line'} aria-hidden="true" />
            </button>
            {deleting && (
              <div className="attachment-inline-progress" role="progressbar" aria-label={`Deleting ${attachment.originalName}`} aria-valuetext="Deleting">
                <span />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function AttachmentListItemMain({
  sessionId,
  attachment,
  deleting,
  onPreview,
}: {
  sessionId: string
  attachment: AttachmentRecord
  deleting: boolean
  onPreview: (attachment: AttachmentRecord) => void
}) {
  const [dimensions, setDimensions] = useState({ width: 1200, height: 900 })
  const url = attachmentUrl(sessionId, attachment.id)
  const meta = deleting ? 'Deleting' : formatBytes(attachment.sizeBytes)
  const content = (
    <>
      <AttachmentThumbnail
        sessionId={sessionId}
        attachment={attachment}
        onImageLoad={(image) => {
          if (image.naturalWidth > 0 && image.naturalHeight > 0) {
            setDimensions({ width: image.naturalWidth, height: image.naturalHeight })
          }
        }}
      />
      <span>
        <strong>{attachment.originalName}</strong>
        <small>{meta}</small>
      </span>
    </>
  )

  if (attachment.mimeType.startsWith('image/')) {
    return (
      <a
        className="attachment-main"
        href={url}
        data-pswp-width={dimensions.width}
        data-pswp-height={dimensions.height}
        target="_blank"
        rel="noreferrer"
        title={`Preview ${attachment.originalName}`}
        aria-label={`Preview ${attachment.originalName}`}
        onClick={(event) => {
          if (deleting) event.preventDefault()
        }}
      >
        {content}
      </a>
    )
  }

  return (
    <button type="button" className="attachment-main" onClick={() => onPreview(attachment)} disabled={deleting}>
      {content}
    </button>
  )
}

function AttachmentThumbnail({
  sessionId,
  attachment,
  onImageLoad,
}: {
  sessionId: string
  attachment: AttachmentRecord
  onImageLoad?: (image: HTMLImageElement) => void
}) {
  if (attachment.mimeType.startsWith('image/')) {
    return (
      <span className="attachment-thumb">
        <img src={attachmentUrl(sessionId, attachment.id)} alt="" onLoad={(event) => onImageLoad?.(event.currentTarget)} />
      </span>
    )
  }

  return <span className="file-kind">{attachmentKind(attachment)}</span>
}

function AttachmentPreview({
  sessionId,
  attachment,
  onClose,
}: {
  sessionId: string
  attachment: AttachmentRecord
  onClose: () => void
}) {
  const url = attachmentUrl(sessionId, attachment.id)
  const isImage = attachment.mimeType.startsWith('image/')
  const isVideo = attachment.mimeType.startsWith('video/')
  const isAudio = attachment.mimeType.startsWith('audio/')
  const canFrame = attachment.mimeType === 'application/pdf' || attachment.mimeType.startsWith('text/')

  return (
    <div className="preview-backdrop" onClick={onClose} role="presentation">
      <div className="preview-screen-chrome" onClick={(event) => event.stopPropagation()}>
        <div className="preview-screen-title">
          <h2>{attachment.originalName}</h2>
          <p>{attachment.mimeType} / {formatBytes(attachment.sizeBytes)}</p>
        </div>
        <div className="preview-screen-actions" aria-label="Attachment preview actions">
          <a href={url} target="_blank" rel="noreferrer" title="Open attachment" aria-label="Open attachment">
            <i className="ri-external-link-line" aria-hidden="true" />
          </a>
          <a href={url} download={attachment.originalName} title="Download attachment" aria-label="Download attachment">
            <i className="ri-download-2-line" aria-hidden="true" />
          </a>
          <button type="button" onClick={onClose} title="Close preview" aria-label="Close preview">
            <i className="ri-close-line" aria-hidden="true" />
          </button>
        </div>
      </div>
      <section className="preview-dialog" onClick={(event) => event.stopPropagation()} aria-label={attachment.originalName}>
        <div className="preview-body">
          {isImage ? (
            <img src={url} alt={attachment.originalName} />
          ) : isVideo ? (
            <video src={url} controls />
          ) : isAudio ? (
            <audio src={url} controls />
          ) : canFrame ? (
            <iframe src={url} title={attachment.originalName} />
          ) : (
            <div className="file-fallback">
              <strong>{attachmentKind(attachment)} file</strong>
              <span>{attachment.storedName}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function sessionLabel(session: Pick<SessionRecord, 'displayName' | 'codexThreadId'>): string {
  return session.displayName?.trim() || shortThreadId(session.codexThreadId)
}

function sessionSummariesSignature(sessions: SessionSummary[]): string {
  return sessions
    .map((session) => [
      session.id,
      session.status,
      session.updatedAt,
      session.latestConclusion,
      session.attachmentCount,
      session.queuedInstructionCount,
      session.consumedInstructionCount,
      session.messageCount,
    ].join(':'))
    .join('|')
}

function sessionDetailSignature(session: SessionDetail): string {
  return [
    session.id,
    session.status,
    session.updatedAt,
    session.messages.length,
    session.conclusions.length,
    session.instructions.length,
    session.attachments.length,
  ].join(':')
}

function codexUsageSignature(usage: CodexLiveContextUsage | null): string {
  if (!usage) return ''
  return [
    usage.timestamp,
    usage.contextWindow,
    usage.usedTokens,
    usage.remainingTokens,
    usage.percentUsed,
    usage.rateLimits?.primary?.usedPercent ?? '',
    usage.rateLimits?.primary?.resetsAtIso ?? '',
    usage.rateLimits?.secondary?.usedPercent ?? '',
    usage.rateLimits?.secondary?.resetsAtIso ?? '',
  ].join(':')
}

function codexActivitySignature(activity: CodexLiveActivity): string {
  return `${activity.latestEventAt ?? ''}:${activity.latestRecordType}:${activity.hasRolloutActivity}`
}

function codexThinkingSignature(records: CodexLiveRecord[]): string {
  return records.map((record) => `${record.id}:${record.text.length}:${record.timestamp}`).join('|')
}

function shortThreadId(threadId: string): string {
  return threadId.length > 18 ? `${threadId.slice(0, 8)}...${threadId.slice(-6)}` : threadId
}

function usageLimitCards(usage: CodexLiveContextUsage) {
  const primary = usage.rateLimits?.primary
  const secondary = usage.rateLimits?.secondary
  return [
    primary ? {
      key: 'primary',
      label: formatLimitName(primary.windowMinutes, '5h'),
      value: `${formatPercent(primary.remainingPercent)} left`,
      detail: formatLimitReset(primary.resetsAtIso),
      percent: primary.usedPercent,
    } : {
      key: 'primary',
      label: '5h',
      value: '...',
      detail: 'Waiting for limit data',
      percent: 0,
    },
    secondary ? {
      key: 'secondary',
      label: formatLimitName(secondary.windowMinutes, 'Weekly'),
      value: `${formatPercent(secondary.remainingPercent)} left`,
      detail: formatLimitReset(secondary.resetsAtIso),
      percent: secondary.usedPercent,
    } : {
      key: 'secondary',
      label: 'Weekly',
      value: '...',
      detail: 'Waiting for limit data',
      percent: 0,
    },
  ]
}

function botVisualState(status: SessionStatus, activity: CodexLiveActivity): 'thinking' | 'stopped' | 'error' {
  if (status === 'ERROR') return 'error'
  if (status === 'RUNNING' || (status !== 'WAITING_FOR_INSTRUCTION' && isRecentActivity(activity.latestEventAt))) return 'thinking'
  return 'stopped'
}

function isRecentActivity(value: string | null): boolean {
  if (!value) return false
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return false
  return Math.abs(Date.now() - timestamp) <= 90_000
}

function findMentionRange(value: string, caretIndex: number): MentionRange | null {
  const prefix = value.slice(0, caretIndex)
  const match = /(^|\s)@([^\s@]*)$/.exec(prefix)
  if (!match) return null
  const query = match[2] ?? ''
  return {
    start: caretIndex - query.length - 1,
    end: caretIndex,
    query,
  }
}

function hasAttachmentMention(value: string, attachmentName: string): boolean {
  const escaped = attachmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`).test(value)
}

function removeAttachmentMention(value: string, attachmentName: string): string {
  const escaped = attachmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value
    .replace(new RegExp(`(^|\\s)@${escaped}(?=\\s|$)`, 'g'), (_match, prefix: string) => prefix)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/^\s+/, '')
}

function appendAttachmentMention(value: string, attachmentName: string): string {
  if (hasAttachmentMention(value, attachmentName)) return value
  const separator = value.trim().length === 0
    ? ''
    : /\s$/.test(value)
      ? ''
      : '\n\n'
  return `${value}${separator}@${attachmentName} `
}

function isScrolledNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.append(textarea)
  textarea.select()
  try {
    document.execCommand('copy')
  } finally {
    textarea.remove()
  }
}

function uniqueAttachmentsByName(attachments: AttachmentRecord[]): AttachmentRecord[] {
  const byName = new Map<string, AttachmentRecord>()
  for (const attachment of attachments) {
    byName.set(attachment.originalName, attachment)
  }
  return Array.from(byName.values())
}

function resizeTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return
  textarea.style.height = '0px'
  textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
}

function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
}

function clipboardFiles(data: DataTransfer): File[] {
  const directFiles = Array.from(data.files ?? []).filter((file) => file.size > 0)
  if (directFiles.length > 0) return directFiles.map(nameClipboardAttachment)

  return Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file && file.size > 0))
    .map(nameClipboardAttachment)
}

function nameClipboardAttachment(file: File): File {
  if (file.name) return file

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

function messagePreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) return 'Empty message'
  return normalized.length > 88 ? `${normalized.slice(0, 85).trimEnd()}...` : normalized
}

function formatLimitName(windowMinutes: number, fallback: string): string {
  if (windowMinutes === 300) return '5h'
  if (windowMinutes === 10_080) return 'Weekly'
  if (windowMinutes > 0 && windowMinutes % 10_080 === 0) return `${windowMinutes / 10_080}w`
  if (windowMinutes > 0 && windowMinutes % 1_440 === 0) return `${windowMinutes / 1_440}d`
  if (windowMinutes > 0 && windowMinutes % 60 === 0) return `${windowMinutes / 60}h`
  return fallback
}

function formatLimitReset(value: string): string {
  if (!value) return 'Reset unavailable'
  return `Resets ${formatDateTime(value)}`
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(Math.round(value))
}

function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function formatStatus(status: SessionStatus): string {
  return status.replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\w/g, (match) => match.toUpperCase())
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function attachmentKind(attachment: AttachmentRecord): string {
  if (attachment.mimeType.startsWith('image/')) return 'IMG'
  if (attachment.mimeType.startsWith('video/')) return 'VID'
  if (attachment.mimeType.startsWith('audio/')) return 'AUD'
  if (attachment.mimeType.includes('pdf')) return 'PDF'
  if (attachment.mimeType.startsWith('text/')) return 'TXT'
  return 'FILE'
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const value = window.localStorage.getItem(key)
    if (value === 'true') return true
    if (value === 'false') return false
    return fallback
  } catch {
    return fallback
  }
}

function writeStoredBoolean(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // Local storage is optional for layout preferences.
  }
}

function draftStorageKey(sessionId: string): string {
  return `${DRAFT_STORAGE_PREFIX}${sessionId}`
}

function readStoredDraft(sessionId: string | null): string {
  if (!sessionId) return ''
  try {
    return window.localStorage.getItem(draftStorageKey(sessionId)) ?? ''
  } catch {
    return ''
  }
}

function writeStoredDraft(sessionId: string, value: string): void {
  try {
    if (value) {
      window.localStorage.setItem(draftStorageKey(sessionId), value)
      return
    }
    window.localStorage.removeItem(draftStorageKey(sessionId))
  } catch {
    // Draft persistence is a convenience feature only.
  }
}

function clearStoredDraft(sessionId: string): void {
  try {
    window.localStorage.removeItem(draftStorageKey(sessionId))
  } catch {
    // Draft persistence is a convenience feature only.
  }
}

async function waitForMinimumElapsed(startedAt: number, minimumMs: number): Promise<void> {
  const remainingMs = minimumMs - (Date.now() - startedAt)
  if (remainingMs <= 0) return
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, remainingMs)
  })
}

function isComposerTextareaFocused(): boolean {
  const activeElement = document.activeElement
  return activeElement instanceof HTMLTextAreaElement && activeElement.closest('.composer') !== null
}
