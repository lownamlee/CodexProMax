import type { Response } from 'express'
import chokidar, { type FSWatcher } from 'chokidar'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ManagerSnapshot, Snapshot } from '../src/shared/protocol'
import {
  LEGACY_RUN_ID,
  PROTOCOL_TEXT_FILES,
  RUNS_DIR_NAME,
} from '../src/shared/protocol'
import {
  ATTACHMENTS_DIR_NAME,
  RUN_METADATA_FILE,
  appendAuditEvent,
  getManagerSnapshot,
  getRunPath,
  getRunSnapshot,
  isSafeRunId,
} from './protocolStore'

interface Client {
  response: Response
  heartbeat: NodeJS.Timeout
}

interface WatchLogTarget {
  runId: string
  runPath: string
  eventType: 'protocol.file.changed' | 'attachment.changed' | 'run.metadata.changed'
  fileName: string
  protocolFile?: string
}

const LOGGED_WATCH_EVENTS = new Set(['add', 'change', 'unlink'])
const TEXT_PREVIEW_BYTES = 1_024

export class MultiRunSnapshotHub {
  private clients = new Set<Client>()
  private watcher: FSWatcher | null = null
  private broadcastTimer: NodeJS.Timeout | null = null
  private ready = false

  constructor(private readonly rootPath: string) {}

  get watcherReady(): boolean {
    return this.ready
  }

  start(): void {
    if (this.watcher) {
      return
    }

    this.watcher = chokidar.watch(this.rootPath, {
      depth: 4,
      ignoreInitial: false,
      persistent: true,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 25,
      },
      ignored: (watchedPath) => this.shouldIgnore(watchedPath),
    })

