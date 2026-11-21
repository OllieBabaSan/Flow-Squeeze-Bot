@echo off
cd /d "%~dp0.."
:restart
node "%~dp0run-paper.mjs" --config "%~1" --data-dir "%~2"
timeout /t 30 /nobreak >nul
goto restart
