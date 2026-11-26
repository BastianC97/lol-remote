@echo off
rem Para desarrollo: ejecuta el servidor con Node.
rem Para tus amigos usa dist\LoLRemote.exe (npm run build).
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)
node server.js
pause
