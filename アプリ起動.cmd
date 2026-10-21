@echo off
setlocal
set "PSModulePath=%USERPROFILE%\Documents\WindowsPowerShell\Modules;%ProgramFiles%\WindowsPowerShell\Modules;%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0StartApp.ps1" %*
if errorlevel 1 (
  echo.
  echo SHIORI could not be started. Review the error message, then press any key.
  pause >nul
  exit /b 1
)
