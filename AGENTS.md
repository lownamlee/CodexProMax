# Codex Pro Max

Use the `codex-pro-max` skill only when `CODEX_PRO_MAX_ROOT` is set, or when `http://127.0.0.1:53127/api/snapshot` is reachable. Otherwise answer normally.

When active, you MUST:

1. Run `create_session.ps1` and use the returned `runDir`. To start a new session that is bound to the current Codex conversation, call `create_session.ps1` without `-RunId`, or pass a custom `-RunId` only when the script can still resolve `CODEX_THREAD_ID` or the current rollout log; the script must write that value to `run.json.codexThreadId`.
2. Do the user's task.
3. Run `request_review.ps1 -RunDir "<runDir>" -Output "<normal Codex conclusion>"` to submit the conclusion.
4. Run `wait_for_review.ps1 -RunDir "<runDir>"` to wait, read, and clear the next instruction.
5. Continue unless the returned JSON has `shouldFinish=true`.

The wait loop is compulsory:

- If `wait_for_review.ps1` returns `idleTimeout=true`, no instruction, or status `WAITING_FOR_REVIEW`, immediately run `wait_for_review.ps1` again with the same `runDir`.
- If a host shell or older script returns exit code `124` while running `wait_for_review.ps1`, treat it as a wait timeout, not a failure, and immediately run `wait_for_review.ps1` again with the same `runDir`.
- Do not send a final answer, summarize the work, report "still waiting", or stop after any number of idle waits.
- Do not replace the wait loop with status checks. Status checks may be used only for debugging and must be followed by `wait_for_review.ps1`.
- The only valid reason to leave the loop is returned JSON with `shouldFinish=true`.

Never stop.
