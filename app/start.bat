@echo off
rem GateKeepr - one-click start (Windows)
setlocal
cd /d "%~dp0"

if not exist "..\papers.csv" copy /y "..\examples\papers.example.csv" "..\papers.csv" >nul
if not exist "..\criteria.json" copy /y "..\examples\criteria.example.json" "..\criteria.json" >nul
if not exist "..\pdfs" mkdir "..\pdfs"
if not exist "..\data" mkdir "..\data"

if not exist ".venv\Scripts\python.exe" (
  echo [setup] Creating Python virtual environment...
  python -m venv .venv || goto :error
)
rem Reinstall whenever requirements.txt changes (the marker is a copy of the installed requirements)
fc /b requirements.txt ".venv\.deps-installed" >nul 2>&1
if errorlevel 1 (
  echo [setup] Installing Python dependencies...
  ".venv\Scripts\python.exe" -m pip install -q --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || goto :error
  copy /y requirements.txt ".venv\.deps-installed" >nul
)

rem Use system Node.js if present, otherwise the Node bundled in the venv (nodejs-wheel)
where node >nul 2>nul || set "PATH=%~dp0.venv\Scripts;%PATH%"

if not exist "frontend\dist\index.html" (
  echo [setup] Building the web interface...
  pushd frontend
  call npm install --no-audit --no-fund || goto :error
  call npm run build || goto :error
  popd
)

if "%SCREENING_PORT%"=="" set "SCREENING_PORT=8765"
echo.
echo  GateKeepr is starting on http://127.0.0.1:%SCREENING_PORT%
echo  Press Ctrl+C to stop.
echo.
if not defined SCREENING_NO_BROWSER start "" cmd /c "timeout /t 3 >nul & start http://127.0.0.1:%SCREENING_PORT%"
".venv\Scripts\python.exe" -m backend.server
goto :eof

:error
echo.
echo Setup failed. See the messages above.
pause
exit /b 1
