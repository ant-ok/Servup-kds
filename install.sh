#!/usr/bin/env bash
# Install or update KDS on a fresh Ubuntu/Debian machine.
#
#   Cloud server with your domain:     sudo DOMAIN=kds.example.com ./install.sh
#   Cloud server, temporary domain:    sudo ./install.sh            → https://<ip>.sslip.io
#   Mini-PC inside the venue (LAN):    sudo MODE=local ./install.sh → http://<lan-ip>/
#
# First venue in the same command (all optional):
#   sudo POSTER_TOKEN=… POSTER_ACCOUNT=myburger VENUE_TYPE=fastfood ./install.sh
#
# Run it again any time to update: data and secrets are kept.
set -euo pipefail

MODE="${MODE:-cloud}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

say() { printf '\n\033[1m→ %s\033[0m\n' "$*"; }
setenv() { # setenv KEY VALUE: replace or append in .env
  if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi
}

if [ "$(id -u)" -ne 0 ]; then echo "Запустите через sudo"; exit 1; fi

if ! command -v docker >/dev/null; then
  say "Устанавливаю Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# Correct time matters: timers, reports and certificates depend on it.
timedatectl set-ntp true >/dev/null 2>&1 || true

# Pick the address.
if [ "$MODE" = "local" ]; then
  LAN_IP="$(hostname -I | awk '{print $1}')"
  DOMAIN=""
  URL="http://${LAN_IP}"
elif [ -z "${DOMAIN:-}" ]; then
  PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)"
  # Temporary domain: <ip>.sslip.io resolves to this server, so a real HTTPS
  # certificate can be issued without buying a domain. Replace it later.
  DOMAIN="${PUBLIC_IP//./-}.sslip.io"
  URL="https://${DOMAIN}"
else
  URL="https://${DOMAIN}"
fi

if [ ! -f .env ]; then
  say "Создаю .env со случайными секретами"
  rand() { openssl rand -hex 24; }
  cp .env.example .env
  setenv APP_SECRET "$(rand)"
  setenv DB_PASSWORD "$(rand)"
  PLATFORM_PASSWORD="$(openssl rand -base64 12 | tr -d '/+=')"
  setenv PLATFORM_PASSWORD "$PLATFORM_PASSWORD"
  NEW_INSTALL=1
fi
setenv PUBLIC_URL "$URL"
setenv DOMAIN "$DOMAIN"
# Values given on the command line go into .env; nothing is erased if omitted.
for KEY in POSTER_TOKEN POSTER_ACCOUNT VENUE_TYPE ADMIN_PASSWORD TELEGRAM_BOT_TOKEN; do
  if [ -n "${!KEY:-}" ]; then setenv "$KEY" "${!KEY}"; fi
done
if grep -q '^POSTER_TOKEN=.' .env && ! grep -q '^ADMIN_PASSWORD=.' .env; then
  ADMIN_PASSWORD="$(openssl rand -base64 9 | tr -d '/+=')"
  setenv ADMIN_PASSWORD "$ADMIN_PASSWORD"
  NEW_ADMIN=1
fi
chmod 600 .env

mkdir -p backups
say "Собираю и запускаю"
docker compose --env-file .env up -d --build --remove-orphans

say "Жду, пока система поднимется"
for _ in $(seq 1 60); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done

echo
if [ "${OK:-}" = 1 ]; then echo "✓ Работает: $URL"; else echo "⚠ Не дождался ответа. Проверьте: ./scripts/doctor.sh"; fi
echo "  Экран:      $URL/kds/"
echo "  Админка:    $URL/admin/"
echo "  Платформа:  $URL/platform/"
[ -n "${NEW_INSTALL:-}" ] && echo "  Пароль платформы: $PLATFORM_PASSWORD  (сохраните, он есть в $DIR/.env)"
if [ -n "${NEW_ADMIN:-}" ]; then
  LOGIN="$(grep '^POSTER_ACCOUNT=' .env | cut -d= -f2-)"
  echo "  Вход в админку: заведение «${LOGIN:-1}», пароль $ADMIN_PASSWORD"
fi
echo "  Токены Poster и Telegram впишите в $DIR/.env и выполните: sudo ./install.sh"
if [ "$MODE" = "local" ]; then
  echo "  Локальный режим: планшеты должны быть в той же сети. Закрепите за сервером IP ${LAN_IP} в роутере."
fi
