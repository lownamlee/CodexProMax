# Codex Pro Max

Codex Pro Max is a local human-in-the-loop inbox for Codex-style agents. It combines a compact React UI, an Express API, Server-Sent Events, and a file protocol so multiple Codex sessions can pause for review without overwriting each other.

## Features

- Multi-session inbox stored under `runs/<runId>/`.
- React + Vite dashboard with a non-overlay run list, selected run detail pane, and a bottom composer for talking to Codex.
- Express 5 backend with JSON APIs and Server-Sent Events.
- Chokidar watcher scoped to protocol files, run metadata, and attachments.
- Atomic writes for human instructions and status changes.
- Per-run `events.ndjson` logging for user messages, backend actions, uploads, and watched protocol file changes such as `output.md` and `progress.md`.
- Image attachment uploads with a 10MB per-file limit.
- Markdown safety warnings above 500KB and render truncation at 1MB.
- Status ownership help for agent-owned and UI-owned states.
- Legacy adapter that exposes existing root-level protocol files as `legacy-root`.
- Run deletion for real `runs/<runId>/` folders. `legacy-root` is protected.
- Global Codex skill support through `codex-pro-max-hitl`.

## Requirements

- Node.js 24 or newer.
- npm 11 or newer.

The app was built and tested on Windows. The default API port is `5127` because some Windows systems reserve nearby lower ports.

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
http://127.0.0.1:5127/
```

## Scripts

```bash
npm run dev
```

Starts the Express API and Vite UI together with `concurrently`.

```bash
npm test
```

Runs Vitest backend and UI tests.

```bash
npm run build
```

Runs TypeScript checks and creates a production Vite build in `dist/`.

```bash
npm run preview
```

Serves the production build with Vite preview.

## Environment Variables

```text
CODEX_PRO_MAX_ROOT
```

Optional manager root. Defaults to the current workspace directory.

```text
CODEX_PRO_MAX_API_PORT
```

Optional API port. Defaults to `5127`.

```text
CODEX_PRO_MAX_RUN_DIR
```

Optional exact run directory for one Codex session. When set, the skill writes only there.

```text
CODEX_PRO_MAX_RUN_ID
```

Optional run id used as `runs/<runId>` under the manager root.

```text
CODEX_THREAD_ID
```

Codex thread id fallback for stable per-session run folders. If it is unavailable, the skill generates `run-<timestamp>-<random>`.

## Multi-Run File Protocol

New work is isolated per Codex session:

```text
<manager-root>/
  runs/
    <runId>/
      status.txt
      progress.md
      output.md
      instruction.txt
      attachments/
      events.ndjson
      run.json
