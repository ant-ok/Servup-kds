#!/usr/bin/env bash
# One-command install on a fresh Ubuntu/Debian server:
#   curl -fsSL <repo>/install.sh | sudo DOMAIN=kds.example.com bash
# or, inside a checkout:  sudo DOMAIN=kds.example.com ./install.sh
set -euo pipefail

: "${DOMAIN:?Укажите домен: DOMAIN=kds.example.com}"
DIR="${KDS_DIR:-/opt/kds}"

if ! command -v docker >/dev/null; then
  echo "→ Устанавливаю Docker"
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f "$DIR/docker-compose.yml" ]; then
  if [ -f ./docker-compose.yml ]; then DIR="$(pwd)"; else
    : "${REPO:?Укажите REPO=<git url> или запустите из папки проекта}"
    git clone "$REPO" "$DIR"
  fi
fi
cd "$DIR"

if [ ! -f .env ]; then
  echo "→ Создаю .env со случайными секретами"
  rand() { openssl rand -hex 24; }
  cp .env.example .env
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://$DOMAIN#" .env
  sed -i "s#^APP_SECRET=.*#APP_SECRET=$(rand)#" .env
  sed -i "s#^DB_PASSWORD=.*#DB_PASSWORD=$(rand)#" .env
  PLATFORM_PASSWORD="$(openssl rand -base64 12 | tr -d '/+=')"
  sed -i "s#^PLATFORM_PASSWORD=.*#PLATFORM_PASSWORD=$PLATFORM_PASSWORD#" .env
  echo "DOMAIN=$DOMAIN" >> .env
  echo "   Пароль панели /platform/: $PLATFORM_PASSWORD  (сохраните его)"
fi

mkdir -p backups
docker compose --env-file .env up -d --build
echo
echo "✓ Готово: https://$DOMAIN  (платформа: https://$DOMAIN/platform/)"
echo "  Токены Poster и Telegram — в $DIR/.env, затем: docker compose up -d"
