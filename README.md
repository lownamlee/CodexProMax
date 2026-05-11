# Codex Pro Max

![Codex Pro Max banner](public/codex-pro-max-banner.png)

Codex Pro Max is a local human-in-the-loop inbox for Codex-style agents. It gives each Codex session its own run folder, displays the agent's latest conclusion, and lets a human send the next instruction from a focused desktop-style UI.

The app is intentionally file-first. Codex and the browser coordinate through plain protocol files under `runs/<runId>/`, while the Express API watches those files and broadcasts live UI updates.

## Installation

### Requirements

- Node.js 24 or newer.
- npm 11 or newer.
- Windows PowerShell for the bundled `.ps1` helper scripts.

The default API port is `53127`. The default Vite UI port is `5173`.

### 1. Install Dependencies

```bash
npm install
```

### 2. Install the HITL Skill

Run the installer from this repository:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-codex-pro-max.ps1
```

The installer writes:

- Global instructions at `C:\Users\ramly\.codex\AGENTS.md`.
- The skill at `C:\Users\ramly\.codex\skills\codex-pro-max-hitl`.
- Helper scripts for request, wait, and consume operations.

The generated instructions point to this clone, so the repository can live outside `Desktop`.

### 3. Start the App

```bash
npm run dev
```

This starts both services:

- API: `http://127.0.0.1:53127/`
- UI: `http://127.0.0.1:5173/`

### 4. Use the Inbox

Open the UI and select a run from the left sidebar. A Codex run appears when a session writes protocol files under `runs/<runId>/`.

Typical loop:

1. Codex finishes work and calls `request_review.ps1`.
2. The UI shows the latest conclusion.
3. The human writes the next instruction.
4. The backend writes `instruction.txt` and updates `status.txt`.
5. Codex's wait script exits.
6. Codex calls `consume_instruction.ps1` and continues.

### 5. Validate a Clone

```bash
npm test
npm run build
```

`npm test` runs backend, UI, and helper-script tests. `npm run build` type-checks the project and creates the production UI in `dist/`.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Starts the Express API and Vite UI together with `concurrently`. |
| `npm test` | Runs Vitest backend, UI, and helper-script tests. |
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

## Feature Tour

### Multi-Run Inbox

- Lists every run folder under `runs/`.
- Shows display name, run id, status icon, attachment count, and latest output preview.
- Sorts runs by latest protocol-file or attachment activity.
- Supports selecting a run without mixing instructions between sessions.
- Supports deleting real run folders while protecting `legacy-root`.
- Preserves left-sidebar collapsed state across reloads.

### Conversation View

- Renders `session.md` as a chronological chat between Codex and the human.
- Falls back to `output.md` when a run has no session history yet.
- Shows an inline Codex working indicator below the latest user message while a run is active.
- Keeps the chat pinned to the bottom only when the user was already near the bottom.
- Shows a floating scroll-to-bottom button when the user scrolls away.
- Provides copy buttons on user and Codex messages.
- Detects oversized Markdown and warns before rendering large content.

### Instruction Composer and Queue

- Sends the current message to the selected run with `Send to Codex`.
- Queues messages when Codex is working, when another queued message exists, or when a queued send is already in flight.
- Stores queued messages in `localStorage`, keyed by run id, so refreshes do not lose drafts.
- Lets queued messages be edited, deleted, and requeued.
- Automatically sends the next queued message when that run returns to review.
- Sends queued messages for non-selected runs in the background.
- Waits for the selected chat to settle at the bottom before auto-sending when the chat was pinned.
- Supports `Ctrl+Enter` sending, with an optional confirmation setting.
- Auto-grows the text area up to a fixed maximum height.

### Attachments and Mentions

- Accepts image uploads from the file picker, drag/drop, and pasted clipboard images.
- Supports PNG, JPEG, GIF, WebP, BMP, and AVIF uploads up to the backend limit.
- Stores attachments per run under `runs/<runId>/attachments/`.
- Adds uploaded or selected attachments to the draft tray.
- Inserts attachment mentions as `@file-name` tokens in the composer.
- Provides an `@` mention menu with keyboard navigation.
- Treats completed mention tokens as cursor-aware units.
- Shows mentioned attachments inline on sent user messages.
- Provides thumbnail previews, gallery navigation, per-attachment delete, and delete-all with progress.

