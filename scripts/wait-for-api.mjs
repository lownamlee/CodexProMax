const DEFAULT_PORT = 53127
const DEFAULT_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 150
const REQUEST_TIMEOUT_MS = 1_000

const port = Number.parseInt(process.env.CODEX_PRO_MAX_PORT || process.env.CODEX_PRO_MAX_API_PORT || '', 10)
const url = process.argv[2] || `http://127.0.0.1:${Number.isFinite(port) ? port : DEFAULT_PORT}/api/healthy`
const timeoutMs = parsePositiveInt(process.argv[3], DEFAULT_TIMEOUT_MS)
const startedAt = Date.now()

process.stdout.write(`Waiting for Codex Pro Max API at ${url}\n`)

while (Date.now() - startedAt < timeoutMs) {
  if (await isHealthy(url)) {
    process.stdout.write('Codex Pro Max API is ready\n')
    process.exit(0)
  }
  await delay(POLL_INTERVAL_MS)
}

process.stderr.write(`Timed out waiting for Codex Pro Max API at ${url}\n`)
process.exit(1)

async function isHealthy(targetUrl) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(targetUrl, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
