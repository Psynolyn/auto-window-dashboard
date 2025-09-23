@echo off
setlocal ENABLEEXTENSIONS

REM Stop the MQTT→DB bridge process
REM This script will find and terminate any Node.js processes running bridge.mjs

echo [INFO] Stopping MQTT->DB bridge...

REM Method 1: Try to find node.exe processes with bridge.mjs in command line
for /f "tokens=2" %%i in ('tasklist /FI "IMAGENAME eq node.exe" /FO CSV ^| findstr /C:"bridge.mjs"') do (
    echo [INFO] Found bridge process with PID %%i, stopping...
    taskkill /PID %%i /F >NUL 2>&1
    if errorlevel 1 (
        echo [WARN] Failed to stop process %%i
    ) else (
        echo [INFO] Bridge process %%i stopped successfully
    )
)

REM Method 2: Fallback - stop all node.exe processes (more aggressive)
tasklist /FI "IMAGENAME eq node.exe" /FO CSV | findstr /V "PID" >NUL 2>&1
if not errorlevel 1 (
    echo [INFO] Stopping all Node.js processes as fallback...
    taskkill /F /IM node.exe >NUL 2>&1
    if errorlevel 1 (
        echo [INFO] No Node.js processes found or failed to stop
    ) else (
        echo [INFO] All Node.js processes stopped
    )
) else (
    echo [INFO] No Node.js processes found running
)

echo [INFO] Bridge stop operation completed
pause