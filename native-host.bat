@echo off
REM Native messaging host launcher. Edits: none needed - resolves host.py
REM relative to this script's folder and uses `python` from PATH.
set PYTHONIOENCODING=utf-8
set "SCRIPT_DIR=%~dp0"
python -u "%SCRIPT_DIR%host.py"
exit /b %ERRORLEVEL%
