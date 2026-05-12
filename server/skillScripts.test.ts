import { spawn } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const SKILL_SCRIPT_DIR = path.resolve('setup', 'skills', 'codex-pro-max', 'scripts')
const CREATE_SCRIPT = path.join(SKILL_SCRIPT_DIR, 'create_session.ps1')
const WAIT_SCRIPT = path.join(SKILL_SCRIPT_DIR, 'wait_for_review.ps1')
const REQUEST_SCRIPT = path.join(SKILL_SCRIPT_DIR, 'request_review.ps1')
const SETUP_SCRIPT = path.resolve('setup.cmd')

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
    await expect(readFile(path.join(targetRunDir, 'instruction.txt'), 'utf8')).resolves.toBe('')
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
    expect(agents).toContain('wait_for_review.ps1 -RunDir "<runDir>"')
    expect(agents).toContain('idleTimeout=true')
    expect(agents).toContain('exit code `124`')
    expect(agents).toContain('The only valid reason to leave the loop is returned JSON with `shouldFinish=true`')
    const skill = await readFile(path.join(codexHome, 'skills', 'codex-pro-max', 'SKILL.md'), 'utf8')
    expect(skill).toContain('idleTimeout=true')
    expect(skill).toContain('Do not send a final answer')
    expect(skill).toContain('The only valid reason to leave the loop is returned JSON with `shouldFinish=true`')
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

  it('request review writes output and session while deleting progress', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'progress.md'), 'stale progress')

    const result = await runPowerShellScript(REQUEST_SCRIPT, [
      '-RunDir',
      runDir,
      '-Output',
      'Done.',
    ])

    expect(result.code).toBe(0)
    await expect(readFile(path.join(runDir, 'output.md'), 'utf8')).resolves.toBe('Done.')
    await expect(readFile(path.join(runDir, 'status.txt'), 'utf8')).resolves.toBe('WAITING_FOR_REVIEW')
    await expect(fileExists(path.join(runDir, 'progress.md'))).resolves.toBe(false)
    const session = await readFile(path.join(runDir, 'session.md'), 'utf8')
    expect(session).toContain('Done.')
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
    await expect(readFile(path.join(runDir, 'instruction.txt'), 'utf8')).resolves.toBe('')
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

  it('wait for review finishes only when the UI writes stopped status', async () => {
    const root = await createTempRoot()
    const runDir = path.join(root, 'runs', 'target-run')
    await mkdir(runDir, { recursive: true })
    await writeFile(path.join(runDir, 'status.txt'), 'STOPPED')
    await writeFile(path.join(runDir, 'instruction.txt'), '')

    const result = await runPowerShellScript(WAIT_SCRIPT, ['-RunDir', runDir])
    const payload = JSON.parse(result.stdout) as {
      instruction: string
      status: string
      shouldFinish: boolean
    }

    expect(result.code).toBe(0)
    expect(payload).toMatchObject({
      instruction: '',
      status: 'STOPPED',
      shouldFinish: true,
    })
  })
})

async function createTempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-pro-max-skill-'))
  tempRoots.push(root)
  return root
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
    env: { ...process.env, CODEX_PRO_MAX_SETUP_NO_PAUSE: '1' },
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

async function fileExists(filePath: string) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}
