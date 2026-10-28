@echo off
rem ============================================================
rem  umount_ssh-remote.cmd - unmount a server (thin wrapper)
rem  equivalent to:  ssh-remote umount [profile]
rem  Deletes the drive mapping only; any symlink is kept.
rem ============================================================
setlocal enabledelayedexpansion

set "SRB_HOME=%~dp0"
set "NODE="

if exist "%SRB_HOME%runtime\node.exe" set "NODE=%SRB_HOME%runtime\node.exe"
if not defined NODE (
  where /q node >nul 2>&1 && set "NODE=node"
)
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo [ERROR] node.exe not found ^(bundled runtime\ or a system Node install^).
  pause
  exit /b 1
)

"%NODE%" "%SRB_HOME%remote-shell.mjs" umount %*
set "RC=%errorlevel%"

rem rclone mounts must be stopped in their own foreground window.

if not "%RC%"=="0" (
  echo.
  echo [ssh-remote] umount exited with code %RC% - check the messages above.
  pause
  exit /b %RC%
)

echo [ssh-remote] drive mapping removed. Any symlink is kept; run setup_ssh-remote.cmd to restore.
if "%cmdcmdline:~0,6%"=="cmd /c" pause
exit /b 0