// The HTTP API end to end: access control, validation, every admin section,
// the screens and the platform panel.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server-helper.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); await s.db.pool.end(); });

const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);

async function screen(v, stationName) {
  const station = v.stations.find((x) => x.name === stationName);
  const d = (await v.admin('/api/admin/devices', { method: 'POST', body: { name: 'Экран', station_id: station?.id ?? null } })).data;
  return { ...d, kds: s.client({ headers: { 'x-device-token': d.token } }) };
}
async function staff(v, name, pin) {
  const e = (await v.admin('/api/admin/employees', { method: 'POST', body: { name } })).data;
  await v.admin(`/api/admin/employees/${e.id}`, { method: 'PATCH', body: { pin } });
  return e;
}
let opSeq = 0;
const op = () => `op-${Date.now()}-${opSeq++}`;

// ---- access control -------------------------------------------------------------

test('every admin endpoint requires a signed-in admin', async () => {
  const anon = s.client();
  for (const path of ['/api/admin/status', '/api/admin/settings', '/api/admin/stations', '/api/admin/employees',
    '/api/admin/products', '/api/admin/devices', `/api/admin/reports/makers?from=${today()}&to=${today()}`,
    '/api/admin/webhooks', '/api/admin/audit', '/api/admin/telegram', '/api/admin/account', '/api/admin/workshops']) {
    assert.equal((await anon(path)).status, 401, path);
  }
  assert.equal((await anon('/api/admin/settings', { method: 'PUT', body: {} })).status, 401);
  assert.equal((await anon('/api/admin/sync/catalog', { method: 'POST' })).status, 401);
});

test('a forged admin cookie is rejected', async () => {
  const c = s.client({ headers: { cookie: 'kds_admin=1.99999999999999.deadbeef' } });
  assert.equal((await c('/api/admin/status')).status, 401);
});

test('admin login: wrong password, unknown venue, by Poster account name', async () => {
  const v = await s.venue();
  const c = s.client();
  assert.equal((await c('/api/admin/login', { method: 'POST', body: { account: String(v.acc.id), password: 'nope' } })).status, 401);
  assert.equal((await c('/api/admin/login', { method: 'POST', body: { account: 'no-such', password: 'password-123' } })).status, 401);
  const name = (await v.admin('/api/admin/account')).data.poster_account;
  assert.equal((await c('/api/admin/login', { method: 'POST', body: { account: name.toUpperCase(), password: 'password-123' } })).status, 200);
  assert.equal((await c('/api/admin/status')).status, 200);
  await c('/api/admin/logout', { method: 'POST' });
  assert.equal((await c('/api/admin/status')).status, 401, 'logout clears the session');
});

test('platform: wrong password refused, every route protected', async () => {
  const c = s.client();
  assert.equal((await c('/api/platform/login', { method: 'POST', body: { password: 'x' } })).status, 401);
  assert.equal((await c('/api/platform/accounts')).status, 401);
  assert.equal((await c('/api/platform/accounts', { method: 'POST', body: { name: 'X' } })).status, 401);
});

