// Real browser against the real server: screens, offline taps, the pass,
// the summary panel, the admin panel, phones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, pollUntil } from './server-helper.js';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // Browser tests need Playwright: CI installs it, locally `npm i --no-save playwright`.
  console.log('# playwright not installed: browser tests skipped');
  process.exit(0);
}

let s;
let browser;
before(async () => {
  s = await startServer();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await s.close();
  await s.db.pool.end();
});

async function setupVenue(preset = 'bar') {
  const v = await s.venue({ preset });
  for (const [name, pin] of [['Иван', '1111'], ['Пётр', '2222']]) {
    const e = (await v.admin('/api/admin/employees', { method: 'POST', body: { name } })).data;
    await v.admin(`/api/admin/employees/${e.id}`, { method: 'PATCH', body: { pin } });
  }
  return v;
}

async function openScreen(v, stationName, viewport = { width: 1280, height: 800 }) {
  const station = v.stations.find((x) => x.name === stationName);
  const d = (await v.admin('/api/admin/devices', { method: 'POST', body: { name: stationName ?? 'все', station_id: station?.id ?? null } })).data;
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${s.base}/kds/#pair=${d.token}`);
  await page.click('#startBtn');
  page.errors = errors;
  return page;
}

async function pin(page, code) {
  for (const d of code) await page.click(`#pinGrid button:text-is("${d}")`);
  await page.click('#pinGrid button:text-is("OK")');
}

test('a new order appears on the open screen by itself, with table and waiter', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  await page.waitForSelector('#empty:not(.hidden)');
  const id = v.fake.open({ table: '12', waiter: 1, comment: 'Аллергия на орехи' });
  v.fake.add(id, 10, 2);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket', { timeout: 5000 });
  const text = await page.textContent('.ticket');
  assert.match(text, /Стол 12/);
  assert.match(text, /Анна/);
  assert.equal(await page.locator('.ticket .unit').count(), 2);
  assert.equal(await page.locator('.comment.alert').count(), 1, 'allergy comment highlighted');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('PIN, take, ready: the order leaves the board and lands in the done strip', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  v.fake.add(v.fake.open({ table: '5' }), 11, 1);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket .unit');
  await page.click('.ticket .unit');          // no one signed in yet: asks for the PIN
  await page.waitForSelector('#pinpad:not(.hidden)');
  await pin(page, '1111');
  await page.waitForSelector('.unit.taken');  // the tap that asked for the PIN is applied
  assert.match(await page.textContent('.unit.taken'), /взял: Иван/);
  await page.click('.unit.taken');
  await page.waitForSelector('.done-strip .done', { timeout: 5000 });
  assert.match(await page.textContent('.done-strip'), /Стол 5 · Иван/);
  const { rows } = await s.db.query(`SELECT status FROM units WHERE account_id = $1`, [v.acc.id]);
  assert.deepEqual(rows.map((r) => r.status), ['ready']);
  await page.close();
});

test('wrong PIN shows an error and lets you retry', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  await page.click('#addStaff');
  await pin(page, '9999');
  await page.waitForFunction(() => document.querySelector('#pinError').textContent.length > 0);
  assert.match(await page.textContent('#pinError'), /Неверный PIN/);
  await pin(page, '2222');
  await page.waitForSelector('#pinpad.hidden', { state: 'attached' });
  assert.match(await page.textContent('#staff'), /Пётр/);
  await page.close();
});

