@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
if not exist "%NODE%" (
  echo.
  echo   ERROR: node.exe not found at:
  echo   %NODE%
  echo.
  echo   Edit this file and change the NODE line to your node path.
  echo.
  pause
  exit /b 1
)

"%NODE%" pipeline\update.mjs

echo.
pause
