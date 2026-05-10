# Codex Pro Max

Codex Pro Max is a local human-in-the-loop inbox for Codex-style agents. It gives each Codex session its own run folder, lets the agent pause with a normal final-style conclusion, and lets the human send the next instruction from a single chat composer.

The current design is intentionally small:

- One human input path: `Send to Codex`.
- One UI-owned normal state: `INSTRUCTION_RECEIVED`.
- One review state: `WAITING_FOR_REVIEW`.
- One complete history file: `session.md`.

## System Overview

The app has three moving parts:

| Layer | Purpose |
| --- | --- |
| React/Vite UI | Shows the run inbox, selected conversation, protocol files, attachments, and a single instruction composer. |
| Express API | Reads/writes run folders, validates requests, serves attachments, and exposes JSON + SSE endpoints. |
| File protocol | Uses plain files under `runs/<runId>/` so Codex and the UI can coordinate without a database. |

The normal flow is:

1. Codex completes a unit of work.
2. Codex calls `request_review.ps1 -Output "<normal conclusion>"`.
3. The script writes `output.md`, appends the assistant message to `session.md`, cleans obsolete run notes, and sets `status.txt` to `WAITING_FOR_REVIEW`.
4. The UI displays the conclusion and waits for the human.
5. The human writes one instruction and clicks `Send to Codex`.
6. The backend writes `instruction.txt`, appends the user message to `session.md`, and sets `status.txt` to `INSTRUCTION_RECEIVED`.
7. Codex's wait script exits.
8. Codex calls `consume_instruction.ps1`, which reads and clears `instruction.txt`, sets `status.txt` to `RUNNING`, and returns the instruction plus `sessionPath`.
9. Codex continues unless `shouldFinish=true`.

## Requirements

- Node.js 24 or newer.
- npm 11 or newer.
- Windows PowerShell for the bundled `.ps1` helper scripts.

The default API port is `53127`. The default Vite UI port is `5173`.

## Getting Started

Install dependencies:

```bash
npm install
```

Start the local API and UI:

```bash
npm run dev
```

Open the UI:

```text
http://127.0.0.1:5173/
```

The API listens on:

```text
http://127.0.0.1:53127/
```

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Starts the Express API and Vite UI together with `concurrently`. |
| `npm test` | Runs Vitest backend and UI tests. |
| `npm run build` | Runs TypeScript checks and builds the production UI in `dist/`. |
| `npm run preview` | Serves the production build with Vite preview. |

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `CODEX_PRO_MAX_ROOT` | Optional manager root. Defaults to the current workspace directory. |
| `CODEX_PRO_MAX_API_PORT` | Optional API port. Defaults to `53127`. |
| `CODEX_PRO_MAX_RUN_DIR` | Exact run directory for one Codex session. Highest priority for the skill. |
| `CODEX_PRO_MAX_RUN_ID` | Run id used as `runs/<runId>` under the manager root. |
| `CODEX_THREAD_ID` | Codex thread id fallback for stable per-session run folders. |
| `CODEX_PRO_MAX_POLL_SECONDS` | Optional wait script polling interval. |

If no run id is available, the skill creates a safe `run-<timestamp>-<random>` folder.

## File Protocol

Each active Codex session is isolated under `runs/<runId>/`:

```text
<manager-root>/
  runs/
    <runId>/
      status.txt
      output.md
      instruction.txt
      session.md
      events.ndjson
      run.json
      attachments/
```

Root-level protocol files are legacy only. If root-level protocol files exist, the backend exposes them as the synthetic run id `legacy-root` so old review state is still visible.

### Core Files

| Path | Owner | Purpose |
| --- | --- | --- |
| `status.txt` | Agent + UI | Single state token for coordination. |
| `output.md` | Agent | Latest Codex conclusion shown to the human. |
| `instruction.txt` | UI then agent | Current instruction waiting for Codex. Cleared after consumption. |
| `session.md` | Agent + UI | Complete session history of assistant conclusions and user instructions. |
| `events.ndjson` | Backend | Append-only audit log for backend/user/watcher events. |
| `run.json` | Agent/backend | Run metadata shown in the inbox. |
| `attachments/` | UI | Uploaded review images. |

New scripts clean obsolete run-note files if they encounter old copies.

