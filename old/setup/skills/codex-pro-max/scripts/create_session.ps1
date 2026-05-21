param(
  [string]$Root = "",
  [string]$RunId = "",
  [string]$DisplayName = "",
  [string]$WorkspacePath = "",
  [string]$CodexThreadId = ""
)

$ErrorActionPreference = "Stop"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $script:Utf8NoBom
$OutputEncoding = $script:Utf8NoBom

function Read-TextUtf8NoBom([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  return [System.IO.File]::ReadAllText($Path, $script:Utf8NoBom)
}

function Write-AtomicTextNoBom([string]$Path, [string]$Value) {
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText($tmp, $Value, $script:Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Get-PositiveEnvInt([string]$Name, [int]$DefaultValue) {
  $raw = [System.Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw)) { return $DefaultValue }

  $parsed = 0
  if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
    return $parsed
  }

  return $DefaultValue
}

function Enter-RunStateLock([string]$Path) {
  $lockPath = Join-Path $Path "run_state.lock"
  $timeoutSeconds = Get-PositiveEnvInt "CODEX_PRO_MAX_LOCK_TIMEOUT_SECONDS" 30
  $startedAt = [System.Diagnostics.Stopwatch]::StartNew()

  while ($true) {
    try {
      $stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
      $stream.SetLength(0)
      $lockText = "pid=$PID`nstartedAt=$((Get-Date).ToUniversalTime().ToString('o'))`nscript=create_session.ps1`n"
      $lockBytes = $script:Utf8NoBom.GetBytes($lockText)
      $stream.Write($lockBytes, 0, $lockBytes.Length)
      $stream.Flush()
      return $stream
    } catch [System.IO.IOException] {
      if ($startedAt.Elapsed.TotalSeconds -ge $timeoutSeconds) {
        throw "Timed out waiting for run state lock in $Path."
      }
      Start-Sleep -Milliseconds 100
    }
  }
}

function Exit-RunStateLock($Stream) {
  if ($null -ne $Stream) {
    $Stream.Dispose()
  }
}

function Get-SafeRunId([string]$Value) {
  $safe = [regex]::Replace($Value, '[^a-zA-Z0-9._-]+', '-').Trim('.', '_', '-')
  if ($safe.Length -gt 128) {
    $safe = $safe.Substring(0, 128).Trim('.', '_', '-')
  }
  if ([string]::IsNullOrWhiteSpace($safe)) {
    return "run-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  }
  return $safe
}

function Get-InstalledDataRoot {
  $scriptRoot = Split-Path -Parent $PSCommandPath
  $skillRoot = Split-Path -Parent $scriptRoot
  $installationPath = Join-Path $skillRoot "INSTALLATION.json"
  if (-not (Test-Path -LiteralPath $installationPath)) { return "" }

  try {
    $installation = Read-TextUtf8NoBom $installationPath | ConvertFrom-Json
    if ($installation.dataRoot) {
      return [string]$installation.dataRoot
    }
  } catch {}

  return ""
}

function Get-DefaultDataRoot {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PRO_MAX_DATA_ROOT)) {
    return $env:CODEX_PRO_MAX_DATA_ROOT
  }
  if (-not [string]::IsNullOrWhiteSpace($HOME)) {
    return (Join-Path $HOME ".codex-pro-max")
  }
  return ""
}

function Get-RolloutRunId([string]$Path) {
  $fileName = [System.IO.Path]::GetFileName($Path)
  $match = [regex]::Match($fileName, '^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(?<id>.+)\.jsonl$')
  if (-not $match.Success) { return "" }
  return [string]$match.Groups["id"].Value
}

function Get-CurrentRolloutLogPath {
  $candidates = @(
    $env:CODEX_ROLLOUT_LOG,
    $env:CODEX_CURRENT_ROLLOUT_LOG,
    $env:CODEX_SESSION_LOG,
    $env:CODEX_CURRENT_SESSION_LOG
  )

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    try {
      $resolved = [System.IO.Path]::GetFullPath($candidate)
      if (Test-Path -LiteralPath $resolved -PathType Leaf) {
        return $resolved
      }
    } catch {}
  }

  return ""
}

