@echo off
setlocal ENABLEEXTENSIONS

REM Run the MQTT→DB bridge from the ingest folder
REM This script will:
REM  - cd into the ingest directory relative to this file
REM  - install dependencies if node_modules is missing
REM  - start the bridge using `npm start`

pushd "%~dp0" >NUL 2>&1
if not exist "ingest" (
  echo [ERROR] Ingest folder not found next to this script.
  echo Expected: %~dp0ingest
  popd >NUL 2>&1
  exit /b 1
)

pushd "ingest" >NUL 2>&1

if not exist "package.json" (
  echo [ERROR] package.json not found in ingest folder.
  popd >NUL 2>&1
  popd >NUL 2>&1
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Installing dependencies... (first run)
  npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    popd >NUL 2>&1
    popd >NUL 2>&1
    exit /b 1
  )
)

echo [INFO] Starting MQTT->DB bridge with npm...
where npm >NUL 2>&1
if errorlevel 1 (
  echo [WARN] npm not found in PATH. Falling back to: node bridge.mjs
  where node >NUL 2>&1
  if errorlevel 1 (
    echo [ERROR] Node.js (node) not found in PATH. Install Node.js or launch this script from a shell where node is available.
    set EXITCODE=1
  ) else (
  node bridge.mjs
  set EXITCODE=%ERRORLEVEL%
  )
) else (
  npm start
  set EXITCODE=%ERRORLEVEL%
  if not %EXITCODE%==0 (
    echo [WARN] npm start exited with code %EXITCODE%. Trying direct node...
    where node >NUL 2>&1
    if errorlevel 1 (
      echo [ERROR] Node.js (node) not found in PATH. Install Node.js or launch this script from a shell where node is available.
      set EXITCODE=1
    ) else (
    node bridge.mjs
    set EXITCODE=%ERRORLEVEL%
    )
  )
)

if %EXITCODE% NEQ 0 (
  echo [HINT] If it exits immediately, ensure ingest/.env has SUPABASE_URL and SUPABASE_SERVICE_ROLE.
)

popd >NUL 2>&1
popd >NUL 2>&1

exit /b %EXITCODE%
