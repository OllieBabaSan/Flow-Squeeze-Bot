@echo off
cd /d "%~dp0.."

:restart
node "%~dp0run-paper.mjs" --config config.binance.json --data-dir data-binance
timeout /t 30 /nobreak >nul
goto restart
