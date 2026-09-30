@echo off
rem Dune MapViewer3D Beta.8 - Start fuer Windows 10/11 (macOS/Linux: start.sh) - ohne Go.
rem Weitere Argumente gehen an das Programm, z. B.:  start.bat -addr 0.0.0.0:8795
setlocal
chcp 65001 >nul
cd /d "%~dp0"
rem Das Programm braucht Windows 10 oder neuer
for /f "tokens=2 delims=[]" %%a in ('ver') do set "WINVER=%%a"
for /f "tokens=2 delims=. " %%b in ("%WINVER%") do set "WINMAJOR=%%b"
if defined WINMAJOR if %WINMAJOR% LSS 10 (
  echo Windows %WINVER% ist zu alt - noetig ist Windows 10 oder 11.
  pause
  exit /b 1
)
set "ARCH=amd64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
set "BIN=%~dp0bin\mapviewer-windows-%ARCH%.exe"
if not exist "%BIN%" goto missing
rem Aus dem Internet geladene Dateien sperrt Windows (SmartScreen); Sperre fuer
rem Programm und Skript loesen, damit der Start nicht still scheitert.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0bin' | Unblock-File" >nul 2>&1
echo Dune MapViewer3D startet ... (Fenster offen lassen, schliessen beendet den Viewer)
"%BIN%" -open %*
if errorlevel 1 goto failed
exit /b 0

:missing
echo Programm fehlt: %BIN%
echo Bitte das vollstaendige Paket herunterladen und entpacken (nicht direkt aus dem ZIP starten).
pause
exit /b 1

:failed
echo.
echo Der Viewer wurde mit einem Fehler beendet (siehe Meldung oben).
pause
exit /b 1
