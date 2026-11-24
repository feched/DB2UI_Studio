@echo off
setlocal
cd /d "%~dp0"

echo Starting DB2UI Studio in the browser at http://127.0.0.1:8501
echo Close this window or press Ctrl+C to stop.
".venv\Scripts\python.exe" app.py
pause