### Protocol Sidebar

- Shows user-message outlines and tracks the active message while scrolling.
- Lets the user jump from an outline item to the corresponding message.
- Shows protocol file presence and metadata for each text protocol file.
- Opens protocol files in a document preview with wrapping, copy, and lightweight syntax highlighting.
- Shows current run attachments with preview, mention, and delete actions.
- Persists collapse state for outlines, protocol files, attachments, and sidebars.

### Session Controls

- Header controls can stop a session, clear conversation history, and toggle sidebars.
- Stop is only available while the selected run is waiting for review.
- Clear history truncates `session.md` without deleting the run, output, instruction, attachments, or metadata.
- Destructive actions use confirmation dialogs and support Escape or backdrop cancel.

### Profile and Settings

- The profile menu exposes teammates, workspace settings, skills, settings, help, and logout actions.
- The teammates dialog reads/writes `teammates.json`, starts with five default teammates, and caps the table at seven seats.
- Workspace settings and skills show under-construction popups with their configured stickers.
- Settings currently controls whether `Ctrl+Enter` asks for confirmation before sending or queueing.
- The logout menu item shows the local error popup instead of attempting external auth.

### Live Updates and Audit Trail

- The browser receives manager snapshots over Server-Sent Events from `/api/events`.
- The backend watches protocol files, run metadata, and attachments with Chokidar.
- File changes are debounced before broadcasting snapshots.
- Every run has append-only `events.ndjson` audit records for user messages, instructions, uploads, deletes, metadata changes, protocol file changes, and attachment changes.
- `events.ndjson` changes are ignored by the watcher to avoid audit loops.

## System Overview

The app has three moving parts:

| Layer | Purpose |
| --- | --- |
| React/Vite UI | Shows the run inbox, selected conversation, composer, attachments, protocol files, profile dialogs, and local UI state. |
| Express API | Reads/writes run folders, validates requests, serves attachments, manages teammate data, and exposes JSON + SSE endpoints. |
| File protocol | Uses plain files under `runs/<runId>/` so Codex and the UI can coordinate without a database. |

Normal review flow:

1. Codex completes a unit of work.
2. Codex calls `request_review.ps1 -RunDir "<run-dir>" -Output "<normal conclusion>"`.
3. The script writes `output.md`, appends the assistant message to `session.md`, removes stale progress, and sets `status.txt` to `WAITING_FOR_REVIEW`.
4. The UI displays the conclusion and waits for the human.
5. The human sends one instruction from the composer.
6. The backend writes `instruction.txt` first, then sets `status.txt` to `INSTRUCTION_RECEIVED`.
7. `wait_for_review.ps1` exits for that run.
8. Codex calls `consume_instruction.ps1`, which reads and clears `instruction.txt`, sets `status.txt` to `RUNNING`, and returns the instruction plus `sessionPath`.
9. Codex continues unless the consume payload says `shouldFinish=true`.

Queued messages use the same `/action` endpoint. The queue is a browser-side convenience layer; the backend still receives one instruction at a time.

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
| `attachments/` | UI | Uploaded review images for that run. |

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

## Backend API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/snapshot` | Manager snapshot with all runs and server health. |
| `GET /api/runs/:runId/snapshot` | Full selected-run snapshot with status, output, files, attachments, and messages. |
| `GET /api/events` | Server-Sent Events stream for live manager snapshots. |
| `GET /api/runs/:runId/files/:fileName` | Preview a selected protocol text file. |
| `POST /api/runs/:runId/action` | Writes one non-empty instruction and sets `INSTRUCTION_RECEIVED`. |
| `POST /api/runs/:runId/upload` | Uploads one raster image attachment. |
| `GET /api/runs/:runId/attachments/:fileName` | Serves an uploaded attachment. |
| `DELETE /api/runs/:runId/attachments/:fileName` | Deletes one attachment from the selected run. |
| `DELETE /api/runs/:runId/messages` | Clears `session.md` for the selected run while keeping the run open. |
| `POST /api/runs/:runId/stop` | Closes the selected run from the UI stop action. |
| `DELETE /api/runs/:runId` | Deletes a real run folder. `legacy-root` is protected. |
| `GET /api/teammates` | Reads teammate rows from `teammates.json` or returns defaults. |
| `POST /api/teammates` | Adds one teammate invite if capacity and email validation pass. |

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