function Find-CurrentCodexConversationRunId {
  $rolloutLogPath = Get-CurrentRolloutLogPath
  if ([string]::IsNullOrWhiteSpace($rolloutLogPath)) {
    return ""
  }

  return Get-RolloutRunId $rolloutLogPath
}

function Read-ExistingRunCodexThreadId([string]$Path) {
  $runJsonPath = Join-Path $Path "run.json"
  if (-not (Test-Path -LiteralPath $runJsonPath)) { return "" }

  try {
    $existing = Read-TextUtf8NoBom $runJsonPath | ConvertFrom-Json
    if ($existing.codexThreadId) { return [string]$existing.codexThreadId }
  } catch {}

  return ""
}

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = $env:CODEX_PRO_MAX_ROOT
}
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = Get-InstalledDataRoot
}
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = Get-DefaultDataRoot
}
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Get-Location).Path
}

if ([string]::IsNullOrWhiteSpace($CodexThreadId)) {
  $CodexThreadId = $env:CODEX_THREAD_ID
}
if ([string]::IsNullOrWhiteSpace($CodexThreadId)) {
  $CodexThreadId = Find-CurrentCodexConversationRunId
}
if ([string]::IsNullOrWhiteSpace($CodexThreadId)) {
  throw "Unable to resolve the current Codex conversation id. CODEX_THREAD_ID is empty and no explicit current rollout log path was provided. Refusing to guess from the newest rollout log because that can bind this Codex Pro Max session to another conversation."
}
if ([string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = $CodexThreadId
}

$resolvedRoot = [System.IO.Path]::GetFullPath($Root)
$safeRunId = Get-SafeRunId $RunId
$runDir = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $resolvedRoot "runs") $safeRunId))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$existingCodexThreadId = Read-ExistingRunCodexThreadId $runDir
if (
  -not [string]::IsNullOrWhiteSpace($existingCodexThreadId) -and
  $existingCodexThreadId -ne $CodexThreadId
) {
  throw "Refusing to attach run '$safeRunId' to Codex conversation '$CodexThreadId' because the existing run.json is bound to '$existingCodexThreadId'."
}

$stateLockStream = $null
try {
  $stateLockStream = Enter-RunStateLock $runDir

  $statusPath = Join-Path $runDir "status.txt"
  $instructionPath = Join-Path $runDir "instruction.txt"
  $outputPath = Join-Path $runDir "output.md"
  $sessionPath = Join-Path $runDir "session.md"

  if (-not (Test-Path -LiteralPath $statusPath)) {
    Write-AtomicTextNoBom $statusPath "RUNNING"
  }
  if (-not (Test-Path -LiteralPath $instructionPath)) {
    Write-AtomicTextNoBom $instructionPath ""
  }
  if (-not (Test-Path -LiteralPath $outputPath)) {
    Write-AtomicTextNoBom $outputPath ""
  }
  if (-not (Test-Path -LiteralPath $sessionPath)) {
    Write-AtomicTextNoBom $sessionPath ""
  }

  $now = (Get-Date).ToUniversalTime().ToString("o")
  $runJsonPath = Join-Path $runDir "run.json"
  $createdAt = $now
  if (Test-Path -LiteralPath $runJsonPath) {
    try {
      $existing = Read-TextUtf8NoBom $runJsonPath | ConvertFrom-Json
      if ($existing.createdAtIso) { $createdAt = [string]$existing.createdAtIso }
    } catch {}
  }

  $runJson = [ordered]@{
    runId = $safeRunId
    displayName = $(if ($DisplayName) { $DisplayName } else { $safeRunId })
    workspacePath = $(if ($WorkspacePath) { $WorkspacePath } else { $resolvedRoot })
    createdAtIso = $createdAt
    updatedAtIso = $now
    codexThreadId = $(if ($CodexThreadId) { $CodexThreadId } else { $null })
  } | ConvertTo-Json -Depth 4
  Write-AtomicTextNoBom $runJsonPath $runJson

  $status = (Read-TextUtf8NoBom $statusPath).Trim()
} finally {
  Exit-RunStateLock $stateLockStream
}

[ordered]@{
  ok = $true
  root = $resolvedRoot
  runId = $safeRunId
  runDir = $runDir
  status = $status
  sessionPath = (Join-Path $runDir "session.md")
} | ConvertTo-Json -Compress
