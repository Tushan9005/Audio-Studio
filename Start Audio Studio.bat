@echo off
rem Starts Audio Studio on this PC only (http://127.0.0.1:8765) and opens it in the browser.
cd /d "%~dp0"
start "" /b cmd /c "timeout /t 3 >nul & start http://127.0.0.1:8765"
".venv\Scripts\python.exe" -m uvicorn app.server:app --host 127.0.0.1 --port 8765
pause
