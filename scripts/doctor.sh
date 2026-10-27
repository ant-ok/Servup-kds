#!/usr/bin/env bash
# Quick health report of an installation: containers, the app, Poster sync,
# disk, backups, time. Exit code 0 = all fine, 1 = something needs attention.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
problems=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; problems=$((problems + 1)); }

echo "Контейнеры:"
for svc in db app caddy backup autoheal; do
  state="$(docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | awk -v s="$svc" '$1==s {print $2, $3}')"
  case "$state" in
    "running healthy"|"running ") ok "$svc: работает" ;;
    running*) [ "$svc" = app ] && bad "$svc: $state" || ok "$svc: $state" ;;
    *) bad "$svc: ${state:-не запущен}" ;;
  esac
done

echo "Приложение:"
health="$(docker compose exec -T app wget -qO- http://127.0.0.1:3000/health 2>/dev/null)"
if [ -n "$health" ]; then
  ok "отвечает: $health"
  syncing="$(echo "$health" | sed -n 's/.*"venuesSyncing":\([0-9]*\).*/\1/p')"
  venues="$(echo "$health" | sed -n 's/.*"venues":\([0-9]*\).*/\1/p')"
  [ "${venues:-0}" = "${syncing:-0}" ] && ok "связь с Poster: $syncing из $venues" || bad "связь с Poster: $syncing из $venues заведений"
else
  bad "не отвечает на /health"
fi

echo "Диск:"
use="$(df -P . | awk 'NR==2 {gsub("%","",$5); print $5}')"
[ "$use" -lt 85 ] && ok "занято ${use}%" || bad "занято ${use}% — освободите место"

echo "Резервные копии:"
last="$(ls -1t backups/kds_*.sql.gz 2>/dev/null | head -1)"
if [ -z "$last" ]; then bad "копий нет"
else
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
  size="$(du -h "$last" | cut -f1)"
  [ "$age_h" -le 26 ] && ok "последняя: $last ($size, ${age_h} ч назад)" || bad "последняя копия ${age_h} ч назад: $last"
fi

echo "Время:"
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then ok "синхронизировано"; else bad "часы не синхронизированы (timedatectl set-ntp true)"; fi

echo
[ "$problems" -eq 0 ] && echo "Всё в порядке." || echo "Проблем: $problems"
exit $(( problems > 0 ))
