@echo off
rem ============================================================
rem  check_deps.cmd - check the two drivers needed for file mapping
rem
rem  This repo ships SOURCE ONLY - no .msi / .exe binaries.
rem  WinFsp and SSHFS-Win are downloaded from their official sites:
rem
rem      WinFsphttps://github.com/winfsp/winfsp/releases
rem      SSHFS-Win    https://github.com/winfsp/sshfs-win/releases
rem
rem  Both install silently, so you can also just run them:
rem      msiexec /i winfsp-*.msi /qb /norestart
rem      msiexec /i sshfs-win-*.msi /qb /norestart
rem
rem  WHAT IS ACTUALLY REQUIRED:
rem    Node.js >= 18 ......... required, for the CLI and the MCP server
rem    plink.exe ............. required, for SSH
rem    WinFsp + SSHFS-Win ... only for file mapping (drive letters)
rem
rem  So if you only want the command line or the MCP server, you can
rem  ignore this script entirely.
rem ============================================================
setlocal enabledelayedexpansion

set "PF1=%ProgramFiles%"
set "PF2=%ProgramFiles(x86)%"

set "MISSING="

if not exist "%PF1%\WinFsp" if not exist "%PF2%\WinFsp" set "MISSING=!MISSING! WinFsp"
if not exist "%PF1%\SSHFS-Win" if not exist "%PF2%\SSHFS-Win" set "MISSING=!MISSING! SSHFS-Win"

echo ============================================================
echo   ssh-remote-bridge - dependency check
echo ============================================================
echo.

rem --- Node.js ---
where node >nul 2>&1
if errorlevel 1 (
  echo [deps] Node.js   NOT FOUND   <- required ^(CLI + MCP^)
  echo [deps]   download: https://nodejs.org  ^(LTS^)
) else (
  echo [deps] Node.js   OK
)

rem --- plink ---
where plink >nul 2>&1
if errorlevel 1 (
  echo [deps] plink     NOT FOUND   <- required ^(SSH^)
  echo [deps]   download: https://www.chiark.greenend.org.uk/~sgtatham/putty/
) else (
  echo [deps] plink     OK
)

rem --- file-mapping drivers ---
if defined MISSING (
  echo [deps] NOT INSTALLED:!MISSING!   <- only needed for file mapping
  echo.
  echo        Download them from the official pages, then install silently:
  echo            WinFsp     https://github.com/winfsp/winfsp/releases
  echo            SSHFS-Win    https://github.com/winfsp/sshfs-win/releases
  echo.
  echo            msiexec /i winfsp-*.msi /qb /norestart
  echo            msiexec /i sshfs-win-*.msi /qb /norestart
  echo.
  echo        Skip this if you only want the CLI or the MCP server -
  echo        command forwarding works without these.
) else (
  echo [deps] WinFsp + SSHFS-Win  OK  ^(file mapping ready^)
)

echo.
echo [deps] This repo intentionally ships no binaries. Keeping ~170MB of
echo        installers out of git means everyone gets the current
echo        version from upstream, and clone stays under 1MB.
echo.
if "%cmdcmdline:~0,6%"=="cmd /c" pause
exit /b 0