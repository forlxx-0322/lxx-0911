@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 客户管理系统 - 服务运行中（关闭本窗口即停止服务）

cd /d "%~dp0"
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "PORT=8899"
set "MAXPORT=8910"

echo.
echo   ==================================================
echo      客户管理系统  ·  本地服务启动器
echo   ==================================================
echo.

rem ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 未检测到 Node.js。
  echo.
  echo   本软件需要 Node.js 22.5 或更高版本（依赖内置的 node:sqlite 模块）。
  echo   请前往 https://nodejs.org 下载安装 LTS 版本后重试。
  echo.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set "NODEV=%%v"
echo   [1/4] Node.js 版本 %NODEV%
node -e "const v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)" >nul 2>nul
if errorlevel 1 (
  echo   [错误] Node.js 版本过低（%NODEV%），需要 22.5 或更高。
  echo   原因：本软件使用 Node 内置的 node:sqlite 模块，低版本不支持。
  echo.
  pause
  exit /b 1
)

rem ---------- 2. 若服务已在运行，直接打开页面 ----------
call :probe
if "!RUNNING!"=="1" (
  echo   [2/4] 服务已在运行
  call :openbrowser
  echo.
  echo   已为你打开浏览器：http://127.0.0.1:!FOUNDPORT!
  timeout /t 3 >nul
  exit /b 0
)
echo   [2/4] 未发现运行中的服务，准备启动

rem ---------- 3. 选择一个可用端口 ----------
call :findport
if "!FREEPORT!"=="" (
  echo   [错误] 端口 %PORT% 至 %MAXPORT% 均被占用，无法启动。
  echo   请关闭占用端口的程序后重试。
  echo.
  pause
  exit /b 1
)
echo   [3/4] 使用端口 !FREEPORT!

rem ---------- 4. 启动服务并等待就绪 ----------
echo   [4/4] 正在启动服务...
echo.
set "CRM_ROOT=%ROOT%"
set "CRM_PORT=!FREEPORT!"
start "" http://127.0.0.1:!FREEPORT!/
echo   --------------------------------------------------
echo    服务日志（关闭本窗口即停止服务）：
echo   --------------------------------------------------
node "%ROOT%\server\server.js"

echo.
echo   服务已停止。
timeout /t 5 >nul
exit /b 0

rem ================= 子过程 =================

rem 依次探测候选端口，确认是否为"本软件"的服务在运行
:probe
set "RUNNING=0"
set "FOUNDPORT="
for /l %%p in (%PORT%,1,%MAXPORT%) do (
  if "!RUNNING!"=="0" (
    call :httpcheck %%p
    if "!ALIVE!"=="1" (
      set "RUNNING=1"
      set "FOUNDPORT=%%p"
    )
  )
)
exit /b 0

rem 请求 http://127.0.0.1:%1/api/health，检查返回内容是否含本软件标识
:httpcheck
set "ALIVE=0"
set "TMPF=%TEMP%\crm_probe_%1.txt"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -Uri ('http://127.0.0.1:%1/api/health') -UseBasicParsing -TimeoutSec 2 | Select-Object -ExpandProperty Content | Out-File -Encoding utf8 -FilePath ('%TEMP%\crm_probe_%1.txt')}catch{}" >nul 2>nul
if exist "%TMPF%" (
  findstr /c:"crm-bjxt" "%TMPF%" >nul 2>nul
  if not errorlevel 1 set "ALIVE=1"
  del "%TMPF%" >nul 2>nul
)
exit /b 0

rem 找到第一个可绑定的端口
:findport
set "FREEPORT="
for /l %%p in (%PORT%,1,%MAXPORT%) do (
  if "!FREEPORT!"=="" (
    call :portfree %%p
    if "!FREE!"=="1" set "FREEPORT=%%p"
  )
)
exit /b 0

rem 测试端口 %1 是否未被占用
:portfree
set "FREE=0"
netstat -ano | findstr /r /c:"LISTENING" | findstr /c:":%1 " >nul 2>nul
if errorlevel 1 set "FREE=1"
exit /b 0

rem 打开浏览器
:openbrowser
start "" "http://127.0.0.1:!FOUNDPORT!/"
exit /b 0
