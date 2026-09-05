@echo off
rem Launch Betterfy. Double-click this, or pin it to the taskbar.
cd /d "%~dp0"
title Betterfy
node server.mjs
if errorlevel 1 (
  echo.
  echo Betterfy stopped with an error. Common causes:
  echo   - not authorised yet      : npm run auth
  echo   - no library snapshot yet : npm run snapshot
  echo   - port 8787 already in use
  echo.
  pause
)
