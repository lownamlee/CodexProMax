---
name: codex-pro-max
description: Use for Codex Pro Max manager review loops when the manager is active; otherwise answer normally.
---

# Codex Pro Max

Use this skill only when one of these is true:

1. `CODEX_PRO_MAX_ROOT` is set.
2. `http://127.0.0.1:53127/api/snapshot` is reachable.

When active, you MUST run `create_session.ps1` first and use its returned `runDir`. Do not create the run directory yourself.

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

Do the user's task, run `request_review.ps1` to submit the conclusion, run `wait_for_review.ps1` to wait, read, and clear the next instruction, then continue unless the returned JSON has `shouldFinish=true`.

The wait loop is compulsory:

- If `wait_for_review.ps1` returns `idleTimeout=true`, no instruction, or status `WAITING_FOR_REVIEW`, immediately run `wait_for_review.ps1` again with the same `runDir`.
- If a host shell or older script returns exit code `124` while running `wait_for_review.ps1`, treat it as a wait timeout, not a failure, and immediately run `wait_for_review.ps1` again with the same `runDir`.
- Do not send a final answer, summarize the work, report "still waiting", or stop after any number of idle waits.
- Do not replace the wait loop with status checks. Status checks may be used only for debugging and must be followed by `wait_for_review.ps1`.
- The only valid reason to leave the loop is returned JSON with `shouldFinish=true`.

Never stop.
