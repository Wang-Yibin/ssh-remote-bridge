@echo off
rem ============================================================
rem  ssh-remote.cmd - portable ssh-remote command
rem
rem  Double-click for a remote shell, or add this folder to PATH
rem  and type "ssh-remote" in any terminal.
rem ============================================================
set "SRB_HOME=%~dp0"
set "NODE="

rem 1) bundled runtime (preferred - no install needed)
if exist "%SRB_HOME%runtime\node.exe" set "NODE=%SRB_HOME%runtime\node.exe"

rem 2) node on PATH
if not defined NODE (
  where /q node >nul 2>&1 && set "NODE=node"
)

rem 3) common install locations
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE (
  echo [ERROR] node.exe not found.
  echo         1) Keep runtime\ next to this file ^(the self-contained package does^), or
  echo         2) install Node.js 18+ from https://nodejs.org/ and reopen the terminal.
  exit /b 1
)

"%NODE%" "%SRB_HOME%remote-shell.mjs" %*