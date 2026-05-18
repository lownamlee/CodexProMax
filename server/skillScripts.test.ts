import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SKILL_SCRIPT_DIR = path.resolve('setup', 'skills', 'codex-pro-max', 'scripts')
const CREATE_SCRIPT = path.join(SKILL_SCRIPT_DIR, 'create_session.ps1')
const WAIT_SCRIPT = path.join(SKILL_SCRIPT_DIR, 'wait_for_review.ps1')
const REQUEST_SCRIPT = path.join(SKILL_SCRIPT_DIR, 'request_review.ps1')
const SETUP_SCRIPT = path.resolve('setup.cmd')
const UNINSTALL_SCRIPT = path.resolve('uninstall.cmd')

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

describe('Codex Pro Max skill scripts', () => {
  it('creates a session folder automatically', async () => {
    const root = await createTempRoot()
    const threadId = 'thread-abc-123'
    const runDir = path.join(root, 'runs', threadId)

    const result = await runPowerShellScript(CREATE_SCRIPT, ['-Root', root], {
      CODEX_THREAD_ID: threadId,
    })
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      runId: string
      runDir: string
      status: string
      sessionPath: string
    }
    const metadata = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as {
      runId: string
      displayName: string
      workspacePath: string
      codexThreadId: string
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      ok: true,
      runId: threadId,
      runDir,
      status: 'RUNNING',
      sessionPath: path.join(runDir, 'session.md'),
    })
    expect(metadata).toMatchObject({
      runId: threadId,
      displayName: threadId,
      workspacePath: root,
      codexThreadId: threadId,
    })
    await expect(readFile(path.join(runDir, 'status.txt'), 'utf8')).resolves.toBe('RUNNING')
    await expect(readFile(path.join(runDir, 'instruction.txt'), 'utf8')).resolves.toBe('')
    await expect(readFile(path.join(runDir, 'output.md'), 'utf8')).resolves.toBe('')
    await expect(readFile(path.join(runDir, 'session.md'), 'utf8')).resolves.toBe('')
  })

  it('uses the latest Codex rollout id when no explicit run id exists', async () => {
    const root = await createTempRoot()
    const sessionsRoot = await createTempRoot()
    const staleRunId = '019e19b7-fef1-7471-b25b-d9afc25c4311'
    const currentRunId = '019e1aab-577b-7741-8889-c683dd299526'
    await writeRolloutLog(
      sessionsRoot,
      `2026/05/12/rollout-2026-05-12T09-05-49-${staleRunId}.jsonl`,
      new Date('2026-05-12T09:05:49.000Z'),
    )
    await writeRolloutLog(
      sessionsRoot,
      `2026/05/12/rollout-2026-05-12T13-31-37-${currentRunId}.jsonl`,
      new Date('2026-05-12T13:31:37.000Z'),
    )

    const runDir = path.join(root, 'runs', currentRunId)
    const result = await runPowerShellScript(CREATE_SCRIPT, ['-Root', root], {
      CODEX_THREAD_ID: '',
      CODEX_SESSIONS_ROOT: sessionsRoot,
    })
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      runId: string
      runDir: string
      status: string
      sessionPath: string
    }
    const metadata = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as {
      runId: string
      displayName: string
      workspacePath: string
      codexThreadId: string
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      ok: true,
      runId: currentRunId,
      runDir,
      status: 'RUNNING',
      sessionPath: path.join(runDir, 'session.md'),
    })
    expect(metadata).toMatchObject({
      runId: currentRunId,
      displayName: currentRunId,
      workspacePath: root,
      codexThreadId: currentRunId,
    })
  })

  it('binds a custom run id to the current Codex conversation', async () => {
    const root = await createTempRoot()
    const sessionsRoot = await createTempRoot()
    const customRunId = 'folder-organize-20260513-154441'
    const currentRunId = '019e203d-0894-7112-9f0c-7a0d45c74d70'
    await writeRolloutLog(
      sessionsRoot,
      `2026/05/13/rollout-2026-05-13T07-39-51-${currentRunId}.jsonl`,
      new Date('2026-05-13T07:39:51.000Z'),
    )

    const runDir = path.join(root, 'runs', customRunId)
    const result = await runPowerShellScript(CREATE_SCRIPT, ['-Root', root, '-RunId', customRunId], {
      CODEX_THREAD_ID: '',
      CODEX_SESSIONS_ROOT: sessionsRoot,
    })
    const payload = JSON.parse(result.stdout) as {
      ok: boolean
      runId: string
      runDir: string
      status: string
      sessionPath: string
    }
    const metadata = JSON.parse(await readFile(path.join(runDir, 'run.json'), 'utf8')) as {
      runId: string
      displayName: string
      workspacePath: string
      codexThreadId: string
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      ok: true,
      runId: customRunId,
      runDir,
      status: 'RUNNING',
      sessionPath: path.join(runDir, 'session.md'),
    })
    expect(metadata).toMatchObject({
      runId: customRunId,
      displayName: customRunId,
      workspacePath: root,
      codexThreadId: currentRunId,
    })
  })

  it('exits only when the selected run status changes', async () => {
    const root = await createTempRoot()
    const targetRunDir = path.join(root, 'runs', 'target-run')
    const otherRunDir = path.join(root, 'runs', 'other-run')
    await mkdir(targetRunDir, { recursive: true })
    await mkdir(otherRunDir, { recursive: true })
    await writeFile(path.join(targetRunDir, 'status.txt'), 'WAITING_FOR_REVIEW')
    await writeFile(path.join(otherRunDir, 'status.txt'), 'INSTRUCTION_RECEIVED')

    const started = startWaitScript(
      {
        CODEX_PRO_MAX_POLL_SECONDS: '1',
      },
      ['-RunDir', targetRunDir],
    )

    let exited = false
    const exitPromise = waitForExit(started, 6_000).then((result) => {
      exited = true
      return result
    })

    await delay(1_200)
    expect(exited).toBe(false)

    await writeFile(path.join(targetRunDir, 'instruction.txt'), 'Continue target run.')
    await writeFile(path.join(targetRunDir, 'status.txt'), 'INSTRUCTION_RECEIVED')
    const result = await exitPromise
    const payload = JSON.parse(started.output.stdout) as {
      instruction: string
      status: string
      shouldFinish: boolean
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      instruction: 'Continue target run.',
      status: 'RUNNING',
      shouldFinish: false,
    })
    await expect(readFile(path.join(targetRunDir, 'status.txt'), 'utf8')).resolves.toBe('RUNNING')
    await expect(readFile(path.join(targetRunDir, 'instruction.txt'), 'utf8')).resolves.toBe('Continue target run.')
  })

  it('blocks until an instruction arrives for a run directory', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'WAITING_FOR_REVIEW')

    const started = startWaitScript(
      {
        CODEX_PRO_MAX_POLL_SECONDS: '1',
      },
      ['-RunDir', runDir],
    )

    let exited = false
    const exitPromise = waitForExit(started, 6_000).then((result) => {
      exited = true
      return result
    })

    await delay(1_200)
    expect(exited).toBe(false)

    await writeFile(path.join(runDir, 'instruction.txt'), 'Continue now.')
    await writeFile(path.join(runDir, 'status.txt'), 'INSTRUCTION_RECEIVED')
    const result = await exitPromise
    const payload = JSON.parse(started.output.stdout) as {
      instruction: string
      status: string
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      instruction: 'Continue now.',
      status: 'RUNNING',
    })
  })

  it('allows multiple waiters to receive the same instruction', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'WAITING_FOR_REVIEW')
    await writeFile(path.join(runDir, 'instruction.txt'), '')

    const firstWaiter = startWaitScript(
      {
        CODEX_PRO_MAX_POLL_SECONDS: '1',
      },
      ['-RunDir', runDir],
    )

    let firstExited = false
    const firstExit = waitForExit(firstWaiter, 6_000).then((result) => {
      firstExited = true
      return result
    })

    let secondWaiter: StartedWaitScript | null = null
    let secondExited = false
    try {
      await delay(1_200)
      secondWaiter = startWaitScript(
        {
          CODEX_PRO_MAX_POLL_SECONDS: '1',
        },
        ['-RunDir', runDir],
      )
      const secondExit = waitForExit(secondWaiter, 6_000).then((result) => {
        secondExited = true
        return result
      })

      await delay(1_200)
      expect(firstExited).toBe(false)
      expect(secondExited).toBe(false)

      await writeFile(path.join(runDir, 'instruction.txt'), 'Continue now.')
      await writeFile(path.join(runDir, 'status.txt'), 'INSTRUCTION_RECEIVED')

      const [firstResult, secondResult] = await Promise.all([firstExit, secondExit])
      const firstPayload = JSON.parse(firstWaiter.output.stdout) as {
        shouldFinish: boolean
        instruction: string
        status: string
      }
      const secondPayload = JSON.parse(secondWaiter.output.stdout) as {
        shouldFinish: boolean
        instruction: string
        status: string
      }

      expect(firstResult.code).toBe(0)
      expect(secondResult.code).toBe(0)
      expect(firstPayload).toMatchObject({
        shouldFinish: false,
        instruction: 'Continue now.',
        status: 'RUNNING',
      })
      expect(secondPayload).toMatchObject({
        shouldFinish: false,
        instruction: 'Continue now.',
        status: 'RUNNING',
      })
    } finally {
      firstWaiter.child.kill()
      if (secondWaiter) {
        secondWaiter.child.kill()
        await waitForExit(secondWaiter, 2_000).catch(() => ({ code: null }))
      }
      await waitForExit(firstWaiter, 2_000).catch(() => ({ code: null }))
    }
  }, 10_000)

  it('reports active waiter state without finishing if an old exclusive lock exists', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'WAITING_FOR_REVIEW')
    await writeFile(path.join(runDir, 'instruction.txt'), '')

    const lockHolder = startStateLockHolder(path.join(runDir, 'wait_for_review.lock'), 2)

    try {
      await waitForFile(path.join(runDir, 'wait_for_review.lock'))
      const result = await runPowerShellScript(WAIT_SCRIPT, ['-RunDir', runDir], {
        CODEX_PRO_MAX_POLL_SECONDS: '1',
        CODEX_PRO_MAX_MAX_WAIT_SECONDS: '2',
      })
      const payload = JSON.parse(result.stdout) as {
        shouldFinish: boolean
        idleTimeout: boolean
        instruction: string
      }

      expect(result.code).toBe(0)
      expect(payload).toMatchObject({
        shouldFinish: false,
        idleTimeout: true,
        instruction: '',
      })
    } finally {
      lockHolder.child.kill()
      await waitForExit(lockHolder, 2_000).catch(() => ({ code: null }))
    }
  }, 10_000)

  it('keeps waiting when review state changes to running without an instruction', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'WAITING_FOR_REVIEW')
    await writeFile(path.join(runDir, 'instruction.txt'), '')

    const started = startWaitScript(
      {
        CODEX_PRO_MAX_POLL_SECONDS: '1',
        CODEX_PRO_MAX_MAX_WAIT_SECONDS: '3',
      },
      ['-RunDir', runDir],
    )

    await delay(1_200)
    await writeFile(path.join(runDir, 'status.txt'), 'RUNNING')
    const result = await waitForExit(started, 6_000)
    const payload = JSON.parse(started.output.stdout) as {
      shouldFinish: boolean
      idleTimeout: boolean
      instruction: string
      status: string
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      shouldFinish: false,
      idleTimeout: true,
      instruction: '',
      status: 'RUNNING',
    })
  })

  it('recovers instruction from session history when an old waiter cleared instruction.txt', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    const instruction = 'Recover this instruction.'
    const sessionBlock = [
      '<!-- codex-pro-max:message {"id":"user-1","role":"user","createdAtIso":"2026-05-10T00:00:00.000Z"} -->',
      '## User - 2026-05-10T00:00:00.000Z',
      '',
      instruction,
      '',
      '',
    ].join('\n')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'WAITING_FOR_REVIEW')
    await writeFile(path.join(runDir, 'instruction.txt'), '')

    const started = startWaitScript(
      {
        CODEX_PRO_MAX_POLL_SECONDS: '1',
      },
      ['-RunDir', runDir],
    )

    await delay(1_200)
    await writeFile(path.join(runDir, 'session.md'), sessionBlock, 'utf8')
    await writeFile(path.join(runDir, 'status.txt'), 'RUNNING')
    const result = await waitForExit(started, 6_000)
    const payload = JSON.parse(started.output.stdout) as {
      shouldFinish: boolean
      instruction: string
      status: string
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      shouldFinish: false,
      instruction,
      status: 'RUNNING',
    })
    await expect(readFile(path.join(runDir, 'instruction.txt'), 'utf8')).resolves.toBe(instruction)
  })

  it('returns cleanly after idle wait timeout before host shell timeout', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'WAITING_FOR_REVIEW')
    await writeFile(path.join(runDir, 'instruction.txt'), '')

    const result = await runPowerShellScript(
      WAIT_SCRIPT,
      ['-RunDir', runDir],
      {
        CODEX_PRO_MAX_POLL_SECONDS: '1',
        CODEX_PRO_MAX_MAX_WAIT_SECONDS: '1',
      },
    )
    const payload = JSON.parse(result.stdout) as {
      instruction: string
      status: string
      shouldFinish: boolean
      idleTimeout: boolean
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      instruction: '',
      status: 'WAITING_FOR_REVIEW',
      shouldFinish: false,
      idleTimeout: true,
    })
  })

  it('setup writes portable global instructions and skill scripts', async () => {
    const codexHome = await createTempRoot()
    const skillRoot = path.join(codexHome, 'skills', 'codex-pro-max')
    await mkdir(path.join(skillRoot, 'scripts'), { recursive: true })
    await writeFile(path.join(skillRoot, 'scripts', 'stale-copy.tmp'), 'stale file')

    const result = await runCmdScript(SETUP_SCRIPT, ['-CodexHome', codexHome])

    expect(result.code).toBe(0)
    await expect(fileExists(path.join(codexHome, 'AGENTS.md'))).resolves.toBe(true)
    await expect(fileExists(path.join(codexHome, 'skills', 'codex-pro-max', 'SKILL.md'))).resolves.toBe(true)
    await expect(fileExists(path.join(codexHome, 'skills', 'codex-pro-max', 'scripts', 'create_session.ps1'))).resolves.toBe(true)
    await expect(fileExists(path.join(codexHome, 'skills', 'codex-pro-max', 'scripts', 'request_review.ps1'))).resolves.toBe(true)
    await expect(fileExists(path.join(codexHome, 'skills', 'codex-pro-max', 'scripts', 'wait_for_review.ps1'))).resolves.toBe(true)
    await expect(fileExists(path.join(codexHome, 'skills', 'codex-pro-max', 'INSTALLATION.json'))).resolves.toBe(true)
    await expect(fileExists(path.join(codexHome, 'config.toml'))).resolves.toBe(true)

    const agents = await readFile(path.join(codexHome, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('codex-pro-max')
    expect(agents).toContain('create_session.ps1')
    expect(agents).toContain('bound to the current Codex conversation')
    expect(agents).toContain('run.json.codexThreadId')
    expect(agents).toContain('wait_for_review.ps1 -RunDir "<runDir>"')
    expect(agents).toContain('idleTimeout=true')
    expect(agents).toContain('exit code `124`')
    expect(agents).toContain('Ignore `shouldFinish=true`; it is not a valid stop signal')
    const skill = await readFile(path.join(codexHome, 'skills', 'codex-pro-max', 'SKILL.md'), 'utf8')
    expect(skill).toContain('bound to the current Codex conversation')
    expect(skill).toContain('run.json.codexThreadId')
    expect(skill).toContain('idleTimeout=true')
    expect(skill).toContain('Do not send a final answer')
    expect(skill).toContain('Ignore `shouldFinish=true`; it is not a valid stop signal')
    const installation = JSON.parse(
      await readFile(path.join(codexHome, 'skills', 'codex-pro-max', 'INSTALLATION.json'), 'utf8'),
    ) as { projectRoot: string; codexHome: string; skillRoot: string }
    expect(installation.projectRoot).toBe(process.cwd())
    expect(installation.codexHome).toBe(codexHome)
    expect(installation.skillRoot).toBe(path.join(codexHome, 'skills', 'codex-pro-max'))
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8')
    expect(config).toContain(path.join(codexHome, 'skills', 'codex-pro-max', 'SKILL.md').replaceAll('\\', '\\\\'))
    const scriptFiles = await readdir(path.join(skillRoot, 'scripts'))
    expect([...scriptFiles].sort()).toEqual(['create_session.ps1', 'request_review.ps1', 'wait_for_review.ps1'])
    const installedFiles = await readdir(skillRoot, { recursive: true })
    expect(installedFiles.some((fileName) => String(fileName).includes('stale-copy.tmp'))).toBe(false)
  })

  it('uninstall removes installed skill, global instructions, and config entry', async () => {
    const codexHome = await createTempRoot()
    await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n\n')

    const setupResult = await runCmdScript(SETUP_SCRIPT, ['-CodexHome', codexHome])
    const uninstallResult = await runCmdScript(UNINSTALL_SCRIPT, ['-CodexHome', codexHome])

    expect(setupResult.code).toBe(0)
    expect(uninstallResult.code).toBe(0)
    await expect(fileExists(path.join(codexHome, 'skills', 'codex-pro-max'))).resolves.toBe(false)
    await expect(fileExists(path.join(codexHome, 'AGENTS.md'))).resolves.toBe(false)
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8')
    expect(config).toContain('model = "gpt-5"')
    expect(config).not.toContain('codex-pro-max')
  })

  it('uninstall preserves modified global instructions unless forced', async () => {
    const codexHome = await createTempRoot()
    const customAgents = 'custom global instructions\n'

    const setupResult = await runCmdScript(SETUP_SCRIPT, ['-CodexHome', codexHome])
    await writeFile(path.join(codexHome, 'AGENTS.md'), customAgents)
    const uninstallResult = await runCmdScript(UNINSTALL_SCRIPT, ['-CodexHome', codexHome])

    expect(setupResult.code).toBe(0)
    expect(uninstallResult.code).toBe(0)
    await expect(readFile(path.join(codexHome, 'AGENTS.md'), 'utf8')).resolves.toBe(customAgents)
    await expect(fileExists(path.join(codexHome, 'skills', 'codex-pro-max'))).resolves.toBe(false)
  })

  it('request review writes output and session while deleting progress', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'progress.md'), 'stale progress')
    await writeFile(path.join(runDir, 'instruction.txt'), 'stale instruction')

    const result = await runPowerShellScript(REQUEST_SCRIPT, [
      '-RunDir',
      runDir,
      '-Output',
      'Done.',
    ])

    expect(result.code).toBe(0)
    await expect(readFile(path.join(runDir, 'output.md'), 'utf8')).resolves.toBe('Done.')
    await expect(readFile(path.join(runDir, 'status.txt'), 'utf8')).resolves.toBe('WAITING_FOR_REVIEW')
    await expect(readFile(path.join(runDir, 'instruction.txt'), 'utf8')).resolves.toBe('')
    await expect(fileExists(path.join(runDir, 'progress.md'))).resolves.toBe(false)
    const session = await readFile(path.join(runDir, 'session.md'), 'utf8')
    expect(session).toContain('Done.')
  })

  it('request review waits for the selected run state lock', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    const holder = startStateLockHolder(path.join(runDir, 'run_state.lock'), 1)

    try {
      await waitForFile(path.join(runDir, 'run_state.lock'))
      const startedAt = Date.now()
      const result = await runPowerShellScript(
        REQUEST_SCRIPT,
        ['-RunDir', runDir, '-Output', 'Done after lock.'],
        {
          CODEX_PRO_MAX_LOCK_TIMEOUT_SECONDS: '5',
        },
      )

      expect(result.code).toBe(0)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800)
      await expect(readFile(path.join(runDir, 'output.md'), 'utf8')).resolves.toBe('Done after lock.')
      await expect(readFile(path.join(runDir, 'status.txt'), 'utf8')).resolves.toBe('WAITING_FOR_REVIEW')
    } finally {
      holder.child.kill()
      await waitForExit(holder, 2_000).catch(() => ({ code: null }))
    }
  })

  it('run state locks are scoped to each run directory', async () => {
    const root = await createTempRoot()
    const lockedRunDir = path.join(root, 'runs', 'locked-run')
    const freeRunDir = path.join(root, 'runs', 'free-run')
    await mkdir(lockedRunDir, { recursive: true })
    await mkdir(freeRunDir, { recursive: true })
    const holder = startStateLockHolder(path.join(lockedRunDir, 'run_state.lock'), 2)

    try {
      await waitForFile(path.join(lockedRunDir, 'run_state.lock'))
      const startedAt = Date.now()
      const result = await runPowerShellScript(
        REQUEST_SCRIPT,
        ['-RunDir', freeRunDir, '-Output', 'Free run done.'],
        {
          CODEX_PRO_MAX_LOCK_TIMEOUT_SECONDS: '5',
        },
      )

      expect(result.code).toBe(0)
      expect(Date.now() - startedAt).toBeLessThan(1_500)
      await expect(readFile(path.join(freeRunDir, 'output.md'), 'utf8')).resolves.toBe('Free run done.')
      await expect(readFile(path.join(lockedRunDir, 'output.md'), 'utf8')).rejects.toThrow()
    } finally {
      holder.child.kill()
      await waitForExit(holder, 2_000).catch(() => ({ code: null }))
    }
  })

  it('wait for review reads instruction, appends user history, and returns session path', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'INSTRUCTION_RECEIVED')
    await writeFile(path.join(runDir, 'instruction.txt'), 'Continue now.')

    const result = await runPowerShellScript(WAIT_SCRIPT, ['-RunDir', runDir])
    const payload = JSON.parse(result.stdout) as {
      status: string
      instruction: string
      sessionPath: string
      shouldFinish: boolean
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      status: 'RUNNING',
      instruction: 'Continue now.',
      sessionPath: path.join(runDir, 'session.md'),
      shouldFinish: false,
    })
    await expect(readFile(path.join(runDir, 'status.txt'), 'utf8')).resolves.toBe('RUNNING')
    await expect(readFile(path.join(runDir, 'instruction.txt'), 'utf8')).resolves.toBe('Continue now.')
    await expect(readFile(path.join(runDir, 'session.md'), 'utf8')).resolves.toContain('Continue now.')
  })

  it('wait for review does not duplicate backend-appended UTF-8 user history', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    const instruction = 'Use the Vite output ➜ Local: http://127.0.0.1:5173/'
    const sessionBlock = [
      '<!-- codex-pro-max:message {"id":"user-1","role":"user","createdAtIso":"2026-05-10T00:00:00.000Z"} -->',
      '## User - 2026-05-10T00:00:00.000Z',
      '',
      instruction,
      '',
      '',
    ].join('\n')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'INSTRUCTION_RECEIVED', 'utf8')
    await writeFile(path.join(runDir, 'instruction.txt'), instruction, 'utf8')
    await writeFile(path.join(runDir, 'session.md'), sessionBlock, 'utf8')

    const result = await runPowerShellScript(WAIT_SCRIPT, ['-RunDir', runDir])
    const payload = JSON.parse(result.stdout) as {
      instruction: string
      status: string
    }
    const session = await readFile(path.join(runDir, 'session.md'), 'utf8')

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      instruction,
      status: 'RUNNING',
    })
    expect(session.match(/role":"user"/g)).toHaveLength(1)
    expect(session).toContain('➜ Local')
    expect(session).not.toContain('âžœ')
  })

  it('wait for review does not finish from instruction text', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'INSTRUCTION_RECEIVED')
    await writeFile(path.join(runDir, 'instruction.txt'), 'Stop this Codex Pro Max session now.')

    const result = await runPowerShellScript(WAIT_SCRIPT, ['-RunDir', runDir])
    const payload = JSON.parse(result.stdout) as {
      instruction: string
      status: string
      shouldFinish: boolean
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      instruction: 'Stop this Codex Pro Max session now.',
      status: 'RUNNING',
      shouldFinish: false,
    })
  })

  it('wait for review does not finish when the UI writes stopped status', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'STOPPED')
    await writeFile(path.join(runDir, 'instruction.txt'), '')

    const result = await runPowerShellScript(WAIT_SCRIPT, ['-RunDir', runDir], {
      CODEX_PRO_MAX_POLL_SECONDS: '1',
      CODEX_PRO_MAX_MAX_WAIT_SECONDS: '1',
    })
    const payload = JSON.parse(result.stdout) as {
      instruction: string
      status: string
      shouldFinish: boolean
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      instruction: '',
      status: 'STOPPED',
      shouldFinish: false,
    })
  }, 10_000)
})

