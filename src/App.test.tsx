import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { AttachmentMeta, ManagerSnapshot, Snapshot, Teammate } from './shared/protocol'
import { DEFAULT_TEAMMATES, TEAMMATE_AVATAR_URLS } from './shared/protocol'

const appStyles = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf-8')

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
  window.history.replaceState(null, '', '/')
  window.localStorage.clear()
  let prankTeammates = teammateFactory()
  vi.stubGlobal('EventSource', MockEventSource)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(url)
      if (requestUrl === '/api/teammates' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { email: string }
        const usedAvatars = new Set(prankTeammates.map((teammate) => teammate.avatarUrl))
        const avatarUrl = TEAMMATE_AVATAR_URLS.find((item) => !usedAvatars.has(item)) ?? TEAMMATE_AVATAR_URLS[0]
        prankTeammates = [
          ...prankTeammates,
          {
            id: `invited-${prankTeammates.length + 1}`,
            name: `Invited Burger ${prankTeammates.length - 4}`,
            email: body.email,
            avatarUrl,
            role: 'Member',
            seat: 'Codex Pro Max',
            dateAdded: 'May 10, 2026',
          },
        ]
        return jsonResponse({ ok: true, teammates: prankTeammates }, 201)
      }

      if (requestUrl === '/api/teammates') {
        return jsonResponse({ ok: true, teammates: prankTeammates })
      }

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
            status: 'STOPPED',
            instruction: '',
            messages: [
              {
                id: 'stop-1',
                role: 'user',
                content: 'Stop this Codex Pro Max session now.',
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
    const reviewButton = screen.getByRole('button', { name: /Run A/i })
    const reviewImage = reviewButton.querySelector('.run-status-review-avatar img')
    expect(reviewButton.querySelector('.run-status-waiting-for-review')).toBeInTheDocument()
    expect(reviewImage).toHaveAttribute('src', '/codex-thinking.webp')
    expect(reviewButton.querySelector('.run-status-review-orb')).not.toBeInTheDocument()
    expect(reviewButton.querySelector('.ri-question-answer-line')).not.toBeInTheDocument()
    expect(appStyles).toMatch(/\.left-sidebar \.run-status-review-avatar img\s*\{[^}]*filter:\s*sepia\(0\.9\) saturate\(1\.8\) hue-rotate\(345deg\);/)
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.run-status-instruction-received')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.run-status-success-wrapper')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.run-status-success-check')).toHaveAttribute('d', 'M16 26 L22 32 L34 18')
    expect(screen.getByRole('button', { name: /Run B/i }).querySelector('.ri-inbox-archive-line')).not.toBeInTheDocument()
  })

  it('preserves soft line breaks in sent user messages', async () => {
    const messages: Snapshot['messages'] = [
      {
        id: 'user-with-newlines',
        role: 'user',
        content: 'First line\nSecond line',
        createdAtIso: '2026-05-07T00:00:04.000Z',
      },
    ]
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl === '/api/teammates') {
        return jsonResponse({ ok: true, teammates: teammateFactory() })
      }
      if (requestUrl === '/api/snapshot') {
        return jsonResponse(managerFactory())
      }
      if (requestUrl.includes('/api/runs/run-a/snapshot')) {
        return jsonResponse(snapshotFactory({ messages }))
      }
      return jsonResponse({ ok: false, error: `Unhandled request: ${requestUrl}` }, 500)
    })

    render(<App />)
    await getEventSource()

    await waitFor(() => {
      const userMarkdown = document.querySelector('.user-message .markdown-body')
      expect(userMarkdown).toHaveClass('preserve-soft-breaks')
      expect(userMarkdown?.textContent).toBe('First line\nSecond line')
    })
  })

  it('uses the animated thinking image for running runs', async () => {
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
    const thinkingImage = runButton.querySelector('.run-status-thinking-avatar img')
    expect(thinkingImage).toHaveAttribute('src', '/codex-thinking.webp')
    expect(runButton.querySelector('svg.run-status-spinner')).not.toBeInTheDocument()
    expect(runButton.querySelector('.ri-loader-4-line')).not.toBeInTheDocument()
  })

  it('uses the animated stopped image for stopped runs', async () => {
    const manager = managerFactory()
    manager.runs[0] = {
      ...manager.runs[0],
      status: 'STOPPED',
    }
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(manager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'STOPPED' })))

    render(<App />)
    await getEventSource()

    const runButton = await screen.findByRole('button', { name: /Run A/i })
    const stoppedImage = runButton.querySelector('.run-status-stopped-avatar img')
    expect(stoppedImage).toHaveAttribute('src', '/codex-stopped.webp')
    expect(runButton.querySelector('.ri-stop-circle-line')).not.toBeInTheDocument()
    expect(appStyles).toMatch(/\.left-sidebar \.run-status-stopped-avatar img\s*\{[^}]*filter:\s*grayscale\(1\);/)
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

  it('caps collapsed run inbox items to the visible height without scroll overflow', async () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({
      ...managerFactory().runs[0],
      runId: index === 0 ? 'run-a' : `run-${index + 1}`,
      displayName: `Run ${index + 1}`,
      rootPath: `C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-${index + 1}`,
      updatedAtIso: `2026-05-07T00:${String(index).padStart(2, '0')}:00.000Z`,
      updatedAtMs: index + 1,
    }))
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl === '/api/teammates') {
        return jsonResponse({ ok: true, teammates: teammateFactory() })
      }
      if (requestUrl === '/api/snapshot') {
        return jsonResponse(managerFactory({ runs, selectedRunId: 'run-a' }))
      }
      if (requestUrl.includes('/api/runs/run-a/snapshot')) {
        return jsonResponse(snapshotFactory({ displayName: 'Run 1' }))
      }
      return jsonResponse({ ok: false, error: `Unhandled request: ${requestUrl}` }, 500)
    })
    window.localStorage.setItem('codex-pro-max:left-sidebar-collapsed', 'true')

    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Run inbox')
    const runList = sidebar.querySelector('.run-list') as HTMLElement
    expect(runList.querySelectorAll('.run-item')).toHaveLength(10)
    expect(appStyles).toMatch(/\.left-sidebar\.collapsed \.run-list\s*\{[^}]*overflow:\s*hidden;/)
    expect(appStyles).toMatch(/\.run-list\s*\{[^}]*overflow-x:\s*hidden;/)

    Object.defineProperty(runList, 'clientHeight', {
      configurable: true,
      get: () => 154,
    })
    act(() => window.dispatchEvent(new Event('resize')))

    await waitFor(() => expect(runList.querySelectorAll('.run-item')).toHaveLength(3))
  })

  it('shows context separately from matching 5h and weekly limits on the root conversation', async () => {
    const currentRunId = '019e1aab-577b-7741-8889-c683dd299526'
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl === '/api/snapshot') {
        return jsonResponse(managerFactory({
          selectedRunId: currentRunId,
          runs: [
            {
              runId: currentRunId,
              displayName: currentRunId,
              rootPath: `C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\${currentRunId}`,
              status: 'WAITING_FOR_REVIEW',
              owner: 'agent',
              updatedAtIso: '2026-05-07T00:00:00.000Z',
              updatedAtMs: 1,
              outputPreview: 'Ready for review.',
              attachmentCount: 0,
              hasInstruction: false,
            },
          ],
        }))
      }
      if (requestUrl === `/api/runs/${currentRunId}/snapshot`) {
        return jsonResponse(snapshotFactory({
          runId: currentRunId,
          displayName: currentRunId,
          rootPath: `C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\${currentRunId}`,
          outputMd: '## Draft A\n\nReady for review.',
        }))
      }
      if (requestUrl === '/api/codex-live/sessions?limit=100') {
        return jsonResponse({
          ok: true,
          rootPath: 'C:\\Users\\ramly\\.codex\\sessions',
          sessions: [
            {
              id: 'session-run-a',
              fileName: `rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
              relativePath: `2026/05/07/rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
              createdAtIso: '2026-05-07T00:00:00.000Z',
              updatedAtIso: '2026-05-07T00:04:00.000Z',
              sizeBytes: 4096,
            },
          ],
        })
      }
      if (requestUrl.startsWith('/api/codex-live/sessions/session-run-a?')) {
        return jsonResponse({
          ok: true,
          rootPath: 'C:\\Users\\ramly\\.codex\\sessions',
          session: {
            id: 'session-run-a',
            fileName: `rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
            relativePath: `2026/05/07/rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
            createdAtIso: '2026-05-07T00:00:00.000Z',
            updatedAtIso: '2026-05-07T00:04:00.000Z',
            sizeBytes: 4096,
          },
          records: [],
          context: {
            timestamp: '2026-05-07T00:04:00.000Z',
            contextWindow: 258400,
            usedTokens: 67869,
            remainingTokens: 190531,
            inputTokens: 67688,
            cachedInputTokens: 66944,
            outputTokens: 181,
            reasoningOutputTokens: 164,
            percentUsed: 26.264318885448918,
            percentRemaining: 73.73568111455108,
            totalUsage: {
              inputTokens: 135721336,
              cachedInputTokens: 133152896,
              outputTokens: 346237,
              reasoningOutputTokens: 117450,
              totalTokens: 136067573,
            },
            rateLimits: {
              limitId: 'codex',
              limitName: null,
              planType: 'team',
              rateLimitReachedType: null,
              primary: {
                usedPercent: 67,
                remainingPercent: 33,
                windowMinutes: 300,
                resetsAt: 1778615464,
                resetsAtIso: '2026-05-12T19:51:04.000Z',
              },
              secondary: {
                usedPercent: 41,
                remainingPercent: 59,
                windowMinutes: 10080,
                resetsAt: 1779090417,
                resetsAtIso: '2026-05-18T13:06:57.000Z',
              },
              credits: {
                hasCredits: false,
                unlimited: false,
                balance: null,
              },
            },
          },
          tailBytes: 2048,
          totalSizeBytes: 4096,
          truncated: false,
        })
      }
      return jsonResponse({ ok: false, error: `Unhandled request: ${requestUrl}` }, 500)
    })

    render(<App />)
    await getEventSource()

    const usage = await screen.findByLabelText('Conversation usage limits')
    const contextLimit = within(usage).getByLabelText('Conversation context limit')
    const rateLimits = usage.querySelectorAll('.conversation-rate-limit')

    expect(usage.children).toHaveLength(3)
    expect(contextLimit.querySelector('.conversation-context-icon')).toBeNull()
    expect(contextLimit).toHaveTextContent('Context')
    expect(contextLimit).toHaveTextContent('26%')
    expect(contextLimit).toHaveTextContent('67.9K/258.4K')
    expect(contextLimit).not.toHaveTextContent('Context limit')
    expect(rateLimits).toHaveLength(2)
    expect(usage).toHaveTextContent('5h')
    expect(usage).toHaveTextContent('33% left')
    expect(usage).toHaveTextContent('Weekly')
    expect(usage).toHaveTextContent('59% left')
    expect(usage).not.toHaveTextContent('5h limit')
    expect(usage).not.toHaveTextContent('Resets')

    const collapseButton = screen.getByRole('button', { name: 'Collapse conversation usage gauges' })
    expect(collapseButton).toBeEnabled()
    expect(collapseButton).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(collapseButton)

    expect(usage).toHaveClass('is-collapsed')
    expect(appStyles).toMatch(/\.conversation-usage\.is-collapsed\s*\{[^}]*pointer-events:\s*none;/)
    expect(window.localStorage.getItem('codex-pro-max:conversation-usage-collapsed')).toBe('true')

    const expandButton = screen.getByRole('button', { name: 'Expand conversation usage gauges' })
    expect(expandButton).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(expandButton)

    expect(usage).not.toHaveClass('is-collapsed')
    expect(window.localStorage.getItem('codex-pro-max:conversation-usage-collapsed')).toBe('false')
  })

  it('shows live assistant messages as thinking from the matching rollout log while Codex is working', async () => {
    const currentRunId = '019e1aab-577b-7741-8889-c683dd299526'
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl === '/api/snapshot') {
        return jsonResponse(managerFactory({
          selectedRunId: currentRunId,
          runs: [
            {
              runId: currentRunId,
              displayName: currentRunId,
              rootPath: `C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\${currentRunId}`,
              status: 'RUNNING',
              owner: 'agent',
              updatedAtIso: '2026-05-07T00:00:00.000Z',
              updatedAtMs: 1,
              outputPreview: 'Working.',
              attachmentCount: 0,
              hasInstruction: false,
            },
          ],
        }))
      }
      if (requestUrl === `/api/runs/${currentRunId}/snapshot`) {
        return jsonResponse(snapshotFactory({
          runId: currentRunId,
          displayName: currentRunId,
          rootPath: `C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\${currentRunId}`,
          status: 'RUNNING',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              content: 'Implement the current request',
              createdAtIso: '2026-05-07T00:00:01.000Z',
            },
          ],
        }))
      }
      if (requestUrl === '/api/codex-live/sessions?limit=100') {
        return jsonResponse({
          ok: true,
          rootPath: 'C:\\Users\\ramly\\.codex\\sessions',
          sessions: [
            {
              id: 'session-run-a',
              fileName: `rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
              relativePath: `2026/05/07/rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
              createdAtIso: '2026-05-07T00:00:00.000Z',
              updatedAtIso: '2026-05-07T00:04:00.000Z',
              sizeBytes: 4096,
            },
          ],
        })
      }
      if (requestUrl.startsWith('/api/codex-live/sessions/session-run-a?')) {
        return jsonResponse({
          ok: true,
          rootPath: 'C:\\Users\\ramly\\.codex\\sessions',
          session: {
            id: 'session-run-a',
            fileName: `rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
            relativePath: `2026/05/07/rollout-2026-05-07T00-00-00-${currentRunId}.jsonl`,
            createdAtIso: '2026-05-07T00:00:00.000Z',
            updatedAtIso: '2026-05-07T00:04:00.000Z',
            sizeBytes: 4096,
          },
          records: [
            {
              id: 'old-assistant-before-user',
              index: 0,
              timestamp: '2026-05-07T00:00:00.500Z',
              kind: 'message',
              title: 'Assistant',
              text: 'Old assistant message before the latest user request.',
              callId: '',
              status: 'completed',
            },
            ...Array.from({ length: 31 }, (_, index) => ({
              id: `assistant-message-${index + 1}`,
              index: index + 1,
              timestamp: `2026-05-07T00:02:${String(index).padStart(2, '0')}.000Z`,
              kind: 'message',
              title: 'Assistant',
              text: index === 0
                ? 'Dropped assistant update'
                : index === 30
                  ? 'Checking the implementation path.'
                  : `Assistant update ${index + 1}`,
              callId: '',
              status: 'completed',
            })),
            {
              id: 'reasoning-1',
              index: 33,
              timestamp: '2026-05-07T00:02:30.000Z',
              kind: 'reasoning',
              title: 'Thinking',
              text: 'Raw reasoning should stay hidden from the root thinking bubble.',
              callId: '',
              status: 'running',
            },
            {
              id: 'tool-1',
              index: 34,
              timestamp: '2026-05-07T00:03:00.000Z',
              kind: 'tool-call',
              title: 'Shell command',
              text: 'Tool output should stay hidden from the thinking bubble.',
              callId: 'call-tool-1',
              status: 'completed',
            },
          ],
          context: null,
          tailBytes: 2048,
          totalSizeBytes: 4096,
          truncated: false,
        })
      }
      return jsonResponse({ ok: false, error: `Unhandled request: ${requestUrl}` }, 500)
    })

    render(<App />)
    await getEventSource()

    const thinking = await screen.findByTestId('ai-thinking-process')
    expect(thinking.querySelectorAll('.ai-thinking-label-dots span')).toHaveLength(3)
    expect(thinking.querySelector('.thinking-avatar-image')).toHaveAttribute('src', '/codex-thinking.webp')
    await waitFor(() => expect(thinking).toHaveTextContent('Checking the implementation path.'))
    expect(thinking).toHaveTextContent('Assistant update 2')
    expect(thinking).not.toHaveTextContent('Old assistant message before the latest user request')
    expect(thinking).not.toHaveTextContent('Dropped assistant update')
    expect(thinking).not.toHaveTextContent('Raw reasoning should stay hidden')
    expect(thinking).not.toHaveTextContent('Tool output should stay hidden')
    expect(screen.queryByTestId('ai-loading-indicator')).not.toBeInTheDocument()
    const liveHistoryRequest = vi.mocked(fetch).mock.calls
      .map(([url]) => String(url))
      .find((requestUrl) => requestUrl.startsWith('/api/codex-live/sessions/session-run-a?'))
    expect(liveHistoryRequest).toContain('records=500')
    expect(liveHistoryRequest).toContain('tailBytes=2097152')
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
    expect(within(profileMenu).getByText('Ultra Plan')).toBeInTheDocument()
    fireEvent.click(within(profileMenu).getByRole('menuitem', { name: /Add teammates/i }))
    expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()
    const teammatesDialog = screen.getByRole('dialog', { name: /invite members to the ramlyburger workspace/i })
    expect(teammatesDialog.closest('.left-sidebar')).toBeNull()
    expect(teammatesDialog.closest('.preview-backdrop')?.parentElement).toBe(document.body)
    expect(await within(teammatesDialog).findByText('Cheeseburger')).toBeInTheDocument()
    expect(within(teammatesDialog).getByText('cheeseburger@codexpromax.com')).toBeInTheDocument()
    expect(within(teammatesDialog).getByText('Double Burger')).toBeInTheDocument()
    expect(within(teammatesDialog).getByText('doubleburger@codexpromax.com')).toBeInTheDocument()
    const initialAvatarSources = within(teammatesDialog)
      .getAllByRole('img', { name: /avatar/i })
      .map((image) => image.getAttribute('src'))
    expect(initialAvatarSources).toHaveLength(5)
    expect(new Set(initialAvatarSources).size).toBe(5)

    fireEvent.change(within(teammatesDialog).getByLabelText('Email'), {
      target: { value: 'newburger@codexpromax.com' },
    })
    fireEvent.click(within(teammatesDialog).getByRole('button', { name: /send invites/i }))
    expect(await within(teammatesDialog).findByText('newburger@codexpromax.com')).toBeInTheDocument()
    const updatedAvatarSources = within(teammatesDialog)
      .getAllByRole('img', { name: /avatar/i })
      .map((image) => image.getAttribute('src'))
    expect(updatedAvatarSources).toHaveLength(6)
    expect(new Set(updatedAvatarSources).size).toBe(6)

    fireEvent.click(within(teammatesDialog).getByRole('button', { name: /close teammates dialog/i }))
    expect(screen.queryByRole('dialog', { name: /invite members to the ramlyburger workspace/i })).not.toBeInTheDocument()

    fireEvent.click(profileButton)
    const profileMenuAfterTeammates = screen.getByRole('menu', { name: 'Profile menu' })
    fireEvent.click(within(profileMenuAfterTeammates).getByRole('menuitem', { name: /Workspace settings/i }))
    expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()
    const workspaceDialog = screen.getByRole('dialog', { name: /workspace settings under construction/i })
    expect(workspaceDialog.closest('.left-sidebar')).toBeNull()
    expect(workspaceDialog.closest('.preview-backdrop')?.parentElement).toBe(document.body)
    expect(within(workspaceDialog).getByText(/still under construction/i)).toBeInTheDocument()
    expect(within(workspaceDialog).getByRole('img', { name: /workspace settings under construction sticker/i }))
      .toHaveAttribute('src', 'https://media.tenor.com/OY6bIk0asR4AAAAi/quby.gif')
    fireEvent.click(within(workspaceDialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: /workspace settings under construction/i })).not.toBeInTheDocument()

    fireEvent.click(profileButton)
    const profileMenuAfterWorkspace = screen.getByRole('menu', { name: 'Profile menu' })
    fireEvent.click(within(profileMenuAfterWorkspace).getByRole('menuitem', { name: /^Skills$/i }))
    expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()
    const skillsDialog = screen.getByRole('dialog', { name: /skills under construction/i })
    expect(within(skillsDialog).getByText(/skill oven is preheating/i)).toBeInTheDocument()
    expect(within(skillsDialog).getByRole('img', { name: /skills under construction sticker/i }))
      .toHaveAttribute('src', 'https://media1.tenor.com/m/XFwbgqtJB98AAAAC/quby-quby-sticker.gif')
    fireEvent.click(within(skillsDialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog', { name: /skills under construction/i })).not.toBeInTheDocument()

    fireEvent.click(profileButton)
    const profileMenuAfterSkills = screen.getByRole('menu', { name: 'Profile menu' })
    const logoutButton = within(profileMenuAfterSkills).getByRole('menuitem', { name: /Log out/i })
    expect(logoutButton.querySelector('.profile-menu-chevron')).not.toBeInTheDocument()

    fireEvent.click(logoutButton)

    expect(screen.queryByRole('menu', { name: 'Profile menu' })).not.toBeInTheDocument()
    const logoutError = screen.getByRole('dialog', { name: 'Unable to logout' })
    expect(logoutError.closest('.left-sidebar')).toBeNull()
    expect(logoutError.closest('.preview-backdrop')?.parentElement).toBe(document.body)
    await waitFor(() => expect(within(logoutError).getByRole('button', { name: 'Close' })).toHaveFocus())
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
    const settingsDialog = screen.getByRole('dialog', { name: 'Settings' })
    const shortcutConfirmSetting = within(settingsDialog).getByRole('checkbox', {
      name: /confirm ctrl enter send/i,
    })
    expect(shortcutConfirmSetting).toBeChecked()

    fireEvent.click(shortcutConfirmSetting)
    expect(window.localStorage.getItem('codex-pro-max:confirm-ctrl-enter-send')).toBe('false')

    fireEvent.click(within(settingsDialog).getByRole('button', { name: /close settings/i }))
    expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('keeps the teammates popup populated when the teammate endpoint is unavailable', async () => {
    vi.mocked(fetch).mockImplementation(async (url: string | URL | Request) => {
      const requestUrl = String(url)
      if (requestUrl === '/api/teammates') {
        return jsonResponse({ ok: false, error: 'Not found' }, 404)
      }

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

      return jsonResponse({ ok: false, error: 'Not found' }, 404)
    })

    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /open profile menu/i }))
    fireEvent.click(within(screen.getByRole('menu', { name: 'Profile menu' })).getByRole('menuitem', {
      name: /Add teammates/i,
    }))

    const teammatesDialog = screen.getByRole('dialog', { name: /invite members to the ramlyburger workspace/i })
    expect(within(teammatesDialog).getByText('Cheeseburger')).toBeInTheDocument()
    expect(within(teammatesDialog).getByText('Veggie Burger')).toBeInTheDocument()
    expect(within(teammatesDialog).queryByText('Not found')).not.toBeInTheDocument()
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

  it('keeps the manually selected run when the manager default changes', async () => {
    render(<App />)
    const events = await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /Run B/i }))

    expect(await screen.findByRole('heading', { name: 'Draft B' })).toBeInTheDocument()

    act(() => {
      events.emitSnapshot(managerFactory({
        selectedRunId: 'run-a',
        health: {
          rootExists: true,
          watcherReady: true,
          serverTimeIso: '2026-05-07T00:00:07.000Z',
        },
      }))
    })

    expect(await screen.findByRole('heading', { name: 'Draft B' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run B/i })).toHaveAttribute('aria-current', 'true')
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

  it('sends instructions immediately when the selected run is stopped', async () => {
    const fetchMock = vi.mocked(fetch)
    const stoppedManager = managerFactory({
      runs: [
        {
          ...managerFactory().runs[0],
          status: 'STOPPED',
          owner: 'agent',
        },
      ],
    })
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(stoppedManager))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ status: 'STOPPED' })))

    render(<App />)
    await getEventSource()

    fireEvent.change(await screen.findByLabelText('Instruction'), {
      target: { value: 'Resume this stopped session.' },
    })
    fireEvent.click(await screen.findByRole('button', { name: /send to codex/i }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            instruction: 'Resume this stopped session.',
          }),
        }),
      ),
    )
    expect(screen.queryByLabelText('Queued messages')).not.toBeInTheDocument()
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

  it('waits for a pinned selected chat to reach bottom before sending a queued message', async () => {
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

    const scrollPane = screen.getByTestId('chat-scroll')
    const metrics = setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 140,
    })
    fireEvent.scroll(scrollPane)

    fireEvent.change(await screen.findByLabelText('Instruction'), {
      target: { value: 'Queued message should pin bottom.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))
    expect(await screen.findByLabelText('Queued messages')).toHaveTextContent('Queued message should pin bottom.')
    metrics.setScrollHeight(520)

    act(() => {
      events.emitSnapshot(managerFactory({
        health: {
          rootExists: true,
          watcherReady: true,
          serverTimeIso: '2026-05-07T00:00:07.000Z',
        },
      }))
    })

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/action'))).toHaveLength(0)
    await waitFor(() => expect(scrollPane.scrollTop).toBe(520))
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/action'))).toHaveLength(0)
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            instruction: 'Queued message should pin bottom.',
          }),
        }),
      ),
      { timeout: 2000 },
    )
    expect(await within(scrollPane).findByText('Queued message should pin bottom.')).toBeInTheDocument()
  })

  it('does not wait for bottom before sending a queued message when the selected chat was not pinned', async () => {
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

    const scrollPane = screen.getByTestId('chat-scroll')
    const metrics = setScrollMetrics(scrollPane, {
      clientHeight: 100,
      scrollHeight: 240,
      scrollTop: 60,
    })
    fireEvent.scroll(scrollPane)

    fireEvent.change(await screen.findByLabelText('Instruction'), {
      target: { value: 'Queued message while reading earlier context.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /queue for review/i }))
    metrics.setScrollHeight(520)

    act(() => {
      events.emitSnapshot(managerFactory({
        health: {
          rootExists: true,
          watcherReady: true,
          serverTimeIso: '2026-05-07T00:00:07.000Z',
        },
      }))
    })

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            instruction: 'Queued message while reading earlier context.',
          }),
        }),
      ),
    )
    expect(scrollPane.scrollTop).toBe(60)
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
      '/codex-stopped.webp',
    )
    expect(screen.queryByRole('heading', { name: 'Draft A' })).not.toBeInTheDocument()
  })

  it('closes confirmation dialogs with Escape', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    fireEvent.click(await screen.findByRole('button', { name: /clear conversation history/i }))

    const dialog = await screen.findByRole('dialog', { name: 'Clear conversation history' })
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Clear history' })).toHaveFocus())

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
    expect(within(screen.getByTestId('chat-scroll')).getByText('Stop this Codex Pro Max session now.')).toBeInTheDocument()
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

  it('uploads a pasted attachment from the instruction field', async () => {
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

  it('shows upload progress while attaching a file', async () => {
    render(<App />)
    await getEventSource()

    const upload = deferredResponse()
    const attachment = attachmentFactory('slow-upload.png')
    vi.mocked(fetch).mockReturnValueOnce(upload.promise)

    const file = new File(['image'], 'slow-upload.png', { type: 'image/png' })
    fireEvent.change(await screen.findByLabelText(/attach file/i), {
      target: { files: [file] },
    })

    expect(await screen.findByRole('progressbar', { name: /uploading slow-upload\.png/i })).toBeInTheDocument()

    upload.resolve(jsonResponse({
      ok: true,
      attachment,
      snapshot: snapshotFactory({
        attachments: [attachment],
      }),
    }))

    await waitFor(() =>
      expect(screen.queryByRole('progressbar', { name: /uploading slow-upload\.png/i })).not.toBeInTheDocument(),
    )
    expect(await screen.findByRole('button', { name: /preview slow-upload\.png/i })).toBeInTheDocument()
  })

  it('confirms Ctrl Enter before sending the current instruction', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    input.focus()
    fireEvent.change(input, {
      target: { value: 'Send with shortcut.' },
    })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

    const actionCallsBeforeConfirm = fetchMock.mock.calls.filter(([url]) => String(url).includes('/action'))
    expect(actionCallsBeforeConfirm).toHaveLength(0)

    const confirmDialog = screen.getByRole('dialog', { name: /send with ctrl enter/i })
    expect(within(confirmDialog).getByText('Ctrl')).toBeInTheDocument()
    expect(within(confirmDialog).getByText('Enter')).toBeInTheDocument()
    const dontShowAgain = within(confirmDialog).getByRole('checkbox', { name: /do not show again/i })
    fireEvent.click(dontShowAgain)
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ instruction: 'Send with shortcut.' }),
        }),
      ),
    )
    await waitFor(() => expect(input).toHaveFocus())
    expect(window.localStorage.getItem('codex-pro-max:confirm-ctrl-enter-send')).toBe('false')
  })

  it('returns focus to the instruction field after canceling the Ctrl Enter confirmation', async () => {
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    input.focus()
    fireEvent.change(input, {
      target: { value: 'Keep focus after cancel.' },
    })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

    const confirmDialog = screen.getByRole('dialog', { name: /send with ctrl enter/i })
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.queryByRole('dialog', { name: /send with ctrl enter/i })).not.toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/action'))).toHaveLength(0)
  })

  it('sends immediately with Ctrl Enter when shortcut confirmation is disabled', async () => {
    window.localStorage.setItem('codex-pro-max:confirm-ctrl-enter-send', 'false')
    const fetchMock = vi.mocked(fetch)
    render(<App />)
    await getEventSource()

    const input = await screen.findByLabelText('Instruction')
    fireEvent.change(input, {
      target: { value: 'Shortcut without warning.' },
    })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })

    expect(screen.queryByRole('dialog', { name: /send with ctrl enter/i })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/runs/run-a/action',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ instruction: 'Shortcut without warning.' }),
        }),
      ),
    )
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

  it('renders GitHub-flavored markdown tables', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({
        outputMd: [
          '## Missing CDD data',
          '',
          '| Field | Status |',
          '| --- | --- |',
          '| PEP status | Not in SSM PDF |',
        ].join('\n'),
      })))

    render(<App />)
    await getEventSource()

    const table = await screen.findByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Field' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: 'PEP status' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: 'Not in SSM PDF' })).toBeInTheDocument()
    expect(table.parentElement).toHaveClass('markdown-table-scroll')
  })

  it('opens uploaded image attachments in a preview', async () => {
    render(<App />)
    await getEventSource()

    const file = new File(['image'], 'review.png', { type: 'image/png' })
    fireEvent.change(await screen.findByLabelText(/attach file/i), {
      target: { files: [file] },
    })

    fireEvent.click(await screen.findByRole('button', { name: /preview uploaded\.png/i }))

    const dialog = screen.getByRole('dialog', { name: 'uploaded.png' })
    expect(dialog).toBeInTheDocument()
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close preview' })).toHaveFocus())
    expect(within(dialog).getByRole('img', { name: 'uploaded.png' })).toHaveAttribute(
      'src',
      '/api/runs/run-a/attachments/uploaded.png',
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'uploaded.png' })).not.toBeInTheDocument()
  })

  it('opens non-image attachments in a file preview', async () => {
    const attachments = [attachmentFactory('archive.zip')]
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ attachments })))

    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    fireEvent.click(await within(sidebar).findByRole('button', { name: /preview archive\.zip/i }))

    const dialog = screen.getByRole('dialog', { name: 'archive.zip' })
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Archive')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/api/runs/run-a/attachments/archive.zip',
    )
    expect(within(dialog).getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'archive.zip')
  })

  it('opens video attachments in a native media preview', async () => {
    const attachments = [attachmentFactory('clip.mp4')]
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ attachments })))

    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    fireEvent.click(await within(sidebar).findByRole('button', { name: /preview clip\.mp4/i }))

    const dialog = screen.getByRole('dialog', { name: 'clip.mp4' })
    const video = dialog.querySelector('video')
    expect(video).not.toBeNull()
    expect(video).toHaveAttribute('src', '/api/runs/run-a/attachments/clip.mp4')
    expect(video).toHaveAttribute('controls')
    expect(within(dialog).queryByText('Video')).not.toBeInTheDocument()
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
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Close preview' })).toHaveFocus())

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

  it('closes the image preview when clicking empty preview space', async () => {
    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    fireEvent.click(await within(sidebar).findByRole('button', { name: /preview existing\.png/i }))

    const dialog = screen.getByRole('dialog', { name: 'existing.png' })
    const stage = dialog.querySelector('.preview-stage')
    expect(stage).not.toBeNull()

    fireEvent.click(stage as Element)
    expect(screen.getByRole('dialog', { name: 'existing.png' })).toBeInTheDocument()

    fireEvent.click(dialog)
    expect(screen.queryByRole('dialog', { name: 'existing.png' })).not.toBeInTheDocument()
  })

  it('shows gallery controls for multiple image previews', async () => {
    const attachments = [
      attachmentFactory('first.png'),
      attachmentFactory('second.png'),
      attachmentFactory('third.png'),
    ]
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(managerFactory()))
      .mockResolvedValueOnce(jsonResponse(snapshotFactory({ attachments })))

    render(<App />)
    await getEventSource()

    const sidebar = screen.getByLabelText('Protocol details')
    fireEvent.click(await within(sidebar).findByRole('button', { name: /preview first\.png/i }))

    let dialog = screen.getByRole('dialog', { name: 'first.png' })
    expect(within(dialog).getByRole('button', { name: 'Previous attachment' })).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Next attachment' })).toBeInTheDocument()
    expect(within(dialog).getByLabelText('Attachment list')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: /preview attachment 1: first\.png/i })).toHaveAttribute(
      'aria-current',
      'true',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next attachment' }))

    dialog = await screen.findByRole('dialog', { name: 'second.png' })
    expect(dialog.querySelector('.preview-stage img')).toHaveAttribute(
      'src',
      '/api/runs/run-a/attachments/second.png',
    )

    fireEvent.click(within(dialog).getByRole('button', { name: /preview attachment 1: first\.png/i }))

    dialog = await screen.findByRole('dialog', { name: 'first.png' })
    expect(dialog.querySelector('.preview-stage img')).toHaveAttribute(
      'src',
      '/api/runs/run-a/attachments/first.png',
    )
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

  it('keeps the chat pinned when observed layout changes resize the scroll area', async () => {
    class MockResizeObserver {
      static instances: MockResizeObserver[] = []

      constructor(private readonly callback: ResizeObserverCallback) {
        MockResizeObserver.instances.push(this)
      }

      observe = vi.fn()
      disconnect = vi.fn()

      trigger() {
        this.callback([], this as unknown as ResizeObserver)
      }
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver)

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
    metrics.setScrollHeight(520)

    act(() => {
      MockResizeObserver.instances.forEach((observer) => observer.trigger())
    })

    await waitFor(() => expect(scrollPane.scrollTop).toBe(520))

    scrollPane.scrollTop = 60
    fireEvent.scroll(scrollPane)
    metrics.setScrollHeight(700)

    act(() => {
      MockResizeObserver.instances.forEach((observer) => observer.trigger())
    })

    expect(scrollPane.scrollTop).toBe(60)
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

function teammateFactory(): Teammate[] {
  return DEFAULT_TEAMMATES.map((teammate) => ({ ...teammate }))
}

function attachmentFactory(name: string, overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  const lowerName = name.toLowerCase()
  const kind: AttachmentMeta['kind'] = lowerName.endsWith('.zip')
    ? 'archive'
    : lowerName.endsWith('.pdf')
      ? 'pdf'
      : lowerName.endsWith('.txt')
        ? 'text'
        : lowerName.endsWith('.mp4')
          ? 'video'
          : lowerName.endsWith('.mp3')
            ? 'audio'
            : 'image'
  const mimeType = kind === 'archive'
    ? 'application/zip'
    : kind === 'pdf'
      ? 'application/pdf'
      : kind === 'text'
        ? 'text/plain'
        : kind === 'video'
          ? 'video/mp4'
          : kind === 'audio'
            ? 'audio/mpeg'
            : 'image/png'

  return {
    name,
    url: `/api/runs/run-a/attachments/${name}`,
    size: 42,
    mimeType,
    kind,
    mtimeMs: 1,
    mtimeIso: '2026-05-07T00:00:00.000Z',
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
