@echo off
cd /d "%~dp0.."

:restart
node "%~dp0local-radar.mjs"
timeout /t 30 /nobreak >nul
goto restart
