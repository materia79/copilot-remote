@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

for %%I in ("%SCRIPT_DIR%\..\..") do set "REPO_ROOT=%%~fI"

if not exist "%REPO_ROOT%\package.json" (
  echo [copilot-remote] Unable to locate the repository root from "%SCRIPT_DIR%".
  exit /b 1
)

echo(;%PATH%; | findstr /I /C:";%SCRIPT_DIR%;" >nul
if errorlevel 1 (
  call :AddToUserPath "%SCRIPT_DIR%"
  if errorlevel 1 (
    echo [copilot-remote] Warning: could not update your user PATH.
  ) else (
    echo [copilot-remote] Ensured "%SCRIPT_DIR%" is in your user PATH.
    echo [copilot-remote] Open a new cmd.exe window to use copilot-remote by name.
    echo.
  )
)

set "COPILOT_WORKSPACE_ROOT=%REPO_ROOT%"
set "COPILOT_WEB_RELAY_ROOT=%REPO_ROOT%"
set "COPILOT_WEB_RELAY_SERVER_DIR=%REPO_ROOT%\server"

pushd "%REPO_ROOT%" >nul
if errorlevel 1 (
  echo [copilot-remote] Failed to change to repo root: "%REPO_ROOT%".
  exit /b 1
)

echo [copilot-remote] Starting Copilot from "%REPO_ROOT%"...
gh copilot -- --allow-all
set "EXIT_CODE=%errorlevel%"
popd >nul
exit /b %EXIT_CODE%

:AddToUserPath
set "TARGET_DIR=%~1"
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$target = [System.IO.Path]::GetFullPath($env:TARGET_DIR.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)); $current = [Environment]::GetEnvironmentVariable('Path', 'User'); $parts = @(); if ($current) { $parts = $current -split ';' | ForEach-Object { $_.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) } | Where-Object { $_ } }; if ($parts -contains $target) { exit 0 }; $next = ($parts + $target) -join ';'; [Environment]::SetEnvironmentVariable('Path', $next, 'User')" >nul
if errorlevel 1 exit /b 1
exit /b 0
