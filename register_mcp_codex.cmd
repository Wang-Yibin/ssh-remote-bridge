@echo off
rem ============================================================
rem  register_mcp_codex.cmd - register ssh-remote-bridge into Codex
rem
rem  Prefers the official `codex mcp add`; falls back to editing
rem  ~/.codex/config.toml directly if the CLI is not on PATH.
rem
rem  After running: RESTART Codex (config.toml is read at startup).
rem ============================================================
setlocal enabledelayedexpansion

set "SRB_HOME=%~dp0"
set "NODE=%SRB_HOME%runtime\node.exe"

if not exist "%NODE%" (
  if exist "%SRB_HOME%..\..\runtime\node.exe" (
    set "NODE=%SRB_HOME%..\..\runtime\node.exe"
  ) else (
    echo [ERROR] runtime\node.exe not found.
    echo [ERROR] the package looks incomplete.
    pause
    exit /b 1
  )
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