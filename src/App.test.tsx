import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { ManagerSnapshot, Snapshot } from './shared/protocol'

class MockEventSource {
  static instances: MockEventSource[] = []

  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>()

  constructor(readonly url: string) {
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  close() {}

  open() {
    this.onopen?.()
  }

  fail() {
    this.onerror?.()
  }

  emitSnapshot(snapshot: ManagerSnapshot) {
    const event = { data: JSON.stringify(snapshot) } as MessageEvent
    for (const listener of this.listeners.get('snapshot') ?? []) {
      listener(event)
    }
  }
}

beforeEach(() => {
  MockEventSource.instances = []
  window.localStorage.clear()
  vi.stubGlobal('EventSource', MockEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      if (requestUrl === '/api/snapshot') {
        return jsonResponse(managerFactory())
      }

      if (requestUrl.includes('/api/runs/run-a/snapshot')) {
        return jsonResponse(snapshotFactory({
          runId: 'run-a',
          displayName: 'Run A',
          outputMd: '## Draft A\n\nReady for review.',
          attachments: [attachmentFactory('existing.png')],
        }))
      }

      if (requestUrl.includes('/api/runs/run-b/snapshot')) {
        return jsonResponse(snapshotFactory({
          runId: 'run-b',
          displayName: 'Run B',
          status: 'INSTRUCTION_RECEIVED',
          outputMd: '## Draft B\n\nInstruction packet.',
        }))
      }

      if (requestUrl === '/api/runs/run-a/files/output.md') {
        const content = '## File Preview\n\nReady for preview.'
        return jsonResponse({
          ok: true,
          fileName: 'output.md',
          content,
          truncated: false,
          size: content.length,
        })
      }

      if (requestUrl === '/api/runs/run-a/messages' && init?.method === 'DELETE') {
        const snapshot = snapshotFactory({
          runId: 'run-a',
          displayName: 'Run A',
          outputMd: '## Draft A\n\nReady for review.',
          messages: [],
          attachments: [attachmentFactory('existing.png')],
        })
        snapshot.files['session.md'] = fileMeta(true)
        return jsonResponse({
          ok: true,
          snapshot,
        })
      }

      if (requestUrl === '/api/runs/run-a/stop' && init?.method === 'POST') {
        return jsonResponse({
          ok: true,
          snapshot: snapshotFactory({
            runId: 'run-a',
            displayName: 'Run A',
            status: 'INSTRUCTION_RECEIVED',
            instruction: 'Stop this Codex Pro Max HITL session now.\n',
            messages: [
              {
                id: 'stop-1',
                role: 'user',
                content: 'Stop this Codex Pro Max HITL session now.',
                createdAtIso: '2026-05-07T00:00:03.000Z',
              },
            ],
          }),
        })
      }

      if (requestUrl === '/api/runs/run-a/attachments/existing.png' && init?.method === 'DELETE') {
        return jsonResponse({
          ok: true,
          snapshot: snapshotFactory({
            runId: 'run-a',
            displayName: 'Run A',
            attachments: [],
          }),
        })
      }

      if (requestUrl === '/api/runs/run-a' && init?.method === 'DELETE') {
        return jsonResponse({
          ok: true,
          snapshot: managerFactory({
            runs: [
              {
                runId: 'run-b',
                displayName: 'Run B',
                rootPath: 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-b',
                status: 'INSTRUCTION_RECEIVED',
                owner: 'ui',
                updatedAtIso: '2026-05-07T00:00:02.000Z',
                updatedAtMs: 2,
                outputPreview: 'Instruction packet.',
                attachmentCount: 0,
                hasInstruction: false,
                isLegacy: false,
              },
            ],
            selectedRunId: 'run-b',
          }),
        })
      }

      if (requestUrl.includes('/api/runs/') && requestUrl.includes('/action')) {
        const body = JSON.parse(String(init?.body)) as { instruction: string }
        return jsonResponse({
          ok: true,
          snapshot: snapshotFactory({
            runId: 'run-a',
            displayName: 'Run A',
            status: 'INSTRUCTION_RECEIVED',
            messages: [
              {
                id: 'user-action-1',
                role: 'user',
                content: body.instruction,
                createdAtIso: '2026-05-07T00:00:04.000Z',
              },
            ],
          }),
        })
      }

      if (requestUrl.includes('/api/runs/') && requestUrl.includes('/upload')) {
        const attachment = attachmentFactory('uploaded.png')
        return jsonResponse({
          ok: true,
          attachment,
          snapshot: snapshotFactory({
            attachments: [attachment],
          }),
        })
      }

      return jsonResponse({ ok: false, error: `Unhandled request: ${requestUrl}` }, 500)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('renders multiple runs and selected output markdown', async () => {
    render(<App />)
    await getEventSource()

    expect(await screen.findByRole('button', { name: /Run A/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Draft A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run A/i }).querySelector('.run-status-waiting-for-review')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run A/i }).querySelector('.run-status-review-orb')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run A/i }).querySelector('.ri-question-answer-line')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.run-status-instruction-received')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.run-status-success-wrapper')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.run-status-success-check')).toHaveAttribute('d', 'M16 26 L22 32 L34 18')
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.ri-inbox-archive-line')).not.toBeInTheDocument()
  })

  it('uses the smooth svg spinner for running runs', async () => {
    const manager = managerFactory()
    manager.runs[0] = {
      ...manager.runs[0],
      status: 'RUNNING',
      owner: 'agent',
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(manager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'RUNNING' })))

    render(<App />)
    await getEventSource()

    const runButton = await screen.findByRole('button', { name: /Run A/i })
    const spinner = runButton.querySelector('svg.run-status-spinner')
    expect(spinner).toBeInTheDocument()
    expect(spinner?.querySelector('circle')).toHaveAttribute('r', '20')
    expect(runButton.querySelector('.ri-loader-4-line')).not.toBeInTheDocument()
  })

  it('persists collapsed sidebar state across remounts', async () => {
    const { unmount } = render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /toggle runs/i }))
    fireEvent.click(await screen.findByRole('button', { name: /toggle protocol details/i }))

    expect(screen.getByLabelText('Run inbox')).toHaveClass('collapsed')
    expect(screen.getByLabelText('Protocol details')).toHaveClass('collapsed')
    expect(window.localStorage.getItem('codex-pro-max:left-sidebar-collapsed')).toBe('true')
    expect(window.localStorage.getItem('codex-pro-max:right-sidebar-collapsed')).toBe('true')

    unmount()
    MockEventSource.instances = []
    render(<App />)
    await getEventSource()

    expect(screen.getByLabelText('Run inbox')).toHaveClass('collapsed')
    expect(screen.getByLabelText('Protocol details')).toHaveClass('collapsed')
  })

  it('opens the left sidebar profile menu', async () => {
    render(<App />)
    await getEventSource()

    const profileButton = await screen.findByRole('button', { name: /open profile menu/i })
    expect(profileButton).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(profileButton)

    expect(profileButton).toHaveAttribute('aria-expanded', 'true')
    const profileMenu = screen.getByRole('menu', { name: 'Profile menu' })
    expect(within(profileMenu).getByText('Ramlyburger')).toBeInTheDocument()
    expect(within(profileMenu).getByText('Pro Max')).toBeInTheDocument()
    expect(within(profileMenu).getByRole('menuitem', { name: /Add teammates/i })).toBeInTheDocument()
    expect(within(profileMenu).getByRole('menuitem', { name: /Workspace settings/i })).toBeInTheDocument()
    const logoutButton = within(profileMenu).getByRole('menuitem', { name: /Log out/i })
    expect(logoutButton.querySelector('.profile-menu-chevron')).not.toBeInTheDocument()

    fireEvent.click(logoutButton)

    expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()
    const logoutError = screen.getByRole('dialog', { name: 'Unable to logout' })
    expect(logoutError.closest('.left-sidebar')).toBeNull()
    expect(logoutError.closest('.preview-backdrop')?.parentElement).toBe(document.body)
    expect(within(logoutError).getByRole('img', { name: /unable to logout sticker/i })).toHaveAttribute(
      'src',
      'https://media.tenor.com/fTH4D95V-oQAAAAi/quby.gif',
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Unable to logout' })).not.toBeInTheDocument()

    fireEvent.click(profileButton)
    expect(screen.getByRole('menu', { name: 'Profile menu' })).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()

    fireEvent.click(profileButton)
    const reopenedProfileMenu = screen.getByRole('menu', { name: 'Profile menu' })
    fireEvent.click(within(reopenedProfileMenu).getByRole('menuitem', { name: /^Settings$/i }))
    expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()
  })

  it('persists right sidebar section collapse state across remounts', async () => {
    const { unmount } = render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    expect(await within(sidebar).findByRole('button', { name: 'Protocol Files' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(await within(sidebar).findByRole('button', { name: 'Outlines' }))
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Protocol Files' }))
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Attachments' }))

    expect(within(sidebar).getByRole('button', { name: 'Outlines' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(sidebar).getByRole('button', { name: 'Protocol Files' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(sidebar).getByRole('button', { name: 'Attachments' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(sidebar).queryByText('No user messages yet.')).not.toBeInTheDocument()
    expect(window.localStorage.getItem('codex-pro-max:right-sidebar-outlines-collapsed')).toBe('true')
    expect(window.localStorage.getItem('codex-pro-max:right-sidebar-protocol-files-collapsed:v2')).toBe('false')
    expect(window.localStorage.getItem('codex-pro-max:right-sidebar-attachments-collapsed')).toBe('true')

    unmount()
    MockEventSource.instances = []
    render(<App />)
    await getEventSource()

    const remountedSidebar = screen.getByLabelText('Protocol details')
    expect(within(remountedSidebar).getByRole('button', { name: 'Outlines' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(remountedSidebar).getByRole('button', { name: 'Protocol Files' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(remountedSidebar).getByRole('button', { name: 'Attachments' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('shows user messages as outlines, highlights by chat position, and jumps to a selected message', async () => {
    const messages: Snapshot['messages'] = Array.from({ length: 12 }, (_, index) => ({
      id: `user-${index + 1}`,
      role: 'user',
      content: `User request ${index + 1}`,
      createdAtIso: `2026-05-07T00:${String(index).padStart(2, '0')}:00.000Z`,
    }))
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ messages })))

    try {
      render(<App />)
      await getEventSource()

      const sidebar = screen.getByLabelText('Protocol details')
      expect(await within(sidebar).findByRole('heading', { name: 'Outlines' })).toBeInTheDocument()
      expect(within(sidebar).getByRole('button', { name: /User request 2/i })).toBeInTheDocument()
      expect(within(sidebar).getByRole('button', { name: /User request 3/i })).toBeInTheDocument()

      const scrollPane = screen.getByTestId('chat-scroll')
      const userBubble = (text: string) => within(scrollPane).getByText(text).closest('.user-bubble') as HTMLElement
      const outlineList = screen.getByTestId('outline-list')
      setScrollMetrics(scrollPane, {
        clientHeight: 300,
        scrollHeight: 900,
        scrollTop: 300,
      })
      setScrollMetrics(outlineList, {
        clientHeight: 80,
        scrollHeight: 400,
        scrollTop: 220,
      })
      mockElementRect(scrollPane, { top: 0, bottom: 300 })
      mockElementRect(outlineList, { top: 0, bottom: 80 })
      mockElementRect(within(sidebar).getByRole('button', { name: /User request 3/i }), { top: -140, bottom: -112 })
      mockElementRect(within(sidebar).getByRole('button', { name: /User request 4/i }), { top: 64, bottom: 96 })
      mockElementRect(userBubble('User request 1'), { top: -260, bottom: -120 })
      mockElementRect(userBubble('User request 2'), { top: -80, bottom: 60 })
      mockElementRect(userBubble('User request 3'), { top: 40, bottom: 180 })
      mockElementRect(userBubble('User request 4'), { top: 330, bottom: 470 })
      for (let index = 5; index <= 12; index += 1) {
        mockElementRect(userBubble(`User request ${index}`), { top: 520 + index * 20, bottom: 660 + index * 20 })
      }
      fireEvent.scroll(scrollPane)

      await waitFor(() =>
        expect(within(sidebar).getByRole('button', { name: /User request 3/i })).toHaveClass('active'),
      )
      await waitFor(() => expect(outlineList.scrollTop).toBe(260))

      mockElementRect(userBubble('User request 4'), { top: 220, bottom: 360 })
      mockElementRect(userBubble('User request 5'), { top: 420, bottom: 560 })
      fireEvent.scroll(scrollPane)

      await waitFor(() =>
        expect(within(sidebar).getByRole('button', { name: /User request 3/i })).toHaveClass('active'),
      )

      scrollPane.scrollTop = 260
      mockElementRect(userBubble('User request 3'), { top: 40, bottom: 180 })
      mockElementRect(userBubble('User request 4'), { top: 110, bottom: 250 })
      fireEvent.scroll(scrollPane)

      await waitFor(() =>
        expect(within(sidebar).getByRole('button', { name: /User request 4/i })).toHaveClass('active'),
      )
      await waitFor(() => expect(outlineList.scrollTop).toBe(276))

      mockElementRect(userBubble('User request 4'), { top: 150, bottom: 290 })
      fireEvent.scroll(scrollPane)

      await waitFor(() =>
        expect(within(sidebar).getByRole('button', { name: /User request 4/i })).toHaveClass('active'),
      )

      scrollPane.scrollTop = 240
      mockElementRect(userBubble('User request 3'), { top: -30, bottom: 110 })
      mockElementRect(userBubble('User request 4'), { top: 180, bottom: 320 })
      fireEvent.scroll(scrollPane)

      await waitFor(() =>
        expect(within(sidebar).getByRole('button', { name: /User request 4/i })).toHaveClass('active'),
      )

      scrollPane.scrollTop = 220
      mockElementRect(within(sidebar).getByRole('button', { name: /User request 3/i }), { top: 20, bottom: 48 })
      mockElementRect(userBubble('User request 3'), { top: 20, bottom: 160 })
      mockElementRect(userBubble('User request 4'), { top: 230, bottom: 370 })
      fireEvent.scroll(scrollPane)

      await waitFor(() =>
        expect(within(sidebar).getByRole('button', { name: /User request 3/i })).toHaveClass('active'),
      )

      outlineList.scrollTop = 320
      fireEvent.scroll(outlineList)
      scrollPane.scrollTop = 600
      mockElementRect(userBubble('User request 12'), { top: 520, bottom: 660 })
      fireEvent.scroll(scrollPane)

      await waitFor(() =>
        expect(within(sidebar).getByRole('button', { name: /User request 12/i })).toHaveClass('active'),
      )
      await waitFor(() => expect(outlineList.scrollTop).toBe(400))

      fireEvent.click(within(sidebar).getByRole('button', { name: /User request 12/i }))

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    } finally {
      Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
  })

  it('keeps the latest outline visible when the chat is at bottom', async () => {
    const initialMessages: Snapshot['messages'] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'First outline',
        createdAtIso: '2026-05-07T00:00:01.000Z',
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'Second outline',
        createdAtIso: '2026-05-07T00:00:02.000Z',
      },
    ]
    const nextMessages: Snapshot['messages'] = [
      ...initialMessages,
      {
        id: 'user-3',
        role: 'user',
        content: 'Third outline',
        createdAtIso: '2026-05-07T00:00:03.000Z',
      },
    ]
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ messages: initialMessages })))

    render(<App />)
    await getEventSource()

    const outlineList = await screen.findByTestId('outline-list')
    const metrics = setScrollMetrics(outlineList, {
      clientHeight: 80,
      scrollHeight: 180,
      scrollTop: 100,
    })
    fireEvent.scroll(outlineList)
    metrics.setScrollHeight(260)
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      snapshot: snapshotFactory({ messages: nextMessages }),
    }))

    fireEvent.change(await screen.findByLabelText('Instruction'), {
      target: { value: 'Third outline' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send to codex/i }))

    expect(await within(screen.getByTestId('chat-scroll')).findByText('Third outline')).toBeInTheDocument()
    await waitFor(() => expect(outlineList.scrollTop).toBe(260))

    outlineList.scrollTop = 40
    fireEvent.scroll(outlineList)
    metrics.setScrollHeight(320)
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      snapshot: snapshotFactory({
        messages: [
          ...nextMessages,
          {
            id: 'user-4',
            role: 'user',
            content: 'Fourth outline',
            createdAtIso: '2026-05-07T00:00:04.000Z',
          },
        ],
      }),
    }))

    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Fourth outline' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send to codex/i }))

    expect(await within(screen.getByTestId('chat-scroll')).findByText('Fourth outline')).toBeInTheDocument()
    await waitFor(() => expect(outlineList.scrollTop).toBe(320))
  })

  it('reveals the latest outline again when the chat scrolls back to bottom', async () => {
    const messages: Snapshot['messages'] = Array.from({ length: 4 }, (_, index) => ({
      id: `user-${index + 1}`,
      role: 'user',
      content: `Bottom sync request ${index + 1}`,
      createdAtIso: `2026-05-07T00:0${index}:00.000Z`,
    }))
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ messages })))

    render(<App />)
    await getEventSource()

    const scrollPane = screen.getByTestId('chat-scroll')
    const outlineList = await screen.findByTestId('outline-list')
    setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 400,
      scrollTop: 300,
    })
    setScrollMetrics(outlineList, {
      clientHeight: 80,
      scrollHeight: 260,
      scrollTop: 180,
    })

    fireEvent.scroll(scrollPane)

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Bottom sync request 4/i })).toHaveClass('active'),
    )
    await waitFor(() => expect(outlineList.scrollTop).toBe(260))

    outlineList.scrollTop = 20
    fireEvent.scroll(outlineList)

    scrollPane.scrollTop = 240
    fireEvent.scroll(scrollPane)
    expect(outlineList.scrollTop).toBe(20)

    scrollPane.scrollTop = 300
    fireEvent.scroll(scrollPane)

    await waitFor(() => expect(outlineList.scrollTop).toBe(260))
  })

  it('selects a different run and switches detail content', async () => {
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /Run B/i }))

    expect(await screen.findByRole('heading', { name: 'Draft B' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.run-status-instruction-received')).toBeInTheDocument()
  })

  it('deletes a run through the selected run endpoint', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /delete run-a/i }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete run' })).getByRole('button', { name: 'Delete run' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a', {
        method: 'DELETE',
      }),
    )
  })

  it('disables sending until an instruction is present', async () => {
    render(<App />)
    await getEventSource()

    const sendButton = await screen.findByRole('button', { name: /send to codex/i })
    expect(sendButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Tighten the conclusion.' },
    })

    expect(sendButton).toBeEnabled()
  })

  it('sends new instructions to the selected run endpoint', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    fireEvent.change(await screen.findByLabelText('Instruction'), {
      target: { value: 'Keep waiting and start the next task.' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /send to codex/i }))

    expect(await screen.findByTestId('ai-loading-indicator')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/runs/run-a/action',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          instruction: 'Keep waiting and start the next task.',
        }),
      }),
    )
  })

  it('shows Codex loading below the latest user message and queues sends while working', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.change(input, {
      target: { value: 'Continue the implementation.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send to codex/i }))

    expect(await within(screen.getByTestId('chat-scroll')).findByText('Continue the implementation.')).toBeInTheDocument()
    expect(screen.getByTestId('ai-loading-indicator')).toBeInTheDocument()

    fireEvent.change(input, {
      target: { value: 'Second instruction while busy.' },
    })

    const queueButton = screen.getByRole('button', { name: /queue for review/i })
    expect(queueButton).toBeEnabled()
    fireEvent.click(queueButton)

    const queuedMessages = await screen.findByLabelText('Queued messages')
    expect(within(queuedMessages).getByText('Second instruction while busy.')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/action'))).toHaveLength(1)
  })

  it('allows queued messages to be edited, deleted, and requeued at the end', async () => {
    const manager = managerFactory()
    manager.runs[0] = {
      ...manager.runs[0],
      status: 'RUNNING',
      owner: 'agent',
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(manager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'RUNNING' })))

    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.change(input, {
      target: { value: 'First queued instruction.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))
    fireEvent.change(input, {
      target: { value: 'Second queued instruction.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))

    const queuedMessages = await screen.findByLabelText('Queued messages')
    fireEvent.click(within(queuedMessages).getByRole('button', { name: /edit queued message 1/i }))

    expect(input).toHaveValue('First queued instruction.')
    expect(within(queuedMessages).queryByText('First queued instruction.')).not.toBeInTheDocument()
    expect(within(queuedMessages).getByText('Second queued instruction.')).toBeInTheDocument()

    fireEvent.change(input, {
      target: { value: 'First queued instruction edited.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))

    const queueItems = within(queuedMessages).getAllByRole('article', { name: /queued message/i })
    expect(queueItems).toHaveLength(2)
    expect(queueItems[0]).toHaveTextContent('Second queued instruction.')
    expect(queueItems[1]).toHaveTextContent('First queued instruction edited.')

    fireEvent.click(within(queuedMessages).getByRole('button', { name: /delete queued message 1/i }))

    expect(within(queuedMessages).queryByText('Second queued instruction.')).not.toBeInTheDocument()
    expect(within(queuedMessages).getByText('First queued instruction edited.')).toBeInTheDocument()
  })

  it('preserves queued messages across a page refresh', async () => {
    const manager = managerFactory()
    manager.runs[0] = {
      ...manager.runs[0],
      status: 'RUNNING',
      owner: 'agent',
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(manager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'RUNNING' })))

    const { unmount } = render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.change(input, {
      target: { value: 'Persist this queued instruction.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))

    expect(await screen.findByLabelText('Queued messages')).toHaveTextContent('Persist this queued instruction.')
    await waitFor(() =>
      expect(window.localStorage.getItem('codex-pro-max:queued-instructions:v1')).toContain(
        'Persist this queued instruction.',
      ),
    )

    unmount()
    MockEventSource.instances = []
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(manager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'RUNNING' })))

    render(<App />)
    await getEventSource()

    expect(await screen.findByLabelText('Queued messages')).toHaveTextContent('Persist this queued instruction.')
  })

  it('automatically sends the next queued message when the run returns to review', async () => {
    const fetchMock = vi.mocked(fetch)
    const runningManager = managerFactory()
    runningManager.runs[0] = {
      ...runningManager.runs[0],
      status: 'RUNNING',
      owner: 'agent',
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(runningManager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'RUNNING' })))

    render(<App />)
    const events = await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.change(input, {
      target: { value: 'Queued once Codex is ready.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))

    const reviewManager = managerFactory({
      health: {
        rootExists: true,
        watcherReady: true,
        serverTimeIso: '2026-05-07T00:00:05.000Z',
      },
    })

    act(() => {
      events.emitSnapshot(reviewManager)
    })

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            instruction: 'Queued once Codex is ready.',
          }),
        }),
      ),
    )
    await waitFor(() => expect(screen.queryByLabelText('Queued messages')).not.toBeInTheDocument())
  })

  it('sends queued messages for a non-selected run in the background', async () => {
    const fetchMock = vi.mocked(fetch)
    const runningManager = managerFactory()
    runningManager.runs[0] = {
      ...runningManager.runs[0],
      status: 'RUNNING',
      owner: 'agent',
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(runningManager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'RUNNING' })))

    render(<App />)
    const events = await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.change(input, {
      target: { value: 'Run A queued while I inspect another run.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))
    fireEvent.click(screen.getByRole('button', { name: /Run B/i }))

    expect(await screen.findByRole('heading', { name: 'Draft B' })).toBeInTheDocument()

    const reviewManager = managerFactory({
      selectedRunId: 'run-b',
      health: {
        rootExists: true,
        watcherReady: true,
        serverTimeIso: '2026-05-07T00:00:06.000Z',
      },
    })

    act(() => {
      events.emitSnapshot(reviewManager)
    })

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            instruction: 'Run A queued while I inspect another run.',
          }),
        }),
      ),
    )
    expect(screen.queryByLabelText('Queued messages')).not.toBeInTheDocument()
  })

  it('clears conversation history without deleting the selected run', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    expect(await screen.findByRole('heading', { name: 'Draft A' })).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: /clear conversation history/i }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Clear conversation history' }))
        .getByRole('button', { name: 'Clear history' }),
    )

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/messages', {
        method: 'DELETE',
      }),
    )
    expect(await screen.findByRole('heading', { name: 'No conversation history' })).toBeInTheDocument()
    expect(screen.getByLabelText('Empty conversation history').querySelector('.bot-avatar img')).toHaveAttribute(
      'src',
      '/codex-color.png',
    )
    expect(screen.queryByRole('heading', { name: 'Draft A' })).not.toBeInTheDocument()
  })

  it('closes confirmation dialogs with Escape', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /clear conversation history/i }))

    expect(await screen.findByRole('dialog', { name: 'Clear conversation history' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: 'Clear conversation history' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/runs/run-a/messages', { method: 'DELETE' })
  })

  it('requests a session stop through the header button', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /stop session/i }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Stop Codex' })).getByRole('button', { name: 'Continue' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Confirm stop' })).getByRole('button', { name: 'Stop session' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/stop', {
        method: 'POST',
      }),
    )
    expect(within(screen.getByTestId('chat-scroll')).getByText('Stop this Codex Pro Max HITL session now.')).toBeInTheDocument()
  })

  it('enables stop session only while waiting for review', async () => {
    render(<App />)
    await getEventSource()

    const stopButton = await screen.findByRole('button', { name: /stop session/i })
    expect(stopButton).toBeEnabled()

    fireEvent.click(await screen.findByRole('button', { name: /Run B/i }))

    expect(await screen.findByRole('heading', { name: 'Draft B' })).toBeInTheDocument()
    expect(stopButton).toBeDisabled()
  })

  it('inserts highlighted attachment mentions from the composer at-menu', async () => {
    const { container } = render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    const value = 'Review @ex'
    fireEvent.change(input, {
      target: { value },
    })
    const textarea = input as HTMLTextAreaElement
    textarea.setSelectionRange(value.length, value.length)
    fireEvent.keyUp(input)

    fireEvent.click(await screen.findByRole('option', { name: /existing\.png/i }))

    expect(input).toHaveValue('Review @existing.png ')
    expect(screen.getByRole('button', { name: /mention attachment existing\.png/i })).toBeInTheDocument()
    expect(container.querySelector('.composer-mention-highlight')).toHaveTextContent('@existing.png')
    expect(screen.queryByRole('listbox', { name: /attachment mentions/i })).not.toBeInTheDocument()
  })

  it('treats completed attachment mentions as cursor tokens', async () => {
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    const value = 'Review @ex'
    fireEvent.change(input, {
      target: { value },
    })
    const textarea = input as HTMLTextAreaElement
    textarea.setSelectionRange(value.length, value.length)
    fireEvent.keyUp(input)
    fireEvent.click(await screen.findByRole('option', { name: /existing\.png/i }))

    const mentionStart = 'Review '.length
    const mentionEnd = 'Review @existing.png'.length

    textarea.setSelectionRange(mentionEnd, mentionEnd)
    fireEvent.keyDown(textarea, { key: 'ArrowLeft' })

    expect(textarea.selectionStart).toBe(mentionStart)
    expect(textarea.selectionEnd).toBe(mentionStart)

    textarea.setSelectionRange(mentionStart + 4, mentionStart + 4)
    fireEvent.click(textarea)

    await waitFor(() => expect(textarea.selectionStart).toBe(mentionStart))
    expect(textarea.selectionEnd).toBe(mentionEnd)

    textarea.setSelectionRange(mentionStart, mentionStart)
    fireEvent.keyDown(textarea, { key: 'ArrowRight' })

    expect(textarea.selectionStart).toBe(mentionEnd)
    expect(textarea.selectionEnd).toBe(mentionEnd)
  })

  it('uploads a pasted image attachment from the instruction field', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    const pastedImage = new File(['image'], '', { type: 'image/png' })
    fireEvent.paste(await screen.findByLabelText('Instruction'), {
      clipboardData: {
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => pastedImage,
          },
        ],
      },
    })

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/upload',
        expect.objectContaining({
          method: 'POST',
          body: expect.any(FormData),
        }),
      ),
    )
    expect(await screen.findByRole('button', { name: /preview uploaded\.png/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Instruction')).toHaveValue('@uploaded.png ')
    expect(screen.getByRole('button', { name: /mention attachment uploaded\.png/i })).toBeInTheDocument()
  })

  it('does not send the current instruction with Ctrl Enter', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.change(input, {
      target: { value: 'Send with shortcut.' },
    })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

    expect(fetchMock).not.toHaveBeenCalledWith('/api/runs/run-a/action', expect.anything())
  })

  it('caps the auto-growing instruction field height and keeps chat pinned to bottom', async () => {
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    const scrollPane = screen.getByTestId('chat-scroll')
    setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 140,
    })
    fireEvent.scroll(scrollPane)
    Object.defineProperty(input, 'scrollHeight', {
      configurable: true,
      value: 260,
    })
    fireEvent.change(input, {
      target: { value: Array.from({ length: 12 }, (_, index) => `Line ${index}`).join('\n') },
    })

    await waitFor(() => expect(input).toHaveStyle({ height: '180px', overflowY: 'auto' }))
    await waitFor(() => expect(scrollPane.scrollTop).toBe(240))
  })

  it('omits workspace, current status, connection, and run count chrome', async () => {
    const { container } = render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    const header = container.querySelector('.chat-header') as HTMLElement

    expect(within(sidebar).queryByRole('heading', { name: 'Workspace' })).not.toBeInTheDocument()
    expect(within(sidebar).queryByRole('heading', { name: 'Current Status' })).not.toBeInTheDocument()
    expect(within(sidebar).getByRole('heading', { name: 'Outlines' })).toBeInTheDocument()
    expect(within(header).queryByText('WAITING_FOR_REVIEW')).not.toBeInTheDocument()
    expect(within(header).queryByText('open')).not.toBeInTheDocument()
    expect(within(header).queryByText(/runs/i)).not.toBeInTheDocument()
  })

  it('renders markdown safety warnings', async () => {
    render(<App />)
    const events = await getEventSource()

    act(() => {
      events.emitSnapshot(managerFactory())
    })

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/runs/run-a/snapshot'))
    act(() => {
      // Force the selected run detail through the action response path with a large file snapshot.
      fireEvent.change(screen.getByLabelText('Instruction'), {
        target: { value: 'Next task.' },
      })
    })
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        snapshot: snapshotFactory({
          outputMd: 'Large draft',
          markdownSafety: {
            'output.md': markdownSafety('output.md', {
              originalBytes: 1024 * 1024 + 20,
              renderedBytes: 1024 * 1024,
              warning: true,
              truncated: true,
            }),
          },
        }),
      }),
    )

    fireEvent.click(screen.getByRole('button', { name: /send to codex/i }))

    expect(await screen.findByTestId('output.md-markdown-warning')).toHaveTextContent(
      'Rendering first',
    )
  })

  it('opens uploaded attachments in an image preview', async () => {
    render(<App />)
    await getEventSource()

    const file = new File(['image'], 'review.png', { type: 'image/png' })
    fireEvent.change(await screen.findByLabelText(/attach review image/i), {
      target: { files: [file] },
    })

    fireEvent.click(await screen.findByRole('button', { name: /preview uploaded\.png/i }))

    const dialog = screen.getByRole('dialog', { name: 'uploaded.png' })
    expect(dialog).toBeInTheDocument()
    expect(within(dialog).getByRole('img', { name: 'uploaded.png' })).toHaveAttribute(
      'src',
      '/api/runs/run-a/attachments/uploaded.png',
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'uploaded.png' })).not.toBeInTheDocument()
  })

  it('shows attachment image previews in the right sidebar', async () => {
    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    expect(await within(sidebar).findByRole('img', { name: 'existing.png' })).toHaveAttribute(
      'src',
      '/api/runs/run-a/attachments/existing.png',
    )
  })

  it('opens protocol files in a document preview', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    fireEvent.click(await within(sidebar).findByRole('button', { name: 'Protocol Files' }))
    fireEvent.click(await within(sidebar).findByRole('button', { name: /preview output\.md/i }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/files/output.md'))
    const dialog = await screen.findByRole('dialog', { name: 'output.md' })
    expect(within(dialog).getByText('## File Preview')).toBeInTheDocument()
    expect(within(dialog).getByText('Ready for preview.')).toBeInTheDocument()
    expect(dialog.querySelector('.document-viewer')).toHaveClass('is-wrapped')
    expect(dialog.querySelectorAll('.document-row')).toHaveLength(3)
    expect(dialog.querySelector('.viewer-token.heading')).toHaveTextContent('## File Preview')

    fireEvent.click(within(dialog).getByRole('button', { name: /disable wrap/i }))

    expect(dialog.querySelector('.document-viewer')).not.toHaveClass('is-wrapped')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'output.md' })).not.toBeInTheDocument()
  })

  it('opens right-sidebar attachments in the image preview', async () => {
    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    fireEvent.click(await within(sidebar).findByRole('button', { name: /preview existing\.png/i }))

    expect(screen.getByRole('dialog', { name: 'existing.png' })).toBeInTheDocument()
  })

  it('shows previews for existing attachments mentioned in user messages', async () => {
    const messages: Snapshot['messages'] = [
      {
        id: 'user-attachment',
        role: 'user',
        content: 'Please review @existing.png',
        createdAtIso: '2026-05-07T00:00:01.000Z',
      },
    ]
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({
        messages,
        attachments: [attachmentFactory('existing.png')],
      })))

    render(<App />)
    await getEventSource()

    const previewButton = await screen.findByRole('button', { name: /preview message attachment existing\.png/i })
    expect(previewButton.querySelector('img')).toHaveAttribute('src', '/api/runs/run-a/attachments/existing.png')

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({
      ok: true,
      snapshot: snapshotFactory({
        messages,
        attachments: [],
      }),
    }))
    fireEvent.click(screen.getByRole('button', { name: /delete attachment existing\.png/i }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete attachment' }))
        .getByRole('button', { name: 'Delete attachment' }),
    )

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /preview message attachment existing\.png/i })).not.toBeInTheDocument(),
    )
  })

  it('shows only draft attachments in the composer tray with remove controls', async () => {
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    expect(screen.queryByRole('button', { name: /mention attachment existing\.png/i })).not.toBeInTheDocument()

    const value = '@ex'
    fireEvent.change(input, {
      target: { value },
    })
    const textarea = input as HTMLTextAreaElement
    textarea.setSelectionRange(value.length, value.length)
    fireEvent.keyUp(input)
    fireEvent.click(await screen.findByRole('option', { name: /existing\.png/i }))

    expect(input).toHaveValue('@existing.png ')
    expect(screen.getByRole('button', { name: /mention attachment existing\.png/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /remove attachment existing\.png/i }))

    expect(screen.queryByRole('button', { name: /mention attachment existing\.png/i })).not.toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('mentions session attachments from the sidebar list', async () => {
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.click(await screen.findByRole('button', { name: /add attachment mention existing\.png/i }))

    expect(input).toHaveValue('@existing.png')
    expect(screen.getByRole('button', { name: /mention attachment existing\.png/i })).toBeInTheDocument()
  })

  it('previews draft attachments from the composer thumbnail', async () => {
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    const value = '@ex'
    fireEvent.change(input, {
      target: { value },
    })
    const textarea = input as HTMLTextAreaElement
    textarea.setSelectionRange(value.length, value.length)
    fireEvent.keyUp(input)
    fireEvent.click(await screen.findByRole('option', { name: /existing\.png/i }))
    fireEvent.click(screen.getByRole('button', { name: /preview attachment existing\.png/i }))

    expect(screen.getByRole('dialog', { name: 'existing.png' })).toBeInTheDocument()
  })

  it('copies sent user and assistant messages', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<App />)
    await getEventSource()
    await screen.findByRole('heading', { name: 'Draft A' })
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        snapshot: snapshotFactory({
          messages: [
            {
              id: 'user-copy',
              role: 'user',
              content: 'User copy text.',
              createdAtIso: '2026-05-07T00:00:01.000Z',
            },
            {
              id: 'assistant-copy',
              role: 'assistant',
              content: 'Assistant copy text.',
              createdAtIso: '2026-05-07T00:00:02.000Z',
            },
          ],
        }),
      }),
    )

    fireEvent.change(await screen.findByLabelText('Instruction'), {
      target: { value: 'Show copied messages.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send to codex/i }))

    fireEvent.click(await screen.findByRole('button', { name: /copy user message/i }))
    fireEvent.click(await screen.findByRole('button', { name: /copy codex message/i }))

    const userArticle = within(screen.getByTestId('chat-scroll')).getByText('User copy text.').closest('article')
    expect(within(userArticle as HTMLElement).queryByText('You')).not.toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith('User copy text.')
    expect(writeText).toHaveBeenCalledWith('Assistant copy text.')
  })

  it('deletes an attachment from the selected run', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    expect(await screen.findByRole('button', { name: /preview existing\.png/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /delete attachment existing\.png/i }))
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete attachment' }))
        .getByRole('button', { name: 'Delete attachment' }),
    )

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/attachments/existing.png', {
        method: 'DELETE',
      }),
    )
    expect(screen.queryByRole('button', { name: /preview existing\.png/i })).not.toBeInTheDocument()
  })

  it('closes confirmation dialogs when clicking outside', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /delete attachment existing\.png/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete attachment' })

    fireEvent.click(dialog.parentElement as HTMLElement)

    expect(screen.queryByRole('dialog', { name: 'Delete attachment' })).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/runs/run-a/attachments/existing.png', {
      method: 'DELETE',
    })
  })

  it('deletes all attachments with per-card progress', async () => {
    const attachments = [attachmentFactory('first.png'), attachmentFactory('second.png')]
    const firstDelete = deferredResponse()
    const secondDelete = deferredResponse()
    const fetchMock = vi.mocked(fetch)
    fetchMock
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ attachments })))
      .mockReturnValueOnce(firstDelete.promise)
      .mockReturnValueOnce(secondDelete.promise)

    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    fireEvent.click(await within(sidebar).findByRole('button', { name: /delete all attachments/i }))
    const dialog = await screen.findByRole('dialog', { name: 'Delete all attachments' })

    expect(within(dialog).getByText('Delete all 2 attachments?')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete all' }))
    expect(await within(sidebar).findByRole('progressbar', { name: /deleting first\.png/i })).toBeInTheDocument()
    expect(within(sidebar).getByRole('progressbar', { name: /deleting second\.png/i })).toBeInTheDocument()

    firstDelete.resolve(jsonResponse({
      ok: true,
      snapshot: snapshotFactory({ attachments: [attachments[1]] }),
    }))

    await waitFor(() =>
      expect(within(sidebar).queryByRole('progressbar', { name: /deleting first\.png/i })).not.toBeInTheDocument(),
    )
    expect(within(sidebar).getByRole('progressbar', { name: /deleting second\.png/i })).toBeInTheDocument()

    secondDelete.resolve(jsonResponse({
      ok: true,
      snapshot: snapshotFactory({ attachments: [] }),
    }))

    await waitFor(() =>
      expect(within(sidebar).queryByRole('button', { name: /preview second\.png/i })).not.toBeInTheDocument(),
    )
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/attachments/first.png', { method: 'DELETE' })
    expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/attachments/second.png', { method: 'DELETE' })
  })

  it('keeps the chat pinned to the bottom when a new message arrives while already at bottom', async () => {
    render(<App />)
    await getEventSource()

    expect(await screen.findByRole('heading', { name: 'Draft A' })).toBeInTheDocument()

    const scrollPane = screen.getByTestId('chat-scroll')
    const metrics = setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 140,
    })
    fireEvent.scroll(scrollPane)
    metrics.setScrollHeight(480)

    const messages: Snapshot['messages'] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Continue',
        createdAtIso: '2026-05-07T00:00:01.000Z',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'New review packet is ready.',
        createdAtIso: '2026-05-07T00:00:02.000Z',
      },
    ]
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true, snapshot: snapshotFactory({ messages }) }))

    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send to codex/i }))
    metrics.setScrollHeight(520)

    expect(await screen.findByText('New review packet is ready.')).toBeInTheDocument()
    await waitFor(() => expect(scrollPane.scrollTop).toBe(520))
  })

  it('does not force-scroll when a new message arrives while the user is scrolled up', async () => {
    render(<App />)
    await getEventSource()

    expect(await screen.findByRole('heading', { name: 'Draft A' })).toBeInTheDocument()

    const scrollPane = screen.getByTestId('chat-scroll')
    const metrics = setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 60,
    })
    fireEvent.scroll(scrollPane)
    metrics.setScrollHeight(480)

    const messages: Snapshot['messages'] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'Continue',
        createdAtIso: '2026-05-07T00:00:01.000Z',
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'New review packet is ready.',
        createdAtIso: '2026-05-07T00:00:02.000Z',
      },
    ]
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ ok: true, snapshot: snapshotFactory({ messages }) }))

    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Continue' },
    })
    fireEvent.click(screen.getByRole('button', { name: /send to codex/i }))

    expect(await screen.findByText('New review packet is ready.')).toBeInTheDocument()
    expect(scrollPane.scrollTop).toBe(60)
  })

  it('shows a floating scroll-to-bottom button only when chat is not at bottom', async () => {
    render(<App />)
    await getEventSource()

    expect(await screen.findByRole('heading', { name: 'Draft A' })).toBeInTheDocument()

    const scrollPane = screen.getByTestId('chat-scroll')
    setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 140,
    })
    fireEvent.scroll(scrollPane)

    expect(screen.queryByRole('button', { name: /scroll to bottom/i })).not.toBeInTheDocument()

    scrollPane.scrollTop = 60
    fireEvent.scroll(scrollPane)

    const scrollButton = screen.getByRole('button', { name: /scroll to bottom/i })
    expect(scrollButton).toBeInTheDocument()
    expect(scrollButton.parentElement).toHaveClass('scroll-bottom-button-layer')

    fireEvent.click(scrollButton)

    expect(scrollPane.scrollTop).toBe(240)
    expect(screen.queryByRole('button', { name: /scroll to bottom/i })).not.toBeInTheDocument()
  })

  it('keeps the scroll-to-bottom button hidden during smooth programmatic scrolling', async () => {
    const { unmount } = render(<App />)
    await getEventSource()

    expect(await screen.findByRole('heading', { name: 'Draft A' })).toBeInTheDocument()

    const scrollPane = screen.getByTestId('chat-scroll')
    setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 60,
    })
    Object.defineProperty(scrollPane, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
    fireEvent.scroll(scrollPane)

    fireEvent.click(screen.getByRole('button', { name: /scroll to bottom/i }))
    expect(screen.queryByRole('button', { name: /scroll to bottom/i })).not.toBeInTheDocument()

    scrollPane.scrollTop = 90
    fireEvent.scroll(scrollPane)
    expect(screen.queryByRole('button', { name: /scroll to bottom/i })).not.toBeInTheDocument()

    scrollPane.scrollTop = 140
    fireEvent.scroll(scrollPane)
    expect(screen.queryByRole('button', { name: /scroll to bottom/i })).not.toBeInTheDocument()
    unmount()
  })

})

