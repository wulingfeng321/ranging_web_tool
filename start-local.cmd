@echo off
cd /d "%~dp0"
backend\.venv\Scripts\python.exe scripts\run_local.py
if errorlevel 1 pause
