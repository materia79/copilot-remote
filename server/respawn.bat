@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "COPILOT_WORKSPACE_ROOT=%CD%"

set "RESPAWN_DELAY_SECONDS=3"

:loop
echo [respawn] Starting server.js at %date% %time%
node "%SCRIPT_DIR%server.js"
set "EXIT_CODE=%errorlevel%"
echo [respawn] server.js exited with code %EXIT_CODE%. Restarting in %RESPAWN_DELAY_SECONDS%s...
timeout /t %RESPAWN_DELAY_SECONDS% /nobreak >nul
goto loop
