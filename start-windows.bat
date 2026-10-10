@echo off
rem Russian Study - launcher for Windows (double-click this file).
setlocal EnableExtensions
cd /d "%~dp0"
set "PYTHONUTF8=1"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=5174"

rem 1. Find Python 3.9+ (py launcher first, then python).
set "PY="
py -3 -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>nul && set "PY=py -3"
if not defined PY (
  python -c "import sys; sys.exit(sys.version_info < (3, 9))" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo Python 3.9 or newer was not found.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this file again.
  start "" "https://www.python.org/downloads/"
  pause
  exit /b 1
)

rem 2. Create the virtual environment on first run.
if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python environment...
  %PY% -m venv .venv
  if errorlevel 1 goto :fail
)

rem 3. Install the voice package on first run (needs internet once).
".venv\Scripts\python.exe" -c "import edge_tts" >nul 2>nul
if errorlevel 1 (
  echo Installing speech support ^(internet needed the first time^)...
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
  if errorlevel 1 echo Could not install edge-tts: the browser voice will be used instead.
)

rem 4. Make sure the port is free.
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo Port %PORT% is already in use. Close the other Russian Study window, or run: start-windows.bat 5175
  pause
  exit /b 1
)

rem 5. Open the browser shortly after the server starts, then run the server.
start "" /b cmd /c "ping -n 3 127.0.0.1 >nul & start http://localhost:%PORT%/"
echo Russian Study: http://localhost:%PORT%   ^(close this window or press Ctrl+C to stop^)
".venv\Scripts\python.exe" server.py %PORT%
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo Something went wrong ^(see the message above^).
pause
exit /b 1