## Backend Internals

### Snapshot Hub

`server/snapshotHub.ts` owns:

- Chokidar file watching.
- SSE client management and heartbeat cleanup.
- Debounced manager snapshot broadcasts.
- Audit logging for watched protocol files, metadata, and attachments.
- Assistant history fallback when a status file changes to `WAITING_FOR_REVIEW`.

### Protocol Store

`server/protocolStore.ts` owns:

- Safe run id validation and path resolution.
- Manager and run snapshot construction.
- Markdown size warnings and render truncation metadata.
- Attachment validation, safe filenames, and atomic writes.
- `session.md` parsing, writing, cache invalidation, and legacy chat-log migration.
- Conversation-history clearing by truncating only `session.md`.
- Legacy root discovery.
- Legacy status normalization.

Run ids must match the safe-name rules and cannot escape `<manager-root>/runs`.

## Codex Skill Runtime

The global skill lives at:

```text
C:\Users\ramly\.codex\skills\codex-pro-max-hitl
```

Run directory resolution priority:

1. `CODEX_PRO_MAX_RUN_DIR`
2. `CODEX_PRO_MAX_ROOT\runs\CODEX_PRO_MAX_RUN_ID`
3. `CODEX_PRO_MAX_ROOT\runs\CODEX_THREAD_ID`
4. `CODEX_PRO_MAX_ROOT\runs\run-<timestamp>-<random>`

Helper scripts:

| Script | Purpose |
| --- | --- |
| `request_review.ps1` | Writes `output.md`, appends assistant history to `session.md`, clears stale progress, and sets `WAITING_FOR_REVIEW`. |
| `wait_for_review.ps1` | Blocks until `status.txt` becomes `INSTRUCTION_RECEIVED`; use `-RunDir` to pin the exact run. |
| `consume_instruction.ps1` | Reads `instruction.txt`, appends user history to `session.md`, clears instruction, sets `RUNNING`, and returns JSON. |

The wait script is intentionally blocking. If it exits because a matching instruction arrived, call `consume_instruction.ps1` for the same run directory.

## Audit Events

Every run has an append-only `events.ndjson`.

Common event types:

- `user.message`: full submitted instruction and target status.
- `instruction.sent`: instruction preview and byte count.
- `session.stop.requested`: stop action preview and byte count.
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
  app.ts              Express routes, teammate endpoints, uploads, and middleware.
  protocolStore.ts    File protocol reads, writes, safety checks, session parsing, uploads.
  snapshotHub.ts      Chokidar watcher and SSE broadcast hub.

src/
  App.tsx             Inbox dashboard UI, queueing, dialogs, previews, and composer behavior.
  api.ts              Browser API helpers.
  hooks/              SSE manager snapshot stream hook.
  shared/             Protocol types shared by backend and frontend.

public/
  codex-pro-max-banner.png
  burger.png
  codex-color.png

runs/
  <runId>/            Local runtime state. Ignored by git.
```

## Testing

The test suite covers:

- Empty manager snapshots and legacy root discovery.
- Per-run instruction isolation, deletion, and protected `legacy-root`.
- Instruction-before-status write ordering.
- Blank and unsafe instruction/run rejection.
- Legacy status normalization.
- Session history append and legacy migration.
- Upload validation, file size limits, attachment deletion, and image previews.
- Watched protocol file audit logging.
- SSE snapshot delivery after watched changes.
- Markdown warning and truncation behavior.
- UI run selection, sending, queueing, auto-send timing, and queued message persistence.
- Sidebar collapse persistence, outlines, protocol file preview, attachment mentions, and gallery controls.
- Stop, clear-history, delete-run, and destructive confirmation flows.
- Profile menu, teammates, settings, and construction popups.
- Helper script behavior for request review, consume instruction, and wait-for-instruction.

Run all tests:

```bash
npm test
```

Build and type-check:

```bash
npm run build
```
