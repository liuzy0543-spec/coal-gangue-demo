@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================================
echo   煤矸石智能匹配平台 · 双端口一键检验
echo   端口二：视觉粗筛（图像 - 四氧化物 - 工艺）
echo   端口一：化验单精准匹配（XRF/工业分析/要求 - R01~R12）
echo ============================================================
echo.

set "PY=python"
where python >nul 2>&1
if errorlevel 1 set "PY=C:\Users\DELL\AppData\Local\Programs\Python\Python310\python.exe"
"%PY%" --version >nul 2>&1
if errorlevel 1 (
  echo [ERROR] 找不到 Python，请先安装 Python 3.10+ 或修改本 BAT 中的 PY 路径。
  pause
  exit /b 1
)

"%PY%" -c "import flask,pandas,numpy,joblib,sklearn,xgboost,ultralytics" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python 依赖不完整，请先运行：pip install -r requirements.txt
  pause
  exit /b 1
)

echo [1/3] 检查 7880 端口...
"%PY%" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7880/api/health', timeout=2)" >nul 2>&1
if errorlevel 1 (
  echo       未运行，正在启动后端...
  start "煤矸石平台后端" /min "%PY%" app.py --no-warmup
) else (
  echo       后端已运行，直接复用。
)

echo [2/3] 运行双端口 API 自检...
"%PY%" -X utf8 scripts\verify_ports.py
if errorlevel 1 (
  echo.
  echo [FAIL] 自检失败，请查看上方输出和 outputs\verify_ports.json。
  pause
  exit /b 1
)

echo.
echo [3/3] 打开前端两个端口...
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%EDGE%" (
  start "" "%EDGE%" "http://127.0.0.1:7880/"
  timeout /t 2 /nobreak >nul
  start "" "%EDGE%" "http://127.0.0.1:7880/precision"
) else (
  start "" "http://127.0.0.1:7880/"
  timeout /t 2 /nobreak >nul
  start "" "http://127.0.0.1:7880/precision"
)

echo.
echo ============================================================
echo   [PASS] 两个端口均通过 API 自检。
echo   端口二： http://127.0.0.1:7880/
echo   端口一： http://127.0.0.1:7880/precision
echo   健康检查： http://127.0.0.1:7880/api/health
echo   自检报告： outputs\verify_ports.json
echo ============================================================
pause
