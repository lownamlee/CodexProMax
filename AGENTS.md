# Codex Pro Max Project Instruction

Use the global Codex Pro Max HITL runtime only when the manager is actually running at `C:\Users\ramly\Desktop\CodexProMax`.

HITL is active when `CODEX_PRO_MAX_RUN_DIR` or `CODEX_PRO_MAX_ROOT` is set, or when `http://127.0.0.1:53127/api/snapshot` is reachable.

When HITL is active:
- Use `C:\Users\ramly\.codex\skills\codex-pro-max-hitl\SKILL.md`.
- Finish work by calling `request_review.ps1 -RunDir "<run-dir>" -Output "<normal Codex conclusion>"`.
- Wait with `wait_for_review.ps1 -RunDir "<run-dir>"`.
- Consume the next instruction with `consume_instruction.ps1 -RunDir "<run-dir>"`.
- Continue unless `consume_instruction.ps1` returns `shouldFinish=true`.
- Read `session.md` if prior conclusions or user instructions matter.

Use `-MaxSeconds` only for explicit diagnostics or user-requested status updates, not for the default review loop.
If the wait command is interrupted, times out, or exits unexpectedly, check `<run-dir>/status.txt`; consume the instruction when it is `INSTRUCTION_RECEIVED`, otherwise resume the exact-run wait. Do not treat an interrupted wait as completion.

Normal statuses are `RUNNING`, `WAITING_FOR_REVIEW`, and `INSTRUCTION_RECEIVED`.

If HITL is not active, answer normally in chat.
Never send the final chat response while HITL is active unless `consume_instruction.ps1` returned `shouldFinish=true`.
