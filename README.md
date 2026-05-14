# Codex Pro Max

![Codex Pro Max banner](public/codex-pro-max-banner.png)

Codex Pro Max is a local human-in-the-loop inbox for Codex-style agents. It gives each Codex session its own run folder, displays the agent's latest conclusion, and lets a human send the next instruction from a focused desktop-style UI.

The app is intentionally file-first. Codex and the browser coordinate through plain protocol files under `runs/<runId>/`, while the Express API watches those files and broadcasts live UI updates.

## Setup

### Requirements

- Node.js 24 or newer.
- npm 11 or newer.
- Windows PowerShell. `setup.cmd` uses it internally, and the helper scripts are still `.ps1` files.

The default API port is `53127`. The default Vite UI port is `5173`.

### 1. Run Setup

Double-click `setup.cmd` from this repository. From a terminal, you can run:

```bat
.\setup.cmd
```

The setup command copies root `AGENTS.md`, copies the checked-in skill files under `setup/`, and writes:

- Global instructions at `C:\Users\ramly\.codex\AGENTS.md`.
- The skill at `C:\Users\ramly\.codex\skills\codex-pro-max`.
- Helper scripts for request, wait, and consume operations.
- Installation metadata at `C:\Users\ramly\.codex\skills\codex-pro-max\INSTALLATION.json`.

The generated instructions point to this clone, so the repository can live outside `Desktop`.

### 2. Start the App

Double-click `start-project.cmd`.

It checks whether dependencies are installed, runs `npm install` when packages are missing or out of sync, then starts both services with `npm run dev`:

- API: `http://127.0.0.1:53127/`
- UI: `http://127.0.0.1:5173/`

### 3. Use the Inbox

Open the UI and select a run from the left sidebar. A Codex run appears when a session writes protocol files under `runs/<runId>/`.

Typical loop:

1. Codex calls `create_session.ps1` to get `runDir`.
2. Codex finishes work and calls `request_review.ps1`.
3. The UI shows the latest conclusion.
4. The human writes the next instruction.
5. The backend writes `instruction.txt` and updates `status.txt`.
6. Codex's wait script reads the instruction, marks the run as running, and returns JSON.
7. Codex keeps waiting until the JSON contains a non-empty `instruction`, handles it, writes the answer with `request_review.ps1`, and waits again.

### 4. Validate a Clone

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

Normal users should not set session environment variables. Codex gets a run folder by calling `create_session.ps1`.

| Variable | Purpose |
| --- | --- |
| `CODEX_PRO_MAX_ROOT` | Optional manager root for the API and session creation. |
| `CODEX_PRO_MAX_API_PORT` | Optional API port. Defaults to `53127`. |
| `CODEX_PRO_MAX_POLL_SECONDS` | Optional wait script polling interval. |
| `CODEX_PRO_MAX_MAX_WAIT_SECONDS` | Optional wait script idle timeout. Defaults to `540` seconds so host shells with ten-minute ceilings do not kill the wait command. |
| `CODEX_SESSIONS_ROOT` | Optional Codex rollout-log root for session id discovery. Defaults to `CODEX_HOME\sessions` or `~\.codex\sessions`. |

`create_session.ps1` binds the run to the current Codex conversation from `CODEX_THREAD_ID`, or from the newest current Codex rollout log such as `rollout-2026-05-12T13-31-37-019e1aab-577b-7741-8889-c683dd299526.jsonl`. It names the run from an explicit `-RunId` when provided, otherwise it uses that conversation id. A custom `-RunId` changes the folder name only; `run.json.codexThreadId` still records the active conversation id when one can be resolved. Users do not need to set these values manually.

## Feature Tour

### Multi-Run Inbox

- Lists every run folder under `runs/`.
- Shows display name, run id, status icon, attachment count, and latest output preview.
- Sorts runs by latest protocol-file or attachment activity.
- Supports selecting a run without mixing instructions between sessions.
- Supports deleting run folders from the inbox.
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

- Accepts file attachments from the file picker, drag/drop, and pasted clipboard files.
- Supports images, PDFs, text/code files, archives, Office-style documents, audio, video, and generic files up to the backend limit.
- Stores attachments per run under `runs/<runId>/attachments/`.
- Adds uploaded or selected attachments to the draft tray.
- Inserts attachment mentions as `@file-name` tokens in the composer.
- Provides an `@` mention menu with keyboard navigation.
- Treats completed mention tokens as cursor-aware units.
- Shows mentioned attachments inline on sent user messages.
- Provides image thumbnails, file-type icons, attachment previews, gallery navigation, per-attachment delete, and delete-all with progress.

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

1. Codex calls `create_session.ps1` and uses the returned `runDir`.
2. Codex completes a unit of work.
3. Codex calls `request_review.ps1 -RunDir "<runDir>" -Output "<normal conclusion>"`.
4. The script writes `output.md`, appends the assistant message to `session.md`, removes stale progress, and sets `status.txt` to `WAITING_FOR_REVIEW`.
5. The UI displays the conclusion and waits for the human.
6. The human sends one instruction from the composer.
7. The backend writes `instruction.txt` first, then sets `status.txt` to `INSTRUCTION_RECEIVED`.
8. `wait_for_review.ps1` reads `instruction.txt`, keeps it available for concurrent waiters, sets `status.txt` to `RUNNING`, and returns the instruction plus `sessionPath`.
9. Codex handles only non-empty returned instructions, writes the answer with `request_review.ps1`, and then waits again.

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

