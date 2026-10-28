@echo off
rem ============================================================
rem  open-ssh-remote-terminal.cmd [mount-path] [profile]
rem
rem  Opens a NEW PowerShell window that is ALREADY inside the
rem  remote shell, positioned at the given local mount path
rem  (the cwd is auto-mapped to the matching remote path).
rem
rem  Examples:
rem    open-ssh-remote-terminal.cmd
rem    open-ssh-remote-terminal.cmd M:\
rem    open-ssh-remote-terminal.cmd M:\ some-subdir myserver
rem
rem  Replace the mount path / profile name with your own values
rem  from servers.json. Do NOT hardcode real hosts or credentials.
rem
rem  Tip: pin this file to the taskbar, or put a shortcut on the
rem  desktop, for one-click remote terminals.
rem ============================================================
setlocal DisableDelayedExpansion

set "SRB_HOME=%~dp0"
set "TARGET=%~1"
set "PROFILE="
if not "%~2"=="" set "PROFILE=%~2"

rem --- locate node ---
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

rem --- no path given: ask servers.json for the default server's mount ---
if "%TARGET%"=="" (
  for /f "delims=" %%m in ('"%NODE%" "%SRB_HOME%tools\default_mount.mjs"') do set "TARGET=%%m"
)

if not exist "%TARGET%" (
  echo [ssh-remote] "%TARGET%" does not exist.
  echo [ssh-remote] Run setup_ssh-remote.cmd first, or pass an existing path.
  pause
  exit /b 1
)

start "" powershell.exe -NoExit -Command "Set-Location -LiteralPath $env:TARGET; $script=Join-Path $env:SRB_HOME 'remote-shell.mjs'; if($env:PROFILE){ & $env:NODE $script $env:PROFILE }else{ & $env:NODE $script }"
exit /b 0
