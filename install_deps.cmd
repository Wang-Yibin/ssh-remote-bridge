@echo off
rem ============================================================
rem  install_deps.cmd - one-click install of the only two
rem  system-level components: WinFsp + SSHFS-Win.
rem
rem  * Needed ONLY for file mapping (drive letters / F:\xxx folders).
rem    Command forwarding (ssh-remote CLI) and the MCP server work
rem    WITHOUT this step - they need only Node and plink.
rem  * Already installed? Auto-skipped, nothing happens.
rem  * One UAC prompt, one time. No reboot needed.
rem ============================================================
setlocal enabledelayedexpansion

set "PF1=%ProgramFiles%"
set "PF2=%ProgramFiles(x86)%"
set "HERE=%~dp0"

set "NEED=0"
if not exist "%PF1%\WinFsp" if not exist "%PF2%\WinFsp" set "NEED=1"
if not exist "%PF1%\SSHFS-Win" if not exist "%PF2%\SSHFS-Win" set "NEED=1"

if "%NEED%"=="0" (
  echo [deps] WinFsp and SSHFS-Win are already installed - nothing to do.
  echo [deps] Run setup_ssh-remote.cmd to mount your server.
  if "%cmdcmdline:~0,6%"=="cmd /c" pause
  exit /b 0
)

rem --- The installer MSIs are not in git; check BEFORE asking for elevation,
rem     so the user is not prompted for admin rights only to be told "no file".
if not exist "%HERE%installers\*.msi" (
  echo [deps] WinFsp and/or SSHFS-Win are not installed, AND the installer
  echo [deps] files are not bundled in this checkout.
  echo.
  echo        The GitHub repo carries source code only. The .msi files live
  echo        in the project's Releases.
  echo.
  echo        1) Download both from the official pages:
  echo             WinFsp     https://github.com/winfsp/winfsp/releases
  echo             SSHFS-Win    https://github.com/winfsp/sshfs-win/releases
  echo        2) Put them in:  %HERE%installers
  echo        3) Re-run this file.
  echo.
  echo [deps] SKIPPING is fine if you only want the CLI or the MCP server -
  echo        those need only Node.js and plink.
  if "%cmdcmdline:~0,6%"=="cmd /c" pause
  exit /b 2
)

echo [deps] WinFsp and/or SSHFS-Win not found - one-time install needed.
echo [deps] A UAC prompt will appear once - please click Yes.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%HERE%install_deps_inner.cmd' -Verb RunAs -Wait"
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