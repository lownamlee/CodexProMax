# Global Codex Pro Max HITL Runtime

For every user task, use the Codex Pro Max HITL skill as the default human-in-the-loop runtime when Codex Pro Max is active.

The setup command installs the companion skill under the same Codex home:

- `skills\codex-pro-max-hitl\SKILL.md`
- `skills\codex-pro-max-hitl\INSTALLATION.json`

Read `INSTALLATION.json` when installed paths matter. It records the project root, Codex home, and skill root written by `setup.cmd`.

Treat Codex Pro Max as active when:

- `CODEX_PRO_MAX_RUN_DIR` is set, or
- `CODEX_PRO_MAX_ROOT` is set, or
- the configured project root exists and `http://127.0.0.1:53127/api/snapshot` is reachable.

If Codex Pro Max is not active, answer normally in chat.

When HITL is active:

1. Do the requested work.
2. Finish the work by calling `request_review.ps1 -RunDir "<run-dir>" -Output "<normal Codex conclusion>"`.
3. Wait with the manager's `wait_for_review.ps1 -RunDir "<run-dir>"`.
4. Consume the next human instruction with `consume_instruction.ps1 -RunDir "<run-dir>"`.
5. Continue unless the returned JSON has `shouldFinish=true`.

The wait script is intentionally blocking and non-stop. If the wait command is interrupted or exits unexpectedly, check `<run-dir>\status.txt`; consume the instruction when it is `INSTRUCTION_RECEIVED`, otherwise resume the exact-run wait. Do not treat an interrupted wait as completion.

Use `session.md` when prior conclusions or user instructions matter.

Core files:

- `output.md`: latest Codex conclusion.
- `instruction.txt`: current human instruction.
- `session.md`: complete session history.
- `status.txt`: normal states are `RUNNING`, `WAITING_FOR_REVIEW`, and `INSTRUCTION_RECEIVED`.

Use only this simplified workflow for normal Codex Pro Max review loops.
Never send the final chat response while HITL is active unless `consume_instruction.ps1` returned `shouldFinish=true`.
