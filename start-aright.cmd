@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-aright.ps1"
if errorlevel 1 (
  echo.
  echo Aright could not start. Review the message above, then try again.
  pause
  exit /b 1
)
