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

function Get-InstalledProjectRoot {
  $scriptRoot = Split-Path -Parent $PSCommandPath
  $skillRoot = Split-Path -Parent $scriptRoot
  $installationPath = Join-Path $skillRoot "INSTALLATION.json"
  if (-not (Test-Path -LiteralPath $installationPath)) { return "" }

  try {
    $installation = Read-TextUtf8NoBom $installationPath | ConvertFrom-Json
    if ($installation.projectRoot) {
      return [string]$installation.projectRoot
    }
  } catch {}

  return ""
}

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = $env:CODEX_PRO_MAX_ROOT
}
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = Get-InstalledProjectRoot
}
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Get-Location).Path
}

if ([string]::IsNullOrWhiteSpace($CodexThreadId)) {
  $CodexThreadId = $env:CODEX_THREAD_ID
}
if ([string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = $CodexThreadId
}
if ([string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = "run-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
}

$resolvedRoot = [System.IO.Path]::GetFullPath($Root)
$safeRunId = Get-SafeRunId $RunId
$runDir = [System.IO.Path]::GetFullPath((Join-Path (Join-Path $resolvedRoot "runs") $safeRunId))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

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

[ordered]@{
  ok = $true
  root = $resolvedRoot
  runId = $safeRunId
  runDir = $runDir
  status = $status
  sessionPath = $sessionPath
} | ConvertTo-Json -Compress
