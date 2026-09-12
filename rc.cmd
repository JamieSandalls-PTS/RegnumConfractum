@echo off
rem ---------------------------------------------------------------------------
rem Regnum Confractum launcher. Double-click this.
rem
rem It exists because the project's go/no-go gate is somebody PLAYING a round
rem (D-521), and what has always stood in the way is not the game -- it is
rem remembering four commands, three environment variables and which port
rem everything is on.
rem
rem This is a thin wrapper on `npm run play`, which is a thin wrapper on the
rem scripts that already exist. Nothing here can drift away from what CI runs.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node is not on PATH. Install Node 22 or newer and try again.
  echo   https://nodejs.org
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing dependencies. This takes a minute.
  call npm install
  if errorlevel 1 (
    echo npm install failed. Fix the error above and run this again.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  echo No .env found -- copying .env.example.
  copy /y ".env.example" ".env" >nul
)

call npx tsx tools/src/control.ts
rem A crash should leave the window up long enough to read why.
if errorlevel 1 pause
endlocal
