#!/usr/bin/env bash
# Chaos test of a running Docker stack (local mode, mock Poster on the host):
#   node test/mock-poster.js &            # fake Poster on :4100
#   docker compose up -d                  # with POSTER_API_URL pointing at it
#   test/stack/chaos.sh
# Kills and pauses parts of the system and checks that no order is lost.
set -uo pipefail
BASE="${BASE:-http://localhost}"
MOCK="${MOCK:-http://localhost:4100}"
PLATFORM_PASSWORD="${PLATFORM_PASSWORD:-platform-pass}"
J="$(mktemp -d)"
pass=0; fail=0
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; pass=$((pass + 1)); }
bad() { printf '\033[31m✗\033[0m %s\n' "$*"; fail=$((fail + 1)); }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log($1)})"; }
P() { curl -s -b "$J/p" -c "$J/p" -H 'content-type: application/json' "$@"; }
A() { curl -s -b "$J/a" -c "$J/a" -H 'content-type: application/json' "$@"; }
K() { curl -s -H 'content-type: application/json' -H "x-device-token: $DEV" "$@"; }
M() { curl -s -H 'content-type: application/json' -X POST "$MOCK/_mock$1" -d "${2:-{\}}"; }
health_up() { for _ in $(seq 1 "${1:-120}"); do curl -sf -m 2 "$BASE/health" >/dev/null && return 0; sleep 1; done; return 1; }
units_of() { K "$BASE/api/kds/board" | json "o.tickets.filter(t=>t.transaction_id==$1).flatMap(t=>t.units).length" 2>/dev/null || echo 0; }
wait_units() { # wait_units CHECK COUNT TIMEOUT
  for _ in $(seq 1 "${3:-30}"); do [ "$(units_of "$1")" = "$2" ] && return 0; sleep 1; done; return 1; }
order() { local id; id="$(M /open '{"table":"9"}' | json o.id)"; M "/$id/add" "{\"product_id\":10,\"num\":$1}" >/dev/null; echo "$id"; }
restarts() { docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q app)"; }
app_id() { docker compose ps -aq app; }   # -a: a paused container still counts

echo "Подготовка"
health_up 60 || { echo "стек не отвечает"; exit 1; }
P -X POST "$BASE/api/platform/login" -d "{\"password\":\"$PLATFORM_PASSWORD\"}" >/dev/null
ACC="$(P -X POST "$BASE/api/platform/accounts" -d '{"name":"Chaos","poster_account":"chaos'$RANDOM'","token":"demo","password":"password-123"}' | json o.id)"
A -X POST "$BASE/api/admin/login" -d "{\"account\":\"$ACC\",\"password\":\"password-123\"}" >/dev/null
EMP="$(A -X POST "$BASE/api/admin/employees" -d '{"name":"Хаос"}' | json o.id)"
A -X PATCH "$BASE/api/admin/employees/$EMP" -d '{"pin":"8080"}' >/dev/null
DEV="$(A -X POST "$BASE/api/admin/devices" -d '{"name":"chaos"}' | json o.token)"

echo "1. Обычная работа"
c1="$(order 2)"; wait_units "$c1" 2 20 && ok "заказ дошёл до экрана" || bad "заказ не дошёл"
TOK="$(K -X POST "$BASE/api/kds/login" -d '{"pin":"8080"}' | json o.token)"
U="$(K "$BASE/api/kds/board" | json "o.tickets.find(t=>t.transaction_id==$c1).units[0].id")"
r="$(K -X POST "$BASE/api/kds/action" -d "{\"op_id\":\"c-$RANDOM\",\"token\":\"$TOK\",\"action\":\"ready\",\"unit_ids\":[$U]}" | json o.changed)"
[ "$r" = 1 ] && ok "отметка «готово» через Caddy" || bad "отметка не прошла"

