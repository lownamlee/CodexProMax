---
name: codex-pro-max-next
description: Use when Codex Pro Max Next is running; manage Codex session, conclusion, and wait through backend endpoints.
---

# Codex Pro Max Next

Use this skill only when `http://127.0.0.1:53127/api/healthy` is reachable. If not reachable, answer normally.

Use the current Codex thread id.

Endpoint flow, with no timeout on the wait request:

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:53127/api/codex/sessions/by-thread/<threadId>" -ContentType "application/json" -Body '{"displayName":"Current Codex Conversation"}'
```

Do the user's task.

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:53127/api/codex/sessions/by-thread/<threadId>/conclusion" -ContentType "application/json" -Body (@{ content = "<normal Codex conclusion>" } | ConvertTo-Json)
```

```powershell
Invoke-RestMethod -Method Post "http://127.0.0.1:53127/api/codex/sessions/by-thread/<threadId>/wait"
```

The wait loop is compulsory and indefinite:

- Never add `timeoutMs`, `TimeoutSec`, query-string timeout values, request-body timeout values, or host timeout wrappers to the `/wait` call.
- While `/wait` is pending, stay silent. Do not send progress messages just to say you are waiting.
- Do not send a final answer, summarize, call the task done, or stop after any amount of waiting.
- Do not replace `/wait` with status checks. Status checks are only for debugging and must be followed by `/wait` again.
- If `/wait` returns `instruction.content`, do that instruction, submit another conclusion, then immediately call `/wait` again.
- If `/wait` returns no instruction, `timedOut=true`, `stopped=true`, an empty response, a client timeout, a broken connection, or any non-instruction result, immediately call `/wait` again with the same thread id and no timeout.
- The only valid reason to leave the wait loop is a non-empty `instruction.content`; after handling it, return to the wait loop.

Never stop waiting for Codex Pro Max Next unless the user explicitly tells you in this chat to stop using Codex Pro Max Next.
