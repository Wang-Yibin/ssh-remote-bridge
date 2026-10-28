@echo off
setlocal DisableDelayedExpansion
set "SRB_HOME=%~dp0"
set "NODE="
if exist "%SRB_HOME%runtime\node.exe" set "NODE=%SRB_HOME%runtime\node.exe"
if not defined NODE (
  where /q node >nul 2>&1 && set "NODE=node"
)
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [ERROR] node.exe not found. Install the project runtime or add Node.js to PATH.
  if "%~1"=="" pause
  exit /b 1
)
for /f "tokens=2 delims=:" %%a in ('chcp') do set "SRB_OLDCP=%%a"
chcp 65001 >nul 2>&1
"%NODE%" "%SRB_HOME%tools\cleanup_stale_mounts.mjs" %*
set "RC=%errorlevel%"
rem Double-clicking cleans confirmed offline duplicates and keeps the results visible.
if "%~1"=="" pause
chcp %SRB_OLDCP% >nul 2>&1
exit /b %RC%
