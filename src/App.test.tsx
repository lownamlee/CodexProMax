import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

      if (requestUrl === '/api/runs/run-a/messages' && init?.method === 'DELETE') {
        const snapshot = snapshotFactory({
          runId: 'run-a',
          displayName: 'Run A',
          outputMd: '## Draft A\n\nReady for review.',
          messages: [],
        })
        snapshot.files['session.md'] = fileMeta(true)
        return jsonResponse({
          ok: true,
          snapshot,
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
        JSON.parse(String(init?.body)) as { instruction: string }
        return jsonResponse({
          ok: true,
          snapshot: snapshotFactory({
            runId: 'run-a',
            displayName: 'Run A',
            status: 'INSTRUCTION_RECEIVED',
          }),
        })
      }

      if (requestUrl.includes('/api/runs/') && requestUrl.includes('/upload')) {
        return jsonResponse({
          ok: true,
          snapshot: snapshotFactory({
            attachments: [
              {
                name: 'uploaded.png',
                url: '/api/runs/run-a/attachments/uploaded.png',
                size: 42,
                mtimeMs: 1,
                mtimeIso: '2026-05-07T00:00:00.000Z',
              },
            ],
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
  })

  it('selects a different run and switches detail content', async () => {
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /Run B/i }))

    expect(await screen.findByRole('heading', { name: 'Draft B' })).toBeInTheDocument()
    expect(screen.getByTestId('current-status')).toHaveTextContent('INSTRUCTION_RECEIVED')
  })

  it('deletes a run through the selected run endpoint', async () => {
    const fetchMock = vi.mocked(fetch)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /delete run-a/i }))

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

    await waitFor(() =>
      expect(screen.getByTestId('current-status')).toHaveTextContent('INSTRUCTION_RECEIVED'),
    )
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

  it('clears conversation history without deleting the selected run', async () => {
    const fetchMock = vi.mocked(fetch)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await getEventSource()

    expect(await screen.findByRole('heading', { name: 'Draft A' })).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('button', { name: /clear conversation history/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/runs/run-a/messages', {
        method: 'DELETE',
      }),
    )
    expect(await screen.findByRole('heading', { name: 'No conversation history' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Draft A' })).not.toBeInTheDocument()
  })

  it('renders status ownership and help text', async () => {
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /Run B/i }))

    expect(await screen.findByTestId('status-owner')).toHaveTextContent('ui')
    expect(screen.getAllByText(/consumes instruction.txt/i).length).toBeGreaterThan(0)
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

    fireEvent.click(await screen.findByRole('button', { name: 'uploaded.png' }))

    expect(screen.getByRole('dialog', { name: 'uploaded.png' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'uploaded.png' })).toHaveAttribute(
      'src',
      '/api/runs/run-a/attachments/uploaded.png',
    )
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

    expect(await screen.findByText('New review packet is ready.')).toBeInTheDocument()
    await waitFor(() => expect(scrollPane.scrollTop).toBe(480))
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

  it('shows reconnecting during SSE retry and open after recovery', async () => {
    render(<App />)
    const events = await getEventSource()

    expect(await screen.findByText('open')).toBeInTheDocument()

    act(() => {
      events.fail()
    })

    expect(screen.getByText('reconnecting')).toBeInTheDocument()

    act(() => {
      events.open()
    })

    expect(screen.getByText('open')).toBeInTheDocument()
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
