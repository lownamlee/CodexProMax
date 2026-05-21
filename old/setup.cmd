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
  [string]$DataRoot = ""
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
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PRO_MAX_DATA_ROOT)) {
    $DataRoot = $env:CODEX_PRO_MAX_DATA_ROOT
  } else {
    $DataRoot = Join-Path $HOME ".codex-pro-max"
  }
}
$DataRoot = [System.IO.Path]::GetFullPath($DataRoot)

function Write-AtomicTextNoBom([string]$Path, [string]$Value) {
  $parent = Split-Path -Parent $Path
  if ($parent) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $tmp = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllText($tmp, $Value, $script:Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Install-CopiedFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Required setup file missing: $Source"
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Update-CodexConfig([string]$Path, [string]$SkillFile) {
  $tomlSkillPath = $SkillFile.Replace("\", "\\")
  $instructionsEntry = 'model_instructions_file = "AGENTS.md"'
  $entry = "[[skills.config]]`npath = `"$tomlSkillPath`"`nenabled = true`n"
  $text = ""
  if (Test-Path -LiteralPath $Path) {
    $text = [System.IO.File]::ReadAllText($Path, $script:Utf8NoBom)
  }

  $updated = $text

  if ([System.Text.RegularExpressions.Regex]::IsMatch($updated, '(?m)^\s*model_instructions_file\s*=')) {
    $updated = [System.Text.RegularExpressions.Regex]::Replace(
      $updated,
      '(?m)^\s*model_instructions_file\s*=.*$',
      $instructionsEntry,
      1
    )
  } elseif ($updated.Trim()) {
    $updated = $instructionsEntry + "`n" + $updated.TrimStart()
  } else {
    $updated = $instructionsEntry + "`n"
  }

  if (-not $updated.Contains($tomlSkillPath)) {
    if ($updated.Trim()) {
      $updated = $updated.TrimEnd() + "`n`n" + $entry
    } else {
      $updated = $entry
    }
  }

  if ($updated -ne $text) {
    Write-AtomicTextNoBom $Path $updated
  }
}

function Copy-LegacyProtocolData([string]$SourceRoot, [string]$DestinationRoot) {
  $sourceFull = [System.IO.Path]::GetFullPath($SourceRoot)
  $destinationFull = [System.IO.Path]::GetFullPath($DestinationRoot)
  if ($sourceFull.TrimEnd('\') -ieq $destinationFull.TrimEnd('\')) { return }

  function Copy-DirectoryContents([string]$SourceDirectory, [string]$DestinationDirectory) {
    New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
    Get-ChildItem -LiteralPath $SourceDirectory -Force -ErrorAction SilentlyContinue | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $DestinationDirectory $_.Name) -Recurse -Force
    }
  }

  $sourceRuns = Join-Path $sourceFull "runs"
  if (Test-Path -LiteralPath $sourceRuns) {
    $destinationRuns = Join-Path $destinationFull "runs"
    New-Item -ItemType Directory -Path $destinationRuns -Force | Out-Null
    Get-ChildItem -LiteralPath $sourceRuns -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      Copy-DirectoryContents $_.FullName (Join-Path $destinationRuns $_.Name)
    }
  }

  $sourceTeammates = Join-Path $sourceFull "teammates.json"
  $destinationTeammates = Join-Path $destinationFull "teammates.json"
  if ((Test-Path -LiteralPath $sourceTeammates) -and -not (Test-Path -LiteralPath $destinationTeammates)) {
    New-Item -ItemType Directory -Path $destinationFull -Force | Out-Null
    Copy-Item -LiteralPath $sourceTeammates -Destination $destinationTeammates -Force
  }
}

$skillsRoot = Join-Path $CodexHome "skills"
$skillRoot = Join-Path $skillsRoot "codex-pro-max"
$skillScripts = Join-Path $skillRoot "scripts"
$agentsPath = Join-Path $CodexHome "AGENTS.md"
$skillPath = Join-Path $skillRoot "SKILL.md"
$configPath = Join-Path $CodexHome "config.toml"

New-Item -ItemType Directory -Path $CodexHome -Force | Out-Null
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
Copy-LegacyProtocolData $ProjectRoot $DataRoot
if (Test-Path -LiteralPath $skillRoot) {
  Remove-Item -LiteralPath $skillRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $skillScripts -Force | Out-Null

Install-CopiedFile (Join-Path $ProjectRoot "AGENTS.md") $agentsPath
Install-CopiedFile (Join-Path $SetupRoot "skills\codex-pro-max\SKILL.md") $skillPath
Install-CopiedFile (Join-Path $SetupRoot "skills\codex-pro-max\scripts\create_session.ps1") (Join-Path $skillScripts "create_session.ps1")
Install-CopiedFile (Join-Path $SetupRoot "skills\codex-pro-max\scripts\request_review.ps1") (Join-Path $skillScripts "request_review.ps1")
Install-CopiedFile (Join-Path $SetupRoot "skills\codex-pro-max\scripts\wait_for_review.ps1") (Join-Path $skillScripts "wait_for_review.ps1")
Update-CodexConfig $configPath $skillPath

$installation = [ordered]@{
  projectRoot = $ProjectRoot
  dataRoot = $DataRoot
  codexHome = $CodexHome
  skillRoot = $skillRoot
  installedAtIso = (Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json -Depth 4
Write-AtomicTextNoBom (Join-Path $skillRoot "INSTALLATION.json") $installation

Write-Host "Installed Codex Pro Max configuration."
Write-Host "Project root: $ProjectRoot"
Write-Host "Data root: $DataRoot"
Write-Host "Codex home: $CodexHome"
Write-Host "Global instructions: $agentsPath"
Write-Host "Skill: $skillPath"
Write-Host "Config: $configPath"
