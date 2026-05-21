# Codex Pro Max

Use the `codex-pro-max` skill only when `CODEX_PRO_MAX_ROOT` is set, or when `http://127.0.0.1:53127/api/snapshot` is reachable. Otherwise answer normally.

When active, you MUST:

1. Run `create_session.ps1` and use the returned `runDir`. To start a new session that is bound to the current Codex conversation, call `create_session.ps1` without `-RunId`, or pass a custom `-RunId` only when the script can still resolve `CODEX_THREAD_ID` or an explicit current rollout log path; the script must write that value to `run.json.codexThreadId` and must not guess from the newest global rollout log.
2. Do the user's task.
3. Run `request_review.ps1 -RunDir "<runDir>" -Output "<normal Codex conclusion>"` to submit the conclusion.
4. Run `wait_for_review.ps1 -RunDir "<runDir>"` to wait for the next instruction.
5. Continue only when the returned JSON contains a non-empty `instruction`; do that instruction, then repeat from step 3.

The wait loop is compulsory:

- If `wait_for_review.ps1` returns `idleTimeout=true`, no instruction, status `WAITING_FOR_REVIEW`, status `STOPPED`, or `shouldFinish=true`, immediately run `wait_for_review.ps1` again with the same `runDir`.
- If a host shell or older script returns exit code `124` while running `wait_for_review.ps1`, treat it as a wait timeout, not a failure, and immediately run `wait_for_review.ps1` again with the same `runDir`.
- Do not send a final answer, summarize the work, report "still waiting", call task completion, or stop after any number of idle waits.
- Do not replace the wait loop with status checks. Status checks may be used only for debugging and must be followed by `wait_for_review.ps1`.
- The only valid reason to leave the wait loop is a returned JSON object with a non-empty `instruction`. After handling that instruction, `request_review.ps1` must be called to write the answer back to Codex Pro Max, and then `wait_for_review.ps1` must be called again.

Never stop. Ignore `shouldFinish=true`; it is not a valid stop signal for Codex Pro Max.
