import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const WAIT_SCRIPT = 'C:\\Users\\ramly\\.codex\\skills\\codex-pro-max-hitl\\scripts\\wait_for_review.ps1'

interface StartedWaitScript {
  child: ReturnType<typeof spawn>
  output: {
    stdout: string
    stderr: string
  }
}

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Codex Pro Max wait script', () => {
  it('resolves CODEX_THREAD_ID into a stable run folder', async () => {
    const root = await createTempRoot()
    const threadId = 'thread-abc-123'
    const runDir = path.join(root, 'runs', threadId)
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'APPROVED')

    const started = startWaitScript({
      CODEX_PRO_MAX_ROOT: root,
      CODEX_THREAD_ID: threadId,
      CODEX_PRO_MAX_POLL_SECONDS: '1',
    })

    const result = await waitForExit(started, 4_000)

    expect(result.code).toBe(0)
    expect(started.output.stdout).toContain(path.join(root, 'runs', threadId, 'status.txt'))
    expect(started.output.stdout).toContain('STATUS_CHANGED: APPROVED')
  })

  it('exits only when the selected run status changes', async () => {
    const root = await createTempRoot()
    const targetRunDir = path.join(root, 'runs', 'target-run')
    const otherRunDir = path.join(root, 'runs', 'other-run')
    await mkdir(targetRunDir, { recursive: true })
    await mkdir(otherRunDir, { recursive: true })
    await writeFile(path.join(targetRunDir, 'status.txt'), 'WAITING_FOR_REVIEW')
    await writeFile(path.join(otherRunDir, 'status.txt'), 'APPROVED')

    const started = startWaitScript({
      CODEX_PRO_MAX_ROOT: root,
      CODEX_PRO_MAX_RUN_ID: 'target-run',
      CODEX_PRO_MAX_POLL_SECONDS: '1',
    })

    let exited = false
    const exitPromise = waitForExit(started, 6_000).then((result) => {
      exited = true
      return result
    })

    await delay(1_200)
    expect(exited).toBe(false)

    await writeFile(path.join(targetRunDir, 'status.txt'), 'APPROVED')
    const result = await exitPromise

    expect(result.code).toBe(0)
    expect(started.output.stdout).toContain(path.join(root, 'runs', 'target-run', 'status.txt'))
    expect(started.output.stdout).toContain('STATUS_CHANGED: APPROVED')
  })
})

async function createTempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-pro-max-skill-'))
  tempRoots.push(root)
  return root
}

function startWaitScript(env: Record<string, string>): StartedWaitScript {
  const output = { stdout: '', stderr: '' }
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WAIT_SCRIPT],
    {
      env: { ...process.env, ...env },
      windowsHide: true,
    },
  )

  child.stdout?.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString('utf8')
  })

  return { child, output }
}

function waitForExit(started: StartedWaitScript, timeoutMs: number) {
  return new Promise<{ code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => {
      started.child.kill()
      reject(
        new Error(
          `wait script did not exit within ${timeoutMs}ms\nstdout:\n${started.output.stdout}\nstderr:\n${started.output.stderr}`,
        ),
      )
    }, timeoutMs)

    started.child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code })
    })

    started.child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
