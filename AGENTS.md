# Codex Pro Max Project Instruction

This project uses the global Codex Pro Max HITL runtime. Before any final completion response after work, use `C:\Users\ramly\.codex\skills\codex-pro-max-hitl\SKILL.md`, resolve this Codex instance's `runs/<runId>` folder, write `progress.md` and `output.md` there, set that run's `status.txt` to `WAITING_FOR_REVIEW`, and wait with the blocking script until the UI writes `APPROVED`, `REVISION_REQUESTED`, or `INSTRUCTION_RECEIVED`.

Do not finish early just because the user did not mention `$codex-pro-max-hitl`. Do not stop after `APPROVED`; consume and clear `instruction.txt`, then continue with any instruction or return to `IDLE` and wait again.

The Codex Pro Max UI uses one primary `Send to Codex` button. Normal human input arrives as `INSTRUCTION_RECEIVED`; read `instruction.txt`, decide whether it is a question, revision request, approval note, or new task, write the answer/result back into the run's `output.md` and `progress.md`, and wait again. Do not answer in the chat window unless the instruction explicitly says to stop, finish, end, or disable HITL.
