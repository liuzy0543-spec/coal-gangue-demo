@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 研智配 · 三端合一 · 一键运行
color 0B

echo ============================================================
echo   研智配 · 煤矸石资源化利用智能匹配平台
echo   三端合一 + 绿色桌宠 · 一键运行
echo ============================================================
echo.

where python >nul 2>nul
if not errorlevel 1 (
  set "PY=python"
  goto python_ready
)
where py >nul 2>nul
if not errorlevel 1 (
  set "PY=py -3"
  goto python_ready
)
echo [ERROR] 未找到 Python，请先安装 Python 3.10+ 并加入 PATH。
pause
exit /b 1

:python_ready
echo [1/3] 检查后端是否已启动...
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:7880/api/health' -TimeoutSec 2).StatusCode | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto already_running

echo [2/3] 启动后端...
start "研智配后端" /min cmd /k "%PY% app.py"
echo       等待服务就绪（最多 40 秒）...
set /a WAIT=0
:wait_loop
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:7880/api/health' -TimeoutSec 2).StatusCode | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 goto ready
set /a WAIT+=1
if %WAIT% GEQ 40 goto startup_failed
goto wait_loop

:already_running
echo       后端已运行，直接打开页面。
goto ready

:startup_failed
echo [ERROR] 后端启动超时，请查看“研智配后端”窗口。
pause
exit /b 1

:ready
echo [3/3] 打开平台首页...
set "B360=%LOCALAPPDATA%\360Chrome\Chrome\Application\360chrome.exe"
if exist "%B360%" set "BROWSER=%B360%"
if not defined BROWSER (
  set "B360=%ProgramFiles(x86)%\360\360Chrome\Chrome\Application\360chrome.exe"
  if exist "%B360%" set "BROWSER=%B360%"
)
if not defined BROWSER (
  set "B360=%ProgramFiles%\360\360Chrome\Chrome\Application\360chrome.exe"
  if exist "%B360%" set "BROWSER=%B360%"
)
if not defined BROWSER (
  set "B360=%LOCALAPPDATA%\360se6\Application\360se6.exe"
  if exist "%B360%" set "BROWSER=%B360%"
)
if not defined BROWSER (
  set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  if exist "%EDGE%" set "BROWSER=%EDGE%"
)
if not defined BROWSER (
  set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  if exist "%EDGE%" set "BROWSER=%EDGE%"
)
if defined BROWSER (
  start "" "%BROWSER%" "http://127.0.0.1:7880/"
) else (
  start "" "http://127.0.0.1:7880/"
)

echo.
echo ============================================================
echo   首页       http://127.0.0.1:7880/
echo   智能入口   http://127.0.0.1:7880/auto
echo   端口一     http://127.0.0.1:7880/precision
echo   端口二     http://127.0.0.1:7880/vision
echo   端口三     http://127.0.0.1:7880/report
echo   健康检查   http://127.0.0.1:7880/api/health
echo ============================================================
echo   关闭本窗口不会停止后端；后端在“研智配后端”窗口运行。
echo.
pause
