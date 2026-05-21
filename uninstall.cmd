@echo off
setlocal EnableExtensions

title Codex Pro Max Next Uninstall
cd /d "%~dp0"
set "SCRIPT_FILE=%~f0"

echo.
echo Codex Pro Max Next uninstall
echo Project folder: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Node.js is needed to update the Codex config.
  echo.
  goto :fail
)

node -e "const fs=require('fs');const file=process.env.SCRIPT_FILE;const text=fs.readFileSync(file,'utf8');const marker=':NODE_PAYLOAD';const index=text.lastIndexOf(marker);if(index<0)throw new Error('Node payload missing.');eval(text.slice(index+marker.length));"
if errorlevel 1 goto :fail

echo.
echo Uninstall complete.
echo Local data in %USERPROFILE%\.codex-pro-max-next was preserved.
echo.
goto :done

:fail
set "EXIT_CODE=1"
echo.
echo [ERROR] Uninstall failed.
echo.
goto :end

:done
set "EXIT_CODE=0"

:end
if /I not "%CODEX_PRO_MAX_NEXT_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%

:NODE_PAYLOAD
const fs = require('fs');
const path = require('path');
const os = require('os');

const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const skillRoot = path.join(codexHome, 'skills', 'codex-pro-max-next');
const configFile = path.join(codexHome, 'config.toml');

fs.rmSync(skillRoot, { recursive: true, force: true });
console.log(`Removed skill: ${skillRoot}`);

if (fs.existsSync(configFile)) {
  const original = fs.readFileSync(configFile, 'utf8');
  const blocks = original.match(/(?:^|\r?\n)[ \t]*\[\[skills\.config\]\][\s\S]*?(?=\r?\n[ \t]*\[\[|\r?\n[ \t]*\[[^\[]|$)/g) || [];
  let updated = original;
  for (const block of blocks) {
    if (block.includes('codex-pro-max-next')) {
      updated = updated.replace(block, '\n');
    }
  }
  updated = updated.replace(/(\r?\n){3,}/g, '\n\n').trim();
  if (updated) {
    fs.writeFileSync(configFile, `${updated}\n`);
  } else {
    fs.rmSync(configFile, { force: true });
  }
  console.log(`Updated Codex config: ${configFile}`);
}
