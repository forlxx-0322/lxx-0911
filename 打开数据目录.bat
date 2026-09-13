@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "data" mkdir "data"
start "" explorer "%~dp0data"
exit /b 0
