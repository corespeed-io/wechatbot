@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python virtual environment not found. See CODEX-WECHAT.md.
  pause
  exit /b 1
)
echo Stop any running Codex Bot or Echo Bot before starting this bridge.
".venv\Scripts\python.exe" "examples\codex_bot.py" %*
if errorlevel 1 pause
