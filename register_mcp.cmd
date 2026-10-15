@echo off
rem ============================================================
rem  register_mcp.cmd - register ssh-remote-bridge into ~/.workbuddy/mcp.json
rem  Merges with existing entries; other MCP servers are kept.
rem  After running: WorkBuddy connector page -> ssh-remote-bridge -> Trust
rem ============================================================
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

"%NODE%" "%SRB_HOME%tools\register_mcp.mjs"
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  pause
  exit /b %RC%
)

echo.
echo [mcp] FINAL STEP: open the connector page in WorkBuddy,
echo [mcp] find ssh-remote-bridge under custom connectors, and click Trust.
if "%cmdcmdline:~0,6%"=="cmd /c" pause
exit /b 0