echo "2. Процесс приложения убит (kill -9)"
before="$(restarts)"; t0=$(date +%s)
# A real crash: the process dies on its own. (`docker kill` would count as a
# manual stop, after which Docker deliberately does not restart.)
kill -9 "$(docker inspect -f '{{.State.Pid}}' "$(app_id)")"
c2="$(order 1)"                                   # пробили, пока приложение лежит
health_up 90 && ok "поднялось само за $(( $(date +%s) - t0 )) с" || bad "не поднялось"
wait_units "$c2" 1 30 && ok "заказ, пробитый во время падения, дошёл" || bad "заказ из простоя потерян"

echo "3. Перезапуск базы данных"
before="$(restarts)"
docker compose restart db >/dev/null 2>&1
c3="$(order 3)"
wait_units "$c3" 3 60 && ok "после перезапуска БД заказы идут" || bad "после перезапуска БД заказ не дошёл"
[ "$(restarts)" = "$before" ] && ok "приложение пережило перезапуск БД без своего перезапуска" || ok "приложение перезапустилось вместе с БД (допустимо)"

echo "4. Приложение зависло (docker pause) — autoheal должен перезапустить"
t0=$(date +%s)
APP="$(app_id)"
docker pause "$APP" >/dev/null
sleep 5
healed=""
for _ in $(seq 1 180); do
  state="$(docker inspect -f '{{.State.Status}}' "$APP" 2>/dev/null)"
  if [ "$state" = running ] && curl -sf -m 2 "$BASE/health" >/dev/null; then healed=1; break; fi
  sleep 1
done
[ -n "$healed" ] && ok "зависание вылечено за $(( $(date +%s) - t0 )) с" || { bad "зависшее приложение не перезапущено ($state)"; docker unpause "$APP" >/dev/null 2>&1; }
c4="$(order 1)"; wait_units "$c4" 1 30 && ok "после лечения заказы идут" || bad "после лечения заказ не дошёл"

echo "5. Отключение питания (kill всех контейнеров) и включение"
wait_units "$c4" 1 30 >/dev/null
total_before="$(docker compose exec -T db psql -U kds -tAc 'SELECT count(*) FROM units')"
ready_before="$(docker compose exec -T db psql -U kds -tAc "SELECT count(*) FROM units WHERE status = 'ready'")"
docker compose kill >/dev/null 2>&1
docker compose up -d >/dev/null 2>&1
health_up 120 && ok "система поднялась после «отключения питания»" || bad "не поднялась"
total_after="$(docker compose exec -T db psql -U kds -tAc 'SELECT count(*) FROM units')"
ready_after="$(docker compose exec -T db psql -U kds -tAc "SELECT count(*) FROM units WHERE status = 'ready'")"
[ "$total_after" -ge "$total_before" ] && [ "$ready_before" = "$ready_after" ] \
  && ok "данные на месте: $total_after порций, из них готовых $ready_after" \
  || bad "данные изменились: было $total_before/$ready_before, стало $total_after/$ready_after"
c5="$(order 2)"; wait_units "$c5" 2 30 && ok "новые заказы идут" || bad "новый заказ не дошёл"

echo "6. Резервная копия и восстановление"
docker compose exec -T db pg_dump -U kds kds | gzip > "$J/chaos_check.sql.gz"
size="$(stat -c %s "$J/chaos_check.sql.gz" 2>/dev/null || echo 0)"
[ "$size" -gt 1000 ] && ok "копия базы снимается ($size байт)" || bad "копия пустая"
count="$(docker compose exec -T db psql -U kds -tAc 'SELECT count(*) FROM units')"
./scripts/restore.sh "$J/chaos_check.sql.gz" >/dev/null 2>&1
health_up 60 >/dev/null
restored="$(docker compose exec -T db psql -U kds -tAc 'SELECT count(*) FROM units')"
[ "$count" = "$restored" ] && ok "восстановление из копии: $restored порций" || bad "после восстановления $restored вместо $count"


echo
echo "Итого: $pass успешно, $fail с ошибками"
rm -rf "$J"
exit $(( fail > 0 ))
