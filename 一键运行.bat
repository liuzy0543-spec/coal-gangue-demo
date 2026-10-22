@echo off
chcp 65001 >nul
setlocal
title 煤矸石智能识别 · 成分预测 · 工艺决策
cd /d "%~dp0"

set "PORT=7880"
set "URL=http://127.0.0.1:%PORT%/"
set "PY=python"
where python >nul 2>&1
if errorlevel 1 set "PY=%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

curl -s -o NUL --max-time 2 "%URL%api/meta" >nul 2>&1
if not errorlevel 1 (
  echo [INFO] 服务已在运行，直接用 Edge 打开页面...
  if exist "%EDGE%" (start "" "%EDGE%" "%URL%") else (start "" "%URL%")
  exit /b 0
)

echo ============================================================
echo   煤矸石 Demo · 一键启动
echo   目录：%cd%
echo   地址：%URL%
echo   提示：保持本窗口开启；关闭窗口即停止服务
echo ============================================================
echo [1/2] 正在加载模型并启动服务...
echo [2/2] 就绪后会自动打开浏览器；若没弹出请手动访问上面的地址。
echo.

"%PY%" -X utf8 app.py --port %PORT% --open

echo.
echo 服务已退出。
pause
