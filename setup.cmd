@echo off
setlocal EnableExtensions

title Codex Pro Max Next Setup
cd /d "%~dp0"
set "SCRIPT_FILE=%~f0"

echo.
echo Codex Pro Max Next setup
echo Project folder: %CD%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found on PATH.
  echo Install Node.js from https://nodejs.org/ and run setup.cmd again.
  echo.
  goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo Reinstall Node.js with npm enabled and run setup.cmd again.
  echo.
  goto :fail
)

if not exist "package.json" (
  echo [ERROR] package.json was not found in this folder.
  echo.
  goto :fail
)

echo Installing npm dependencies...
call npm install
if errorlevel 1 goto :fail

echo.
echo Installing Codex skill...
node -e "const fs=require('fs');const file=process.env.SCRIPT_FILE;const text=fs.readFileSync(file,'utf8');const marker=':NODE_PAYLOAD';const index=text.lastIndexOf(marker);if(index<0)throw new Error('Node payload missing.');eval(text.slice(index+marker.length));"
if errorlevel 1 goto :fail

echo.
echo Setup complete.
echo Run start.cmd to launch Codex Pro Max Next.
echo.
goto :done

:fail
set "EXIT_CODE=1"
echo.
echo [ERROR] Setup failed.
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

const projectRoot = process.cwd();
const codexHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const skillSource = path.join(projectRoot, 'setup', 'skills', 'codex-pro-max-next');
const skillRoot = path.join(codexHome, 'skills', 'codex-pro-max-next');
const skillFile = path.join(skillRoot, 'SKILL.md');
const configFile = path.join(codexHome, 'config.toml');

if (!fs.existsSync(skillSource)) {
  throw new Error(`Skill source folder missing: ${skillSource}`);
}

fs.mkdirSync(path.dirname(skillRoot), { recursive: true });
fs.rmSync(skillRoot, { recursive: true, force: true });
fs.cpSync(skillSource, skillRoot, { recursive: true });

fs.writeFileSync(path.join(skillRoot, 'INSTALLATION.json'), JSON.stringify({
  projectRoot,
  codexHome,
  skillRoot,
  installedAtIso: new Date().toISOString(),
}, null, 2));

fs.mkdirSync(codexHome, { recursive: true });
const skillPathForToml = skillFile.replace(/\\/g, '/');
let config = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
if (!config.includes(skillPathForToml)) {
  const entry = `[[skills.config]]\npath = "${skillPathForToml}"\nenabled = true\n`;
  config = config.trimEnd();
  fs.writeFileSync(configFile, config ? `${config}\n\n${entry}` : entry);
}

console.log(`Skill installed: ${skillFile}`);
console.log(`Codex config: ${configFile}`);
