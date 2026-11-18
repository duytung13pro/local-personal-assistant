@echo off
rem Builds (fast) and opens Personal Assistant. Close this window's app to quit.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || goto :error
)
call npm run build >nul || goto :error
start "" "%~dp0node_modules\electron\dist\electron.exe" .
exit /b 0
:error
echo Build failed. Run "npm run build" in this folder to see why.
pause
