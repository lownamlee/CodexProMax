@echo off
setlocal EnableExtensions

title Codex Pro Max
cd /d "%~dp0"

echo.
echo Starting Codex Pro Max
echo Project folder: %CD%
echo.

if not defined CODEX_PRO_MAX_ROOT (
  set "CODEX_PRO_MAX_ROOT=%USERPROFILE%\.codex-pro-max"
)

if not exist "%CODEX_PRO_MAX_ROOT%" (
  mkdir "%CODEX_PRO_MAX_ROOT%" >nul 2>nul
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Install Node.js from https://nodejs.org/ and run start.cmd again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Reinstall Node.js with npm enabled and run start.cmd again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Dependencies are missing. Running npm install...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed.
    echo.
    pause
    exit /b 1
  )
)

echo Data folder: %CODEX_PRO_MAX_ROOT%
echo API: http://127.0.0.1:53127
echo UI:  http://127.0.0.1:53128
echo.
echo Close this window to stop the project.
echo.

call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Codex Pro Max stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
