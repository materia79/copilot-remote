@echo off
setlocal EnableExtensions

set "SECONDS=%~1"
if not defined SECONDS set "SECONDS=10"

for /f "delims=0123456789" %%A in ("%SECONDS%") do (
    echo Seconds must be a whole number.
    exit /b 1
)

if %SECONDS% LSS 0 (
    echo Seconds must be zero or greater.
    exit /b 1
)

timeout /t %SECONDS% /nobreak >nul
rundll32.exe powrprof.dll,SetSuspendState 0,1,0

endlocal
