@echo off
rem PoxScore — baja el navegador propio (LibreWolf portable) a browser\
rem No instala nada en Windows; queda dentro de la carpeta de PoxScore.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bajar-navegador.ps1"
pause
