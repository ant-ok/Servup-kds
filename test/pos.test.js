// The Poster register app and its server side: pairing by code, order status,
// instant events, CORS and frame headers, and the bundle itself running in a
// browser against a fake Poster terminal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer, pollUntil } from './server-helper.js';
import { buildBundle } from '../pos-app/build.mjs';
import { uploadForm } from '../pos-app/upload.mjs';
import { cookieAttrs } from '../src/auth.js';

let s;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); await s.db.pool.end(); });

const posDevice = async (v, body = {}) => (await v.admin('/api/admin/devices', { method: 'POST', body: { name: 'Касса', kind: 'pos', ...body } })).data;
const pair = (code, extra = {}) => s.client()('/api/pair', { method: 'POST', body: { code, ...extra } });
const as = (token) => s.client({ headers: { 'x-device-token': token } });

// ---- pairing ----------------------------------------------------------------------

test('pairing: a code connects once, returns a working token, stores the register number', async () => {
  const v = await s.venue();
  const d = await posDevice(v);
  assert.match(d.pair_code, /^\d{6}$/);
  const r = await pair(d.pair_code, { tablet: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.data.device.kind, 'pos');
  assert.equal((await as(r.data.token)('/api/kds/me')).status, 200);
  assert.equal((await pair(d.pair_code)).status, 404, 'a code works once');
  const row = (await v.admin('/api/admin/devices')).data.find((x) => x.id === d.id);
  assert.equal(row.poster_tablet_id, 3);
  assert.equal(row.kind, 'pos');
});

test('pairing: expired code refused; a new code disconnects the old tablet', async () => {
  const v = await s.venue();
  const d = await posDevice(v);
  await s.db.query(`UPDATE devices SET pair_exp = now() - interval '1 minute' WHERE id = $1`, [d.id]);
  assert.equal((await pair(d.pair_code)).status, 404);

  const fresh = (await v.admin(`/api/admin/devices/${d.id}/code`, { method: 'POST', body: {} })).data.pair_code;
  const first = (await pair(fresh)).data.token;
  const again = (await v.admin(`/api/admin/devices/${d.id}/code`, { method: 'POST', body: {} })).data.pair_code;
  const second = (await pair(again)).data.token;
  assert.equal((await as(first)('/api/kds/me')).status, 401, 'the replaced tablet lost access');
  assert.equal((await as(second)('/api/kds/me')).status, 200);
  assert.equal((await v.admin('/api/admin/devices/999999/code', { method: 'POST', body: {} })).status, 404);
});

test('pairing: code for a disabled venue does not work; guessing is rate-limited', async () => {
  const v = await s.venue();
  const d = await posDevice(v);
  const p = await s.platform();
  await p(`/api/platform/accounts/${v.acc.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await pair(d.pair_code)).status, 404);
  await p(`/api/platform/accounts/${v.acc.id}`, { method: 'PATCH', body: { active: true } });

  const c = s.client({ headers: { 'x-forwarded-for': '203.0.113.7' } });
  let last;
  for (let i = 0; i < 11; i++) last = await c('/api/pair', { method: 'POST', body: { code: String(100000 + i) } });
  assert.equal(last.status, 429);
});

test('a screen can be paired by code too', async () => {
  const v = await s.venue();
  const d = (await v.admin('/api/admin/devices', { method: 'POST', body: { name: 'Экран бара' } })).data;
  assert.ok(d.token && d.pair_code, 'both a link and a code');
  const r = await pair(d.pair_code);
  assert.equal(r.data.device.kind, 'screen');
  assert.equal((await as(d.token)('/api/kds/me')).status, 401, 'pairing by code replaces the link token');
});

// ---- order status and events -------------------------------------------------------------

async function pairedRegister(v) {
  const d = await posDevice(v);
  return as((await pair(d.pair_code, { tablet: 1 })).data.token);
}

test('order status: by check id, by table as a fallback, not found', async () => {
  const v = await s.venue({ preset: 'restaurant' });
  const pos = await pairedRegister(v);
  const id = v.fake.open({ table: '14', tablet: 1 });
  v.fake.add(id, 20, 2);
  v.fake.add(id, 10, 1);
  await v.engine.pollOpen();

  const byId = (await pos(`/api/pos/order-status?ids=${id}`)).data;
  assert.equal(byId.found, true);
  assert.equal(byId.check.table, '14');
  assert.equal(byId.total, 3);
  assert.equal(byId.ready, 0);
  assert.deepEqual(byId.stations.map((x) => [x.name, x.total, x.waiting]), [['Кухня', 2, 2], ['Бар', 1, 1]]);

  const byTable = (await pos('/api/pos/order-status?ids=local-77&table=14&tablet=1')).data;
  assert.equal(byTable.check.id, id, 'local ids that mean nothing to the server fall back to the table');
  assert.equal((await pos('/api/pos/order-status?ids=424242')).data.found, false);
  assert.equal((await pos('/api/pos/order-status')).data.found, false);
});

test('order status follows the kitchen: taken, ready, served', async () => {
  const v = await s.venue({ preset: 'restaurant' });
  const pos = await pairedRegister(v);
  const e = (await v.admin('/api/admin/employees', { method: 'POST', body: { name: 'Повар' } })).data;
  await v.admin(`/api/admin/employees/${e.id}`, { method: 'PATCH', body: { pin: '3131' } });
  const screen = as((await v.admin('/api/admin/devices', { method: 'POST', body: { name: 'k' } })).data.token);
  const id = v.fake.open({ table: '2' });
  v.fake.add(id, 20, 1);
  await v.engine.pollOpen();
  const t = (await screen('/api/kds/login', { method: 'POST', body: { pin: '3131' } })).data.token;
  const board = (await screen('/api/kds/board')).data.tickets[0];
  await screen('/api/kds/action', { method: 'POST', body: { op_id: 'p1', token: t, action: 'take', unit_ids: [board.units[0].id] } });
  let st = (await pos(`/api/pos/order-status?ids=${id}`)).data;
  assert.deepEqual([st.units[0].status, st.units[0].takenBy], ['taken', 'Повар']);
  await screen('/api/kds/action', { method: 'POST', body: { op_id: 'p2', token: t, action: 'ready', unit_ids: [board.units[0].id] } });
  st = (await pos(`/api/pos/order-status?ids=${id}`)).data;
  assert.equal(st.allReady, true);
  await screen(`/api/kds/tickets/${board.id}/serve`, { method: 'POST', body: { op_id: 'p3', token: t } });
  st = (await pos(`/api/pos/order-status?ids=${id}`)).data;
  assert.deepEqual([st.served, st.servedBy], [true, 'Повар']);
});

test('event from the register: the check is fetched right away', async () => {
  const v = await s.venue();
  const pos = await pairedRegister(v);
  const id = v.fake.open();
  v.fake.add(id, 13, 2);
  v.fake.close(id);
  const r = await pos('/api/pos/event', { method: 'POST', body: { type: 'closed', ids: [id, 'local-1'] } });
  assert.deepEqual(r.data, { ok: true, queued: 1 });
  await pollUntil(async () => (await s.db.query(
    'SELECT count(*)::int AS n FROM units u JOIN transactions t ON t.id = u.transaction_id WHERE t.account_id = $1 AND t.poster_transaction_id = $2',
    [v.acc.id, id])).rows[0].n === 2);
  assert.equal((await pos('/api/pos/event', { method: 'POST', body: { type: 'closed' } })).data.queued, 0, 'no ids: a poll instead');
});

test('register endpoints need a device token', async () => {
  const anon = s.client();
  assert.equal((await anon('/api/pos/order-status?ids=1')).status, 401);
  assert.equal((await anon('/api/pos/event', { method: 'POST', body: {} })).status, 401);
});

// ---- headers ------------------------------------------------------------------------------

test('CORS: register calls from Poster origins are allowed, preflight answered', async () => {
  const res = await fetch(`${s.base}/api/pos/order-status`, { method: 'OPTIONS',
    headers: { origin: 'https://pos.ps', 'access-control-request-method': 'GET', 'access-control-request-headers': 'x-device-token' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers'), /x-device-token/);
  const admin = await fetch(`${s.base}/api/admin/status`, { headers: { origin: 'https://evil.example' } });
  assert.equal(admin.headers.get('access-control-allow-origin'), null, 'the cookie-based admin API is not opened up');
});

test('pages may be framed by Poster only; cookies work inside Poster over HTTPS', async () => {
  const res = await fetch(`${s.base}/admin/`);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'self' .*https:\/\/\*\.joinposter\.com/);
  assert.match(csp, /pos\.ps/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(cookieAttrs('https://kds.example.com'), 'SameSite=None; Secure; Partitioned');
  assert.equal(cookieAttrs('http://192.168.1.10'), 'SameSite=Lax', 'plain HTTP keeps Lax (None needs Secure)');
});

// ---- the bundle ----------------------------------------------------------------------------

test('build bakes the KDS address in; upload is signed like Poster expects', async () => {
  const b = buildBundle('https://kds.example.com/');
  assert.ok(b.includes('"https://kds.example.com"'));
  assert.ok(!b.includes("'__KDS_URL__'"));
  assert.throws(() => buildBundle('kds.example.com'), /http/);
  assert.ok(buildBundle('').includes('"__KDS_URL__"'), 'no address: asked for at pairing');

  const form = uploadForm({ appId: 123, appSecret: 'sec', bundle: b });
  const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
  assert.equal(form.get('application_id'), '123');
  assert.equal(form.get('sign'), md5(`123:${md5(b)}:sec`));
  assert.equal(await form.get('bundle').text(), b);
});

// A fake Poster terminal: records icons and popups, fires events on demand.
const harness = (bundle, { order, tablet = 1 } = {}) => `<!doctype html><html><head></head><body>
<div id="app-container"></div>
<script>
  window.__calls = { icons: null, popups: [], closed: 0 };
  const handlers = {};
  window.Poster = {
    settings: { accountUrl: 'testbar', spotTabletId: ${tablet} },
    interface: {
      showApplicationIconAt: (o) => { window.__calls.icons = o; },
      popup: (o) => { window.__calls.popups.push(o); },
      closePopup: () => { window.__calls.closed++; (handlers.afterPopupClosed || []).forEach((f) => f()); },
    },
    orders: { getActive: async () => ({ order: ${JSON.stringify(order ?? null)} }) },
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
  };
  window.__fire = (ev, data) => (handlers[ev] || []).forEach((f) => f(data));
</script>
<script>${bundle}</script></body></html>`;

let browser;
const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* skipped below */ }

test('the bundle in a fake Poster terminal: pairing, readiness, close event, the board', { skip: !chromium }, async () => {
  // Both sides are on localhost here; Chrome's Local Network Access check would
  // ask the user. In production the register talks to a public HTTPS server.
  browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights'] });
  try {
    const v = await s.venue();
    const e = (await v.admin('/api/admin/employees', { method: 'POST', body: { name: 'Бармен' } })).data;
    await v.admin(`/api/admin/employees/${e.id}`, { method: 'PATCH', body: { pin: '4545' } });
    const id = v.fake.open({ table: '6', tablet: 1 });
    v.fake.add(id, 10, 2);
    await v.engine.pollOpen();
    const d = await posDevice(v);

    // Served from another origin, as inside Poster: exercises CORS for real.
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const foreign = s.base.replace('localhost', '127.0.0.1');
    await page.route(`${foreign}/pos-harness`, (route) => route.fulfill({
      contentType: 'text/html', body: harness(buildBundle(s.base), { order: { id: 9001, tableName: '6' } }) }));
    await page.goto(`${foreign}/pos-harness`);

    const icons = await page.evaluate(() => window.__calls.icons);
    assert.deepEqual(icons, { order: 'Готовность', functions: 'KDS' });

    // Not connected yet: the button asks for the code.
    await page.evaluate(() => window.__fire('applicationIconClicked', { place: 'order' }));
    await page.waitForSelector('#kdsp-code');
    assert.equal(await page.inputValue('#kdsp-url'), s.base);
    await page.fill('#kdsp-code', '000000');
    await page.click('#kdsp-pair button');
    await page.waitForFunction(() => /не подошёл/.test(document.querySelector('#kdsp-err').textContent), null, { timeout: 8000 })
      .catch(async (err) => { console.log('ERRTEXT:', await page.textContent('#kdsp-err'), errors); throw err; });
    await page.fill('#kdsp-code', d.pair_code);
    await page.click('#kdsp-pair button');

    // Paired: shows readiness (the local id 9001 is unknown, the table finds it).
    await page.waitForFunction(() => /Готово 0 из 2/.test(document.body.textContent), null, { timeout: 8000 })
      .catch(async (err) => { console.log('BODY:', await page.textContent('body'), errors); throw err; });
    assert.match(await page.textContent('#app-container'), /Стол 6/);
    const token = await page.evaluate(() => window.__kdsPos.connection().token);
    assert.ok(token);

    // The bar finishes; the open window updates by itself.
    const screen = as(token);
    const t = (await screen('/api/kds/login', { method: 'POST', body: { pin: '4545' } })).data.token;
    const units = (await screen('/api/kds/board')).data.tickets[0].units.map((u) => u.id);
    await screen('/api/kds/action', { method: 'POST', body: { op_id: 'pos-e2e', token: t, action: 'ready', unit_ids: units } });
    await page.waitForFunction(() => /Всё готово/.test(document.body.textContent), null, { timeout: 8000 });
    await page.evaluate(() => window.Poster.interface.closePopup());

    // Closing a check in the register syncs it at once.
    const quick = v.fake.open({ table: '1' });
    v.fake.add(quick, 13, 1);
    v.fake.close(quick);
    await page.evaluate((qid) => window.__fire('afterOrderClose', { order: { id: qid } }), quick);
    await pollUntil(async () => (await s.db.query(
      'SELECT count(*)::int AS n FROM units u JOIN transactions t ON t.id = u.transaction_id WHERE t.poster_transaction_id = $1 AND t.account_id = $2',
      [quick, v.acc.id])).rows[0].n === 1, { timeout: 5000 });

    // "Функции" → the station screen in a frame. It survives a page reload (token kept).
    await page.reload();
    await page.evaluate(() => window.__fire('applicationIconClicked', { place: 'functions' }));
    const src = await page.getAttribute('#kdsp-frame', 'src');
    assert.ok(src.startsWith(`${s.base}/kds/?embed=1#pair=`));
    const popups = await page.evaluate(() => window.__calls.popups);
    assert.equal(popups.at(-1).title, 'KDS');
    assert.deepEqual(errors, []);
    await page.close();

    // Same-origin host so frame-ancestors 'self' lets the board render inside.
    const local = await browser.newPage();
    await local.route(`${s.base}/pos-harness`, (route) => route.fulfill({
      contentType: 'text/html', body: harness(buildBundle(s.base)) }));
    await local.goto(`${s.base}/pos-harness`);
    await local.evaluate((tok) => localStorage.setItem('kds_pos:testbar', JSON.stringify({ url: location.origin, token: tok })), token);
    await local.reload();
    await local.evaluate(() => window.__fire('applicationIconClicked', { place: 'functions' }));
    const frame = await (await local.waitForSelector('#kdsp-frame')).contentFrame();
    await frame.waitForSelector('.ticket, #empty:not(.hidden)', { timeout: 8000 })
      .catch(async (err) => { console.log('FRAME:', frame.url(), await frame.content().catch((e) => e.message)); throw err; });
    assert.equal(await frame.locator('#start.hidden').count(), 1, 'embedded screen starts by itself');
    await local.close();
  } finally {
    await browser.close();
  }
});

test('the bundle asks to pair again when its device was disconnected', { skip: !chromium }, async () => {
  const b = await chromium.launch();
  try {
    const v = await s.venue();
    const d = await posDevice(v);
    const token = (await pair(d.pair_code)).data.token;
    await v.admin(`/api/admin/devices/${d.id}`, { method: 'DELETE' });
    const page = await b.newPage();
    await page.route(`${s.base}/pos-harness`, (route) => route.fulfill({ contentType: 'text/html', body: harness(buildBundle(s.base), { order: { id: 1 } }) }));
    await page.goto(`${s.base}/pos-harness`);
    await page.evaluate((tok) => localStorage.setItem('kds_pos:testbar', JSON.stringify({ url: location.origin, token: tok })), token);
    await page.reload();
    await page.evaluate(() => window.__fire('applicationIconClicked', { place: 'order' }));
    await page.waitForSelector('#kdsp-code', { timeout: 5000 });
  } finally {
    await b.close();
  }
});
