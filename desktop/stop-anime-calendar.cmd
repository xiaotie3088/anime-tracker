@echo off
rem Stop the local server for the anime calendar.
rem IMPORTANT: keep this file ASCII-only. cmd.exe parses .cmd files using the OEM
rem code page (GBK on a Chinese Windows), so UTF-8 Chinese text here gets decoded as
rem garbage and even reported as bogus "not recognized as a command" errors.
setlocal

set PORT=8787
set FOUND=0

echo Looking for a process listening on port %PORT% ...

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
  echo   stopping PID %%p
  taskkill /PID %%p /F >nul 2>&1
  set FOUND=1
)

if "%FOUND%"=="0" (
  echo Nothing to stop: port %PORT% is not being listened on.
) else (
  echo.
  echo Stopped.
)

echo.
pause
