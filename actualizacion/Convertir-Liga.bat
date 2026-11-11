@echo off
REM ============================================================
REM  Convertir paquetes BallScore a .pox.json  (arrastra y suelta)
REM ============================================================
REM  Uso 1: arrastra 1..N archivos .zip/.rar (o carpetas) encima
REM         de este bat  ->  genera salida.pox.json al lado del
REM         primer archivo.
REM  Uso 2: cmd>  Convertir-Liga.bat archivo1.zip archivo2.zip
REM
REM  Si traes bases separadas (ej. "Regular season.zip",
REM  "SEMIFINAL25.zip", "FINAL25.zip") pasa TODAS juntas — el
REM  nombre de cada zip etiqueta la fase (regular/semifinal/final).
REM ============================================================
cd /d "%~dp0server"
if "%~1"=="" (
  echo Arrastra los .zip/.rar de la liga encima de este .bat
  pause
  exit /b 1
)
set "OUT=%~dpn1.pox.json"
npx tsx scripts\zip2pox.ts %* -o "%OUT%"
echo.
if exist "%OUT%" (echo LISTO: %OUT%) else (echo FALLÓ - revisa los mensajes de arriba)
pause
