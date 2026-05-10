param(
  [string]$CodexHome = "",
  [switch]$NoBackup
)

$ErrorActionPreference = "Stop"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSCommandPath))
if ([string]::IsNullOrWhiteSpace($CodexHome)) {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
    $CodexHome = $env:CODEX_HOME
  } else {
    $CodexHome = Join-Path $HOME ".codex"
  }
}
$CodexHome = [System.IO.Path]::GetFullPath($CodexHome)

function Write-AtomicTextNoBom([string]$Path, [string]$Value) {
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText($tmp, $Value, $script:Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Backup-File([string]$Path) {
  if ($NoBackup -or -not (Test-Path -LiteralPath $Path)) {
    return
  }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item -LiteralPath $Path -Destination "$Path.backup-codex-pro-max-$stamp" -Force
}

function Install-TextFile([string]$Path, [string]$Content) {
  Backup-File $Path
  Write-AtomicTextNoBom $Path $Content
}

function Install-CopiedFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required source file missing: $Source"
  }
  Backup-File $Destination
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Convert-ToTemplateText([string]$Template) {
  $text = $Template.Replace("{{PROJECT_ROOT}}", $ProjectRoot)
  $text = $text.Replace("{{CODEX_HOME}}", $CodexHome)
  $text = $text.Replace("{{SKILL_ROOT}}", (Join-Path (Join-Path $CodexHome "skills") "codex-pro-max-hitl"))
  return $text
}

$skillRoot = Join-Path (Join-Path $CodexHome "skills") "codex-pro-max-hitl"
$skillScripts = Join-Path $skillRoot "scripts"
$agentsPath = Join-Path $CodexHome "AGENTS.md"
$skillPath = Join-Path $skillRoot "SKILL.md"

$agentsTemplate = @'
# Global Codex Pro Max HITL Runtime

For every user task, use `{{SKILL_ROOT}}\SKILL.md` as the default human-in-the-loop runtime when Codex Pro Max is active.

Treat Codex Pro Max as active when:

- `CODEX_PRO_MAX_RUN_DIR` is set, or
- `CODEX_PRO_MAX_ROOT` is set, or
- `{{PROJECT_ROOT}}` exists and `http://127.0.0.1:53127/api/snapshot` is reachable.

If Codex Pro Max is not active, answer normally in chat.

When HITL is active:

1. Do the requested work.
2. Finish the work by calling `request_review.ps1 -RunDir "<run-dir>" -Output "<normal Codex conclusion>"`.
3. Wait with the manager's `wait_for_review.ps1 -RunDir "<run-dir>"`.
4. Consume the next human instruction with `consume_instruction.ps1 -RunDir "<run-dir>"`.
5. Continue unless the returned JSON has `shouldFinish=true`.

Use `-MaxSeconds` only for explicit diagnostics or user-requested status updates, not for the default review loop.
If the wait command is interrupted, times out, or exits unexpectedly, check `<run-dir>/status.txt`; consume the instruction when it is `INSTRUCTION_RECEIVED`, otherwise resume the exact-run wait. Do not treat an interrupted wait as completion.

Use `session.md` when prior conclusions or user instructions matter.

Core files:

- `output.md`: latest Codex conclusion.
- `instruction.txt`: current human instruction.
- `session.md`: complete session history.
- `status.txt`: normal states are `RUNNING`, `WAITING_FOR_REVIEW`, and `INSTRUCTION_RECEIVED`.

Use only this simplified workflow for normal Codex Pro Max review loops.
Never send the final chat response while HITL is active unless `consume_instruction.ps1` returned `shouldFinish=true`.
'@

$skillTemplate = @'
---
name: codex-pro-max-hitl
description: Default continuous human-in-the-loop runtime for Codex Pro Max when the manager at {{PROJECT_ROOT}} is actually running or an explicit CODEX_PRO_MAX_* run is active. When the manager is unavailable, skip HITL and answer normally in chat.
---

# Codex Pro Max HITL

Use this skill only when Codex Pro Max is available.

## Availability

HITL is active only when one is true:

1. `CODEX_PRO_MAX_RUN_DIR` is set.
2. `CODEX_PRO_MAX_ROOT` is set.
3. `{{PROJECT_ROOT}}` exists and `http://127.0.0.1:53127/api/snapshot` is reachable.

If none is true, answer normally in chat.

## Run Directory

Use `CODEX_PRO_MAX_RUN_DIR` when set. Otherwise use `<manager-root>/runs/<CODEX_PRO_MAX_RUN_ID>`, then `<manager-root>/runs/<CODEX_THREAD_ID>`, otherwise create a safe `runs/run-<timestamp>-<random>` folder.

## Loop

1. Do the work.
2. Call `request_review.ps1 -RunDir "<run-dir>" -Output "<normal Codex conclusion>"`.
3. Wait with `<manager-root>/wait_for_review.ps1 -RunDir "<run-dir>"`.
4. Call `consume_instruction.ps1 -RunDir "<run-dir>"`.
5. If `shouldFinish=true`, send the final chat response. Otherwise execute `instruction` and repeat.

Do not stop unless `consume_instruction.ps1` returns `shouldFinish=true`.
Use `-MaxSeconds` only for explicit diagnostics or user-requested status updates, not for the default review loop.
If a wait command is interrupted, times out, or exits unexpectedly, immediately check `<run-dir>/status.txt`; consume the instruction when it is `INSTRUCTION_RECEIVED`, otherwise resume the exact-run wait. Do not treat an interrupted wait as completion.

## Files

- `output.md`: latest Codex conclusion.
- `instruction.txt`: current human instruction.
- `session.md`: complete session history. Read it when previous conclusions or instructions matter.
- `status.txt`: normal states are `RUNNING`, `WAITING_FOR_REVIEW`, and `INSTRUCTION_RECEIVED`. `BLOCKED` and `ERROR` are exceptional only.

## Commands

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File {{SKILL_ROOT}}\scripts\request_review.ps1 -RunDir "<run-dir>" -Output "<normal Codex conclusion>"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File {{PROJECT_ROOT}}\wait_for_review.ps1 -RunDir "<run-dir>"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File {{SKILL_ROOT}}\scripts\consume_instruction.ps1 -RunDir "<run-dir>"
```
'@

$requestReviewScript = @'
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

$resolvedRunDir = [System.IO.Path]::GetFullPath($RunDir)
New-Item -ItemType Directory -Force -Path $resolvedRunDir | Out-Null

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

Write-AtomicTextNoBom (Join-Path $resolvedRunDir "status.txt") "WAITING_FOR_REVIEW"

[ordered]@{
  ok = $true
  runDir = $resolvedRunDir
  status = "WAITING_FOR_REVIEW"
  sessionPath = (Join-Path $resolvedRunDir "session.md")
} | ConvertTo-Json -Compress
'@

$consumeInstructionScript = @'
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
'@

New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
New-Item -ItemType Directory -Path $skillScripts -Force | Out-Null

Install-TextFile $agentsPath (Convert-ToTemplateText $agentsTemplate)
Install-TextFile $skillPath (Convert-ToTemplateText $skillTemplate)
Install-TextFile (Join-Path $skillScripts "request_review.ps1") $requestReviewScript
Install-TextFile (Join-Path $skillScripts "consume_instruction.ps1") $consumeInstructionScript
Install-CopiedFile (Join-Path $ProjectRoot "wait_for_review.ps1") (Join-Path $skillScripts "wait_for_review.ps1")

Write-Host "Installed Codex Pro Max HITL configuration."
Write-Host "Project root: $ProjectRoot"
Write-Host "Codex home: $CodexHome"
Write-Host "Global instructions: $agentsPath"
Write-Host "Skill: $skillPath"
