---
name: codex-pro-max-hitl
description: Default continuous human-in-the-loop runtime for Codex Pro Max when the configured manager project is actually running or an explicit CODEX_PRO_MAX_* run is active. When the manager is unavailable, skip HITL and answer normally in chat.
---

# Codex Pro Max HITL

Use this skill only when Codex Pro Max is available.

## Installation

The setup command copies this skill into Codex home and writes `INSTALLATION.json` next to this file. Read that file when you need the installed project root, Codex home, or skill root.

## Availability

HITL is active only when one is true:

1. `CODEX_PRO_MAX_RUN_DIR` is set.
2. `CODEX_PRO_MAX_ROOT` is set.
3. The configured project root from `INSTALLATION.json` exists and `http://127.0.0.1:53127/api/snapshot` is reachable.

If none is true, answer normally in chat.

## Run Directory

Use `CODEX_PRO_MAX_RUN_DIR` when set. Otherwise use `<manager-root>\runs\<CODEX_PRO_MAX_RUN_ID>`, then `<manager-root>\runs\<CODEX_THREAD_ID>`, otherwise create a safe `runs\run-<timestamp>-<random>` folder.

## Loop

1. Do the work.
2. Call `request_review.ps1 -RunDir "<run-dir>" -Output "<normal Codex conclusion>"`.
3. Wait with `<manager-root>\wait_for_review.ps1 -RunDir "<run-dir>"`.
4. Call `consume_instruction.ps1 -RunDir "<run-dir>"`.
5. If `shouldFinish=true`, send the final chat response. Otherwise execute `instruction` and repeat.

Do not stop unless `consume_instruction.ps1` returns `shouldFinish=true`.
The wait script is intentionally blocking and non-stop. If a wait command is interrupted or exits unexpectedly, immediately check `<run-dir>\status.txt`; consume the instruction when it is `INSTRUCTION_RECEIVED`, otherwise resume the exact-run wait. Do not treat an interrupted wait as completion.

## Files

- `output.md`: latest Codex conclusion.
- `instruction.txt`: current human instruction.
- `session.md`: complete session history. Read it when previous conclusions or instructions matter.
- `status.txt`: normal states are `RUNNING`, `WAITING_FOR_REVIEW`, and `INSTRUCTION_RECEIVED`. `BLOCKED` and `ERROR` are exceptional only.

## Commands

Use the paths from `INSTALLATION.json`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skillRoot>\scripts\request_review.ps1" -RunDir "<run-dir>" -Output "<normal Codex conclusion>"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<projectRoot>\wait_for_review.ps1" -RunDir "<run-dir>"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skillRoot>\scripts\consume_instruction.ps1" -RunDir "<run-dir>"
```