    this.watcher
      .on('all', (eventName, watchedPath) => {
        void this.logWatchEvent(eventName, watchedPath)
        this.scheduleBroadcast()
      })
      .on('ready', () => {
        this.ready = true
        void this.broadcastSnapshot()
      })
      .on('error', (error) => {
        console.error('Codex Pro Max watcher error:', error)
      })
  }

  connect(response: Response): void {
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    })

    const client: Client = {
      response,
      heartbeat: setInterval(() => {
        response.write(': heartbeat\n\n')
      }, 25_000),
    }

    this.clients.add(client)
    void this.sendSnapshot(client)

    response.on('close', () => {
      clearInterval(client.heartbeat)
      this.clients.delete(client)
    })
  }

  async readSnapshot(): Promise<ManagerSnapshot> {
    return getManagerSnapshot(this.rootPath, this.ready)
  }

  async readRunSnapshot(runId: string): Promise<Snapshot> {
    return getRunSnapshot(this.rootPath, runId, this.ready)
  }

  async broadcastSnapshot(): Promise<ManagerSnapshot> {
    const snapshot = await this.readSnapshot()
    for (const client of this.clients) {
      this.writeSnapshot(client, snapshot)
    }
    return snapshot
  }

  async close(): Promise<void> {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
      this.broadcastTimer = null
    }

    for (const client of this.clients) {
      clearInterval(client.heartbeat)
      client.response.end()
    }
    this.clients.clear()

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
  }

  private scheduleBroadcast(): void {
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer)
    }

    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      void this.broadcastSnapshot()
    }, 50)
  }

  private async sendSnapshot(client: Client): Promise<void> {
    const snapshot = await this.readSnapshot()
    this.writeSnapshot(client, snapshot)
  }

  private writeSnapshot(client: Client, snapshot: ManagerSnapshot): void {
    client.response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)
  }

  private async logWatchEvent(eventName: string, watchedPath: string): Promise<void> {
    if (!LOGGED_WATCH_EVENTS.has(eventName)) {
      return
    }

    const target = this.describeWatchTarget(watchedPath)
    if (!target) {
      return
    }

    try {
      const payload = await this.createWatchPayload(eventName, watchedPath, target)
      await appendAuditEvent(target.runPath, target.eventType, payload)
    } catch (error) {
      console.error('Codex Pro Max audit log error:', error)
    }
  }

  private describeWatchTarget(watchedPath: string): WatchLogTarget | null {
    const relativePath = path.relative(this.rootPath, watchedPath)
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return null
    }

    const parts = relativePath.split(path.sep)
    const [firstSegment] = parts

    if (firstSegment === RUNS_DIR_NAME) {
      return this.describeRunWatchTarget(parts)
    }

    if (PROTOCOL_TEXT_FILES.includes(firstSegment as (typeof PROTOCOL_TEXT_FILES)[number])) {
      if (firstSegment === 'events.ndjson') {
        return null
      }

      return {
        runId: LEGACY_RUN_ID,
        runPath: this.rootPath,
        eventType: 'protocol.file.changed',
        fileName: firstSegment,
        protocolFile: firstSegment,
      }
    }

    if (firstSegment === ATTACHMENTS_DIR_NAME && parts.length === 2) {
      return {
        runId: LEGACY_RUN_ID,
        runPath: this.rootPath,
        eventType: 'attachment.changed',
        fileName: parts[1],
      }
    }

    return null
  }

  private describeRunWatchTarget(parts: string[]): WatchLogTarget | null {
    const [, runId, protocolEntry, fileName] = parts
    if (!runId || !isSafeRunId(runId) || !protocolEntry) {
      return null
    }

    const runPath = getRunPath(this.rootPath, runId)

    if (PROTOCOL_TEXT_FILES.includes(protocolEntry as (typeof PROTOCOL_TEXT_FILES)[number])) {
      if (protocolEntry === 'events.ndjson') {
        return null
      }

      return {
        runId,
        runPath,
        eventType: 'protocol.file.changed',
        fileName: protocolEntry,
        protocolFile: protocolEntry,
      }
    }

    if (protocolEntry === RUN_METADATA_FILE) {
      return {
        runId,
        runPath,
        eventType: 'run.metadata.changed',
        fileName: RUN_METADATA_FILE,
      }
    }

    if (protocolEntry === ATTACHMENTS_DIR_NAME && fileName) {
      return {
        runId,
        runPath,
        eventType: 'attachment.changed',
        fileName,
      }
    }

    return null
  }

  private async createWatchPayload(
    eventName: string,
    watchedPath: string,
    target: WatchLogTarget,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      event: eventName,
      runId: target.runId,
      fileName: target.fileName,
      relativePath: path.relative(target.runPath, watchedPath),
    }

    try {
      const stats = await fs.stat(watchedPath)
      payload.size = stats.size
      payload.mtimeIso = stats.mtime.toISOString()
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error
      }
      payload.deleted = true
    }

    if (target.protocolFile && eventName !== 'unlink') {
      const preview = await readTextPreview(watchedPath)
      payload.preview = preview.preview
      payload.previewTruncated = preview.truncated
    }

    return payload
  }

  private shouldIgnore(watchedPath: string): boolean {
    const relativePath = path.relative(this.rootPath, watchedPath)
    if (!relativePath) {
      return false
    }

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      return true
    }

    const parts = relativePath.split(path.sep)
    const [firstSegment] = parts

    if (firstSegment === RUNS_DIR_NAME) {
      return this.shouldIgnoreRunPath(parts)
    }

    if (firstSegment === ATTACHMENTS_DIR_NAME) {
      return parts.length > 2
    }

    return !PROTOCOL_TEXT_FILES.includes(firstSegment as (typeof PROTOCOL_TEXT_FILES)[number])
  }

  private shouldIgnoreRunPath(parts: string[]): boolean {
    if (parts.length <= 2) {
      return false
    }

    const protocolEntry = parts[2]

    if (parts.length === 3) {
      return !(
        protocolEntry === RUN_METADATA_FILE ||
        protocolEntry === ATTACHMENTS_DIR_NAME ||
        PROTOCOL_TEXT_FILES.includes(protocolEntry as (typeof PROTOCOL_TEXT_FILES)[number])
      )
    }

    if (parts.length === 4 && protocolEntry === ATTACHMENTS_DIR_NAME) {
      return false
    }

    return true
  }
}

export const LEGACY_ATTACHMENT_RUN_ID = LEGACY_RUN_ID

async function readTextPreview(filePath: string): Promise<{ preview: string; truncated: boolean }> {
  const file = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(TEXT_PREVIEW_BYTES)
    const { bytesRead } = await file.read(buffer, 0, TEXT_PREVIEW_BYTES, 0)
    const contents = buffer.subarray(0, bytesRead).toString('utf8')
    return {
      preview: contents.replace(/\s+/g, ' ').trim(),
      truncated: bytesRead === TEXT_PREVIEW_BYTES,
    }
  } finally {
    await file.close()
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
