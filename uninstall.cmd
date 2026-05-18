@echo off
setlocal EnableExtensions

title Codex Pro Max Uninstall
cd /d "%~dp0"
set "CODEX_PRO_MAX_UNINSTALL_CMD=%~f0"

echo.
echo Codex Pro Max uninstall
echo Project folder: %CD%
echo.

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Windows PowerShell was not found on PATH.
  echo This uninstall file uses Windows PowerShell internally to remove Codex configuration.
  echo.
  goto :fail
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $ErrorActionPreference = 'Stop'; $cmdPath = $env:CODEX_PRO_MAX_UNINSTALL_CMD; $parts = (Get-Content -Raw -LiteralPath $cmdPath) -split '(?m)^:POWERSHELL_PAYLOAD\s*$', 2; if ($parts.Count -lt 2) { throw 'PowerShell payload missing from uninstall.cmd.' }; & ([scriptblock]::Create($parts[1])) @args }" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Uninstall failed with exit code %EXIT_CODE%.
  echo Review the message above, then run uninstall.cmd again.
  echo.
  goto :done
)

echo.
echo Uninstall complete.
echo Restart Codex if it was already open so it unloads the removed skill.
echo.
goto :done

:fail
set "EXIT_CODE=1"

:done
if /I not "%CODEX_PRO_MAX_UNINSTALL_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%

:POWERSHELL_PAYLOAD
param(
  [string]$CodexHome = "",
  [switch]$ForceAgents
)

$ErrorActionPreference = "Stop"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$ProjectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $env:CODEX_PRO_MAX_UNINSTALL_CMD))
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

function Test-PathInside([string]$Child, [string]$Parent) {
  $fullChild = [System.IO.Path]::GetFullPath($Child).TrimEnd("\")
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd("\")
  return $fullChild.StartsWith($fullParent + "\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Remove-CodexConfigEntry([string]$Path, [string]$SkillFile) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }

  $text = [System.IO.File]::ReadAllText($Path, $script:Utf8NoBom)
  $tomlSkillPath = $SkillFile.Replace("\", "\\")
  $candidatePaths = @($tomlSkillPath, $SkillFile) | Select-Object -Unique
  $blockPattern = '(?ms)^[ \t]*\[\[skills\.config\]\][^\r\n]*(?:\r?\n(?![ \t]*\[).*)*'
  $matches = [System.Text.RegularExpressions.Regex]::Matches($text, $blockPattern)
  $rangesToRemove = @()

  foreach ($match in $matches) {
    $containsSkillPath = $false
    foreach ($candidatePath in $candidatePaths) {
      $pathPattern = '(?m)^\s*path\s*=\s*"' + [System.Text.RegularExpressions.Regex]::Escape($candidatePath) + '"\s*(?:#.*)?$'
      if ([System.Text.RegularExpressions.Regex]::IsMatch($match.Value, $pathPattern)) {
        $containsSkillPath = $true
        break
      }
    }

    if ($containsSkillPath) {
      $rangesToRemove += [pscustomobject]@{
        Index = $match.Index
        Length = $match.Length
      }
    }
  }

  if ($rangesToRemove.Count -eq 0) {
    return $false
  }

  $builder = New-Object System.Text.StringBuilder
  $lastIndex = 0
  foreach ($range in $rangesToRemove) {
    if ($range.Index -gt $lastIndex) {
      [void]$builder.Append($text.Substring($lastIndex, $range.Index - $lastIndex))
    }
    $lastIndex = $range.Index + $range.Length
  }
  if ($lastIndex -lt $text.Length) {
    [void]$builder.Append($text.Substring($lastIndex))
  }

  $updated = $builder.ToString()
  $updated = $updated -replace "(\r?\n){3,}", ([Environment]::NewLine + [Environment]::NewLine)
  $updated = $updated.Trim()

  if ([string]::IsNullOrWhiteSpace($updated)) {
    Remove-Item -LiteralPath $Path -Force
  } else {
    Write-AtomicTextNoBom $Path ($updated + [Environment]::NewLine)
  }

  return $true
}

function Remove-CodexInstructionsConfig([string]$Path, [string]$AgentsFile) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }

  $text = [System.IO.File]::ReadAllText($Path, $script:Utf8NoBom)
  $tomlAgentsPath = $AgentsFile.Replace("\", "\\")
  $candidatePaths = @("AGENTS.md", $tomlAgentsPath, $AgentsFile) | Select-Object -Unique
  $updated = $text

  foreach ($candidatePath in $candidatePaths) {
    $linePattern = '(?m)^\s*model_instructions_file\s*=\s*"' + [System.Text.RegularExpressions.Regex]::Escape($candidatePath) + '"\s*(?:#.*)?\r?\n?'
    $next = [System.Text.RegularExpressions.Regex]::Replace($updated, $linePattern, "")
    if ($next -ne $updated) {
      $updated = $next
      break
    }
  }

  if ($updated -eq $text) {
    return $false
  }

  $updated = $updated -replace "(\r?\n){3,}", ([Environment]::NewLine + [Environment]::NewLine)
  $updated = $updated.Trim()

  if ([string]::IsNullOrWhiteSpace($updated)) {
    Remove-Item -LiteralPath $Path -Force
  } else {
    Write-AtomicTextNoBom $Path ($updated + [Environment]::NewLine)
  }

  return $true
}

$skillsRoot = Join-Path $CodexHome "skills"
$skillRoot = Join-Path $skillsRoot "codex-pro-max"
$agentsPath = Join-Path $CodexHome "AGENTS.md"
$projectAgentsPath = Join-Path $ProjectRoot "AGENTS.md"
$skillPath = Join-Path $skillRoot "SKILL.md"
$configPath = Join-Path $CodexHome "config.toml"

Write-Host "Codex home: $CodexHome"

if (Test-Path -LiteralPath $skillRoot) {
  if (-not (Test-PathInside $skillRoot $skillsRoot)) {
    throw "Refusing to remove skill path outside skills root: $skillRoot"
  }
  Remove-Item -LiteralPath $skillRoot -Recurse -Force
  Write-Host "Removed skill: $skillRoot"
} else {
  Write-Host "Skill was not installed: $skillRoot"
}

if (Remove-CodexConfigEntry $configPath $skillPath) {
  Write-Host "Removed Codex config entry: $configPath"
} else {
  Write-Host "Codex config entry was not present: $configPath"
}

if (Remove-CodexInstructionsConfig $configPath $agentsPath) {
  Write-Host "Removed Codex instructions config: $configPath"
} else {
  Write-Host "Codex instructions config was not present: $configPath"
}

if (Test-Path -LiteralPath $agentsPath) {
  $removeAgents = $false
  if ($ForceAgents) {
    $removeAgents = $true
  } elseif (Test-Path -LiteralPath $projectAgentsPath) {
    $installedAgents = [System.IO.File]::ReadAllText($agentsPath, $script:Utf8NoBom)
    $projectAgents = [System.IO.File]::ReadAllText($projectAgentsPath, $script:Utf8NoBom)
    $removeAgents = $installedAgents -eq $projectAgents
  }

  if ($removeAgents) {
    Remove-Item -LiteralPath $agentsPath -Force
    Write-Host "Removed global instructions: $agentsPath"
  } else {
    Write-Host "Preserved global instructions because the file differs from this project's AGENTS.md: $agentsPath"
    Write-Host "Run uninstall.cmd -ForceAgents to remove it anyway."
  }
} else {
  Write-Host "Global instructions were not installed: $agentsPath"
}