test('taps made without network are queued, shown as pending and delivered later', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  v.fake.add(v.fake.open(), 10, 1);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket .unit');
  await page.click('#addStaff');
  await pin(page, '1111');
  await page.waitForSelector('#pinpad.hidden', { state: 'attached' });

  await page.route('**/api/kds/action', (route) => route.abort('internetdisconnected'));
  await page.click('.ticket .unit');
  await page.waitForSelector('.unit.pending');
  await page.waitForFunction(() => /не отправлено: 1/.test(document.querySelector('#statusText').textContent));
  const before = (await s.db.query(`SELECT status FROM units WHERE account_id = $1`, [v.acc.id])).rows[0].status;
  assert.equal(before, 'new', 'nothing reached the server');

  await page.unroute('**/api/kds/action');
  await pollUntil(async () => (await s.db.query(`SELECT status FROM units WHERE account_id = $1`, [v.acc.id])).rows[0].status === 'taken',
    { timeout: 8000 });
  await page.waitForSelector('.unit.taken');
  assert.equal(await page.locator('.unit.pending').count(), 0);

  // The queue survives a reload of the page.
  await page.route('**/api/kds/action', (route) => route.abort('internetdisconnected'));
  await page.click('.unit.taken');
  await page.waitForSelector('.unit.pending');
  await page.unroute('**/api/kds/action');
  await page.reload();
  await page.click('#startBtn');
  await pollUntil(async () => (await s.db.query(`SELECT status FROM units WHERE account_id = $1`, [v.acc.id])).rows[0].status === 'ready',
    { timeout: 8000 });
  await page.close();
});

test('two people on shift: the screen asks who takes; ready goes to whoever took it', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  v.fake.add(v.fake.open(), 10, 1);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket .unit');
  await page.click('#addStaff');
  await pin(page, '1111');
  await page.click('#addStaff');
  await pin(page, '2222');                         // Иван and Пётр on shift
  await page.click('.ticket .unit');
  await page.waitForSelector('#picker:not(.hidden)');
  assert.match(await page.textContent('#pickTitle'), /Кто берёт/);
  await page.click('#pickGrid button:has-text("Иван")');
  await page.waitForSelector('.unit.taken');
  await page.click('.unit.taken');                 // no question: Иван took it, Иван is here
  await pollUntil(async () => (await s.db.query(
    `SELECT e.name FROM units u JOIN employees e ON e.id = u.ready_by WHERE u.account_id = $1`, [v.acc.id])).rows[0]?.name === 'Иван');
  assert.ok(await page.locator('#picker.hidden').count());
  await page.close();
});

test('fast food: order number and takeaway badge instead of a table', async () => {
  const v = await setupVenue();
  await v.admin('/api/admin/settings', { method: 'PUT', body: { quick_service: true } });
  const page = await openScreen(v, 'Бар');
  const id = v.fake.open({ table: '' });
  v.fake.transactions.get(String(id)).service_mode = '2';
  v.fake.add(id, 10, 1);
  v.fake.close(id);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket');
  assert.equal((await page.textContent('.ticket .table')).replace(/\s+/g, ' ').trim(), `№ ${String(id % 1000).padStart(3, '0')}С собой`);
  await page.close();
});

test('a Wolt order carries a Wolt badge on the card', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  v.fake.add(v.fake.open({ comment: 'Wolt #K7' }), 10, 1);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket .badge.agg');
  assert.equal(await page.textContent('.ticket .badge.agg'), 'Wolt');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('summary panel counts portions and ingredients; tapping a row highlights its orders; recipe opens', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  v.fake.add(v.fake.open({ table: '1' }), 10, 2);
  v.fake.add(v.fake.open({ table: '2' }), 11, 1);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket');
  await page.click('#summaryBtn');
  await page.waitForSelector('#summary:not(.hidden) .sum-row');
  assert.match(await page.textContent('#sumTotal'), /3/);
  await page.locator('.sum-row', { hasText: 'Мохито' }).click();
  await page.waitForSelector('.ticket.dim');
  assert.equal(await page.locator('.ticket.dim').count(), 1, 'the Негрони order is dimmed');
  await page.click('[data-st=ingredients]');
  assert.match(await page.textContent('#sumBody'), /100 мл\s*Ром белый/);
  await page.locator('.unit .info').first().click();
  await page.waitForSelector('#recipe:not(.hidden)');
  assert.match(await page.textContent('#recipeBody'), /Ром белый/);
  await page.close();
});

