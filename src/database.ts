import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  AttachmentRecord,
  ConclusionRecord,
  InstructionRecord,
  MessageRecord,
  MessageRole,
  RolloutLookup,
  SessionDetail,
  SessionRecord,
  SessionSummary,
  SessionStatus,
} from './types'

export interface CodexProMaxStoreOptions {
  dataRoot: string
  dbPath?: string
}

export interface UpsertSessionInput {
  codexThreadId: string
  rollout: RolloutLookup | null
  displayName?: string
}

export interface CreateAttachmentInput {
  sessionId: string
  originalName: string
  storedName: string
  mimeType: string
  sizeBytes: number
  storagePath: string
}

type SessionRow = {
  id: string
  codex_thread_id: string
  rollout_path: string | null
  codex_live_session_id: string | null
  display_name: string | null
  status: SessionStatus
  created_at: string
  updated_at: string
  last_seen_at: string
}

type MessageRow = {
  id: string
  session_id: string
  role: MessageRole
  content: string
  created_at: string
}

type ConclusionRow = {
  id: string
  session_id: string
  content: string
  created_at: string
}

type InstructionRow = {
  id: string
  session_id: string
  content: string
  consumed_at: string | null
  created_at: string
}

type AttachmentRow = {
  id: string
  session_id: string
  original_name: string
  stored_name: string
  mime_type: string
  size_bytes: number
  storage_path: string
  created_at: string
}

export class CodexProMaxStore {
  readonly dataRoot: string
  readonly dbPath: string
  private readonly db: DatabaseSync

