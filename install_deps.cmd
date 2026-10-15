@echo off
rem ============================================================
rem  install_deps.cmd - one-click install of the only two
rem  system-level components: WinFsp + SSHFS-Win.
rem
rem  * Needed ONLY for file mapping (F:\xxx folder).
rem    Command forwarding + MCP (AI) work WITHOUT this step -
rem    Node and plink are already bundled in this package.
rem  * Already installed? Auto-skipped, nothing happens.
rem  * One UAC prompt, one time. No reboot needed.
rem ============================================================
setlocal enabledelayedexpansion

set "PF1=%ProgramFiles%"
set "PF2=%ProgramFiles(x86)%"

set "NEED=0"
if not exist "%PF1%\WinFsp" if not exist "%PF2%\WinFsp" set "NEED=1"
if not exist "%PF1%\SSHFS-Win" if not exist "%PF2%\SSHFS-Win" set "NEED=1"

if "%NEED%"=="0" (
  echo [deps] WinFsp and SSHFS-Win are already installed - nothing to do.
  echo [deps] Run setup_ssh-remote.cmd to mount your server.
  if "%cmdcmdline:~0,6%"=="cmd /c" pause
  exit /b 0
)

echo [deps] WinFsp and/or SSHFS-Win not found - one-time install needed.
echo [deps] A UAC prompt will appear once - please click Yes.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0install_deps_inner.cmd' -Verb RunAs -Wait"
if errorlevel 1 (
  echo [deps] install cancelled or failed.
  echo [deps] You can also run the .msi files in the installers folder manually.
  pause
  exit /b 1
)

echo.
echo [deps] done. Now run setup_ssh-remote.cmd to mount your server.
if "%cmdcmdline:~0,6%"=="cmd /c" pause
exit /b 0