async function getEventSource(): Promise<MockEventSource> {
  await waitFor(() => expect(MockEventSource.instances).toHaveLength(1))
  const events = MockEventSource.instances[0]
  act(() => {
    events.open()
  })
  return events
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function deferredResponse() {
  let resolve!: (response: Response) => void
  const promise = new Promise<Response>((nextResolve) => {
    resolve = nextResolve
  })

  return { promise, resolve }
}

function managerFactory(overrides: Partial<ManagerSnapshot> = {}): ManagerSnapshot {
  return {
    rootPath: 'C:\\Users\\ramly\\Desktop\\CodexProMax',
    runsPath: 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs',
    selectedRunId: 'run-a',
    runs: [
      {
        runId: 'run-a',
        displayName: 'Run A',
        rootPath: 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-a',
        status: 'WAITING_FOR_REVIEW',
        owner: 'agent',
        updatedAtIso: '2026-05-07T00:00:00.000Z',
        updatedAtMs: 1,
        outputPreview: 'Ready for review.',
        attachmentCount: 0,
        hasInstruction: false,
        isLegacy: false,
      },
      {
        runId: 'run-b',
        displayName: 'Run B',
        rootPath: 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-b',
        status: 'INSTRUCTION_RECEIVED',
        owner: 'ui',
        updatedAtIso: '2026-05-07T00:01:00.000Z',
        updatedAtMs: 2,
        outputPreview: 'Instruction packet.',
        attachmentCount: 1,
        hasInstruction: false,
        isLegacy: false,
      },
    ],
    health: {
      rootExists: true,
      watcherReady: true,
      serverTimeIso: '2026-05-07T00:00:00.000Z',
    },
    ...overrides,
  }
}

function snapshotFactory(overrides: Partial<Snapshot> = {}): Snapshot {
  const files = {
    'status.txt': fileMeta(true),
    'output.md': fileMeta(true),
    'instruction.txt': fileMeta(false),
    'session.md': fileMeta(false),
    'events.ndjson': fileMeta(false),
  }

  return {
    runId: 'run-a',
    displayName: 'Run A',
    rootPath: 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-a',
    status: 'WAITING_FOR_REVIEW',
    outputMd: '',
    markdownSafety: {
      'output.md': markdownSafety('output.md'),
    },
    instruction: '',
    files,
    attachments: [],
    messages: [],
    health: {
      rootExists: true,
      watcherReady: true,
      serverTimeIso: '2026-05-07T00:00:00.000Z',
    },
    ...overrides,
  }
}

function attachmentFactory(name: string) {
  return {
    name,
    url: `/api/runs/run-a/attachments/${name}`,
    size: 42,
    mtimeMs: 1,
    mtimeIso: '2026-05-07T00:00:00.000Z',
  }
}

function markdownSafety(
  fileName: 'output.md',
  overrides: Partial<Snapshot['markdownSafety']['output.md']> = {},
) {
  return {
    fileName,
    originalBytes: 12,
    renderedBytes: 12,
    warnBytes: 500 * 1024,
    limitBytes: 1024 * 1024,
    warning: false,
    truncated: false,
    ...overrides,
  }
}

function fileMeta(exists: boolean) {
  return {
    exists,
    mtimeMs: exists ? 1 : null,
    mtimeIso: exists ? '2026-05-07T00:00:00.000Z' : null,
    size: exists ? 12 : null,
  }
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: {
    clientHeight: number
    scrollHeight: number
    scrollTop: number
  },
) {
  let scrollHeight = metrics.scrollHeight

  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  })
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
  element.scrollTop = metrics.scrollTop

  return {
    setScrollHeight(nextScrollHeight: number) {
      scrollHeight = nextScrollHeight
    },
  }
}

function mockElementRect(
  element: HTMLElement,
  rect: Pick<DOMRect, 'top' | 'bottom'> & Partial<DOMRect>,
) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      x: 0,
      y: rect.top,
      width: 240,
      height: rect.bottom - rect.top,
      left: 0,
      right: 240,
      top: rect.top,
      bottom: rect.bottom,
      toJSON: () => ({}),
    }),
  })
}