async function createTempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-pro-max-skill-'))
  tempRoots.push(root)
  return root
}

async function writeRolloutLog(root: string, relativePath: string, mtime: Date) {
  const filePath = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, '{"type":"session_meta"}\n', 'utf8')
  await utimes(filePath, mtime, mtime)
}

function startWaitScript(env: Record<string, string>, args: string[] = []): StartedWaitScript {
  const output = { stdout: '', stderr: '' }
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WAIT_SCRIPT, ...args],
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

async function runPowerShellScript(scriptPath: string, args: string[], env: Record<string, string> = {}) {
  const started = startPowerShellScript(scriptPath, args, env)
  const result = await waitForExit(started, 4_000)
  return { ...result, stdout: started.output.stdout, stderr: started.output.stderr }
}

async function runCmdScript(scriptPath: string, args: string[]) {
  const output = { stdout: '', stderr: '' }
  const child = spawn('cmd', ['/d', '/c', scriptPath, ...args], {
    env: {
      ...process.env,
      CODEX_PRO_MAX_SETUP_NO_PAUSE: '1',
      CODEX_PRO_MAX_UNINSTALL_NO_PAUSE: '1',
    },
    windowsHide: true,
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    output.stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output.stderr += chunk.toString('utf8')
  })

  const result = await waitForExit({ child, output }, 4_000)
  return { ...result, stdout: output.stdout, stderr: output.stderr }
}

