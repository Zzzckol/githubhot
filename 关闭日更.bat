@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "PIDFILE=pipeline\out\auto.pid"
set "PID="
if exist "%PIDFILE%" for /f "usebackq delims=" %%i in ("%PIDFILE%") do set "PID=%%i"
if defined PID (
  taskkill /PID %PID% /F >nul 2>&1
  echo 已结束日更进程 PID %PID%
) else (
  echo 没找到正在运行的日更进程。
)
if exist "%PIDFILE%" del "%PIDFILE%" >nul 2>&1
echo.
echo 注意：这只停「这一次」。下次开机它还会自己起来。
echo 要彻底关掉，把启动文件夹里的 开机自启.vbs 删掉（win+R 输入 shell:startup 就能打开）。
echo.
pause
