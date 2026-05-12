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

function Read-And-ClearInstruction([string]$Path) {
  $statusPath = Join-Path $Path "status.txt"
  $instructionPath = Join-Path $Path "instruction.txt"
  $sessionPath = Join-Path $Path "session.md"

  $status = (Read-TextUtf8NoBom $statusPath).Trim()
  $instruction = (Read-TextUtf8NoBom $instructionPath).Trim()

  if ($status -eq "INSTRUCTION_RECEIVED" -and $instruction) {
    Append-SessionMessage $Path "user" $instruction
  }

  Write-AtomicTextNoBom $instructionPath ""
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
    shouldFinish = $true
  } | ConvertTo-Json -Compress
}

$resolvedRunDir = [System.IO.Path]::GetFullPath($RunDir)
New-Item -ItemType Directory -Path $resolvedRunDir -Force | Out-Null

$statusPath = Join-Path $resolvedRunDir "status.txt"
$pollSeconds = 10
if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PRO_MAX_POLL_SECONDS)) {
  $parsedPollSeconds = 0
  if ([int]::TryParse($env:CODEX_PRO_MAX_POLL_SECONDS, [ref]$parsedPollSeconds) -and $parsedPollSeconds -gt 0) {
    $pollSeconds = $parsedPollSeconds
  }
}

while ($true) {
  try {
    $current = (Read-TextUtf8NoBom $statusPath).Trim()
    if ($current -eq "INSTRUCTION_RECEIVED") {
      Read-And-ClearInstruction $resolvedRunDir
      exit 0
    }
    if ($current -eq "STOPPED") {
      Read-StoppedSession $resolvedRunDir
      exit 0
    }
  } catch {
    [Console]::Error.WriteLine("WAIT_ERROR: $($_.Exception.Message)")
  }

  Start-Sleep -Seconds $pollSeconds
}
