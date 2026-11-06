@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0project-list\Launch.ps1"
if errorlevel 1 pause
