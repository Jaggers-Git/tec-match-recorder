@echo off
title TEC Match Recorder
cd /d "%~dp0"
set "NODE=%~dp0node.exe"
if not exist "%NODE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js was not found on this PC and this folder has no node.exe.
    echo Either use the portable zip from the releases page, or install the LTS version from https://nodejs.org
    echo and run this file again.
    echo.
    pause
    exit /b 1
  )
  set "NODE=node"
)
echo Starting TEC Match Recorder... keep this window open while recording.
echo (Close it with Ctrl+C or the X when the event is over.)
echo.
"%NODE%" server.js
echo.
echo The recorder stopped. Press any key to close this window.
pause >nul
