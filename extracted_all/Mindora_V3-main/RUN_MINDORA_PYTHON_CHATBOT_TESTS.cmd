@echo off
setlocal
cd /d "%~dp0services\python-conversational-therapy"
where python >nul 2>nul
if errorlevel 1 (
  echo ERROR: Python 3.10 or newer is required.
  exit /b 1
)
python -m pip install -r requirements-test.txt
if errorlevel 1 exit /b 1
python -m compileall -q app tests
if errorlevel 1 exit /b 1
python -m pytest -q tests
if errorlevel 1 exit /b 1
echo Python chatbot tests passed. This does not verify Railway or Ollama/Qdrant runtime credentials.
