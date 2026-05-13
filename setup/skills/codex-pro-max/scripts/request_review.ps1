param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$Progress = "",
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

function Add-TextUtf8NoBom([string]$Path, [string]$Value) {
  [System.IO.File]::AppendAllText($Path, $Value, $script:Utf8NoBom)
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
      $lockText = "pid=$PID`nstartedAt=$((Get-Date).ToUniversalTime().ToString('o'))`nscript=request_review.ps1`n"
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

function Format-SessionBlock([string]$Role, [string]$Content, [string]$CreatedAtIso, [string]$Id) {
  $trimmed = $Content.Trim()
  if (-not $trimmed) { return "" }
  if (-not $CreatedAtIso) { $CreatedAtIso = (Get-Date).ToUniversalTime().ToString("o") }
  if (-not $Id) { $Id = [guid]::NewGuid().ToString() }
  $metadata = [ordered]@{
    id = $Id
    role = $Role
    createdAtIso = $CreatedAtIso
  } | ConvertTo-Json -Compress
  $title = $(if ($Role -eq "assistant") { "Codex" } else { "User" })
  return "<!-- codex-pro-max:message $metadata -->`n## $title - $CreatedAtIso`n`n$trimmed`n`n"
}

function Append-SessionMessage([string]$Path, [string]$Role, [string]$Content) {
  $trimmed = $Content.Trim()
  if (-not $trimmed) { return }

  $sessionPath = Join-Path $Path "session.md"
  $existing = Read-TextUtf8NoBom $sessionPath
  if ($existing.TrimEnd().EndsWith($trimmed)) { return }

  Add-TextUtf8NoBom $sessionPath (Format-SessionBlock $Role $trimmed "" "")
}

$resolvedRunDir = [System.IO.Path]::GetFullPath($RunDir)
New-Item -ItemType Directory -Force -Path $resolvedRunDir | Out-Null

$stateLockStream = $null
try {
  $stateLockStream = Enter-RunStateLock $resolvedRunDir

  $now = (Get-Date).ToUniversalTime().ToString("o")
  $runJsonPath = Join-Path $resolvedRunDir "run.json"
  $runId = Split-Path -Leaf $resolvedRunDir
  $createdAt = $now
  if (Test-Path -LiteralPath $runJsonPath) {
    try {
      $existing = Read-TextUtf8NoBom $runJsonPath | ConvertFrom-Json
      if ($existing.createdAtIso) { $createdAt = [string]$existing.createdAtIso }
    } catch {}
  }

  if ($DisplayName -or $WorkspacePath -or $CodexThreadId) {
    $runJson = [ordered]@{
      runId = $runId
      displayName = $(if ($DisplayName) { $DisplayName } else { $runId })
      workspacePath = $WorkspacePath
      createdAtIso = $createdAt
      updatedAtIso = $now
      codexThreadId = $(if ($CodexThreadId) { $CodexThreadId } else { $null })
    } | ConvertTo-Json -Depth 4
    Write-AtomicTextNoBom $runJsonPath $runJson
  }

  Write-AtomicTextNoBom (Join-Path $resolvedRunDir "output.md") $Output
  Append-SessionMessage $resolvedRunDir "assistant" $Output

  $progressPath = Join-Path $resolvedRunDir "progress.md"
  if (Test-Path -LiteralPath $progressPath) {
    Remove-Item -LiteralPath $progressPath -Force
  }

  Write-AtomicTextNoBom (Join-Path $resolvedRunDir "instruction.txt") ""
  Write-AtomicTextNoBom (Join-Path $resolvedRunDir "status.txt") "WAITING_FOR_REVIEW"
} finally {
  Exit-RunStateLock $stateLockStream
}

[ordered]@{
  ok = $true
  runDir = $resolvedRunDir
  status = "WAITING_FOR_REVIEW"
  sessionPath = (Join-Path $resolvedRunDir "session.md")
} | ConvertTo-Json -Compress
