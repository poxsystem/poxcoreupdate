@echo off
setlocal
rem ============================================================
rem  ACTUALIZAR.bat — aplica la actualizacion de PoxScore
rem  Puedes ejecutarlo desde donde este la carpeta — te pregunta
rem  donde esta instalado PoxScore.
rem ============================================================
cd /d "%~dp0"

echo.
echo  ======================================================
echo   ACTUALIZACION DE POXSCORE
echo  ======================================================
echo.
echo  Este instalador detiene PoxScore solo (launcher + servidor).
echo  Si prefieres hacerlo a mano: icono en la bandeja -^> Salir.
echo.
echo  Escribe la ruta donde esta INSTALADO PoxScore
echo  (la carpeta que contiene server\, web\, launcher\...)
echo  Ejemplos:  C:\PoxScore    D:\PoxScore    C:\app\poxscore
echo.
set /p DEST="Ruta de instalacion (Enter = carpeta de arriba): "

if "%DEST%"=="" set "DEST=.."

if not exist "%DEST%\server" (
  echo.
  echo  ERROR: no encuentro la carpeta server en "%DEST%"
  echo  Verifica la ruta — debe ser donde esta instalado PoxScore.
  echo.
  pause
  exit /b 1
)

echo.
echo  Deteniendo PoxScore...
rem --- PRIMERO el launcher: tiene auto-reinicio y resucita el server
rem --- en 3 segundos si solo matas el node (PoxScore-Control.cs Exited /
rem --- launcher.mjs server.on('exit')). Sin esto el server "no muere".
taskkill /F /IM PoxScore.exe >nul 2>&1
if errorlevel 1 (echo  [..] panel PoxScore.exe no estaba corriendo) else (echo  [OK] panel PoxScore.exe detenido)
set "LPID="
if exist "%DEST%\launcher\launcher.pid" set /p LPID=<"%DEST%\launcher\launcher.pid"
if defined LPID (
  taskkill /F /PID %LPID% >nul 2>&1
  if errorlevel 1 (echo  [..] launcher.mjs no estaba corriendo) else (echo  [OK] launcher.mjs detenido ^(PID %LPID%^))
)
rem respaldo: cualquier node corriendo launcher.mjs aunque falte el pidfile
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'launcher\.mjs' }; if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Write-Output '  [OK] launcher.mjs detenido' }" 2>nul
rem --- DESPUES el server en :4000 (bloquea el DLL de Prisma -> EPERM) ---
set "SVPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":4000 " ^| findstr LISTENING') do set "SVPID=%%p"
if defined SVPID (
  taskkill /F /PID %SVPID% >nul 2>&1 && echo  [OK] server detenido ^(PID %SVPID%^)
) else (
  echo  [..] no habia server escuchando en :4000
)
timeout /t 3 /nobreak >nul
rem verifica que el puerto quedo libre — si un launcher sobrevivio lo reocupa
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":4000 " ^| findstr LISTENING') do (
  echo  [!!] el puerto 4000 SIGUE ocupado ^(PID %%p^) — algun launcher lo revivio.
  echo       Cierra el icono de PoxScore en la bandeja ^(Salir^) y repite este bat.
)

echo.
echo  Actualizando PoxScore en "%DEST%" ...
echo.

xcopy /E /I /Y /Q "web\dist" "%DEST%\web\dist" >nul && echo  [OK] web\dist
rem limpia bundles viejos acumulados — index.html solo usa el actual
for %%f in ("%DEST%\web\dist\assets\index-*.*") do (
  findstr /C:"%%~nxf" "%DEST%\web\dist\index.html" >nul 2>&1 || del /q "%%f" >nul 2>&1
)
xcopy /E /I /Y /Q "server\dist" "%DEST%\server\dist" >nul && echo  [OK] server\dist
xcopy /E /I /Y /Q "server\src" "%DEST%\server\src" >nul && echo  [OK] server\src
xcopy /E /I /Y /Q "server\scripts" "%DEST%\server\scripts" >nul && echo  [OK] server\scripts
copy /Y "server\tsconfig.json" "%DEST%\server\tsconfig.json" >nul && echo  [OK] server\tsconfig.json
copy /Y "server\selftest.cjs" "%DEST%\server\selftest.cjs" >nul && echo  [OK] server\selftest.cjs
xcopy /E /I /Y /Q "server\prisma" "%DEST%\server\prisma" >nul && echo  [OK] server\prisma
xcopy /E /I /Y /Q "shared-src" "%DEST%\shared\src" >nul && echo  [OK] shared\src (motor)
xcopy /E /I /Y /Q "docs" "%DEST%\docs" >nul && echo  [OK] docs
copy /Y "AGENTS.md" "%DEST%\AGENTS.md" >nul && echo  [OK] AGENTS.md
if exist "%DEST%\launcher" (
  xcopy /E /I /Y /Q "launcher" "%DEST%\launcher" >nul && echo  [OK] launcher
  echo  [!!] Para activar el launcher nuevo: icono en bandeja -^> Salir, y abre PoxScore de nuevo
)
if exist "browser" (
  xcopy /E /I /Y /Q "browser" "%DEST%\browser" >nul && echo  [OK] navegador propio (LibreWolf portable)
)

