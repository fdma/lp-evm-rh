@echo off
title LP EVM RH
cd /d "%~dp0"

rem Пробуем разные способы запустить локальный сервер: на разных машинах
rem Python зовётся по-разному, а где-то его нет вовсе.
where py >nul 2>&1 && (
  echo Запускаю через py. Открой http://127.0.0.1:8799
  start "" http://127.0.0.1:8799
  py -m http.server 8799 --bind 127.0.0.1
  goto :eof
)
where python >nul 2>&1 && (
  echo Запускаю через python. Открой http://127.0.0.1:8799
  start "" http://127.0.0.1:8799
  python -m http.server 8799 --bind 127.0.0.1
  goto :eof
)
where node >nul 2>&1 && (
  echo Запускаю через node. Открой http://127.0.0.1:8799
  start "" http://127.0.0.1:8799
  npx --yes http-server -p 8799 -a 127.0.0.1
  goto :eof
)

echo.
echo НЕ НАШЁЛ, ЧЕМ ЗАПУСТИТЬ ЛОКАЛЬНЫЙ СЕРВЕР.
echo Нужен Python или Node. Поставь Python с python.org
echo (при установке отметь галочку Add Python to PATH) и запусти этот файл снова.
echo.
pause
