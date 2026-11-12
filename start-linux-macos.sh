#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then cp .env.example .env; echo "Создан .env. Добавь GEMINI_API_KEY и запусти скрипт снова."; exit 0; fi
node --version
npm install
npm start
