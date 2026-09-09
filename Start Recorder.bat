@echo off
title Smash Match Recorder
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on this PC.
  echo Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
echo Starting Smash Match Recorder... keep this window open while recording.
echo (Close it with Ctrl+C or the X when the event is over.)
echo.
node server.js
echo.
echo The recorder stopped. Press any key to close this window.
pause >nul
