@echo off
rem ---------------------------------------------------------------------------
rem Anime Calendar - DEBUG launcher (visible console).
rem
rem Use this when the normal shortcut does nothing or fails silently:
rem this one keeps the console open and prints the real error text.
rem
rem It does NOT use Windows Script Host, so it also works when .vbs files are
rem blocked by security software or group policy.
rem
rem Browser: it launches a browser EXE directly instead of letting Windows resolve
rem the http:// association. On this machine that association is broken (it points
rem at an uninstalled Quark browser), which is why plain "open this URL" popped up
rem "no application is associated with the specified file".
rem
rem The normal (silent) launcher is start-anime-calendar.vbs; it writes a
rem step-by-step log to data\launcher.log.
rem
rem IMPORTANT: keep this file ASCII-only. cmd.exe parses .cmd files using the OEM
rem code page (GBK on a Chinese Windows), so UTF-8 Chinese text here gets decoded
rem as garbage and even reported as bogus "not recognized as a command" errors.
rem ---------------------------------------------------------------------------

setlocal
rem Respect an already-set PORT (useful for testing / running two copies);
rem otherwise default to the same port the VBS launcher uses.
if not defined PORT set PORT=8787
set ROOT=%~dp0..
set SERVER=%ROOT%\src\server\server.ts

echo ============================================================
echo  Anime Calendar - debug launcher
echo ============================================================
echo  Project : %ROOT%
echo  Server  : %SERVER%
echo  Port    : %PORT%
echo.

if not exist "%SERVER%" (
  echo [ERROR] Cannot find %SERVER%
  echo         This .cmd file must stay inside the project's desktop\ folder.
  goto :fail
)

rem --- Is the server already running? -----------------------------------------
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
  echo [INFO] A server is already listening on port %PORT%.
  echo        Opening the browser only; no second server is started.
  call :open_browser "http://127.0.0.1:%PORT%"
  echo.
  echo Done. Close this window whenever you like.
  pause
  exit /b 0
)

rem --- Find node.exe -----------------------------------------------------------
set NODE_EXE=
if exist "%ProgramFiles%\nodejs\node.exe"        set NODE_EXE=%ProgramFiles%\nodejs\node.exe
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe

if not defined NODE_EXE (
  rem Fall back to PATH. "where" also proves whether node is reachable at all.
  for /f "delims=" %%p in ('where node 2^>nul') do if not defined NODE_EXE set NODE_EXE=%%p
)

if not defined NODE_EXE (
  echo [ERROR] node.exe was not found.
  echo.
  echo         Install Node.js 22.18 or newer from https://nodejs.org/
  echo         then run this file again.
  goto :fail
)

echo [INFO] Using node: %NODE_EXE%
pushd "%ROOT%"

if not exist "node_modules" (
  echo [WARN] node_modules is missing - 'pnpm install' has probably not been run.
  echo        The server may still start, but the data sources need those packages.
  echo.
)

echo [INFO] Starting the server in THIS window (press Ctrl+C to stop)...
echo ------------------------------------------------------------
echo.

"%NODE_EXE%" "%SERVER%"
set EXITCODE=%ERRORLEVEL%

echo.
echo ------------------------------------------------------------
echo [INFO] The server exited with code %EXITCODE%.
if not "%EXITCODE%"=="0" (
  echo        The error text is printed above. Common causes:
  echo          - 'pnpm install' has not been run yet
  echo          - port %PORT% is already used by another program
  echo          - a data source is unreachable ^(the server still starts^)
)
popd

:fail
echo.
pause
exit /b 1

rem ---------------------------------------------------------------------------
rem Launch a browser executable with the given URL.
rem
rem Why not "start "" URL": that goes through the shell's http association, which
rem is broken on this machine (it points at an uninstalled browser). Passing the URL
rem as an argument to a browser exe does not need that association at all.
rem
rem NOTE: never use %ProgramFiles(x86)% in an "if exist" or "for" -- the closing
rem parenthesis inside that variable name terminates the surrounding block early
rem and cmd reports something like "\Microsoft\Edge\... was unexpected at this
rem time". %ProgramW6432% is the same folder without a parenthesis, and the
rem single-line "call :try" form below also avoids a parenthesised block.
rem ---------------------------------------------------------------------------
:open_browser
set "TARGET=%~1"
set "BROWSER="

rem 1) The browser the user actually chose as default: read the ProgId, then launch
rem    that exe directly. This respects the user's choice while still not depending
rem    on the (possibly broken) URL association itself. On this machine the default
rem    is QuarkHTM whose exe is gone, so this step yields nothing and we fall through.
call :try_default

rem 2) Well-known install paths (Chrome first: it is the most common working default).
call :try "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
call :try "%ProgramW6432%\Google\Chrome\Application\chrome.exe"
call :try "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
call :try "%ProgramW6432%\Microsoft\Edge\Application\msedge.exe"
call :try "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
call :try "%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
call :try "%ProgramW6432%\Mozilla Firefox\firefox.exe"
call :try "%ProgramFiles%\Mozilla Firefox\firefox.exe"

if not defined BROWSER goto :no_browser
echo [INFO] Opening with: %BROWSER%
start "" "%BROWSER%" "%TARGET%"
exit /b 0

rem --- helpers ---------------------------------------------------------------

:try
rem %1 is an already quoted path; only the first existing one wins
if defined BROWSER exit /b 0
if exist %1 set "BROWSER=%~1"
exit /b 0

:try_default
if defined BROWSER exit /b 0
set "PROGID="
set "DEFAULTCWD="
for /f "tokens=3" %%v in ('reg query "HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" /v ProgId 2^>nul ^| findstr /i ProgId') do set "PROGID=%%v"
if not defined PROGID exit /b 0
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Classes\%PROGID%\shell\open\command" /ve 2^>nul ^| findstr /i REG_SZ') do set "DEFAULTCWD=%%b"
if not defined DEFAULTCWD for /f "tokens=2,*" %%a in ('reg query "HKLM\Software\Classes\%PROGID%\shell\open\command" /ve 2^>nul ^| findstr /i REG_SZ') do set "DEFAULTCWD=%%b"
if not defined DEFAULTCWD exit /b 0
rem strip quotes, then take the first token (the command may carry arguments)
set "DEFAULTEXE=%DEFAULTCWD:"=%"
for /f "tokens=1" %%e in ("%DEFAULTEXE%") do set "DEFAULTEXE=%%e"
if not exist "%DEFAULTEXE%" (
  echo [INFO] Default browser exe is missing on disk: %DEFAULTEXE%
  echo        Falling back to a known browser.
  exit /b 0
)
echo [INFO] Default browser: %DEFAULTEXE%
set "BROWSER=%DEFAULTEXE%"
exit /b 0

:no_browser
echo [WARN] No browser executable found in the usual locations.
echo        Trying the Windows URL association instead...
start "" "%TARGET%"
echo [ERROR] If nothing opened, open this address manually:
echo         %TARGET%
exit /b 0