  constructor(options: CodexProMaxStoreOptions) {
    this.dataRoot = path.resolve(options.dataRoot)
    this.dbPath = path.resolve(options.dbPath ?? path.join(this.dataRoot, 'codex-pro-max.sqlite3'))
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true })
    fs.mkdirSync(this.getAttachmentsRoot(), { recursive: true })
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.migrate()
    this.normalizeAttachmentDisplayNames()
  }

  close(): void {
    this.db.close()
  }

  upsertSession(input: UpsertSessionInput): SessionRecord {
    const now = nowIso()
    const existing = this.getSessionByThreadId(input.codexThreadId)
    const displayName = input.displayName?.trim() || existing?.displayName || input.codexThreadId
    const rolloutPath = input.rollout?.rolloutPath ?? existing?.rolloutPath ?? null
    const codexLiveSessionId = input.rollout?.codexLiveSessionId ?? existing?.codexLiveSessionId ?? null

    if (existing) {
      this.db.prepare(`
        UPDATE sessions
        SET rollout_path = ?, codex_live_session_id = ?, display_name = ?, status = 'RUNNING',
            updated_at = ?, last_seen_at = ?
        WHERE id = ?
      `).run(rolloutPath, codexLiveSessionId, displayName, now, now, existing.id)
      this.appendEvent(existing.id, 'session.resumed', {
        codexThreadId: input.codexThreadId,
        rolloutPath,
        codexLiveSessionId,
      })
      return this.getSessionById(existing.id)!
    }

    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO sessions (
        id, codex_thread_id, rollout_path, codex_live_session_id, display_name,
        status, created_at, updated_at, last_seen_at
      )
      VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)
    `).run(id, input.codexThreadId, rolloutPath, codexLiveSessionId, displayName, now, now, now)
    this.appendEvent(id, 'session.created', {
      codexThreadId: input.codexThreadId,
      rolloutPath,
      codexLiveSessionId,
    })
    return this.getSessionById(id)!
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      ORDER BY updated_at DESC, created_at DESC
    `).all() as SessionRow[]
    return rows.map(mapSession)
  }

  listSessionSummaries(): SessionSummary[] {
    const sessions = this.listSessions()
    return sessions.map((session) => {
      const latestConclusion = this.db.prepare(`
        SELECT content FROM conclusions
        WHERE session_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(session.id) as { content: string } | undefined
      const counts = this.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM attachments WHERE session_id = ?) AS attachment_count,
          (SELECT COUNT(*) FROM instructions WHERE session_id = ? AND consumed_at IS NULL) AS queued_instruction_count,
          (SELECT COUNT(*) FROM instructions WHERE session_id = ? AND consumed_at IS NOT NULL) AS consumed_instruction_count,
          (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS message_count
      `).get(session.id, session.id, session.id, session.id) as {
        attachment_count: number
        queued_instruction_count: number
        consumed_instruction_count: number
        message_count: number
      }

      return {
        ...session,
        latestConclusion: latestConclusion?.content ?? '',
        attachmentCount: counts.attachment_count,
        queuedInstructionCount: counts.queued_instruction_count,
        consumedInstructionCount: counts.consumed_instruction_count,
        messageCount: counts.message_count,
        hasQueuedInstruction: counts.queued_instruction_count > 0,
      }
    })
  }

  getSessionById(id: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? mapSession(row) : null
  }

  getSessionByThreadId(codexThreadId: string): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE codex_thread_id = ?').get(codexThreadId) as SessionRow | undefined
    return row ? mapSession(row) : null
  }

  getSessionDetailById(id: string): SessionDetail | null {
    const session = this.getSessionById(id)
    if (!session) return null
    return {
      ...session,
      messages: this.listMessages(id),
      conclusions: this.listConclusions(id),
      instructions: this.listInstructions(id),
      attachments: this.listAttachments(id),
    }
  }

  getSessionDetailByThreadId(codexThreadId: string): SessionDetail | null {
    const session = this.getSessionByThreadId(codexThreadId)
    return session ? this.getSessionDetailById(session.id) : null
  }

  deleteSession(sessionId: string): boolean {
    const existing = this.getSessionById(sessionId)
    if (!existing) return false
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
    return true
  }

  clearConversation(sessionId: string): SessionRecord {
    const now = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM conclusions WHERE session_id = ?').run(sessionId)
      this.db.prepare('UPDATE sessions SET updated_at = ?, last_seen_at = ? WHERE id = ?')
        .run(now, now, sessionId)
      this.insertEvent(sessionId, 'conversation.cleared', {}, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    const session = this.getSessionById(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }

  markSessionStatus(sessionId: string, status: SessionStatus): SessionRecord {
    const now = nowIso()
    this.db.prepare('UPDATE sessions SET status = ?, updated_at = ?, last_seen_at = ? WHERE id = ?')
      .run(status, now, now, sessionId)
    const session = this.getSessionById(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return session
  }

  recordConclusion(sessionId: string, content: string): ConclusionRecord {
    const now = nowIso()
    const conclusionId = randomUUID()
    const messageId = randomUUID()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO conclusions (id, session_id, content, created_at) VALUES (?, ?, ?, ?)')
        .run(conclusionId, sessionId, content, now)
      this.db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(messageId, sessionId, 'codex', content, now)
      this.db.prepare(`
        UPDATE sessions
        SET status = 'WAITING_FOR_INSTRUCTION', updated_at = ?, last_seen_at = ?
        WHERE id = ?
      `).run(now, now, sessionId)
      this.insertEvent(sessionId, 'conclusion.submitted', { conclusionId }, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return this.getConclusionById(conclusionId)!
  }

  enqueueInstruction(sessionId: string, content: string): InstructionRecord {
    const now = nowIso()
    const id = randomUUID()
    this.db.prepare('INSERT INTO instructions (id, session_id, content, consumed_at, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run(id, sessionId, content, now)
    this.touchSession(sessionId, now)
    this.appendEvent(sessionId, 'instruction.queued', { instructionId: id })
    return this.getInstructionById(id)!
  }

  updateQueuedInstruction(sessionId: string, instructionId: string, content: string): InstructionRecord | null {
    const existing = this.getInstructionById(instructionId)
    if (!existing || existing.sessionId !== sessionId || existing.consumedAt) return null

    const now = nowIso()
    this.db.prepare('UPDATE instructions SET content = ? WHERE id = ? AND session_id = ? AND consumed_at IS NULL')
      .run(content, instructionId, sessionId)
    this.touchSession(sessionId, now)
    this.appendEvent(sessionId, 'instruction.updated', { instructionId })
    return this.getInstructionById(instructionId)
  }

  deleteQueuedInstruction(sessionId: string, instructionId: string): InstructionRecord | null {
    const existing = this.getInstructionById(instructionId)
    if (!existing || existing.sessionId !== sessionId || existing.consumedAt) return null

    const now = nowIso()
    this.db.prepare('DELETE FROM instructions WHERE id = ? AND session_id = ? AND consumed_at IS NULL')
      .run(instructionId, sessionId)
    this.touchSession(sessionId, now)
    this.appendEvent(sessionId, 'instruction.deleted', { instructionId })
    return existing
  }

  countQueuedInstructions(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM instructions WHERE session_id = ? AND consumed_at IS NULL')
      .get(sessionId) as { count: number } | undefined
    return row?.count ?? 0
  }

  getLatestUserMessageCreatedAt(sessionId: string): string | null {
    const row = this.db.prepare(`
      SELECT created_at
      FROM messages
      WHERE session_id = ? AND role = 'user'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(sessionId) as { created_at: string } | undefined
    return row?.created_at ?? null
  }

  consumeNextInstruction(sessionId: string): InstructionRecord | null {
    const now = nowIso()
    let consumedId = ''

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare(`
        SELECT * FROM instructions
        WHERE session_id = ? AND consumed_at IS NULL
        ORDER BY created_at ASC, id ASC
        LIMIT 1
      `).get(sessionId) as InstructionRow | undefined

      if (!row) {
        this.db.exec('COMMIT')
        return null
      }

      consumedId = row.id
      this.db.prepare('UPDATE instructions SET consumed_at = ? WHERE id = ?').run(now, row.id)
      this.db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), sessionId, 'user', row.content, now)
      this.db.prepare(`
        UPDATE sessions
        SET status = 'RUNNING', updated_at = ?, last_seen_at = ?
        WHERE id = ?
      `).run(now, now, sessionId)
      this.insertEvent(sessionId, 'instruction.consumed', { instructionId: row.id }, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return this.getInstructionById(consumedId)
  }

  consumeInstructionById(sessionId: string, instructionId: string): InstructionRecord | null {
    const existing = this.getInstructionById(instructionId)
    if (!existing || existing.sessionId !== sessionId || existing.consumedAt) return null

    const now = nowIso()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE instructions SET consumed_at = ? WHERE id = ? AND session_id = ? AND consumed_at IS NULL')
        .run(now, instructionId, sessionId)
      this.db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), sessionId, 'user', existing.content, now)
      this.db.prepare(`
        UPDATE sessions
        SET status = 'RUNNING', updated_at = ?, last_seen_at = ?
        WHERE id = ?
      `).run(now, now, sessionId)
      this.insertEvent(sessionId, 'instruction.consumed', { instructionId }, now)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return this.getInstructionById(instructionId)
  }

  createAttachment(input: CreateAttachmentInput): AttachmentRecord {
    const now = nowIso()
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO attachments (
        id, session_id, original_name, stored_name, mime_type, size_bytes, storage_path, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId,
      input.originalName,
      input.storedName,
      input.mimeType,
      input.sizeBytes,
      input.storagePath,
      now,
    )
    this.touchSession(input.sessionId, now)
    this.appendEvent(input.sessionId, 'attachment.uploaded', {
      attachmentId: id,
      originalName: input.originalName,
      storedName: input.storedName,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    })
    return this.getAttachmentById(id)!
  }

  deleteAttachment(sessionId: string, attachmentId: string): AttachmentRecord | null {
    const attachment = this.getAttachmentById(attachmentId)
    if (!attachment || attachment.sessionId !== sessionId) return null

    const now = nowIso()
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(attachmentId)
    this.touchSession(sessionId, now)
    this.appendEvent(sessionId, 'attachment.deleted', {
      attachmentId,
      storedName: attachment.storedName,
      originalName: attachment.originalName,
    })
    return attachment
  }

  getAttachmentById(id: string): AttachmentRecord | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined
    return row ? mapAttachment(row) : null
  }

  getAttachmentsRoot(): string {
    return path.join(this.dataRoot, 'attachments')
  }

  getSessionAttachmentsRoot(sessionId: string): string {
    return path.join(this.getAttachmentsRoot(), sessionId)
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL UNIQUE,
        rollout_path TEXT,
        codex_live_session_id TEXT,
        display_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('RUNNING', 'WAITING_FOR_INSTRUCTION', 'STOPPED', 'ERROR')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'codex', 'system')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conclusions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS instructions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_codex_thread_id ON sessions(codex_thread_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_conclusions_session_created ON conclusions(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_instructions_session_pending ON instructions(session_id, consumed_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_session_created ON attachments(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_session_created ON session_events(session_id, created_at);
    `)
  }

  private listMessages(sessionId: string): MessageRecord[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC')
      .all(sessionId) as MessageRow[]
    return rows.map(mapMessage)
  }

  private listConclusions(sessionId: string): ConclusionRecord[] {
    const rows = this.db.prepare('SELECT * FROM conclusions WHERE session_id = ? ORDER BY created_at ASC, id ASC')
      .all(sessionId) as ConclusionRow[]
    return rows.map(mapConclusion)
  }

  private listInstructions(sessionId: string): InstructionRecord[] {
    const rows = this.db.prepare('SELECT * FROM instructions WHERE session_id = ? ORDER BY created_at ASC, id ASC')
      .all(sessionId) as InstructionRow[]
    return rows.map(mapInstruction)
  }

  private listAttachments(sessionId: string): AttachmentRecord[] {
    const rows = this.db.prepare('SELECT * FROM attachments WHERE session_id = ? ORDER BY created_at ASC, id ASC')
      .all(sessionId) as AttachmentRow[]
    return rows.map(mapAttachment)
  }

  private getConclusionById(id: string): ConclusionRecord | null {
    const row = this.db.prepare('SELECT * FROM conclusions WHERE id = ?').get(id) as ConclusionRow | undefined
    return row ? mapConclusion(row) : null
  }

  getInstructionById(id: string): InstructionRecord | null {
    const row = this.db.prepare('SELECT * FROM instructions WHERE id = ?').get(id) as InstructionRow | undefined
    return row ? mapInstruction(row) : null
  }

  private touchSession(sessionId: string, now = nowIso()): void {
    this.db.prepare('UPDATE sessions SET updated_at = ?, last_seen_at = ? WHERE id = ?').run(now, now, sessionId)
  }

  private appendEvent(sessionId: string | null, type: string, payload: Record<string, unknown>): void {
    this.insertEvent(sessionId, type, payload, nowIso())
  }

  private insertEvent(sessionId: string | null, type: string, payload: Record<string, unknown>, createdAt: string): void {
    this.db.prepare('INSERT INTO session_events (id, session_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), sessionId, type, JSON.stringify(payload), createdAt)
  }

  private normalizeAttachmentDisplayNames(): void {
    const rows = this.db.prepare('SELECT id, original_name, created_at FROM attachments')
      .all() as Pick<AttachmentRow, 'id' | 'original_name' | 'created_at'>[]
    for (const row of rows) {
      if (hasAttachmentTimestamp(row.original_name)) continue
      const createdAt = new Date(row.created_at)
      const displayName = createAttachmentDisplayName(
        row.original_name,
        Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
      )
      this.db.prepare('UPDATE attachments SET original_name = ? WHERE id = ?').run(displayName, row.id)
    }
  }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    codexThreadId: row.codex_thread_id,
    rolloutPath: row.rollout_path,
    codexLiveSessionId: row.codex_live_session_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  }
}

function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }
}

function mapConclusion(row: ConclusionRow): ConclusionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    createdAt: row.created_at,
  }
}

function mapInstruction(row: InstructionRow): InstructionRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: row.content,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  }
}

function mapAttachment(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    originalName: row.original_name,
    storedName: row.stored_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function createAttachmentDisplayName(fileName: string, now: Date): string {
  const extension = safeAttachmentExtension(fileName)
  const rawStem = path.basename(fileName || 'attachment', path.extname(fileName || ''))
  const stem = sanitizeAttachmentStem(rawStem) || 'attachment'
  return `${stem}-${formatAttachmentTimestamp(now)}${extension}`
}

function hasAttachmentTimestamp(fileName: string): boolean {
  return /-\d{8}-\d{6}-\d{3}(?:\.[a-z0-9]{1,12})?$/i.test(fileName)
}

function safeAttachmentExtension(fileName: string): string {
  const extension = path.extname(fileName || '').toLowerCase()
  return /^[.][a-z0-9]{1,12}$/.test(extension) ? extension : ''
}

function sanitizeAttachmentStem(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

function formatAttachmentTimestamp(value: Date): string {
  return value.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, `-${String(value.getMilliseconds()).padStart(3, '0')}`)
}
