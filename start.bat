@echo off
setlocal
cd /d "%~dp0"
title AIPM Study Workbench

echo ==========================================================
echo    AIPM Study Workbench  -  local server
echo ==========================================================
echo.
echo   Folder: %CD%
echo.

rem --- 1. locate a working node.exe -------------------------------------------
rem Why this block exists: on some Windows machines "node" on PATH is a 0-byte
rem Microsoft Store stub that refuses to run ("Access is denied"). If that
rem happens we fall back to a known local install. Edit NODE_FALLBACK if your
rem Node lives somewhere else.
set "NODE_CMD=node"
set "NODE_FALLBACK=E:\deepseek harness\node.exe"

"%NODE_CMD%" --version >nul 2>&1
if errorlevel 1 (
  if exist "%NODE_FALLBACK%" set "NODE_CMD=%NODE_FALLBACK%"
)
"%NODE_CMD%" --version >nul 2>&1
if errorlevel 1 (
  echo   [!] No working node.exe found.
  echo       Install Node.js 18+ from https://nodejs.org  then run this file again.
  echo       ^(or edit NODE_FALLBACK at the top of start.bat^)
  echo.
  pause
  goto :eof
)
for /f "delims=" %%v in ('"%NODE_CMD%" --version') do echo   node: %%v  ^(%NODE_CMD%^)
echo.

echo [1/2] Checking port 3000 ...
set FOUND=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do set FOUND=%%a
if not "%FOUND%"=="" (
  echo     Port 3000 is already in use by PID %FOUND%
  choice /C YN /M "     Kill that process and continue"
  if errorlevel 2 goto :abort
  taskkill /F /PID %FOUND% >nul 2>&1
  ping -n 3 127.0.0.1 >nul
  echo     old process stopped.
) else (
  echo     free.
)

echo.
echo [2/2] Starting server ...
echo.
echo ----------------------------------------------------------
echo   Browser address :  http://127.0.0.1:3000
echo   Keep this window OPEN while you study.
echo   Press Ctrl+C to stop.
echo ----------------------------------------------------------
echo.
rem 默认用「真实模型编码」模式（ENABLE_QUERY_MODEL=1），超纲识别更准；
rem 若机器跑本地模型卡、或想用纯关键词近似，可把下面这行改成 set ENABLE_QUERY_MODEL=0
if "%ENABLE_QUERY_MODEL%"=="" set ENABLE_QUERY_MODEL=1
"%NODE_CMD%" server.js

echo.
echo Server stopped.
pause
goto :eof

:abort
echo.
echo Aborted. Port 3000 is still in use by PID %FOUND%.
pause
