@echo off
chcp 65001 >nul
setlocal
title 客户管理系统 - 停止服务

cd /d "%~dp0"
set "RUNFILE=%~dp0data\.run.json"

echo.
echo   正在停止 客户管理系统 服务...
echo.

if not exist "%RUNFILE%" (
  echo   未找到运行记录，服务可能已经停止。
  echo.
  pause
  exit /b 0
)

rem 优先通过本机接口优雅停机（会先做数据落盘）
set "RUNPORT=8899"
for /f "usebackq tokens=2 delims=:," %%a in (`findstr /i "\"port\"" "%RUNFILE%"`) do set "RUNPORT=%%a"
set "RUNPORT=%RUNPORT: =%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -Uri ('http://127.0.0.1:%RUNPORT%/api/shutdown') -Method POST -UseBasicParsing -TimeoutSec 3 | Out-Null}catch{}" >nul 2>nul
timeout /t 2 >nul

if not exist "%RUNFILE%" (
  echo   服务已优雅停止，数据已安全保存。
  echo.
  pause
  exit /b 0
)

rem 兜底：按记录的进程号结束进程（含子进程）
for /f "usebackq tokens=2 delims=:," %%a in (`findstr /i "\"pid\"" "%RUNFILE%"`) do set "PID=%%a"
set "PID=%PID: =%"
if not "%PID%"=="" (
  taskkill /PID %PID% /T /F >nul 2>nul
  if not errorlevel 1 echo   已结束进程 %PID%。
)
if exist "%RUNFILE%" del "%RUNFILE%" >nul 2>nul

echo   服务已停止。
echo.
pause
exit /b 0