test('restaurant: kitchen marks ready, the pass sees 1/2, bar finishes, the runner serves', async () => {
  const v = await setupVenue('restaurant');
  const kitchen = await openScreen(v, 'Кухня');
  const bar = await openScreen(v, 'Бар');
  const pass = await openScreen(v, 'Раздача');
  const id = v.fake.open({ table: '8' });
  v.fake.add(id, 20, 1);
  v.fake.add(id, 10, 1);
  await v.engine.pollOpen();

  await kitchen.waitForSelector('.ticket .t-actions button');
  await kitchen.click('#addStaff');
  await pin(kitchen, '1111');
  await kitchen.click('.ticket .t-actions button');
  await pass.waitForFunction(() => /готово 1\/2/.test(document.querySelector('.ticket .meta')?.textContent ?? ''), null, { timeout: 5000 });

  await bar.waitForSelector('.ticket .t-actions button');
  await bar.click('#addStaff');
  await pin(bar, '2222');
  await bar.click('.ticket .t-actions button');
  await pass.waitForSelector('.ticket.all-ready', { timeout: 5000 });

  await pass.click('#addStaff');
  await pin(pass, '1111');
  await pass.click('.ticket.all-ready .t-actions button');
  await pass.waitForSelector('.done-strip .done', { timeout: 5000 });
  const { rows } = await s.db.query(`SELECT served_by FROM tickets WHERE account_id = $1`, [v.acc.id]);
  assert.ok(rows[0].served_by);
  for (const p of [kitchen, bar, pass]) { assert.deepEqual(p.errors, []); await p.close(); }
});

test('the screen reloads itself after a new version is deployed', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар');
  await page.waitForSelector('#empty:not(.hidden)');
  await page.route('**/api/kds/board', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, version: 'new-version' } });
  });
  const reloaded = page.waitForEvent('load', { timeout: 25000 });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  v.fake.add(v.fake.open(), 10, 1);
  await v.engine.pollOpen();       // triggers a board refresh, which sees the new version
  await reloaded;
  await page.close();
});

test('an unpaired device explains what to do', async () => {
  const page = await browser.newPage();
  await page.goto(`${s.base}/kds/`);
  assert.match(await page.textContent('#startMsg'), /Экран не подключён/);
  await page.close();
});

test('phone: no horizontal scrolling, one column', async () => {
  const v = await setupVenue();
  const page = await openScreen(v, 'Бар', { width: 375, height: 740 });
  for (let i = 0; i < 3; i++) v.fake.add(v.fake.open({ table: String(i) }), 10, 2);
  await v.engine.pollOpen();
  await page.waitForSelector('.ticket');
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  assert.ok(scroll <= client, `page ${scroll}px wide on a ${client}px screen`);
  const xs = await page.locator('.ticket').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left)))]);
  assert.equal(xs.length, 1, 'cards stack in one column');
  await page.close();
});

test('admin panel: sign in, reports show who made what, settings save', async () => {
  const v = await setupVenue();
  const d = (await v.admin('/api/admin/devices', { method: 'POST', body: { name: 'x' } })).data;
  const kds = s.client({ headers: { 'x-device-token': d.token } });
  v.fake.add(v.fake.open(), 10, 1);
  await v.engine.pollOpen();
  const t = (await kds('/api/kds/login', { method: 'POST', body: { pin: '1111' } })).data.token;
  const u = (await kds('/api/kds/board')).data.tickets[0].units[0];
  await kds('/api/kds/action', { method: 'POST', body: { op_id: 'e2e-1', token: t, action: 'ready', unit_ids: [u.id] } });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${s.base}/admin/`);
  await page.fill('#account', String(v.acc.id));
  await page.fill('#password', 'password-123');
  await page.click('#loginForm > button');
  await page.waitForSelector('table');
  assert.match(await page.textContent('main'), /Иван/);
  await page.click('[data-tab=settings]');
  await page.waitForSelector('#maker');
  await page.fill('#maker', 'Бармен');
  await page.click('#save');
  await pollUntil(async () => (await v.admin('/api/admin/settings')).data.maker_title === 'Бармен');
  for (const tab of ['anomalies', 'stations', 'employees', 'rates', 'devices', 'status']) {
    await page.click(`[data-tab=${tab}]`);
    await page.waitForSelector('main .card');
  }
  assert.deepEqual(errors, []);
  await page.close();
});
