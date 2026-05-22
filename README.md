# Codex Pro Max

This repository contains the SQLite-backed Codex Pro Max backend and UI. The archived file-based implementation lives under `old/`.

## Codex Flow

1. Codex checks whether the backend is alive.
   - `GET /api/health`
   - `GET /api/healthy`
2. Codex reads its current `CODEX_THREAD_ID`.
3. Codex creates or resumes a session by thread id.
   - `POST /api/codex/sessions/by-thread/:codexThreadId`
4. Codex does the requested work.
5. Codex submits a conclusion.
   - `POST /api/codex/sessions/by-thread/:codexThreadId/conclusion`
6. Codex waits for the next user instruction.
   - `POST /api/codex/sessions/by-thread/:codexThreadId/wait`

The backend uses the Codex thread id to resolve the exact rollout log path and Codex live session id from the Codex sessions directory.

## Data Model

SQLite is the source of truth. Attachments are stored on disk under the configured data root and referenced from SQLite.

Core session states:

- `RUNNING`
- `WAITING_FOR_INSTRUCTION`
- `STOPPED`
- `ERROR`

There is no delivered-instruction state. When `wait` returns an instruction to Codex, the instruction is consumed and the session goes back to `RUNNING`.

## Composer Context

The session composer keeps context attached to the next instruction:

- Type `@` to insert an uploaded attachment mention.
- Type `/` to open saved slash skills. Arrow keys move through attachment or skill suggestions, while `Enter` or `Tab` inserts the active item.
- Manage slash skills from the profile menu's Skills dialog. New data roots include a removable `/plan-first` system skill for the deeper planning prompt used during development.

Slash skills are global SQLite records, so they are available across Codex sessions without belonging to one session transcript.

## Local Commands

```powershell
cd C:\Users\ramly\Documents\GitHub\CodexProMax
npm run test
npm run build
npm run dev
```

Default port is `53127`. Override it with `CODEX_PRO_MAX_PORT`.
