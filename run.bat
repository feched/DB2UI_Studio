@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creating Python virtual environment .venv ...
    python -m venv .venv
    if errorlevel 1 goto :error
)

".venv\Scripts\python.exe" -c "import flask, psycopg2, dotenv, webview" >nul 2>&1
if errorlevel 1 (
    echo [2/3] Installing dependencies. This is needed only once...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto :error
) else (
    echo [2/3] Dependencies are already installed.
)

echo [3/3] Starting DB2UI Studio desktop window...
".venv\Scripts\python.exe" desktop.py
if errorlevel 1 goto :error
goto :eof

:error
echo.
echo Failed to start DB2UI Studio. Check that Python 3.10+ is installed
echo and requirements.txt can be installed.
pause
exit /b 1