### Status Model

Normal statuses:

| Status | Owner | Meaning |
| --- | --- | --- |
| `RUNNING` | Agent | Codex has consumed any instruction and is working or ready to continue. |
| `WAITING_FOR_REVIEW` | Agent | Codex has paused and the human can send the next instruction. |
| `INSTRUCTION_RECEIVED` | UI | The UI wrote a human instruction and Codex should consume it. |

Exceptional statuses:

| Status | Owner | Meaning |
| --- | --- | --- |
| `BLOCKED` | Agent | Codex is waiting on an external dependency or cannot proceed. |
| `ERROR` | Agent | Codex hit a failure and needs human input. |

Legacy status handling:

- Old UI-owned statuses are normalized in snapshots.
- If an old run has a pending instruction, snapshots map it to `INSTRUCTION_RECEIVED`.
- If an old run has no pending instruction, snapshots map it to `RUNNING`.

### Session History

`session.md` is the source of truth for conversation history. It is intentionally readable by both humans and agents.

Each message is stored as a Markdown block with a metadata comment:

```markdown
<!-- codex-pro-max:message {"id":"...","role":"assistant","createdAtIso":"..."} -->
## Codex - 2026-05-10T00:00:00.000Z

Implemented the requested change.
```

Roles are:

- `assistant`: Codex conclusions written by `request_review.ps1` or watcher fallback.
- `user`: human instructions sent through the UI or consumed by `consume_instruction.ps1`.

Legacy chat logs are read only for compatibility. When the backend or scripts need to write history and no `session.md` exists yet, legacy messages are seeded into `session.md` first.

## Backend Design

### Express API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/snapshot` | Manager snapshot with all runs and server health. |
| `GET /api/runs/:runId/snapshot` | Full selected-run snapshot with status, output, files, attachments, and messages. |
| `GET /api/events` | Server-Sent Events stream for live manager snapshots. |
| `POST /api/runs/:runId/action` | Writes one non-empty instruction and sets `INSTRUCTION_RECEIVED`. |
| `POST /api/runs/:runId/upload` | Uploads one raster image attachment. |
| `GET /api/runs/:runId/attachments/:fileName` | Serves an uploaded attachment. |
| `DELETE /api/runs/:runId/attachments/:fileName` | Deletes one attachment from the selected run. |
| `DELETE /api/runs/:runId/messages` | Clears `session.md` for the selected run while keeping the run open. |
| `POST /api/runs/:runId/stop` | Sends the canonical stop instruction through the selected run. |
| `DELETE /api/runs/:runId` | Deletes a real run folder. `legacy-root` is protected. |

The `/action` route name is kept for API compatibility, but the payload is now only:

```json
{
  "instruction": "Continue with the next task."
}
```

The backend writes `instruction.txt` before `status.txt` so a waiting agent never observes `INSTRUCTION_RECEIVED` without the matching instruction.

Legacy aliases remain available:

- `POST /api/action`
- `POST /api/upload`

Both target `legacy-root`.

### Snapshot Hub

`server/snapshotHub.ts` owns:

- Chokidar file watching.
- SSE client management.
- Debounced manager snapshot broadcasts.
- Audit logging for watched protocol files, metadata, and attachments.
- Assistant history fallback when a status file changes to `WAITING_FOR_REVIEW`.

The watcher ignores recursive changes to `events.ndjson` so audit writes do not trigger audit loops.

### Protocol Store

`server/protocolStore.ts` owns:

- Safe run id validation and path resolution.
- Snapshot construction.
- Markdown size warnings and render truncation.
- Attachment validation and atomic writes.
- `session.md` parsing, writing, and legacy chat-log migration.
- Conversation-history clearing by truncating only `session.md`.
- Legacy root discovery.
- Legacy status normalization.

Run ids must match the safe-name rules and cannot escape `<manager-root>/runs`.

## UI Design

The React app is a dense local operations UI, not a landing page.

Main surfaces:

