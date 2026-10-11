@echo off
cd /d "%~dp0.."
:restart
node "%~dp0run-paper.mjs"
timeout /t 30 /nobreak >nul
goto restart
