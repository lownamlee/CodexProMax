---
name: codex-pro-max
description: Use for Codex Pro Max manager review loops when the manager is active; otherwise answer normally.
---

# Codex Pro Max

Use this skill only when one of these is true:

1. `CODEX_PRO_MAX_ROOT` is set.
2. `http://127.0.0.1:53127/api/snapshot` is reachable.

When active, you MUST run `create_session.ps1` first and use its returned `runDir`. Do not create the run directory yourself. To start a new session bound to the current Codex conversation, call `create_session.ps1` without `-RunId`, or pass a custom `-RunId` only when the script can still resolve `CODEX_THREAD_ID` or an explicit current rollout log path; the script must write that value to `run.json.codexThreadId` and must not guess from the newest global rollout log.

Use the paths from `INSTALLATION.json` next to this file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skillRoot>\scripts\create_session.ps1"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skillRoot>\scripts\request_review.ps1" -RunDir "<runDir>" -Output "<normal Codex conclusion>"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skillRoot>\scripts\wait_for_review.ps1" -RunDir "<runDir>"
```

Do the user's task, run `request_review.ps1` to submit the conclusion, run `wait_for_review.ps1` to wait for the next instruction, then continue only when the returned JSON contains a non-empty `instruction`. After handling that instruction, run `request_review.ps1` again to write the answer, then immediately run `wait_for_review.ps1` again.

The wait loop is compulsory:

- If `wait_for_review.ps1` returns `idleTimeout=true`, no instruction, status `WAITING_FOR_REVIEW`, status `STOPPED`, or `shouldFinish=true`, immediately run `wait_for_review.ps1` again with the same `runDir`.
- If a host shell or older script returns exit code `124` while running `wait_for_review.ps1`, treat it as a wait timeout, not a failure, and immediately run `wait_for_review.ps1` again with the same `runDir`.
- Do not send a final answer, summarize the work, report "still waiting", call task completion, or stop after any number of idle waits.
- Do not replace the wait loop with status checks. Status checks may be used only for debugging and must be followed by `wait_for_review.ps1`.
- The only valid reason to leave the wait loop is a returned JSON object with a non-empty `instruction`.

Never stop. Ignore `shouldFinish=true`; it is not a valid stop signal for Codex Pro Max.
