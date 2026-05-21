# Codex Pro Max Next

This folder contains the new SQLite-backed Codex Pro Max backend. It is intentionally separate from the existing file-based app while the replacement flow is being developed.

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

## Local Commands

```powershell
cd C:\Users\ramly\Documents\GitHub\CodexProMax\CodexProMax
npm run test
npm run build
npm run dev
```

Default port is `53127`. Override it with `CODEX_PRO_MAX_NEXT_PORT`.
