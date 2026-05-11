@echo off
setlocal EnableExtensions

title Codex Pro Max
cd /d "%~dp0"

echo.
echo Starting Codex Pro Max
echo Project folder: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Install Node.js from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Reinstall Node.js with npm enabled and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] package.json was not found in this folder.
  echo Make sure this file stays in the project root.
  echo.
  pause
  exit /b 1
)

set "NEED_INSTALL=0"

if not exist "node_modules" (
  echo Dependencies are not installed.
  set "NEED_INSTALL=1"
) else (
  echo Checking installed dependencies...
  call npm ls --depth=0 >nul 2>nul
  if errorlevel 1 (
    echo Dependencies are missing or out of sync.
    set "NEED_INSTALL=1"
  )
)

if "%NEED_INSTALL%"=="1" (
  echo.
  echo Installing dependencies. This may take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed.
    echo Review the npm output above, then run this file again.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo Dependencies are ready.
echo Starting dev server...
echo Close this window to stop the project.
echo.

call npm run dev
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Dev server stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
