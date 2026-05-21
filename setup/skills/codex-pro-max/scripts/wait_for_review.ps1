param(
  [Parameter(Mandatory = $true)][string]$RunDir
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
      $lockText = "pid=$PID`nstartedAt=$((Get-Date).ToUniversalTime().ToString('o'))`nscript=wait_for_review.ps1`n"
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

function Read-ExistingRunCodexThreadId([string]$Path) {
  $runJsonPath = Join-Path $Path "run.json"
  if (-not (Test-Path -LiteralPath $runJsonPath)) { return "" }

  try {
    $existing = Read-TextUtf8NoBom $runJsonPath | ConvertFrom-Json
    if ($existing.codexThreadId) { return [string]$existing.codexThreadId }
  } catch {}

  return ""
}

function Assert-CurrentConversationCanUseRun([string]$Path) {
  $currentCodexThreadId = $env:CODEX_THREAD_ID
  if ([string]::IsNullOrWhiteSpace($currentCodexThreadId)) { return }

  $existingCodexThreadId = Read-ExistingRunCodexThreadId $Path
  if ([string]::IsNullOrWhiteSpace($existingCodexThreadId)) { return }

  if ($existingCodexThreadId -ne $currentCodexThreadId) {
    $runId = Split-Path -Leaf $Path
    throw "Refusing to wait on run '$runId' because run.json is bound to Codex conversation '$existingCodexThreadId' while the current conversation is '$currentCodexThreadId'."
  }
}

function Read-LatestSessionUserInstruction([string]$Path) {
  $sessionPath = Join-Path $Path "session.md"
  $session = Read-TextUtf8NoBom $sessionPath
  if (-not $session.Trim()) { return "" }

  $pattern = "(?ms)<!-- codex-pro-max:message (?<metadata>\{[^\r\n]*?`"role`":`"(?<role>user|assistant)`"[^\r\n]*?\}) -->\s*## (?:User|Codex) - [^\r\n]*\r?\n\r?\n(?<content>.*?)(?=\r?\n<!-- codex-pro-max:message|\z)"
  $matches = [System.Text.RegularExpressions.Regex]::Matches($session, $pattern)
  for ($i = $matches.Count - 1; $i -ge 0; $i--) {
    $content = $matches[$i].Groups["content"].Value.Trim()
    if ($content) {
      if ($matches[$i].Groups["role"].Value -eq "user") { return $content }
      return ""
    }
  }

  return ""
}

function Read-InstructionAndMarkRunning([string]$Path, [string]$FallbackInstruction = "") {
  $statusPath = Join-Path $Path "status.txt"
  $instructionPath = Join-Path $Path "instruction.txt"
  $sessionPath = Join-Path $Path "session.md"

  $status = (Read-TextUtf8NoBom $statusPath).Trim()
  $instruction = (Read-TextUtf8NoBom $instructionPath).Trim()
  if (-not $instruction -and $FallbackInstruction.Trim()) {
    $instruction = $FallbackInstruction.Trim()
    Write-AtomicTextNoBom $instructionPath $instruction
  }

  if ($instruction) {
    Append-SessionMessage $Path "user" $instruction
  }

  if ($status -eq "INSTRUCTION_RECEIVED") {
    Write-AtomicTextNoBom $statusPath "RUNNING"
    $status = "RUNNING"
  }

  [ordered]@{
    ok = $true
    runDir = $Path
    status = $status
    instruction = $instruction
    sessionPath = $sessionPath
    shouldFinish = $false
  } | ConvertTo-Json -Compress
}

function Read-StoppedSession([string]$Path) {
  $sessionPath = Join-Path $Path "session.md"

  [ordered]@{
    ok = $true
    runDir = $Path
    status = "STOPPED"
    instruction = ""
    sessionPath = $sessionPath
    shouldFinish = $false
    idleTimeout = $true
  } | ConvertTo-Json -Compress
}

function Read-WaitingSession([string]$Path, [string]$Status) {
  $sessionPath = Join-Path $Path "session.md"

  [ordered]@{
    ok = $true
    runDir = $Path
    status = $Status
    instruction = ""
    sessionPath = $sessionPath
    shouldFinish = $false
    idleTimeout = $true
  } | ConvertTo-Json -Compress
}

$resolvedRunDir = [System.IO.Path]::GetFullPath($RunDir)
New-Item -ItemType Directory -Path $resolvedRunDir -Force | Out-Null
Assert-CurrentConversationCanUseRun $resolvedRunDir

$statusPath = Join-Path $resolvedRunDir "status.txt"
$instructionPath = Join-Path $resolvedRunDir "instruction.txt"
$waiterId = [guid]::NewGuid().ToString("N")
$waiterPath = Join-Path (Join-Path $resolvedRunDir "waiters") "$waiterId.txt"
Write-AtomicTextNoBom $waiterPath "pid=$PID`nstartedAt=$((Get-Date).ToUniversalTime().ToString('o'))`nscript=wait_for_review.ps1`n"

$pollSeconds = 10
if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PRO_MAX_POLL_SECONDS)) {
  $parsedPollSeconds = 0
  if ([int]::TryParse($env:CODEX_PRO_MAX_POLL_SECONDS, [ref]$parsedPollSeconds) -and $parsedPollSeconds -gt 0) {
    $pollSeconds = $parsedPollSeconds
  }
}

$maxWaitSeconds = 540
if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PRO_MAX_MAX_WAIT_SECONDS)) {
  $parsedMaxWaitSeconds = 0
  if ([int]::TryParse($env:CODEX_PRO_MAX_MAX_WAIT_SECONDS, [ref]$parsedMaxWaitSeconds) -and $parsedMaxWaitSeconds -gt 0) {
    $maxWaitSeconds = $parsedMaxWaitSeconds
  }
}

$startedAt = [System.Diagnostics.Stopwatch]::StartNew()
$observedReviewState = $false
try {
  while ($true) {
    $stateLockStream = $null
    try {
      $stateLockStream = Enter-RunStateLock $resolvedRunDir
      $current = (Read-TextUtf8NoBom $statusPath).Trim()
      if ($current -eq "WAITING_FOR_REVIEW") {
        $observedReviewState = $true
      }
      if ($current -eq "INSTRUCTION_RECEIVED") {
        Read-InstructionAndMarkRunning $resolvedRunDir
        exit 0
      }
      if ($current -eq "RUNNING") {
        $runningInstruction = (Read-TextUtf8NoBom $instructionPath).Trim()
        if (-not $runningInstruction) {
          $runningInstruction = Read-LatestSessionUserInstruction $resolvedRunDir
        }

        if ($runningInstruction) {
          Read-InstructionAndMarkRunning $resolvedRunDir $runningInstruction
          exit 0
        }
      }
      if ($startedAt.Elapsed.TotalSeconds -ge $maxWaitSeconds) {
        Read-WaitingSession $resolvedRunDir $current
        exit 0
      }
    } catch {
      [Console]::Error.WriteLine("WAIT_ERROR: $($_.Exception.Message)")
    } finally {
      Exit-RunStateLock $stateLockStream
    }

    Start-Sleep -Seconds $pollSeconds
  }
} finally {
  Remove-Item -LiteralPath $waiterPath -Force -ErrorAction SilentlyContinue
}
