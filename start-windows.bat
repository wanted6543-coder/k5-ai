@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .env (
  copy .env.example .env >nul
  echo Создан файл .env. Открой его в Блокноте и вставь GEMINI_API_KEY.
  notepad .env
  echo После сохранения запусти start-windows.bat ещё раз.
  pause
  exit /b
)
where node >nul 2>nul || (echo Не найден Node.js 22+. Установи его с https://nodejs.org/ && pause && exit /b)
if not exist node_modules call npm install
npm start
pause