Only files under `runs/<runId>/` are protocol state. Root-level protocol files are ignored.

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
- `user`: human instructions sent through the UI and read by `wait_for_review.ps1`.

## Backend API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/snapshot` | Manager snapshot with all runs and server health. |
| `GET /api/runs/:runId/snapshot` | Full selected-run snapshot with status, output, files, attachments, and messages. |
| `GET /api/events` | Server-Sent Events stream for live manager snapshots. |
| `GET /api/runs/:runId/files/:fileName` | Preview a selected protocol text file. |
| `POST /api/runs/:runId/action` | Writes one non-empty instruction and sets `INSTRUCTION_RECEIVED`. |
| `POST /api/runs/:runId/upload` | Uploads one attachment up to the configured size limit. |
| `GET /api/runs/:runId/attachments/:fileName` | Serves an uploaded attachment. |
| `DELETE /api/runs/:runId/attachments/:fileName` | Deletes one attachment from the selected run. |
| `DELETE /api/runs/:runId/messages` | Clears `session.md` for the selected run while keeping the run open. |
| `POST /api/runs/:runId/stop` | Closes the selected run from the UI stop action. |
| `DELETE /api/runs/:runId` | Deletes a run folder. |
| `GET /api/teammates` | Reads teammate rows from `teammates.json` or returns defaults. |
| `POST /api/teammates` | Adds one teammate invite if capacity and email validation pass. |

Instruction requests use this payload:

```json
{
  "instruction": "Continue with the next task."
}
```

The backend writes `instruction.txt` before `status.txt` so a waiting agent never observes `INSTRUCTION_RECEIVED` without the matching instruction.

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
- `session.md` parsing, writing, and cache invalidation.
- Conversation-history clearing by truncating only `session.md`.

Run ids must match the safe-name rules and cannot escape `<manager-root>/runs`.

## Codex Skill Runtime

The global skill lives at:

```text
C:\Users\ramly\.codex\skills\codex-pro-max
```

Codex should not construct run folders itself. It should call `create_session.ps1` once, parse the returned JSON, and reuse `runDir` for the other scripts.

Helper scripts:

| Script | Purpose |
| --- | --- |
| `create_session.ps1` | Creates or reopens a run folder, derives the default run id from Codex conversation metadata or the newest rollout log, initializes protocol files, writes `run.json`, and returns JSON with `runDir`. |
| `request_review.ps1` | Writes `output.md`, appends assistant history to `session.md`, clears stale progress and the last instruction, and sets `WAITING_FOR_REVIEW`. |
| `wait_for_review.ps1` | Blocks until `status.txt` becomes `INSTRUCTION_RECEIVED`, then reads `instruction.txt`, appends user history, keeps the instruction available for concurrent waiters, sets `RUNNING`, and returns JSON. If no instruction arrives before the idle timeout, it returns `idleTimeout=true` with `shouldFinish=false` so Codex can call it again without the host shell marking the command failed. |

The wait script is intentionally blocking. When it exits with an instruction, use the returned JSON instruction and continue. When it exits with `idleTimeout=true`, no instruction, `WAITING_FOR_REVIEW`, `STOPPED`, or `shouldFinish=true`, call it again immediately with the same `runDir`. A host shell exit code `124` while running `wait_for_review.ps1` is also a wait timeout, not a completion or failure. Do not stop after repeated idle waits, do not call task completion, and do not treat `shouldFinish=true` as permission to stop.

## Audit Events

Every run has an append-only `events.ndjson`.

Common event types:

- `user.message`: full submitted instruction and target status.
- `instruction.sent`: instruction preview and byte count.
- `session.stop.requested`: stop action preview and byte count.
- `conversation.cleared`: selected run history was cleared.
- `upload.attachment`: accepted attachment metadata.
- `attachment.deleted`: selected attachment name.
- `protocol.file.changed`: watched protocol file add/change/unlink with preview when available.
- `run.metadata.changed`: `run.json` changes.
- `attachment.changed`: attachment additions, changes, and removals.

Audit events are for traceability. `session.md` is the conversational history that agents should read.

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

- Empty manager snapshots and root-level protocol-file ignoring.
- Per-run instruction isolation and deletion.
- Instruction-before-status write ordering.
- Blank and unsafe instruction/run rejection.
- Session history append.
- Upload validation, file size limits, attachment deletion, and image previews.
- Watched protocol file audit logging.
- SSE snapshot delivery after watched changes.
- Markdown warning and truncation behavior.
- UI run selection, sending, queueing, auto-send timing, and queued message persistence.
- Sidebar collapse persistence, outlines, protocol file preview, attachment mentions, and gallery controls.
- Stop, clear-history, delete-run, and destructive confirmation flows.
- Profile menu, teammates, settings, and construction popups.
- Helper script behavior for session creation, request review, and wait-for-instruction.

Run all tests:

```bash
npm test
```

Build and type-check:

```bash
npm run build
```

## Educational Purpose, License, and Responsible Use

This project is provided for educational and research purposes. Use it only in lawful, authorized, and responsible environments.

Codex Pro Max is licensed under the MIT License. See [`LICENSE`](LICENSE) for the full license text.

Do not use this project to abuse services, bypass access controls, violate platform terms, compromise systems, exfiltrate data, harass people, or automate activity you are not authorized to perform. Users are solely responsible for how they configure, deploy, modify, and operate this software.

The author and contributors are not responsible for misuse, abuse, damage, data loss, service violations, illegal activity, or other consequences caused by anyone using this project.