echo.
echo  Verificando que el server quedo actualizado...
findstr /C:"Respaldo PoxScore" "%DEST%\server\dist\index.js" >nul 2>&1
if errorlevel 1 (
  echo  [!!] server\dist\index.js NO tiene el codigo nuevo
  echo       - la copia no entro. Revisa permisos de la carpeta.
) else (
  echo  [OK] server\dist\index.js contiene el codigo nuevo
)

echo  Verificando el build web...
findstr /C:"index-" "%DEST%\web\dist\index.html" >nul 2>&1
if errorlevel 1 (
  echo  [!!] web\dist\index.html no quedo bien
) else (
  echo  [OK] web\dist actualizado
)

echo.
echo  Aplicando cambios de base de datos y cliente Prisma...
echo  (ESTE PASO ES CLAVE: sin el, el server se cae al anotar)
pushd "%DEST%\server"
call npx prisma db push
if errorlevel 1 (
  echo.
  echo  AVISO: prisma no pudo aplicar el esquema — verifica que
  echo  PoxScore este detenido y MySQL corriendo, y repite:
  echo      cd server ^&^& npx prisma db push
) else (
  echo  [OK] base de datos al dia
)
rem Regenera el cliente Prisma por si db push se omitio o fallo
rem a medias — sin el, crear una jugada tumba el servidor
rem (Unknown argument 'aiVoice').
call npx prisma generate
if errorlevel 1 (
  rem un reintento: a veces el antivirus suelta el DLL en segundos
  echo  [...] reintentando en 5 segundos ^(si el server sigue vivo falla de nuevo^)
  timeout /t 5 /nobreak >nul
  call npx prisma generate
)
if errorlevel 1 (
  echo.
  echo  [!!] prisma generate fallo — PoxScore sigue corriendo y tiene
  echo       bloqueado el DLL. PASOS:
  echo       1. Sal del launcher ^(icono en bandeja -^> Salir^)
  echo       2. Corre:  cd C:\PoxScore\server ^&^& npx prisma generate
  echo       3. Inicia PoxScore de nuevo
  echo       ^(o vuelve a correr este bat — ahora detecta y detiene el server^)
) else (
  echo  [OK] cliente Prisma regenerado
)
popd

echo.
echo  Dejando la app en MODO ABIERTO (sin pantalla de login)...
rem Las acciones de admin (borrar/bloquear) quedan protegidas por
rem ADMIN_KEY del .env — si no existe se agrega con el valor de
rem fabrica admin123.
findstr /C:"ADMIN_KEY" "%DEST%\server\.env" >nul 2>&1
if errorlevel 1 (
  echo ADMIN_KEY=admin123>>"%DEST%\server\.env"
  echo  [OK] ADMIN_KEY=admin123 agregada a server\.env
) else (
  echo  [OK] server\.env ya tiene ADMIN_KEY
)
rem Borra usuarios y sesiones — el admin sembrado automaticamente ya no
rem se recrea (el seed se quito en esta version). Quien quiera usuarios
rem los crea despues en /usuarios.
pushd "%DEST%\server"
call node scripts\reset-auth.mjs
if errorlevel 1 (
  echo  [!!] reset-auth fallo — corre a mano:  cd server ^&^& node scripts\reset-auth.mjs
)
popd

echo.
rem lee la version y el bundle del paquete aplicado (asi nunca queda viejo)
rem (sin for /f: los parentesis del node -e rompen el parseo y el bat muere)
set "EXPV=?"
set "EXPB=?"
node -e "const fs=require('fs');const v=(fs.readFileSync('server/dist/index.js','utf8').match(/20\d\d-\d\d-\d\d\.\d+/)||['?'])[0];const b=(fs.readFileSync('web/dist/index.html','utf8').match(/index-[\w-]+\.js/)||['?'])[0];fs.writeFileSync(process.env.TEMP+'/poxver.bat','@set EXPV='+v+'\r\n@set EXPB='+b+'\r\n')" >nul 2>&1
if exist "%TEMP%\poxver.bat" (call "%TEMP%\poxver.bat" & del /q "%TEMP%\poxver.bat" >nul 2>&1)
echo  ======================================================
echo   LISTO — ahora:
echo   1. Inicia PoxScore
echo   2. En el navegador abre  http://localhost:4000/api/health
echo      debe decir  "v":"%EXPV%"  y  "build":"%EXPB%"
echo   3. Presiona Ctrl+F5 en la app
echo   4. Ya NO hay pantalla de login — la clave de admin
echo      (admin123) solo se pide para borrar/bloquear
echo  ======================================================
echo.
echo  Chequeo rápido del sistema (server\selftest.cjs):
pushd "%DEST%\server"
call node selftest.cjs
if errorlevel 2 (
  echo  ^(server apagado — normal. Al iniciar PoxScore corre: node selftest.cjs^)
) else if errorlevel 1 (
  echo  [!!] el self-test encontro problemas — lee las lineas [!!] arriba
) else (
  echo  [OK] self-test pasado
)
popd
echo.
pause
