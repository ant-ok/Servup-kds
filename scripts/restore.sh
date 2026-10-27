#!/usr/bin/env bash
# Restore the database from a backup:  sudo ./scripts/restore.sh backups/kds_2026-10-27_0300.sql.gz
# The current database is dumped first, so a restore can itself be undone.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
file="${1:?Укажите файл копии из папки backups/}"
[ -f "$file" ] || { echo "Нет файла $file"; exit 1; }

echo "→ Сохраняю текущую базу перед восстановлением"
docker compose exec -T db pg_dump -U kds kds | gzip > "backups/before_restore_$(date +%F_%H%M%S).sql.gz"

echo "→ Останавливаю приложение"
docker compose stop app

echo "→ Восстанавливаю $file"
docker compose exec -T db psql -U kds -d postgres -c "DROP DATABASE IF EXISTS kds_restore" >/dev/null
docker compose exec -T db psql -U kds -d postgres -c "CREATE DATABASE kds_restore" >/dev/null
gunzip -c "$file" | docker compose exec -T db psql -q -U kds -d kds_restore >/dev/null
docker compose exec -T db psql -U kds -d postgres -c "DROP DATABASE kds" -c "ALTER DATABASE kds_restore RENAME TO kds" >/dev/null

echo "→ Запускаю приложение"
docker compose start app
echo "✓ Готово"
