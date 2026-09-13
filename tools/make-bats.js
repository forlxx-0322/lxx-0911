/**
 * .bat 启动器生成器
 *
 * 为什么用脚本生成而不用手写：
 *   .bat 必须保存为 **UTF-8 无 BOM** 才能在 chcp 65001 下正确显示中文；
 *   实测发现用 PowerShell 的 here-string 写文件会把中文全角冒号等字符破坏，
 *   导致 cmd 报 "'??：客户管理系统' is not recognized"。
 *   因此统一改由 Node 以 Buffer 精确写入（CRLF + UTF-8 无 BOM）。
 *
 * 用法：node tools/make-bats.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ */
/* 启动.bat                                                            */
/* ------------------------------------------------------------------ */

const START_BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal enabledelayedexpansion',
  'title 客户管理系统 - 服务运行中（关闭本窗口即停止服务）',
  '',
  'cd /d "%~dp0"',
  'set "ROOT=%~dp0"',
  'if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"',
  '',
  'set "PORT=8899"',
  'set "MAXPORT=8910"',
  '',
  'echo.',
  'echo   ==================================================',
  'echo      客户管理系统  ·  本地服务启动器',
  'echo   ==================================================',
  'echo.',
  '',
  'rem ---------- 1. Check Node.js ----------',
  'where node >nul 2>nul',
  'if errorlevel 1 (',
  '  echo   [错误] 未检测到 Node.js。',
  '  echo.',
  '  echo   本软件需要 Node.js 22.5 或更高版本（依赖内置的 node:sqlite 模块）。',
  '  echo   请前往 https://nodejs.org 下载安装 LTS 版本后重试。',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'for /f "tokens=*" %%v in (\'node -v\') do set "NODEV=%%v"',
  'echo   [1/4] Node.js 版本 %NODEV%',
  'node -e "const v=process.versions.node.split(\'.\').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)" >nul 2>nul',
  'if errorlevel 1 (',
  '  echo   [错误] Node.js 版本过低（%NODEV%），需要 22.5 或更高。',
  '  echo   原因：本软件使用 Node 内置的 node:sqlite 模块，低版本不支持。',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'rem ---------- 2. If the service is already running, just open the page ----------',
  'call :probe',
  'if "!RUNNING!"=="1" (',
  '  echo   [2/4] 服务已在运行',
  '  call :openbrowser',
  '  echo.',
  '  echo   已为你打开浏览器：http://127.0.0.1:!FOUNDPORT!',
  '  timeout /t 3 >nul',
  '  exit /b 0',
  ')',
  'echo   [2/4] 未发现运行中的服务，准备启动',
  '',
  'rem ---------- 3. Port ----------',
  'rem The server itself picks a free port: it scans %PORT% and the next',
  'rem 11 ports, then writes the chosen port into data\\.run.json.',
  'rem This launcher deliberately does NOT pre-check ports with',
  'rem "netstat | findstr": that pipeline could hang under an inherited',
  'rem handle and left the service never starting.',
  'echo   [3/4] 端口 %PORT%（若被占用会自动顺延，服务端会记录实际端口）',
  '',
  'rem ---------- 4. Start the service ----------',
  'echo   [4/4] 正在启动服务...',
  'echo.',
  'set "CRM_ROOT=%ROOT%"',
  'set "CRM_PORT=%PORT%"',
  'start "" "http://127.0.0.1:%PORT%/"',
  'echo   --------------------------------------------------',
  'echo    服务日志（关闭本窗口即停止服务）：',
  'echo   --------------------------------------------------',
  'node "%ROOT%\\server\\server.js"',
  '',
  'echo.',
  'echo   服务已停止。',
  'timeout /t 5 >nul',
  'exit /b 0',
  '',
  'rem ================= subroutines =================',
  '',
  'rem Probe candidate ports and confirm the running service is ours.',
  'rem Note: all rem lines are kept ASCII-only on purpose. A rem line that',
  'rem contains multi-byte characters can, under a codepage mismatch, be',
  'rem mangled by the parser and executed as a command, which surfaces as',
  'rem "xxx is not recognized as an internal or external command".',
  ':probe',
  'set "RUNNING=0"',
  'set "FOUNDPORT="',
  'set "RECPORT="',
  '',
  'rem 1) Authoritative source: the port recorded in data\\.run.json.',
  'rem The service enforces its single instance by that file regardless of',
  'rem port, so scanning a different range would wrongly report "not running"',
  'rem and then the new instance would refuse to start.',
  'if exist "%~dp0data\\.run.json" (',
  '  for /f "usebackq tokens=2 delims=:," %%a in (`findstr /i "\\"port\\"" "%~dp0data\\.run.json"`) do set "RECPORT=%%a"',
  '  set "RECPORT=!RECPORT: =!"',
  '  if not "!RECPORT!"=="" (',
  '    call :httpcheck !RECPORT!',
  '    if "!ALIVE!"=="1" (',
  '      set "RUNNING=1"',
  '      set "FOUNDPORT=!RECPORT!"',
  '    )',
  '  )',
  ')',
  '',
  'rem 2) Fallback: scan the configured range in case the record is stale.',
  'for /l %%p in (%PORT%,1,%MAXPORT%) do (',
  '  if "!RUNNING!"=="0" (',
  '    call :httpcheck %%p',
  '    if "!ALIVE!"=="1" (',
  '      set "RUNNING=1"',
  '      set "FOUNDPORT=%%p"',
  '    )',
  '  )',
  ')',
  'exit /b 0',
  '',
  'rem GET http://127.0.0.1:%1/api/health and look for our signature.',
  'rem curl.exe ships with Windows 10 1803+ (present on Windows 11);',
  'rem it replaces the old PowerShell probe, which was slow to start and',
  'rem depended on a temp file plus findstr.',
  ':httpcheck',
  'set "ALIVE=0"',
  'curl -s --max-time 2 "http://127.0.0.1:%1/api/health" >"%TEMP%\\crm_probe_%1.txt" 2>nul',
  'if exist "%TEMP%\\crm_probe_%1.txt" (',
  '  findstr /c:"crm-bjxt" "%TEMP%\\crm_probe_%1.txt" >nul 2>nul',
  '  if not errorlevel 1 set "ALIVE=1"',
  '  del "%TEMP%\\crm_probe_%1.txt" >nul 2>nul',
  ')',
  'exit /b 0',
  '',
  'rem Open the browser.',
  ':openbrowser',
  'start "" "http://127.0.0.1:!FOUNDPORT!/"',
  'exit /b 0',
  ''
].join('\r\n');