test('disabling a venue locks its admin and its screens', async () => {
  const v = await s.venue();
  const d = await screen(v, 'Бар');
  assert.equal((await d.kds('/api/kds/me')).status, 200);
  const p = await s.platform();
  await p(`/api/platform/accounts/${v.acc.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await v.admin('/api/admin/status')).status, 401);
  assert.equal((await d.kds('/api/kds/board')).status, 401);
  await p(`/api/platform/accounts/${v.acc.id}`, { method: 'PATCH', body: { active: true } });
  assert.equal((await d.kds('/api/kds/board')).status, 200);
});

// ---- validation ---------------------------------------------------------------------

test('malformed JSON and oversized bodies get 4xx, never 500', async () => {
  const v = await s.venue();
  const r1 = await v.admin('/api/admin/settings', { method: 'PUT', body: '{not json' });
  assert.equal(r1.status, 400);
  const big = JSON.stringify({ name: 'x'.repeat(1.2 * 1024 * 1024) });
  const r2 = await v.admin('/api/admin/employees', { method: 'POST', body: big });
  assert.equal(r2.status, 413);
});

test('settings: known keys are saved, unknown keys ignored', async () => {
  const v = await s.venue();
  const r = await v.admin('/api/admin/settings', { method: 'PUT', body: { maker_title: 'Бармен', warn_minutes: 7, kds_started_at: 'hack', bogus: 1 } });
  assert.equal(r.data.maker_title, 'Бармен');
  assert.equal(r.data.warn_minutes, 7);
  assert.notEqual(r.data.kds_started_at, 'hack');
  assert.equal(r.data.bogus, undefined);
});

test('account: short password refused, new password works', async () => {
  const v = await s.venue();
  assert.equal((await v.admin('/api/admin/account', { method: 'PATCH', body: { password: 'short' } })).status, 400);
  assert.equal((await v.admin('/api/admin/account', { method: 'PATCH', body: { password: 'brand-new-pass', name: 'Новое имя' } })).status, 200);
  const c = s.client();
  assert.equal((await c('/api/admin/login', { method: 'POST', body: { account: String(v.acc.id), password: 'brand-new-pass' } })).status, 200);
  assert.equal((await c('/api/admin/account')).data.name, 'Новое имя');
});

test('stations: create, rename, route workshops, delete moves its screens to "all"', async () => {
  const v = await s.venue({ preset: 'restaurant' });
  assert.equal((await v.admin('/api/admin/stations', { method: 'POST', body: { name: ' ' } })).status, 400);
  const hot = (await v.admin('/api/admin/stations', { method: 'POST', body: { name: 'Горячий цех', workshop_ids: [2] } })).data;
  const ws = (await v.admin('/api/admin/workshops')).data;
  assert.equal(ws.find((w) => w.name === 'Кухня').station_id, hot.id, 'an explicit claim beats the name match');
  assert.equal(ws.find((w) => w.name === 'Бар').station_id, v.stations.find((x) => x.name === 'Бар').id);
  await v.admin(`/api/admin/stations/${hot.id}`, { method: 'PATCH', body: { name: 'Гриль' } });
  const d = await screen({ ...v, stations: (await v.admin('/api/admin/stations')).data }, 'Гриль');
  await v.admin(`/api/admin/stations/${hot.id}`, { method: 'DELETE' });
  assert.ok(!(await v.admin('/api/admin/stations')).data.some((x) => x.id === hot.id));
  const dev = (await v.admin('/api/admin/devices')).data.find((x) => x.id === d.id);
  assert.equal(dev.station_id, null);
});

test('employees: name required, PIN format, duplicate PIN, PIN change ends sessions', async () => {
  const v = await s.venue();
  assert.equal((await v.admin('/api/admin/employees', { method: 'POST', body: { name: '' } })).status, 400);
  const a = (await v.admin('/api/admin/employees', { method: 'POST', body: { name: 'Иван' } })).data;
  const b = (await v.admin('/api/admin/employees', { method: 'POST', body: { name: 'Пётр' } })).data;
  for (const pin of ['12', 'abcd', '123456789', '12 34']) {
    assert.equal((await v.admin(`/api/admin/employees/${a.id}`, { method: 'PATCH', body: { pin } })).status, 400, pin);
  }
  assert.equal((await v.admin(`/api/admin/employees/${a.id}`, { method: 'PATCH', body: { pin: '4321' } })).status, 200);
  assert.equal((await v.admin(`/api/admin/employees/${b.id}`, { method: 'PATCH', body: { pin: '4321' } })).status, 409);
  assert.equal((await v.admin('/api/admin/employees/999999', { method: 'PATCH', body: { name: 'x' } })).status, 404);

  const d = await screen(v, 'Бар');
  const login = (await d.kds('/api/kds/login', { method: 'POST', body: { pin: '4321' } })).data;
  assert.ok(login.token);
  await v.admin(`/api/admin/employees/${a.id}`, { method: 'PATCH', body: { pin: '9999' } });
  v.fake.add(v.fake.open(), 10, 1);
  await v.engine.pollOpen();
  const unit = (await d.kds('/api/kds/board')).data.tickets[0].units[0];
  const r = await d.kds('/api/kds/action', { method: 'POST', body: { op_id: op(), token: login.token, action: 'take', unit_ids: [unit.id] } });
  assert.equal(r.status, 401, 'old session is gone after the PIN changed');
});

test('employees without KDS access or inactive cannot sign in on a screen', async () => {
  const v = await s.venue();
  const e = await staff(v, 'Ольга', '5555');
  const d = await screen(v, 'Бар');
  await v.admin(`/api/admin/employees/${e.id}`, { method: 'PATCH', body: { kds_access: false } });
  assert.equal((await d.kds('/api/kds/login', { method: 'POST', body: { pin: '5555' } })).status, 401);
  await v.admin(`/api/admin/employees/${e.id}`, { method: 'PATCH', body: { kds_access: true, active: false } });
  assert.equal((await d.kds('/api/kds/login', { method: 'POST', body: { pin: '5555' } })).status, 401);
});

test('rates and norms: validation and saving', async () => {
  const v = await s.venue();
  assert.equal((await v.admin('/api/admin/rates/10', { method: 'PUT', body: { rate: -5 } })).status, 400);
  assert.equal((await v.admin('/api/admin/rates/10', { method: 'PUT', body: { rate: 'abc' } })).status, 400);
  assert.equal((await v.admin('/api/admin/rates/10', { method: 'PUT', body: { rate: 35 } })).status, 200);
  assert.equal((await v.admin('/api/admin/products/10/info', { method: 'PUT', body: { norm_seconds: 0 } })).status, 400);
  assert.equal((await v.admin('/api/admin/products/10/info', { method: 'PUT', body: { norm_seconds: 120, recipe_note: 'С мятой' } })).status, 200);
  await v.admin('/api/admin/products/10/info', { method: 'PUT', body: { recipe_note: 'Без мяты' } });
  const p = (await v.admin('/api/admin/products')).data.find((x) => x.id === 10);
  assert.deepEqual([p.rate, p.norm_seconds, p.recipe_note], [35, 120, 'Без мяты'], 'a note update keeps the norm');
  assert.equal((await v.admin('/api/admin/products/10/recipe')).data.ingredients.length, 3);
  assert.equal((await v.admin('/api/admin/products/987654/recipe')).status, 404);
});

test('devices: token shown once, revocation, foreign station refused', async () => {
  const v = await s.venue();
  const other = await s.venue();
  const d = await screen(v, 'Бар');
  assert.ok(d.token.length > 30);
  const list = (await v.admin('/api/admin/devices')).data;
  assert.ok(list.every((x) => !('token' in x) && !('token_hash' in x)));
  assert.equal((await v.admin(`/api/admin/devices/${d.id}`, { method: 'PATCH', body: { station_id: other.stations[0].id } })).status, 404);
  assert.equal((await d.kds('/api/kds/me')).status, 200);
  await v.admin(`/api/admin/devices/${d.id}`, { method: 'DELETE' });
  assert.equal((await d.kds('/api/kds/me')).status, 401);
  assert.equal((await d.kds('/api/kds/me')).data.code, 'device');
});

test('reports: every kind answers, bad period is 400, unknown kind 404, CSV is Excel-friendly', async () => {
  const v = await s.venue();
  for (const kind of ['makers', 'sellers', 'runners', 'stations', 'products', 'details', 'anomalies']) {
    const r = await v.admin(`/api/admin/reports/${kind}?from=${today()}&to=${today()}`);
    assert.equal(r.status, 200, kind);
  }
  assert.equal((await v.admin('/api/admin/reports/makers?from=2024-13-01&to=x')).status, 400);
  assert.equal((await v.admin('/api/admin/reports/makers')).status, 400);
  assert.equal((await v.admin(`/api/admin/reports/toCsv?from=${today()}&to=${today()}`)).status, 404);
  const csv = await v.admin(`/api/admin/reports/makers?from=${today()}&to=${today()}&format=csv`, { raw: true });
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="makers_/);
  assert.match(csv.data, /^﻿?Сотрудник;Станции;Порций сделано;/);
  // fetch().text() strips a BOM, so check the bytes.
  const bytes = new Uint8Array(await (await v.adminFetch(`/api/admin/reports/makers?from=${today()}&to=${today()}&format=csv`)).arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM for Cyrillic in Excel');
});

test('full shift over HTTP: login, take, ready, idempotent retry, reassign with reason, reports', async () => {
  const v = await s.venue();
  await v.admin('/api/admin/rates/10', { method: 'PUT', body: { rate: 30 } });
  const ivan = await staff(v, 'Иван', '1111');
  const petr = await staff(v, 'Пётр', '2222');
  const d = await screen(v, 'Бар');
  const id = v.fake.open({ table: '3', waiter: 1 });
  v.fake.add(id, 10, 2);
  await v.engine.pollOpen();

  const s1 = (await d.kds('/api/kds/login', { method: 'POST', body: { pin: '1111' } })).data;
  const board = (await d.kds('/api/kds/board')).data;
  assert.equal(board.station.name, 'Бар');
  assert.ok(board.version);
  const [u1, u2] = board.tickets[0].units;

  const bad = (body) => d.kds('/api/kds/action', { method: 'POST', body: { op_id: op(), token: s1.token, ...body } });
  assert.equal((await bad({ action: 'explode', unit_ids: [u1.id] })).status, 400);
  assert.equal((await bad({ action: 'take', unit_ids: [] })).status, 400);
  assert.equal((await d.kds('/api/kds/action', { method: 'POST', body: { token: s1.token, action: 'take', unit_ids: [u1.id] } })).status, 400, 'op_id required');
  assert.equal((await bad({ action: 'take', unit_ids: [999999] })).status, 404);

  const once = { op_id: op(), token: s1.token, action: 'ready', unit_ids: [u1.id, u2.id] };
  const r1 = await d.kds('/api/kds/action', { method: 'POST', body: once });
  const r2 = await d.kds('/api/kds/action', { method: 'POST', body: once });
  assert.deepEqual(r1.data, r2.data);
  assert.equal(r1.data.changed, 2);
  assert.equal((await d.kds('/api/kds/board')).data.tickets[0].done, true);

  assert.equal((await v.admin(`/api/admin/units/${u1.id}/reassign`, { method: 'POST', body: { employee_id: petr.id } })).status, 400);
  assert.equal((await v.admin(`/api/admin/units/${u1.id}/reassign`, { method: 'POST', body: { employee_id: petr.id, reason: 'Делал Пётр' } })).status, 200);
  const makers = (await v.admin(`/api/admin/reports/makers?from=${today()}&to=${today()}`)).data;
  assert.deepEqual(makers.map((m) => [m.name, m.portions, m.earned]).sort(), [['Иван', 1, 30], ['Пётр', 1, 30]]);
  const anomalies = (await v.admin(`/api/admin/reports/anomalies?from=${today()}&to=${today()}`)).data;
  assert.equal(anomalies.corrections.length, 1);
  assert.equal(anomalies.corrections[0].details.reason, 'Делал Пётр');
  const audit = (await v.admin(`/api/admin/audit?check_id=${id}`)).data;
  assert.ok(audit.some((a) => a.action === 'order_received'));
  assert.ok(audit.some((a) => a.action === 'admin_reassign'));
  assert.ok(ivan.id);
});

test('one venue admin cannot reassign another venue portion', async () => {
  const a = await s.venue();
  const b = await s.venue();
  await staff(b, 'Б', '1212');
  const d = await screen(b, 'Бар');
  b.fake.add(b.fake.open(), 10, 1);
  await b.engine.pollOpen();
  const t = (await d.kds('/api/kds/login', { method: 'POST', body: { pin: '1212' } })).data.token;
  const u = (await d.kds('/api/kds/board')).data.tickets[0].units[0];
  await d.kds('/api/kds/action', { method: 'POST', body: { op_id: op(), token: t, action: 'ready', unit_ids: [u.id] } });
  const aEmp = (await a.admin('/api/admin/employees', { method: 'POST', body: { name: 'A' } })).data;
  assert.equal((await a.admin(`/api/admin/units/${u.id}/reassign`, { method: 'POST', body: { employee_id: aEmp.id, reason: 'x' } })).status, 409);
});

test('KDS: wrong PINs are rate-limited per screen', async () => {
  const v = await s.venue();
  await staff(v, 'Иван', '1111');
  const d = await screen(v, 'Бар');
  for (let i = 0; i < 5; i++) assert.equal((await d.kds('/api/kds/login', { method: 'POST', body: { pin: '0000' } })).status, 401);
  assert.equal((await d.kds('/api/kds/login', { method: 'POST', body: { pin: '1111' } })).status, 429, 'even the right PIN waits');
  const other = await screen(v, 'Бар');
  assert.equal((await other.kds('/api/kds/login', { method: 'POST', body: { pin: '1111' } })).status, 200, 'another screen is not blocked');
});

test('KDS: logout ends the session; summary and recipe endpoints', async () => {
  const v = await s.venue();
  await staff(v, 'Иван', '1111');
  const d = await screen(v, 'Бар');
  v.fake.add(v.fake.open(), 10, 3);
  await v.engine.pollOpen();
  const sum = (await d.kds('/api/kds/summary')).data;
  assert.equal(sum.total, 3);
  assert.equal(sum.ingredients.find((i) => i.name === 'Ром белый').amount, 150);
  assert.equal((await d.kds('/api/kds/recipe/10')).data.name, 'Мохито');
  assert.equal((await d.kds('/api/kds/recipe/424242')).status, 404);

  const t = (await d.kds('/api/kds/login', { method: 'POST', body: { pin: '1111' } })).data.token;
  await d.kds('/api/kds/logout', { method: 'POST', body: { token: t } });
  const u = (await d.kds('/api/kds/board')).data.tickets[0].units[0];
  assert.equal((await d.kds('/api/kds/action', { method: 'POST', body: { op_id: op(), token: t, action: 'take', unit_ids: [u.id] } })).status, 401);
});

test('KDS: a screen bound to one station never sees another station portion', async () => {
  const v = await s.venue({ preset: 'restaurant' });
  const kitchen = await screen(v, 'Кухня');
  const bar = await screen(v, 'Бар');
  const all = await screen(v, null);
  const id = v.fake.open();
  v.fake.add(id, 20, 1);
  v.fake.add(id, 10, 1);
  await v.engine.pollOpen();
  const names = async (d) => (await d.kds('/api/kds/board')).data.tickets.flatMap((t) => t.units.map((u) => u.name)).sort();
  assert.deepEqual(await names(kitchen), ['Бургер']);
  assert.deepEqual(await names(bar), ['Мохито']);
  assert.deepEqual(await names(all), ['Бургер', 'Мохито']);
});

test('expo over HTTP: serve, undo within the window, double serve is a no-op', async () => {
  const v = await s.venue({ preset: 'restaurant' });
  await staff(v, 'Раннер', '7777');
  const expo = await screen(v, 'Раздача');
  v.fake.add(v.fake.open(), 20, 1);
  await v.engine.pollOpen();
  const t = (await expo.kds('/api/kds/login', { method: 'POST', body: { pin: '7777' } })).data.token;
  const ticket = (await expo.kds('/api/kds/board')).data.tickets[0];
  const serve = (undo = false) => expo.kds(`/api/kds/tickets/${ticket.id}/serve`, { method: 'POST', body: { op_id: op(), token: t, undo } });
  assert.equal((await serve()).data.changed, 1);
  assert.equal((await serve()).data.changed, 0);
  assert.equal((await expo.kds('/api/kds/board')).data.tickets[0].done, true);
  assert.equal((await serve(true)).data.changed, 1);
  assert.equal((await expo.kds('/api/kds/board')).data.tickets[0].done, false);
  assert.equal((await expo.kds('/api/kds/tickets/999999/serve', { method: 'POST', body: { op_id: op(), token: t } })).status, 404);
});

test('fast food: a check paid at once reaches the kitchen on the fast poll; order number and pickup screen', async () => {
  const v = await s.venue({ preset: 'fastfood' });
  assert.deepEqual(v.stations.map((x) => x.name).sort(), ['Выдача', 'Кухня']);
  await staff(v, 'Повар', '3333');
  await staff(v, 'Кассир', '4444');
  const kitchen = await screen(v, 'Кухня');
  const pickup = await screen(v, 'Выдача');
  const id = v.fake.open({ table: '' });
  v.fake.transactions.get(String(id)).service_mode = '2';
  v.fake.add(id, 20, 2);
  v.fake.close(id);                      // paid before the screen ever saw it
  await v.engine.pollOpen();
  const board = (await kitchen.kds('/api/kds/board')).data;
  assert.equal(board.quickService, true);
  assert.equal(board.tickets.length, 1);
  assert.equal(board.tickets[0].service_mode, 2);
  const number = String(id % 1000).padStart(3, '0');

  const token = (await v.admin('/api/admin/pickup')).data.token;
  assert.equal((await v.admin('/api/admin/pickup')).data.token, token, 'the link is stable');
  const guests = s.client();
  let tv = (await guests(`/api/pickup/${token}`)).data;
  assert.deepEqual([tv.preparing, tv.ready], [[number], []]);

  const cook = (await kitchen.kds('/api/kds/login', { method: 'POST', body: { pin: '3333' } })).data.token;
  await kitchen.kds('/api/kds/action', { method: 'POST',
    body: { op_id: op(), token: cook, action: 'ready', unit_ids: board.tickets[0].units.map((u) => u.id) } });
  tv = (await guests(`/api/pickup/${token}`)).data;
  assert.deepEqual([tv.preparing, tv.ready], [[], [number]]);

  const cashier = (await pickup.kds('/api/kds/login', { method: 'POST', body: { pin: '4444' } })).data.token;
  await pickup.kds(`/api/kds/tickets/${board.tickets[0].id}/serve`, { method: 'POST', body: { op_id: op(), token: cashier } });
  tv = (await guests(`/api/pickup/${token}`)).data;
  assert.deepEqual([tv.preparing, tv.ready], [[], []], 'handed out: gone from the TV');

  const renewed = (await v.admin('/api/admin/pickup/renew', { method: 'POST', body: {} })).data.token;
  assert.notEqual(renewed, token);
  assert.equal((await guests(`/api/pickup/${token}`)).status, 404);
  assert.equal((await guests(`/api/pickup/${renewed}`)).status, 200);
  assert.equal((await guests('/pickup/')).status, 200);
});

test('the fast poll stays light: open checks, and in fast food closed check ids only', async () => {
  const v = await s.venue({ preset: 'restaurant' });
  const calls = [];
  const orig = v.fake.getTransactions.bind(v.fake);
  v.fake.getTransactions = (q) => { calls.push(`${q.status}${q.light ? ' light' : ''}`); return orig(q); };
  await v.engine.pollOpen();
  assert.deepEqual(calls, ['1']);
  // fast food: plus closed checks, ids only — never the whole day with items every few seconds
  await v.admin('/api/admin/settings', { method: 'PUT', body: { quick_service: true } });
  await v.engine.pollOpen();
  assert.deepEqual(calls, ['1', '1', '2 light']);
});

// ---- platform, onboarding, health ------------------------------------------------------

test('platform: name required, list shows health and counts, impersonation opens the venue admin', async () => {
  const p = await s.platform();
  assert.equal((await p('/api/platform/accounts', { method: 'POST', body: { name: '' } })).status, 400);
  const v = await s.venue({ name: 'Видимый' });
  const row = (await p('/api/platform/accounts')).data.find((a) => a.id === v.acc.id);
  assert.equal(row.name, 'Видимый');
  assert.equal(row.connected, true);
  assert.ok('health' in row && 'devices' in row && 'portions_24h' in row);
  await p(`/api/platform/accounts/${v.acc.id}/impersonate`, { method: 'POST' });
  assert.equal((await p('/api/admin/account')).data.id, v.acc.id);
});

test('OAuth/manage sign-in is unavailable until a Poster app is configured', async () => {
  const c = s.client();
  assert.equal((await c('/auth/poster/start')).status, 503);
  assert.equal((await c('/auth/poster/manage?code=x')).status, 400);
  assert.equal((await c('/api/admin/oauth')).data.enabled, false);
});

test('webhooks for unknown venues are logged and answered 200', async () => {
  const c = s.client();
  const r = await c('/webhooks/poster', { method: 'POST', body: { account: 'ghost', object: 'transaction', object_id: 1, action: 'changed', time: '1' } });
  assert.equal(r.status, 200);
  const { rows } = await s.db.query(`SELECT error FROM webhook_log WHERE payload->>'account' = 'ghost'`);
  assert.equal(rows[0].error, 'unknown account');
});

test('health: OK with version and venue counts', async () => {
  const r = await s.client()('/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.ok(r.data.version.length >= 8);
  assert.ok(r.data.venues >= 1);
});

test('static pages are served', async () => {
  const c = s.client();
  for (const path of ['/', '/kds/', '/admin/', '/platform/', '/manifest.json', '/sw.js', '/kds/kds.js', '/socket.io/socket.io.js']) {
    assert.equal((await c(path, { raw: true })).status, 200, path);
  }
});

test('the screen installs as an app: manifest with PNG icons that exist, icon for iPhone', async () => {
  const c = s.client();
  const m = (await c('/manifest.json')).data;
  assert.equal(m.start_url, '/kds/');
  const png = m.icons.filter((i) => i.type === 'image/png');
  for (const size of ['192x192', '512x512']) assert.ok(png.some((i) => i.sizes === size && i.purpose === 'any'), size);
  assert.ok(png.some((i) => i.purpose === 'maskable'), 'maskable icon for Android');
  for (const i of [...png, { src: '/apple-touch-icon.png' }]) {
    const res = await c(i.src, { raw: true });
    assert.equal(res.status, 200, i.src);
    assert.match(res.headers.get('content-type'), /image\/png/, i.src);
  }
  const html = (await c('/kds/', { raw: true })).data;
  assert.match(html, /rel="manifest"/);
  assert.match(html, /rel="apple-touch-icon"/);
});
