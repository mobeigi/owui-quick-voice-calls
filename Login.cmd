@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 24+ was not found. Install it and reopen this launcher.
  pause
  exit /b 1
)
if not exist "node_modules\playwright\package.json" (
  echo Dependencies missing. Run npm install from this directory, then launch again.
  pause
  exit /b 1
)
node src\cli.js login
if errorlevel 1 pause
