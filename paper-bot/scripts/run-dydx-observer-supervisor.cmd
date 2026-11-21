@echo off
cd /d "%~dp0.."

:restart
node "%~dp0run-dydx-observer.mjs"
timeout /t 30 /nobreak >nul
goto restart
