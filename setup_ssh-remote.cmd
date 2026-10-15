@echo off
rem ============================================================
rem  setup_ssh-remote.cmd - mount a server to a local drive
rem  equivalent to:  ssh-remote setup [profile]
rem  real logic lives in remote-shell.mjs + lib/engine.mjs
rem  (edit servers.json to add/change servers, not this file)
rem ============================================================
setlocal enabledelayedexpansion

set "SRB_HOME=%~dp0"
set "NODE="

rem node detection: bundled runtime first, then PATH, then common locations
if exist "%SRB_HOME%runtime\node.exe" set "NODE=%SRB_HOME%runtime\node.exe"
if not defined NODE (
  where /q node >nul 2>&1 && set "NODE=node"
)
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo [ERROR] node.exe not found.
  echo         The self-contained release ships runtime\node.exe - if it is
  echo         missing, the download is incomplete. Otherwise install
  echo         Node.js LTS from https://nodejs.org and reopen the terminal.
  pause
  exit /b 1
)

"%NODE%" "%SRB_HOME%remote-shell.mjs" setup %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo [ssh-remote] setup exited with code %RC% - check the messages above.
  echo [ssh-remote] common causes:
  echo [ssh-remote]   - WinFsp / SSHFS-Win not installed ^(run install_deps.cmd^)
  echo [ssh-remote]   - the drive letter is already used by another server
  echo [ssh-remote]   - you set "mount" in servers.json but symlinks are not
  echo [ssh-remote]     permitted ^(needs Developer Mode or admin^) - delete the
  echo [ssh-remote]     "mount" line to use the plain drive letter instead.
  pause
  exit /b %RC%
)

rem pause only when double-clicked from Explorer (cmd /c "...")
if "%cmdcmdline:~0,6%"=="cmd /c" pause
exit /b 0