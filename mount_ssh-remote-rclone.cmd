@echo off
rem ============================================================
rem  mount_ssh-remote-rclone.cmd - fallback mount via rclone (thin wrapper)
rem  equivalent to:  ssh-remote rclone [profile]
rem  Use ONLY if setup_ssh-remote.cmd (SSHFS-Win route) fails.
rem  Config is generated automatically from servers.json
rem  (password obscured on the fly) - nothing to edit here.
rem  Keep this window open to stay mounted; close to unmount.
rem ============================================================
setlocal enabledelayedexpansion

set "SRB_HOME=%~dp0"
set "NODE="

if exist "%SRB_HOME%runtime\node.exe" set "NODE=%SRB_HOME%runtime\node.exe"
if not defined NODE (
  where /q node >nul 2>&1 && set "NODE=node"
)
if not defined NODE if exist "D:\Program Files\nodejs\node.exe" set "NODE=D:\Program Files\nodejs\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE (
  echo [ERROR] node.exe not found ^(bundled runtime\ or system install^).
  pause
  exit /b 1
)

"%NODE%" "%SRB_HOME%remote-shell.mjs" rclone %*
exit /b %errorlevel%
