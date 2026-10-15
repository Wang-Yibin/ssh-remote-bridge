@echo off
rem ============================================================
rem  install_deps_inner.cmd - elevated worker for install_deps.cmd
rem  Do NOT run this directly - it is launched elevated by
rem  install_deps.cmd. Installs WinFsp + SSHFS-Win if missing and
rem  enables Developer Mode (so mklink works without admin).
rem ============================================================
setlocal enabledelayedexpansion

set "PF1=%ProgramFiles%"
set "PF2=%ProgramFiles(x86)%"
set "HERE=%~dp0"
set "WINFSP=%HERE%installers\winfsp-2.1.25156.msi"
set "SSHFS=%HERE%installers\sshfs-win-3.5.20357-x64.msi"

echo ============================================================
echo   ssh-remote-bridge dependency installer ^(elevated^)
echo ============================================================
echo.

rem --- missing MSI? Point to the download page instead of failing blind ---
if not exist "%WINFSP%" goto nomsi
if not exist "%SSHFS%" goto nomsi

rem --- WinFsp ---
if not exist "%PF1%\WinFsp" if not exist "%PF2%\WinFsp" (
  echo [deps] installing WinFsp ...
  msiexec /i "%WINFSP%" /qb /norestart
  if errorlevel 1 goto fail
) else (
  echo [deps] WinFsp already installed - skipping.
)

rem --- SSHFS-Win (must come after WinFsp) ---
if not exist "%PF1%\SSHFS-Win" if not exist "%PF2%\SSHFS-Win" (
  echo [deps] installing SSHFS-Win ...
  msiexec /i "%SSHFS%" /qb /norestart
  if errorlevel 1 goto fail
) else (
  echo [deps] SSHFS-Win already installed - skipping.
)

rem --- Developer Mode: allows mklink /D without admin rights ---
echo [deps] enabling Developer Mode ^(only needed for the symlink mode^) ...
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock" /t REG_DWORD /f /v AllowDevelopmentWithoutDevLicense /d 1 >nul 2>&1

echo.
echo [===========================================================]
echo   All dependencies installed. You can close this window.
echo   No reboot needed. Next: run setup_ssh-remote.cmd to mount.
echo [===========================================================]
pause
exit /b 0

rem ============================================================
:nomsi
echo.
echo [deps] The installers are NOT bundled in this checkout.
echo.
echo        The GitHub repo carries source code only - the installer
echo        files live in the project's Releases, not in git.
echo.
echo        Download WinFsp + SSHFS-Win from these official pages,
echo        drop both .msi files into:
echo            %HERE%installers
echo        then re-run install_deps.cmd.
echo.
echo        WinFsp    https://github.com/winfsp/winfsp/releases
echo        SSHFS-Win https://github.com/winfsp/sshfs-win/releases
echo.
echo        Both are MIT / BSD-licensed and install silently:
echo            msiexec /i winfsp-*.msi /qb /norestart
echo            msiexec /i sshfs-win-*.msi /qb /norestart
echo.
echo [deps] SKIPPING: you only need these for file mapping.
echo        The CLI (ssh-remote) and the MCP server work without them.
pause
exit /b 2

:fail
echo.
echo [deps] install FAILED ^(see messages above^).
echo [deps] If the .msi files are missing, see the download links above.
pause
exit /b 1