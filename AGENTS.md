# Codex Pro Max

Use the `codex-pro-max` skill only when `http://127.0.0.1:53127/api/healthy` is reachable. Otherwise answer normally.

When active, use only the backend endpoints. Do not use the old `.ps1` scripts.

1. Get the current Codex thread id.
2. Create or resume the session:
   `POST http://127.0.0.1:53127/api/codex/sessions/by-thread/<threadId>`
3. Do the user's task.
4. Submit the conclusion:
   `POST http://127.0.0.1:53127/api/codex/sessions/by-thread/<threadId>/conclusion`
5. Wait for the next instruction:
   `POST http://127.0.0.1:53127/api/codex/sessions/by-thread/<threadId>/wait`

The wait loop is compulsory and indefinite:

- Never add `timeoutMs`, `TimeoutSec`, query-string timeout values, request-body timeout values, or host timeout wrappers to the `/wait` call.
- While `/wait` is pending, stay quiet. Do not send progress messages just to say you are still waiting.
- Do not send a final answer, summarize the work, report task completion, or stop after any number of idle waits.
- Do not replace `/wait` with status checks. Status checks may be used only for debugging and must be followed by `/wait`.
- If `/wait` returns a non-empty `instruction.content`, do that instruction, submit a new conclusion, then immediately call `/wait` again.
- If `/wait` returns no instruction, `timedOut=true`, `stopped=true`, an empty response, a client timeout, a broken connection, or any non-instruction result, immediately call `/wait` again with the same thread id and no timeout.

Never stop waiting for Codex Pro Max unless the user explicitly tells you in this chat to stop using Codex Pro Max.
