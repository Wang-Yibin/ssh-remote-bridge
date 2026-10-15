@echo off
rem ============================================================
rem  remount_all.cmd - reboot recovery: restore all drive mappings
rem
rem  Why this exists:
rem    "net use ... /persistent:yes" only TRIES to reconnect at logon.
rem    If the network is not up yet, Windows silently gives up and the
rem    drive letter is gone after a reboot. This re-mounts everything.
rem
rem  Safe to run repeatedly - healthy servers are skipped.
rem
rem  Drive letter clashes (two servers sharing one letter) are reported
rem  up front, with a suggested free letter for each one.
rem
rem  If the optional symlink step fails, either:
rem    - Settings - System - Optional features - enable Developer Mode, or
rem    - right-click this file - Run as administrator
rem  ...or simply drop the "mount" field from servers.json and use the
rem  plain drive letter (recommended).
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
  echo [ERROR] node.exe not found.
  echo         The self-contained release ships runtime\node.exe - if it is
  echo         missing, the download is incomplete. Otherwise install
  echo         Node.js LTS from https://nodejs.org and reopen the terminal.
  pause
  exit /b 1
)

title Restore server drive mappings

rem The Windows console defaults to GBK (cp936) while Node writes UTF-8
rem bytes, so CJK output turns into "????".
rem setDefaultEncoding('utf8') does NOT help (that only covers reads).
rem The only real fix is switching the console code page.
rem Remember the original one and restore it at the end, so we leave the
rem user's terminal exactly as we found it.
for /f "tokens=2 delims=:" %%a in ('chcp') do set "SRB_OLDCP=%%a"
chcp 65001 >nul 2>&1

echo.
"%NODE%" "%SRB_HOME%tools\restore_all.mjs"
set "RC=%errorlevel%"

chcp %SRB_OLDCP% >nul 2>&1

echo.
if not "%RC%"=="0" (
  echo [HINT] Some servers did not restore - reasons and fixes are listed above.
) else (
  echo [DONE] Mappings restored. Open the drive in Explorer / VS Code now.
)
echo.
echo TIP: if this is needed again after every reboot, either enable
echo      Developer Mode once ^(Settings - System - Optional features^),
echo      or right-click this file and choose "Run as administrator".
echo      Plain drive letters need neither.
echo.

if "%cmdcmdline:~0,6%"=="cmd /c" pause
exit /b %RC%