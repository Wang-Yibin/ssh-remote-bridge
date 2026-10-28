@echo off
setlocal DisableDelayedExpansion
echo Checking and restoring configured drives in the current user session.
echo Inaccessible occupied drives require manual release or a Windows restart.
call "%~dp0remount_all.cmd" %*
exit /b %errorlevel%
