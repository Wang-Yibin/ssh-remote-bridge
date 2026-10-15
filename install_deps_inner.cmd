@echo off
rem ============================================================
rem  install_deps_inner.cmd - elevated worker for install_deps.cmd
rem  Do NOT run this directly - it is launched elevated by
rem  install_deps.cmd. Installs the bundled MSIs if missing and
rem  enables Developer Mode (so mklink works without admin).
rem ============================================================
setlocal enabledelayedexpansion

set "PF1=%ProgramFiles%"
set "PF2=%ProgramFiles(x86)%"
set "HERE=%~dp0"

echo ============================================================
echo   ssh-remote-bridge dependency installer ^(elevated^)
echo ============================================================
echo.

rem --- WinFsp ---
if not exist "%PF1%\WinFsp" if not exist "%PF2%\WinFsp" (
  echo [deps] installing WinFsp ...
  msiexec /i "%HERE%installers\winfsp-2.1.25156.msi" /qb /norestart
  if errorlevel 1 goto fail
) else (
  echo [deps] WinFsp already installed - skipping.
)

rem --- SSHFS-Win (must come after WinFsp) ---
if not exist "%PF1%\SSHFS-Win" if not exist "%PF2%\SSHFS-Win" (
  echo [deps] installing SSHFS-Win ...
  msiexec /i "%HERE%installers\sshfs-win-3.5.20357-x64.msi" /qb /norestart
  if errorlevel 1 goto fail
) else (
  echo [deps] SSHFS-Win already installed - skipping.
)

rem --- Developer Mode: allows mklink /D without admin rights ---
echo [deps] enabling Developer Mode ^(needed for symlinks^) ...
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD /f /v AllowDevelopmentWithoutDevLicense /d 1 >nul 2>&1

echo.
echo [===========================================================]
echo   All dependencies installed. You can close this window.
echo   No reboot needed. Next: run setup_ssh-remote.cmd to mount.
echo [===========================================================]
pause
exit /b 0

:fail
echo.
echo [deps] install FAILED ^(see messages above^).
echo [deps] You can run the .msi files in the installers folder manually.
pause
exit /b 1
