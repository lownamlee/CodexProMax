param(
  [string]$RunDir = "",
  [int]$MaxSeconds = 0
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-SafeRunId([string]$value) {
  $safe = [regex]::Replace($value, '[^a-zA-Z0-9._-]+', '-').Trim('.', '_', '-')
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return "run-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  }
  if ($safe.Length -gt 128) {
    $safe = $safe.Substring(0, 128).Trim('.', '_', '-')
  }
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return "run-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  }
  return $safe
}

$runDir = $RunDir
if ([string]::IsNullOrWhiteSpace($runDir)) {
  $runDir = $env:CODEX_PRO_MAX_RUN_DIR
}

if ([string]::IsNullOrWhiteSpace($runDir)) {
  $root = $env:CODEX_PRO_MAX_ROOT
  if ([string]::IsNullOrWhiteSpace($root)) {
    $root = (Get-Location).Path
  }

  $runId = $env:CODEX_PRO_MAX_RUN_ID
  if ([string]::IsNullOrWhiteSpace($runId)) {
    $runId = $env:CODEX_THREAD_ID
  }
  if ([string]::IsNullOrWhiteSpace($runId)) {
    $runId = "run-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  }

  $runDir = Join-Path (Join-Path $root 'runs') (Get-SafeRunId $runId)
}

New-Item -ItemType Directory -Path $runDir -Force | Out-Null

$statusFile = Join-Path $runDir 'status.txt'
$pollSeconds = 10
if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PRO_MAX_POLL_SECONDS)) {
  $parsedPollSeconds = 0
  if ([int]::TryParse($env:CODEX_PRO_MAX_POLL_SECONDS, [ref]$parsedPollSeconds) -and $parsedPollSeconds -gt 0) {
    $pollSeconds = $parsedPollSeconds
  }
}

Write-Output "Polling $statusFile every $pollSeconds seconds..."

$deadline = $null
if ($MaxSeconds -gt 0) {
  $deadline = (Get-Date).AddSeconds($MaxSeconds)
}

while ($true) {
  $current = ''
  if (Test-Path -LiteralPath $statusFile) {
    $current = (Get-Content -LiteralPath $statusFile -Raw) -replace '\s', ''
  }

  if ($current -eq 'INSTRUCTION_RECEIVED') {
    Write-Output "STATUS_CHANGED: $current"
    exit 0
  }

  if ($null -ne $deadline) {
    $remainingSeconds = ($deadline - (Get-Date)).TotalSeconds
    if ($remainingSeconds -le 0) {
      Write-Output "STILL_WAITING: $current"
      exit 0
    }

    Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min($pollSeconds, [int][Math]::Ceiling($remainingSeconds))))
    continue
  }

  Start-Sleep -Seconds $pollSeconds
}
