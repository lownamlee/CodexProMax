import { describe, expect, it } from 'vitest'
import { parseCodexLiveContext, parseCodexLiveRecord } from './codexLiveView'

describe('Codex live view JSONL parser', () => {
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
      title: 'Shell command',
      text: 'git push origin main',
      callId: 'call_1',
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

  it('extracts context usage from token count events', () => {
    const context = parseCodexLiveContext(JSON.stringify({
      timestamp: '2026-05-12T09:29:29.803Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 67688,
            cached_input_tokens: 66944,
            output_tokens: 181,
            reasoning_output_tokens: 164,
            total_tokens: 67869,
          },
          model_context_window: 258400,
        },
      },
    }))

    expect(context).toMatchObject({
      timestamp: '2026-05-12T09:29:29.803Z',
      contextWindow: 258400,
      usedTokens: 67869,
      inputTokens: 67688,
      cachedInputTokens: 66944,
      outputTokens: 181,
      reasoningOutputTokens: 164,
    })
    expect(context?.percentUsed).toBeCloseTo(26.265)
  })
})