```

Root-level protocol files are legacy only. If any exist, the backend exposes them in the UI as the synthetic run id `legacy-root` so old review state is not lost.

| Path | Owner | Purpose |
| --- | --- | --- |
| `runs/<runId>/status.txt` | Agent + UI | One status token that drives that run's review state. |
| `runs/<runId>/progress.md` | Agent | Durable progress notes, next steps, and copied human instructions. |
| `runs/<runId>/output.md` | Agent | Reviewable draft or result rendered in the UI. |
| `runs/<runId>/instruction.txt` | UI then Agent | Human instruction. The agent consumes and clears it. |
| `runs/<runId>/attachments/` | UI | Uploaded review images for that run. |
| `runs/<runId>/events.ndjson` | Backend | Append-only audit log for user messages, actions, uploads, metadata changes, attachments, and watched protocol file changes. |
| `runs/<runId>/run.json` | Agent/backend | Run metadata shown in the inbox. |

Valid statuses:

| Status | Owner | Meaning |
| --- | --- | --- |
| `IDLE` | Agent | Agent can work or prepare another review packet. |
| `WAITING_FOR_REVIEW` | Agent | Agent paused and is waiting for the next human instruction/action from the UI. |
| `APPROVED` | UI | Human approved this packet. Agent consumes `instruction.txt`, clears it, then keeps waiting unless explicitly told to end. |
| `REVISION_REQUESTED` | UI | Human requested changes. Agent consumes `instruction.txt`, clears it, sets `IDLE`, then continues. |
| `INSTRUCTION_RECEIVED` | UI | Human sent a new instruction. Agent consumes `instruction.txt`, clears it, sets `IDLE`, then executes it. |
| `BLOCKED` | Agent | Agent is waiting on an external dependency or instruction. |
| `ERROR` | Agent | Agent hit a failure and is waiting for instruction. |

Protocol writes should be atomic: write a sibling temp file, then rename it over the target.

Run ids are strict safe names containing only letters, digits, `.`, `_`, and `-`. API requests reject unsafe ids and never resolve outside `<manager-root>/runs`.

## API

```http
GET /api/snapshot
```

Returns a manager snapshot with the manager root, `runs/` path, all run summaries, default selected run id, and server health.

```http
GET /api/runs/:runId/snapshot
```

Returns a per-run snapshot with status, markdown contents, file metadata, attachments, markdown safety metadata, and server health.

```http
GET /api/events
```

Opens an SSE stream. The server sends an initial manager snapshot and subsequent manager snapshots after watched run files change.

```http
POST /api/runs/:runId/action
Content-Type: application/json
```

```json
{
  "action": "revision",
  "instruction": "Please adjust the summary"
}
```

Accepted actions are `approve`, `revision`, and `instruct`.

- `approve` writes `APPROVED` and allows an optional instruction.
- `revision` writes `REVISION_REQUESTED` and requires a non-empty instruction.
- `instruct` writes `INSTRUCTION_RECEIVED` and requires a non-empty instruction.

For every action, the backend writes `instruction.txt` before `status.txt`.

The current UI intentionally exposes one primary send button. It posts `instruct` so the human can write any message, approval note, revision request, question, or next task in one place. The backend keeps `approve` and `revision` for protocol compatibility and tests.

Each action appends audit events to the selected run's `events.ndjson`. User messages include the action, target status, full instruction text, and byte count. Compatibility `action.*` entries include status, instruction byte count, and a compact instruction preview.

```http
POST /api/runs/:runId/upload
Content-Type: multipart/form-data
```

Uploads one image field named `file` into that run's `attachments/` directory. Supported MIME types are PNG, JPEG, GIF, WebP, BMP, and AVIF.

```http
DELETE /api/runs/:runId
```

Deletes a real run folder under `runs/` and returns an updated manager snapshot. `legacy-root` cannot be deleted through this endpoint.

Legacy aliases remain available for old root-level protocol files:

- `POST /api/action`
- `POST /api/upload`

Both target `legacy-root`.

## Audit Events

Every run has an append-only `events.ndjson` file. The backend writes one JSON object per line with an ISO timestamp and event type.

Logged event types include:

- `user.message`: every `/action` request, including full instruction text.
- `action.approve`, `action.revision`, `action.instruct`: compatibility action audit entries with instruction metadata.
- `upload.image`: accepted image uploads, including original name, saved name, MIME type, and size.
- `protocol.file.changed`: watched `status.txt`, `instruction.txt`, `output.md`, and `progress.md` changes, including file size and a 1KB text preview when available.
- `run.metadata.changed`: watched `run.json` changes.
- `attachment.changed`: watched attachment file additions, changes, and removals.

Changes to `events.ndjson` itself are intentionally not logged, preventing recursive audit loops.

## Codex HITL Skill

The global Codex skill lives at:

```text
C:\Users\ramly\.codex\skills\codex-pro-max-hitl
```

Use it when an agent needs to pause for review through this app:

```text
$codex-pro-max-hitl
```

The skill resolves the run directory in this order:

1. `CODEX_PRO_MAX_RUN_DIR`
2. `CODEX_PRO_MAX_ROOT\runs\CODEX_PRO_MAX_RUN_ID`
3. `CODEX_PRO_MAX_ROOT\runs\CODEX_THREAD_ID`
4. `CODEX_PRO_MAX_ROOT\runs\run-<timestamp>-<random>`

The skill instructs Codex to:

- Read existing run protocol files before writing new state.
- Write `progress.md`, `output.md`, then `status.txt = WAITING_FOR_REVIEW` inside its own run folder.
- Run one blocking wait script instead of manually polling `status.txt`.
- Consume and clear `instruction.txt` before continuing.
- Treat `APPROVED` as packet approval, not session termination; continue waiting unless the human explicitly tells Codex to end the workflow.

Bundled wait scripts:

```text
C:\Users\ramly\.codex\skills\codex-pro-max-hitl\scripts\wait_for_review.ps1
C:\Users\ramly\.codex\skills\codex-pro-max-hitl\scripts\wait_for_review.sh
```

## Project Structure

```text
server/
  app.ts             Express routes and middleware.
  protocolStore.ts   Multi-run file protocol reads, writes, safety checks, and uploads.
  snapshotHub.ts     Chokidar watcher and SSE broadcast hub.

src/
  App.tsx            Inbox dashboard UI.
  api.ts             Browser API helpers.
  hooks/             SSE manager snapshot stream hook.
  shared/            Protocol types shared by backend and frontend.
```

## Testing

The test suite covers:

- Empty manager snapshots.
- Legacy root discovery as `legacy-root`.
- Independent state for multiple runs.
- Per-run action and upload isolation.
- Per-run deletion and `legacy-root` deletion protection.
- User message and watched protocol file audit logging.
- Unsafe run id rejection.
- Instruction-before-status write ordering.
- Revision and instruction validation.
- Upload validation and file size limits.
- SSE manager snapshot delivery after watched changes.
- Markdown warning and truncation behavior.
- UI run selection, selected-run actions, status ownership, markdown warnings, and reconnecting state.

Run all tests with:

```bash
npm test
```