/* ------------------------------------------------------------------ */
/* 停止.bat                                                            */
/* ------------------------------------------------------------------ */

const STOP_BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'title 客户管理系统 - 停止服务',
  '',
  'cd /d "%~dp0"',
  'set "RUNFILE=%~dp0data\\.run.json"',
  '',
  'echo.',
  'echo   正在停止 客户管理系统 服务...',
  'echo.',
  '',
  'if not exist "%RUNFILE%" (',
  '  echo   未找到运行记录，服务可能已经停止。',
  '  echo.',
  '  pause',
  '  exit /b 0',
  ')',
  '',
  'rem Prefer the local API for a graceful shutdown (flushes data first).',
  'set "RUNPORT=8899"',
  'for /f "usebackq tokens=2 delims=:," %%a in (`findstr /i "\\"port\\"" "%RUNFILE%"`) do set "RUNPORT=%%a"',
  'set "RUNPORT=%RUNPORT: =%"',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -Uri (\'http://127.0.0.1:%RUNPORT%/api/shutdown\') -Method POST -UseBasicParsing -TimeoutSec 3 | Out-Null}catch{}" >nul 2>nul',
  'timeout /t 2 >nul',
  '',
  'if not exist "%RUNFILE%" (',
  '  echo   服务已优雅停止，数据已安全保存。',
  '  echo.',
  '  pause',
  '  exit /b 0',
  ')',
  '',
  'rem Fallback: kill the recorded process tree.',
  'for /f "usebackq tokens=2 delims=:," %%a in (`findstr /i "\\"pid\\"" "%RUNFILE%"`) do set "PID=%%a"',
  'set "PID=%PID: =%"',
  'if not "%PID%"=="" (',
  '  taskkill /PID %PID% /T /F >nul 2>nul',
  '  if not errorlevel 1 echo   已结束进程 %PID%。',
  ')',
  'if exist "%RUNFILE%" del "%RUNFILE%" >nul 2>nul',
  '',
  'echo   服务已停止。',
  'echo.',
  'pause',
  'exit /b 0',
  ''
].join('\r\n');

/* ------------------------------------------------------------------ */
/* 打开数据目录.bat                                                    */
/* ------------------------------------------------------------------ */

const OPEN_DATA_BAT = [
  '@echo off',
  'chcp 65001 >nul',
  'cd /d "%~dp0"',
  'if not exist "data" mkdir "data"',
  'start "" explorer "%~dp0data"',
  'exit /b 0',
  ''
].join('\r\n');

/* ------------------------------------------------------------------ */

function writeBat(name, content) {
  const file = path.join(ROOT, name);
  // CRLF + UTF-8 无 BOM：cmd 在 chcp 65001 下才能正确解析中文
  fs.writeFileSync(file, Buffer.from(content, 'utf8'));
  const buf = fs.readFileSync(file);
  const hasBom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  console.log(`已生成 ${name}  (${buf.length} 字节, BOM: ${hasBom ? '有(异常!)' : '无 ✓'})`);
  return file;
}

writeBat('启动.bat', START_BAT);
writeBat('停止.bat', STOP_BAT);
writeBat('打开数据目录.bat', OPEN_DATA_BAT);
console.log('\n完成。双击 启动.bat 即可运行。');
