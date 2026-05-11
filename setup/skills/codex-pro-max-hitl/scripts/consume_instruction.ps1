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

function Initialize-SessionFromLegacy([string]$Path) {
  $sessionPath = Join-Path $Path "session.md"
  if (Test-Path -LiteralPath $sessionPath) { return }

  $messagesPath = Join-Path $Path "messages.ndjson"
  if (-not (Test-Path -LiteralPath $messagesPath)) { return }

  $body = ""
  foreach ($line in ([System.IO.File]::ReadLines($messagesPath, $script:Utf8NoBom))) {
    if (-not $line.Trim()) { continue }
    try {
      $message = $line | ConvertFrom-Json
      if ($message.role -ne "assistant" -and $message.role -ne "user") { continue }
      $body += Format-SessionBlock ([string]$message.role) ([string]$message.content) ([string]$message.createdAtIso) ([string]$message.id)
    } catch {}
  }

  if ($body) {
    Write-AtomicTextNoBom $sessionPath $body
  }
}

function Append-SessionMessage([string]$Path, [string]$Role, [string]$Content) {
  $trimmed = $Content.Trim()
  if (-not $trimmed) { return }

  Initialize-SessionFromLegacy $Path
  $sessionPath = Join-Path $Path "session.md"
  $existing = Read-TextUtf8NoBom $sessionPath
  if ($existing.TrimEnd().EndsWith($trimmed)) { return }

  Add-TextUtf8NoBom $sessionPath (Format-SessionBlock $Role $trimmed "" "")
}

function Test-ShouldFinish([string]$Instruction) {
  $normalized = ($Instruction -replace '\s+', ' ').Trim().ToLowerInvariant()
  if (-not $normalized) { return $false }

  $exactFinishCommands = @(
    "stop",
    "stop.",
    "stop!",
    "stop now",
    "stop now.",
    "please stop",
    "please stop.",
    "please stop now",
    "please stop now.",
    "finish",
    "finish.",
    "finish!",
    "finish now",
    "finish now.",
    "please finish",
    "please finish.",
    "end",
    "end.",
    "end!",
    "end session",
    "end session.",
    "disable hitl",
    "disable codex pro max",
    "stop this codex pro max hitl session now."
  )

  return $exactFinishCommands -contains $normalized
}

$resolvedRunDir = [System.IO.Path]::GetFullPath($RunDir)
$statusPath = Join-Path $resolvedRunDir "status.txt"
$instructionPath = Join-Path $resolvedRunDir "instruction.txt"
$sessionPath = Join-Path $resolvedRunDir "session.md"

$status = ""
if (Test-Path -LiteralPath $statusPath) {
  $status = (Read-TextUtf8NoBom $statusPath).Trim()
}

$instruction = ""
if (Test-Path -LiteralPath $instructionPath) {
  $instruction = (Read-TextUtf8NoBom $instructionPath).Trim()
}

if ($status -eq "INSTRUCTION_RECEIVED" -and $instruction) {
  Append-SessionMessage $resolvedRunDir "user" $instruction
}

Write-AtomicTextNoBom $instructionPath ""
if ($status -eq "INSTRUCTION_RECEIVED") {
  Write-AtomicTextNoBom $statusPath "RUNNING"
  $status = "RUNNING"
}

$shouldFinish = Test-ShouldFinish $instruction

[ordered]@{
  ok = $true
  runDir = $resolvedRunDir
  status = $status
  instruction = $instruction
  sessionPath = $sessionPath
  shouldFinish = [bool]$shouldFinish
} | ConvertTo-Json -Compress
