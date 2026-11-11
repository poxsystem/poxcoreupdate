@echo off
rem ==========================================================================
rem PoxScoreWin — compila PoxScoreWin.cs → PoxScoreWin.exe
rem csc de .NET Framework 4.x + DLLs del SDK WebView2 en libs\ (embebidas).
rem Distribuir: SOLO PoxScoreWin.exe (auto-contenido — las DLLs van DENTRO).
rem ==========================================================================
setlocal
set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
cd /d "%~dp0"

"%CSC%" /nologo /target:winexe /platform:anycpu /out:PoxScoreWin.exe /win32icon:icon.ico ^
  /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll ^
  /r:System.Management.dll ^
  /r:libs\Microsoft.Web.WebView2.Core.dll /r:libs\Microsoft.Web.WebView2.WinForms.dll ^
  /resource:libs\Microsoft.Web.WebView2.Core.dll,Microsoft.Web.WebView2.Core.dll ^
  /resource:libs\Microsoft.Web.WebView2.WinForms.dll,Microsoft.Web.WebView2.WinForms.dll ^
  /resource:libs\WebView2Loader.dll,WebView2Loader.dll ^
  PoxScoreWin.cs

if errorlevel 1 (echo. & echo *** ERROR de compilacion *** & pause & exit /b 1)

echo. & echo OK → PoxScoreWin.exe  (auto-contenido — las DLLs van DENTRO)
