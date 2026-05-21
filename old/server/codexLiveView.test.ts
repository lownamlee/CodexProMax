import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCodexLiveContext, parseCodexLiveRecord, readCodexLiveHistory } from './codexLiveView'

afterEach(() => {
  delete process.env.CODEX_SESSIONS_ROOT
})

describe('Codex rollout JSONL parser', () => {
  it('extracts shell command text from function call records', () => {
    const record = parseCodexLiveRecord(JSON.stringify({
      timestamp: '2026-05-12T08:15:34.755Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        arguments: JSON.stringify({ command: 'git push origin main', timeout_ms: 120000 }),
        call_id: 'call_1',
      },
    }), 0)

    expect(record).toMatchObject({
      kind: 'tool-call',
      title: 'Git command',
      text: 'git push origin main',
      callId: 'call_1',
      status: 'running',
    })
  })

  it('titles wait-for-review commands distinctly', () => {
    const record = parseCodexLiveRecord(JSON.stringify({
      timestamp: '2026-05-12T08:15:34.755Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'shell_command',
        arguments: JSON.stringify({
          command: "& 'C:\\Users\\ramly\\.codex\\skills\\codex-pro-max\\scripts\\wait_for_review.ps1' -RunDir 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-a'",
        }),
        call_id: 'call_wait',
      },
    }), 0)

    expect(record).toMatchObject({
      kind: 'tool-call',
      title: 'Wait for review',
      callId: 'call_wait',
      status: 'running',
    })
  })

  it('marks non-zero tool outputs as failed', () => {
    const record = parseCodexLiveRecord(JSON.stringify({
      timestamp: '2026-05-12T08:15:38.032Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Exit code: 1\nWall time: 0.2 seconds\nOutput:\nfatal: failed',
      },
    }), 1)

    expect(record).toMatchObject({
      kind: 'tool-output',
      callId: 'call_1',
      status: 'failed',
    })
  })

  it('uses actual user message text from user_message events', () => {
    const record = parseCodexLiveRecord(JSON.stringify({
      timestamp: '2026-05-12T14:50:22.476Z',
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: 'Open the rollout log in a new tab.',
      },
    }), 2)

    expect(record).toMatchObject({
      kind: 'message',
      title: 'User',
      text: 'Open the rollout log in a new tab.',
      status: 'completed',
    })
  })

  it('keeps assistant message ids stable when the live window index shifts', () => {
    const line = JSON.stringify({
      timestamp: '2026-05-12T14:50:23.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Keep this Thinking message visible.' }],
      },
    })

    const firstRecord = parseCodexLiveRecord(line, 12)
    const shiftedRecord = parseCodexLiveRecord(line, 84)

    expect(firstRecord?.id).toBe(shiftedRecord?.id)
  })

  it('hides empty reasoning events', () => {
    const record = parseCodexLiveRecord(JSON.stringify({
      timestamp: '2026-05-12T14:50:22.476Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [],
      },
    }), 3)

    expect(record).toBeNull()
  })

  it('hides patch apply end events because apply_patch output is summarized separately', () => {
    const record = parseCodexLiveRecord(JSON.stringify({
      timestamp: '2026-05-12T14:51:33.712Z',
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: 'call_patch',
        stdout: 'Success. Updated the following files:\nM server/codexLiveView.test.ts\n',
        success: true,
        changes: {
          'server/codexLiveView.test.ts': {
            type: 'update',
            unified_diff: '@@ -1 +1 @@',
          },
        },
        status: 'completed',
      },
    }), 4)

    expect(record).toBeNull()
  })

  it('unwraps custom tool output status', () => {
    const record = parseCodexLiveRecord(JSON.stringify({
      timestamp: '2026-05-12T14:51:33.712Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: 'call_patch',
        output: JSON.stringify({
          output: 'Success. Updated the following files:\nM C:\\Users\\ramly\\Desktop\\CodexProMax\\src\\App.tsx\n',
          metadata: { exit_code: 0, duration_seconds: 0 },
        }),
      },
    }), 4)

    expect(record).toMatchObject({
      kind: 'tool-output',
      callId: 'call_patch',
      text: 'Success. Updated the following files:\nM C:\\Users\\ramly\\Desktop\\CodexProMax\\src\\App.tsx\n',
      status: 'completed',
    })
  })

  it('combines shell calls and outputs into one record', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-'))
    process.env.CODEX_SESSIONS_ROOT = rootPath
    const relativePath = '2026/05/12/rollout-2026-05-12T09-05-49-session.jsonl'
    const filePath = path.join(rootPath, ...relativePath.split('/'))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, [
      JSON.stringify({
        timestamp: '2026-05-12T09:05:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: JSON.stringify({ command: 'npm test -- --run' }),
          call_id: 'call_test',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:05:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_test',
          output: 'Exit code: 0\nWall time: 1.0 seconds\nOutput:\nTest Files  4 passed (4)\nTests  88 passed (88)',
        },
      }),
    ].join('\n'))

    const id = Buffer.from(relativePath, 'utf8').toString('base64url')
    const history = await readCodexLiveHistory(id)

    expect(history.records).toHaveLength(1)
    expect(history.records[0]).toMatchObject({
      kind: 'tool-call',
      title: 'Run tests',
      status: 'completed',
      callId: 'call_test',
    })
    expect(history.records[0].text).toContain('npm test -- --run')
    expect(history.records[0].text).toContain('Result:')
    expect(history.records[0].text).toContain('Test Files  4 passed')
  })

  it('keeps assistant messages around oversized image output records', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-'))
    process.env.CODEX_SESSIONS_ROOT = rootPath
    const relativePath = '2026/05/12/rollout-2026-05-12T09-05-54-session.jsonl'
    const filePath = path.join(rootPath, ...relativePath.split('/'))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const oversizedImageOutput = JSON.stringify([
      {
        type: 'input_image',
        image_url: `data:image/png;base64,${'a'.repeat((2 * 1024 * 1024) + 1024)}`,
      },
    ])
    await fs.writeFile(filePath, [
      JSON.stringify({
        timestamp: '2026-05-12T09:05:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Verify the generated image.',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:05:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Generating the verification screenshot.' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:05:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'view_image',
          arguments: JSON.stringify({ path: 'C:\\Users\\ramly\\Desktop\\image.png' }),
          call_id: 'call_image',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:05:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_image',
          output: oversizedImageOutput,
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:05:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The generated verification screenshot shows the expected evidence.' }],
        },
      }),
    ].join('\n'))

    const id = Buffer.from(relativePath, 'utf8').toString('base64url')
    const history = await readCodexLiveHistory(id, { records: 10, tailBytes: 16 * 1024 })
    const assistantMessages = history.records
      .filter((record) => record.kind === 'message' && record.title === 'Assistant')
      .map((record) => record.text)

    expect(assistantMessages).toEqual([
      'Generating the verification screenshot.',
      'The generated verification screenshot shows the expected evidence.',
    ])
    expect(history.truncated).toBe(true)
  })

  it('keeps timed-out wait-for-review calls in waiting state', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-'))
    process.env.CODEX_SESSIONS_ROOT = rootPath
    const relativePath = '2026/05/12/rollout-2026-05-12T09-05-59-session.jsonl'
    const filePath = path.join(rootPath, ...relativePath.split('/'))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, [
      JSON.stringify({
        timestamp: '2026-05-12T09:05:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: JSON.stringify({
            command: "& 'C:\\Users\\ramly\\.codex\\skills\\codex-pro-max\\scripts\\wait_for_review.ps1' -RunDir 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-a'",
          }),
          call_id: 'call_wait',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T10:05:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_wait',
          output: 'Exit code: 124\nWall time: 3600 seconds\nOutput:\ncommand timed out after 3600012 milliseconds',
        },
      }),
    ].join('\n'))

    const id = Buffer.from(relativePath, 'utf8').toString('base64url')
    const history = await readCodexLiveHistory(id)

    expect(history.records).toHaveLength(1)
    expect(history.records[0]).toMatchObject({
      kind: 'tool-call',
      title: 'Wait for review',
      status: 'waiting',
      callId: 'call_wait',
    })
  })

  it('keeps clean idle wait-for-review returns in waiting state', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-'))
    process.env.CODEX_SESSIONS_ROOT = rootPath
    const relativePath = '2026/05/12/rollout-2026-05-12T09-06-19-session.jsonl'
    const filePath = path.join(rootPath, ...relativePath.split('/'))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, [
      JSON.stringify({
        timestamp: '2026-05-12T09:06:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: JSON.stringify({
            command: "& 'C:\\Users\\ramly\\.codex\\skills\\codex-pro-max\\scripts\\wait_for_review.ps1' -RunDir 'C:\\Users\\ramly\\Desktop\\CodexProMax\\runs\\run-a'",
          }),
          call_id: 'call_wait_idle',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:59:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_wait_idle',
          output: 'Exit code: 0\nWall time: 3300 seconds\nOutput:\n{"ok":true,"status":"WAITING_FOR_REVIEW","instruction":"","shouldFinish":false,"idleTimeout":true}',
        },
      }),
    ].join('\n'))

    const id = Buffer.from(relativePath, 'utf8').toString('base64url')
    const history = await readCodexLiveHistory(id)

    expect(history.records).toHaveLength(1)
    expect(history.records[0]).toMatchObject({
      kind: 'tool-call',
      title: 'Wait for review',
      status: 'waiting',
      callId: 'call_wait_idle',
    })
  })

  it('groups consecutive actions without a message between them', async () => {
    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-live-'))
    process.env.CODEX_SESSIONS_ROOT = rootPath
    const relativePath = '2026/05/12/rollout-2026-05-12T09-06-49-session.jsonl'
    const filePath = path.join(rootPath, ...relativePath.split('/'))
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, [
      JSON.stringify({
        timestamp: '2026-05-12T09:06:00.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: JSON.stringify({ command: 'npm test -- --run' }),
          call_id: 'call_test',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:06:01.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_test',
          output: 'Exit code: 0\nWall time: 1.0 seconds\nOutput:\nTest Files  4 passed (4)\nTests  88 passed (88)',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:06:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'shell_command',
          arguments: JSON.stringify({ command: 'npm run build' }),
          call_id: 'call_build',
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-12T09:06:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_build',
          output: 'Exit code: 0\nWall time: 1.0 seconds\nOutput:\nvite v7.3.3 building client environment for production...\n✓ built in 2.5s',
        },
      }),
    ].join('\n'))

    const id = Buffer.from(relativePath, 'utf8').toString('base64url')
    const history = await readCodexLiveHistory(id)

    expect(history.records).toHaveLength(1)
    expect(history.records[0]).toMatchObject({
      kind: 'action-group',
      title: '2 actions',
      status: 'completed',
    })
    expect(history.records[0].children).toHaveLength(2)
    expect(history.records[0].children?.map((record) => record.title)).toEqual(['Run tests', 'Build app'])
  })

  it('extracts context usage from token count events', () => {
    const context = parseCodexLiveContext(JSON.stringify({
      timestamp: '2026-05-12T09:29:29.803Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 135721336,
            cached_input_tokens: 133152896,
            output_tokens: 346237,
            reasoning_output_tokens: 117450,
            total_tokens: 136067573,
          },
          last_token_usage: {
            input_tokens: 67688,
            cached_input_tokens: 66944,
            output_tokens: 181,
            reasoning_output_tokens: 164,
            total_tokens: 67869,
          },
          model_context_window: 258400,
        },
        rate_limits: {
          limit_id: 'codex',
          limit_name: null,
          primary: {
            used_percent: 67,
            window_minutes: 300,
            resets_at: 1778615464,
          },
          secondary: {
            used_percent: 41,
            window_minutes: 10080,
            resets_at: 1779090417,
          },
          credits: {
            has_credits: false,
            unlimited: false,
            balance: null,
          },
          plan_type: 'team',
          rate_limit_reached_type: null,
        },
      },
    }))

    expect(context).toMatchObject({
      timestamp: '2026-05-12T09:29:29.803Z',
      contextWindow: 258400,
      usedTokens: 67869,
      remainingTokens: 190531,
      inputTokens: 67688,
      cachedInputTokens: 66944,
      outputTokens: 181,
      reasoningOutputTokens: 164,
      totalUsage: {
        totalTokens: 136067573,
      },
      rateLimits: {
        limitId: 'codex',
        planType: 'team',
        primary: {
          usedPercent: 67,
          remainingPercent: 33,
          windowMinutes: 300,
          resetsAt: 1778615464,
        },
        secondary: {
          usedPercent: 41,
          remainingPercent: 59,
          windowMinutes: 10080,
        },
      },
    })
    expect(context?.percentUsed).toBeCloseTo(26.265)
    expect(context?.percentRemaining).toBeCloseTo(73.735)
  })
})
