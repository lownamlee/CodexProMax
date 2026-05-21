import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RolloutLookup } from './types'

export function getDefaultCodexSessionsRoot(): string {
  return process.env.CODEX_SESSIONS_ROOT || path.join(os.homedir(), '.codex', 'sessions')
}

export function normalizeCodexThreadId(value: string): string {
  const stripped = value.trim().replace(/^["']+|["']+$/g, '')
  const compact = stripped.replace(/-/g, '')
  if (/^[0-9a-f]{32}$/i.test(compact)) {
    return [
      compact.slice(0, 8),
      compact.slice(8, 12),
      compact.slice(12, 16),
      compact.slice(16, 20),
      compact.slice(20),
    ].join('-').toLowerCase()
  }
  return stripped
}

export function validateCodexThreadId(value: string): string {
  const threadId = normalizeCodexThreadId(value)
  if (!threadId) {
    throw new Error('Codex thread id is required.')
  }
  if (threadId.length > 240 || /[\\/]/.test(threadId) || /[\u0000-\u001f]/.test(threadId)) {
    throw new Error('Invalid Codex thread id.')
  }
  return threadId
}

export async function findRolloutByCodexThreadId(
  rawThreadId: string,
  sessionsRoot = getDefaultCodexSessionsRoot(),
): Promise<RolloutLookup | null> {
  const codexThreadId = validateCodexThreadId(rawThreadId)
  const rootPath = path.resolve(sessionsRoot)
  const matches: Array<{ filePath: string; stats: { birthtime: Date; mtime: Date; size: number } }> = []

  await walkJsonlFiles(rootPath, async (filePath) => {
    if (getRolloutThreadId(filePath) !== codexThreadId) return
    const stats = await fs.stat(filePath)
    if (stats.isFile()) {
      matches.push({ filePath, stats })
    }
  })

  if (matches.length === 0) return null

  matches.sort((left, right) => right.stats.mtime.getTime() - left.stats.mtime.getTime())
  const latest = matches[0]
  const relativePath = path.relative(rootPath, latest.filePath).split(path.sep).join('/')

  return {
    codexThreadId,
    rootPath,
    rolloutPath: latest.filePath,
    codexLiveSessionId: Buffer.from(relativePath, 'utf8').toString('base64url'),
    fileName: path.basename(latest.filePath),
    relativePath,
    createdAtIso: parseCreatedAt(latest.filePath) || latest.stats.birthtime.toISOString(),
    updatedAtIso: latest.stats.mtime.toISOString(),
    sizeBytes: latest.stats.size,
    matchCount: matches.length,
  }
}

async function walkJsonlFiles(rootPath: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw error
    }

    for (const entry of entries) {
      const filePath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(filePath)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        await onFile(filePath)
      }
    }
  }
}

function getRolloutThreadId(filePath: string): string {
  const match = path.basename(filePath).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/)
  return match?.[1] ?? ''
}

function parseCreatedAt(filePath: string): string {
  const match = path.basename(filePath).match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!match) return ''
  const [, year, month, day, hour, minute, second] = match
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}
