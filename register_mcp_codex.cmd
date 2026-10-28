@echo off
rem ============================================================
rem  register_mcp_codex.cmd - register ssh-remote-bridge into Codex
rem
rem  Updates the bridge command in config.toml, preserving env/options.
rem
rem  After running: RESTART Codex (config.toml is read at startup).
rem ============================================================
setlocal DisableDelayedExpansion

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
  echo [ERROR] node.exe not found in runtime or PATH.
  exit /b 1
)

"%NODE%" "%SRB_HOME%tools\register_mcp_codex.mjs"
set "RC=%errorlevel%"
if not "%RC%"=="0" (
  echo.
  pause
  exit /b %RC%
)

echo.
echo [mcp] FINAL STEP: restart Codex so it picks up the new MCP server.
if "%cmdcmdline:~0,6%"=="cmd /c" pause
exit /b 0
