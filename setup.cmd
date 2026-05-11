@echo off
setlocal EnableExtensions

title Codex Pro Max Setup
cd /d "%~dp0"
set "CODEX_PRO_MAX_SETUP_CMD=%~f0"

echo.
echo Codex Pro Max setup
echo Project folder: %CD%
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell was not found on PATH.
  echo This setup file uses Windows PowerShell internally to copy Codex configuration.
  echo.
  goto :fail
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $ErrorActionPreference = 'Stop'; $cmdPath = $env:CODEX_PRO_MAX_SETUP_CMD; $parts = (Get-Content -Raw -LiteralPath $cmdPath) -split '(?m)^:POWERSHELL_PAYLOAD\s*$', 2; if ($parts.Count -lt 2) { throw 'PowerShell payload missing from setup.cmd.' }; & ([scriptblock]::Create($parts[1])) @args }" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Setup failed with exit code %EXIT_CODE%.
  echo Review the message above, then run setup.cmd again.
  echo.
  goto :done
)

echo.
echo Setup complete.
echo You can now run start-project.cmd to launch Codex Pro Max.
echo.
goto :done

:fail
set "EXIT_CODE=1"

:done
if /I not "%CODEX_PRO_MAX_SETUP_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%

:POWERSHELL_PAYLOAD
param(
  [string]$CodexHome = "",
  [switch]$NoBackup
)

$ErrorActionPreference = "Stop"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $env:CODEX_PRO_MAX_SETUP_CMD))
$SetupRoot = Join-Path $ProjectRoot "setup"
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

function Install-CopiedFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required setup file missing: $Source"
  }
  Backup-File $Destination
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

$skillRoot = Join-Path (Join-Path $CodexHome "skills") "codex-pro-max-hitl"
$skillScripts = Join-Path $skillRoot "scripts"
$agentsPath = Join-Path $CodexHome "AGENTS.md"
$skillPath = Join-Path $skillRoot "SKILL.md"

New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
New-Item -ItemType Directory -Path $skillScripts -Force | Out-Null

Install-CopiedFile (Join-Path $SetupRoot "AGENTS.md") $agentsPath
Install-CopiedFile (Join-Path $SetupRoot "skills\codex-pro-max-hitl\SKILL.md") $skillPath
Install-CopiedFile (Join-Path $SetupRoot "skills\codex-pro-max-hitl\scripts\request_review.ps1") (Join-Path $skillScripts "request_review.ps1")
Install-CopiedFile (Join-Path $SetupRoot "skills\codex-pro-max-hitl\scripts\consume_instruction.ps1") (Join-Path $skillScripts "consume_instruction.ps1")
Install-CopiedFile (Join-Path $ProjectRoot "wait_for_review.ps1") (Join-Path $skillScripts "wait_for_review.ps1")

$installation = [ordered]@{
  projectRoot = $ProjectRoot
  codexHome = $CodexHome
  skillRoot = $skillRoot
  installedAtIso = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 4
Write-AtomicTextNoBom (Join-Path $skillRoot "INSTALLATION.json") $installation

Write-Host "Installed Codex Pro Max HITL configuration."
Write-Host "Project root: $ProjectRoot"
Write-Host "Codex home: $CodexHome"
Write-Host "Global instructions: $agentsPath"
Write-Host "Skill: $skillPath"
