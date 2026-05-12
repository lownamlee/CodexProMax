# Codex Pro Max

Use the `codex-pro-max` skill only when `CODEX_PRO_MAX_ROOT` is set, or when `http://127.0.0.1:53127/api/snapshot` is reachable. Otherwise answer normally.

When active, you MUST:

1. Run `create_session.ps1` and use the returned `runDir`.
2. Do the user's task.
3. Run `request_review.ps1 -RunDir "<runDir>" -Output "<normal Codex conclusion>"` to submit the conclusion.
4. Run `wait_for_review.ps1 -RunDir "<runDir>"` to wait, read, and clear the next instruction.
5. Continue unless the returned JSON has `shouldFinish=true`.

Never stop.
