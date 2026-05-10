# Codex Pro Max Project Instruction

Use the global Codex Pro Max HITL runtime only when the manager is actually running at `C:\Users\ramly\Desktop\CodexProMax`.

HITL is active when `CODEX_PRO_MAX_RUN_DIR` or `CODEX_PRO_MAX_ROOT` is set, or when `http://127.0.0.1:5127/api/snapshot` is reachable.

When HITL is active:
- Use `C:\Users\ramly\.codex\skills\codex-pro-max-hitl\SKILL.md`.
- Finish work by calling `request_review.ps1 -RunDir "<run-dir>" -Output "<normal Codex conclusion>"`.
- Wait with `wait_for_review.ps1`.
- Consume the next instruction with `consume_instruction.ps1 -RunDir "<run-dir>"`.
- Continue unless `consume_instruction.ps1` returns `shouldFinish=true`.
- Read `session.md` if prior conclusions or user instructions matter.

Normal statuses are `RUNNING`, `WAITING_FOR_REVIEW`, and `INSTRUCTION_RECEIVED`.

If HITL is not active, answer normally in chat.