function startPowerShellScript(scriptPath: string, args: string[], env: Record<string, string> = {}): StartedWaitScript {
  const output = { stdout: '', stderr: '' }
  const child = spawn(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
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

function startStateLockHolder(lockPath: string, holdSeconds: number): StartedWaitScript {
  const output = { stdout: '', stderr: '' }
  const escapedLockPath = lockPath.replaceAll("'", "''")
  const command = [
    "$ErrorActionPreference = 'Stop'",
    `$path = '${escapedLockPath}'`,
    `$seconds = ${holdSeconds}`,
    '$encoding = New-Object System.Text.UTF8Encoding($false)',
    '$stream = [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    'try {',
    '  $stream.SetLength(0)',
    "  $bytes = $encoding.GetBytes('holder')",
    '  $stream.Write($bytes, 0, $bytes.Length)',
    '  $stream.Flush()',
    '  Start-Sleep -Seconds $seconds',
    '} finally {',
    '  $stream.Dispose()',
    '}',
  ].join('; ')
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand], {
    env: { ...process.env },
    windowsHide: true,
  })

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

async function waitForFile(filePath: string, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await fileExists(filePath)) {
      await delay(100)
      return
    }
    await delay(50)
  }

  throw new Error(`File did not appear: ${filePath}`)
}

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
