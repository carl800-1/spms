@echo off
chcp 437 >nul 2>&1
setlocal EnableDelayedExpansion
title SPMS - Open PDA Port (Firewall)

rem ============================================================
rem  SPMS PDA port firewall helper
rem  Adds an inbound TCP rule so PDA / handheld terminals on the
rem  same LAN can reach the mobile service (default port 8765).
rem  Self-elevates to Administrator via UAC. Idempotent: removes
rem  any existing rule with the same name before adding it.
rem  Usage:  open-pda-port.bat [port]
rem ============================================================

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8765"
set "RULE=SPMS PDA %PORT%"

echo.
echo ============================================================
echo   SPMS - Open PDA Port ^(Windows Firewall^)
echo ============================================================
echo.
echo   Port   : %PORT% / TCP (inbound)
echo   Rule   : %RULE%
echo.

rem ---- Self-elevate to Administrator ----
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator privileges via UAC...
  echo If prompted, click YES to allow the firewall rule.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%PORT%' -Verb RunAs" >nul 2>&1
  if %errorlevel% neq 0 (
    echo [FAIL] Could not request elevation. Please right-click this file and choose "Run as administrator".
  ) else (
    echo Elevation requested. A new admin window should appear.
  )
  echo.
  pause
  exit /b
)

echo Running as Administrator. Configuring firewall rule...
echo.

rem ---- Remove old rule with same name (idempotent) ----
netsh advfirewall firewall delete rule name="%RULE%" >nul 2>&1

rem ---- Add inbound allow rule for the port ----
netsh advfirewall firewall add rule name="%RULE%" dir=in action=allow protocol=TCP localport=%PORT% profile=any >nul 2>&1
if %errorlevel% equ 0 (
  echo [OK] Firewall rule created: "%RULE%" allows inbound TCP %PORT%.
  echo.
  echo   The PDA can now reach the mobile service on this port.
  echo   Make sure the SPMS app is running and the PDA is on the same Wi-Fi.
) else (
  echo [FAIL] netsh could not add the rule. Check Windows Firewall settings.
)

echo.
echo Press any key to close...
pause >nul
endlocal
