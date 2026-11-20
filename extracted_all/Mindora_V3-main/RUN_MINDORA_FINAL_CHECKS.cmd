@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================================
echo MINDORA V3 - dependency, formatting, lint, test and build
echo ============================================================

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js 24.16.0 is required. Install it from https://nodejs.org/ and try again.
  exit /b 1
)
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<24 || (v[0]===24 && v[1]<16)) process.exit(1)"
if errorlevel 1 (
  echo ERROR: This repository requires Node.js 24.16.0 or newer. Current version:
  node -v
  exit /b 1
)

if not exist validation mkdir validation

echo [1/8] Regenerating package-lock.json with the safe patched dependency overrides...
call npm install --package-lock-only --ignore-scripts --no-audit
if errorlevel 1 goto failed

echo [2/8] Installing exactly from the regenerated lockfile...
call npm ci
if errorlevel 1 goto failed

echo [3/8] Formatting source files using the repository's pinned Prettier...
call npm run format
if errorlevel 1 goto failed

echo [4/8] Checking formatting...
call npm run format:check
if errorlevel 1 goto failed

echo [5/8] Running workspace lint...
call npm run lint
if errorlevel 1 goto failed

echo [6/8] Running workspace tests...
call npm test
if errorlevel 1 goto failed

echo [7/8] Building all Turbo workspaces...
call npm run build
if errorlevel 1 goto failed

echo [8/8] Auditing production dependencies for high-severity advisories...
call npm audit --audit-level=high --omit=dev --omit=optional
if errorlevel 1 goto failed

echo.
echo SUCCESS: all local commands completed. Review git diff and commit package-lock.json plus formatted files.
echo IMPORTANT: CI must still pass on GitHub; this script does not deploy to Railway.
exit /b 0

:failed
echo.
echo FAILED: a command above failed. Keep this window open and save the full output.
echo Do not merge or deploy until the failing command is investigated.
exit /b 1