- Left sidebar: run inbox, active run selection, delete controls for real runs.
- Center: chat-style conversation from `session.md`, with assistant and user messages in chronological order.
- Header actions: sidebar toggles, connection state, run count, stop session, and conversation-history clearing.
- Bottom composer: one auto-growing text box, one send button, current-message attachment chips, and highlighted `@` attachment mentions.
- Attachment control: image upload from file picker, drag/drop, or pasted clipboard image; pasted images are inserted into the composer as `@file-name` references.
- Right sidebar: workspace path, current status, protocol file presence, and the current session attachment list with thumbnails when images can render.

Important UI behavior:

- New messages auto-scroll only if the user was already near the bottom.
- If the user scrolls up, new messages do not yank the viewport.
- Clicking an attachment opens an image preview dialog.
- Message headers include copy buttons for user and Codex messages.
- The UI shows only the simplified normal protocol files.

## Codex Skill Runtime

The global skill lives at:

```text
C:\Users\ramly\.codex\skills\codex-pro-max-hitl
```

The global Codex instruction file should point to that skill:

```text
C:\Users\ramly\.codex\AGENTS.md
```

Run directory resolution priority:

1. `CODEX_PRO_MAX_RUN_DIR`
2. `CODEX_PRO_MAX_ROOT\runs\CODEX_PRO_MAX_RUN_ID`
3. `CODEX_PRO_MAX_ROOT\runs\CODEX_THREAD_ID`
4. `CODEX_PRO_MAX_ROOT\runs\run-<timestamp>-<random>`

Helper scripts:

| Script | Purpose |
| --- | --- |
| `request_review.ps1` | Writes `output.md`, appends assistant history to `session.md`, cleans obsolete run notes, sets `WAITING_FOR_REVIEW`. |
| `consume_instruction.ps1` | Reads `instruction.txt`, appends user history to `session.md`, clears instruction, sets `RUNNING`, returns JSON. |
| `wait_for_review.ps1` | Polls until `status.txt` becomes `INSTRUCTION_RECEIVED`; use `-RunDir` to pin the exact run and `-MaxSeconds` for bounded heartbeat waits. |

The agent should only stop when `consume_instruction.ps1` returns `shouldFinish=true`.

## Audit Events

Every run has an append-only `events.ndjson`.

Common event types:

- `user.message`: full submitted instruction and target status.
- `instruction.sent`: instruction preview and byte count.
- `session.stop.requested`: stop instruction preview and byte count.
- `conversation.cleared`: selected run history was cleared.
- `upload.image`: accepted image upload metadata.
- `attachment.deleted`: selected attachment name.
- `protocol.file.changed`: watched protocol file add/change/unlink with preview when available.
- `run.metadata.changed`: `run.json` changes.
- `attachment.changed`: attachment additions, changes, and removals.

Audit events are for traceability. `session.md` is the conversational history that agents should read.

## Compatibility and Migration

Compatibility behavior exists so old runs keep working:

- Existing legacy chat logs are parsed and migrated into `session.md`.
- Old UI-owned statuses are normalized in snapshots.
- Root-level protocol files appear as `legacy-root`.
- The route name `/action` remains, but request bodies no longer contain an action field.

New code should write only the simplified protocol files and statuses described above.

## Project Structure

```text
server/
  app.ts              Express routes and middleware.
  protocolStore.ts    File protocol reads, writes, safety checks, session parsing, uploads.
  snapshotHub.ts      Chokidar watcher and SSE broadcast hub.

src/
  App.tsx             Inbox dashboard UI.
  api.ts              Browser API helpers.
  hooks/              SSE manager snapshot stream hook.
  shared/             Protocol types shared by backend and frontend.

runs/
  <runId>/            Local runtime state. Not source code.
```

## Testing

The test suite covers:

- Empty manager snapshots.
- Legacy root discovery.
- Per-run instruction isolation.
- Per-run deletion and `legacy-root` protection.
- Instruction-before-status write ordering.
- Blank instruction rejection.
- Legacy status normalization.
- Session history append and legacy migration.
- Upload validation and file size limits.
- Watched protocol file audit logging.
- SSE snapshot delivery after watched changes.
- Markdown warning and truncation behavior.
- UI run selection, send button, status help, markdown warnings, image preview, reconnecting state, and bottom-pinned chat scrolling.
- Helper script behavior for request review, consume instruction, and wait-for-instruction.

Run all tests:

```bash
npm test
```

Build and type-check:

```bash
npm run build
```
