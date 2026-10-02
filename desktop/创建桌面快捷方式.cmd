@echo off
rem Create desktop shortcuts for the anime calendar.
rem IMPORTANT: keep this file ASCII-only (see the note in the stop script).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcuts.ps1"
echo.
pause
