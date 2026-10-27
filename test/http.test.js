import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { db, resetDb, FakePoster } from './helpers.js';
import { createApp } from '../src/app.js';
import { EngineManager } from '../src/sync/engine.js';
import { oauthState } from '../src/auth.js';

let server;
let base;
const fakes = new Map(); // poster token -> FakePoster
const engines = new EngineManager({ posterFor: (token) => fakes.get(token) ?? new FakePoster() });

before(async () => {
  await resetDb();
  const app = createApp({
    engines, notify: () => {},
    exchangeCode: async ({ account }) => ({ access_token: `tok-${account}`, account }),
  });
  server = http.createServer(app).listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  engines.stopAll();
  server.close();
  await db.pool.end();
});

// Tiny cookie-keeping client.
function client() {
  let cookie = '';
  return async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* html/redirect */ }
    return { status: res.status, data, location: res.headers.get('location') };
  };
}

test('venue connects through Poster OAuth and lands in its admin panel', async () => {
  fakes.set('tok-cafe', new FakePoster());
  const c = client();
  const r = await c(`/auth/poster/callback?code=abc&account=cafe&state=${encodeURIComponent(oauthState('restaurant'))}`);
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin/');
  const st = await c('/api/admin/stations');
  assert.deepEqual(st.data.map((s) => s.name), ['Кухня', 'Бар', 'Раздача']);
});

test('OAuth callback with a forged state is refused', async () => {
  const r = await client()('/auth/poster/callback?code=abc&account=evil&state=1.2.3');
  assert.equal(r.status, 400);
});

test('webhooks are routed to the right venue by Poster account', async () => {
  const p = client();
  assert.equal((await p('/api/platform/login', { method: 'POST', body: { password: 'platform' } })).status, 200);
  const fake = new FakePoster();
  fakes.set('tok-bar1', fake);
  const acc = (await p('/api/platform/accounts', { method: 'POST', body: { name: 'Бар 1', poster_account: 'bar1', token: 'tok-bar1', password: 'secret123' } })).data;

  const id = fake.open({ table: '4' });
  fake.add(id, 10, 1);
  await p('/webhooks/poster', { method: 'POST', body: { account: 'bar1', object: 'transaction', object_id: id, action: 'changed', time: '1' } });
  await new Promise((r) => setTimeout(r, 200));
  await engines.get(acc.id).idle();

  const { rows } = await db.query('SELECT account_id FROM transactions WHERE poster_transaction_id = $1', [id]);
  assert.deepEqual(rows.map((r) => r.account_id), [acc.id]);
  const log = await db.query(`SELECT account_id FROM webhook_log ORDER BY id DESC LIMIT 1`);
  assert.equal(log.rows[0].account_id, acc.id);
});

test('one venue admin cannot touch another venue', async () => {
  const p = client();
  await p('/api/platform/login', { method: 'POST', body: { password: 'platform' } });
  await p('/api/platform/accounts', { method: 'POST', body: { name: 'A', poster_account: 'aaa', password: 'password-a' } });
  await p('/api/platform/accounts', { method: 'POST', body: { name: 'B', poster_account: 'bbb', password: 'password-b' } });

  const a = client();
  assert.equal((await a('/api/admin/login', { method: 'POST', body: { account: 'aaa', password: 'wrong' } })).status, 401);
  assert.equal((await a('/api/admin/login', { method: 'POST', body: { account: 'aaa', password: 'password-a' } })).status, 200);

  const b = client();
  await b('/api/admin/login', { method: 'POST', body: { account: 'bbb', password: 'password-b' } });
  const bEmp = (await b('/api/admin/employees', { method: 'POST', body: { name: 'Сотрудник B' } })).data;

  const r = await a(`/api/admin/employees/${bEmp.id}`, { method: 'PATCH', body: { pin: '1234' } });
  assert.equal(r.status, 404);
  assert.ok(!(await a('/api/admin/employees')).data.some((e) => e.id === bEmp.id));

  const bStation = (await b('/api/admin/stations')).data[0];
  const dev = await a('/api/admin/devices', { method: 'POST', body: { name: 'x', station_id: bStation.id } });
  assert.equal(dev.status, 404);
});

test('a KDS screen only works with its own token', async () => {
  const p = client();
  await p('/api/platform/login', { method: 'POST', body: { password: 'platform' } });
  await p('/api/platform/accounts', { method: 'POST', body: { name: 'C', poster_account: 'ccc', password: 'password-c' } });
  const admin = client();
  await admin('/api/admin/login', { method: 'POST', body: { account: 'ccc', password: 'password-c' } });
  const dev = (await admin('/api/admin/devices', { method: 'POST', body: { name: 'Экран' } })).data;

  const kds = client();
  assert.equal((await kds('/api/kds/board', { headers: { 'x-device-token': 'nope' } })).status, 401);
  const ok = await kds('/api/kds/board', { headers: { 'x-device-token': dev.token } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.station.name, 'Все станции');
});

test('application webhook: a signed token update is applied, an unsigned one ignored, uninstall revokes', async () => {
  const crypto = await import('node:crypto');
  const p = client();
  await p('/api/platform/login', { method: 'POST', body: { password: 'platform' } });
  const acc = (await p('/api/platform/accounts', { method: 'POST', body: { name: 'D', poster_account: 'ddd', token: 'old' } })).data;
  const sign = (b) => crypto.createHash('md5')
    .update([b.account, b.object, b.object_id, b.action, b.data, b.time, 'poster-secret'].filter((x) => x !== undefined).join(';')).digest('hex');
  const hook = (b) => p('/webhooks/poster', { method: 'POST', body: b });
  const token = async () => (await db.query('SELECT poster_token FROM accounts WHERE id = $1', [acc.id])).rows[0].poster_token;
  const settle = () => new Promise((r) => setTimeout(r, 150));

  const forged = { account: 'ddd', object: 'application', object_id: 1, action: 'changed', time: '1', data: JSON.stringify({ access_token: 'evil' }), verify: 'x' };
  await hook(forged);
  await settle();
  assert.equal(await token(), 'old');

  const update = { account: 'ddd', object: 'application', object_id: 1, action: 'changed', time: '2', data: JSON.stringify({ access_token: 'new' }) };
  await hook({ ...update, verify: sign(update) });
  await settle();
  assert.equal(await token(), 'new');

  const removed = { account: 'ddd', object: 'application', object_id: 1, action: 'removed', time: '3' };
  await hook({ ...removed, verify: sign(removed) });
  await settle();
  assert.equal(await token(), null);
});
