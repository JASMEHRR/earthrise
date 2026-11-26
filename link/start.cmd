@echo off
title Earthrise Link
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org and run this again. & pause & exit /b 1)
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:5173/link"
node earthrise-link.js
pause
