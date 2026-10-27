import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, units, resetDb, venue, staff, act, serve, unitsOf, board } from './helpers.js';
import * as reports from '../src/reports.js';
import { stationResolver } from '../src/sync/reconcile.js';

let v;
beforeEach(async () => { await resetDb(); v = await venue(); });
after(() => db.pool.end());

const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); // business day with 06:00 start
const range = (extra = {}) => ({ accountId: v.accountId, from: today(), to: today(), ...extra });
const poll = (x = v) => x.engine.pollOpen();

test('order reaches the bar screen with table, waiter, only bar items', async () => {
  const id = v.fake.open({ table: '7', waiter: 1, comment: 'без льда' });
  v.fake.add(id, 10, 2);
  v.fake.add(id, 20, 1); // kitchen workshop: no kitchen station in the bar preset
  v.fake.add(id, 12, 1, '1');
  await poll();

  const us = await unitsOf(v, id);
  assert.deepEqual(us.map((u) => u.name), ['Мохито', 'Мохито', 'Латте']);
  assert.equal(us[2].modifiers, 'Овсяное молоко');
  const [ticket] = await board(v.device);
  assert.equal(ticket.table_name, '7');
  assert.equal(ticket.waiter_name, 'Анна (официант)');
  assert.equal(ticket.comment, 'без льда');
  assert.equal(ticket.round, 1);
});

test('webhook + poll + full poll for the same check never duplicate portions', async () => {
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  v.engine.enqueue(id);
  await v.engine.idle();
  await v.engine.pollFull();
  await poll();
  assert.equal((await unitsOf(v, id)).length, 1);
});

test('additional order creates a second ticket ("дозаказ")', async () => {
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  v.fake.add(id, 10, 1);
  v.fake.add(id, 11, 1);
  await poll();
  assert.deepEqual((await board(v.device)).map((t) => [t.round, t.units.length]), [[1, 1], [2, 2]]);
});

test('removing from check cancels untouched portions first, made ones are flagged', async () => {
  const a = await staff(v, 'Иван', '1111');
  const id = v.fake.open();
  v.fake.add(id, 10, 3);
  await poll();
  const [u1, u2] = await unitsOf(v, id);
  await act(a, 'ready', [u1.id]);
  await act(a, 'take', [u2.id]);

  v.fake.remove(id, 10, 1);
  await poll();
  assert.deepEqual((await unitsOf(v, id)).map((u) => u.status), ['ready', 'taken', 'cancelled']);

  v.fake.remove(id, 10, 2);
  await poll();
  const us = await unitsOf(v, id);
  assert.deepEqual(us.map((u) => u.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(us[0].made_then_removed, true);
  assert.equal(us[0].ready_by, a.id, 'who made it is preserved');
});

test('deleted check stays on screen as cancelled until dismissed', async () => {
  const id = v.fake.open();
  v.fake.add(id, 10, 2);
  await poll();
  v.fake.delete(id);
  await v.engine.pollFull();
  assert.ok((await unitsOf(v, id)).every((u) => u.status === 'cancelled'));
  const [ticket] = await board(v.device);
  assert.equal(ticket.done, false);
  await units.dismissTicket(ticket.id, v.device);
  assert.equal((await board(v.device)).length, 0);
});

test('anyone can make it; credit goes to who marks ready; interception is audited', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const petr = await staff(v, 'Пётр', '2222');
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(v, id);

  await act(ivan, 'take', [u.id]);
  await assert.rejects(act(petr, 'take', [u.id]), /Уже взято/);
  await act(petr, 'ready', [u.id]);

  const [after1] = await unitsOf(v, id);
  assert.equal(after1.ready_by, petr.id);
  assert.equal(after1.taken_by, ivan.id);
  const { rows } = await db.query(`SELECT details FROM audit_log WHERE action='ready' AND unit_id=$1`, [u.id]);
  assert.equal(rows[0].details.prevTakenBy, ivan.id);
});

test('a retried tap with the same op_id is applied once', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(v, id);
  const call = (action) => units.applyAction({ opId: 'same', token: ivan.token, action, unitIds: [u.id], device: v.device });
  const r1 = await call('ready');
  await call('undo').catch(() => {});
  const r2 = await call('ready');
  assert.deepEqual(r1, r2);
  assert.equal((await unitsOf(v, id))[0].status, 'ready');
});

test('simultaneous taps by two people credit exactly one', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const petr = await staff(v, 'Пётр', '2222');
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(v, id);
  const res = await Promise.all([act(ivan, 'ready', [u.id]), act(petr, 'ready', [u.id])]);
  assert.equal(res.reduce((s, r) => s + r.changed, 0), 1);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='ready'`);
  assert.equal(rows[0].n, 1);
});

test('undo only by the same person; ticket returns to the board', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const petr = await staff(v, 'Пётр', '2222');
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(v, id);
  await act(ivan, 'ready', [u.id]);
  assert.equal((await board(v.device))[0].done, true);
  await assert.rejects(act(petr, 'undo', [u.id]), /только тот/);
  await act(ivan, 'undo', [u.id]);
  assert.equal((await unitsOf(v, id))[0].status, 'taken');
  assert.equal((await board(v.device))[0].done, false);
});

test('reports: piece rates are snapshotted, sellers get closed-check sums', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const petr = await staff(v, 'Пётр', '2222');
  await db.query(`INSERT INTO product_rates (account_id, poster_product_id, rate) VALUES ($1, 10, 30), ($1, 11, 50)`, [v.accountId]);

  const id = v.fake.open({ waiter: 1 });
  v.fake.add(id, 10, 2);
  v.fake.add(id, 11, 1);
  await poll();
  const [m1, m2, n1] = await unitsOf(v, id);
  await act(ivan, 'ready', [m1.id, n1.id]);
  await act(petr, 'ready', [m2.id]);
  await db.query(`UPDATE product_rates SET rate = 999`);

  v.fake.close(id);
  await poll();

  const b = await reports.makers(range());
  assert.deepEqual(b.map((r) => [r.name, r.portions, r.earned]), [['Иван', 2, 80], ['Пётр', 1, 30]]);

  const s = await reports.sellers(range());
  assert.equal(s.length, 1);
  assert.equal(s[0].name, 'Анна (официант)');
  assert.equal(s[0].checks, 1);
  assert.equal(s[0].payed, 1500); // 3 × 500 ₽, Poster sends kopecks
  assert.equal(s[0].kds_portions, 3);

  const d = await reports.details(range());
  assert.deepEqual(d.map((r) => r.made_by), ['Иван', 'Пётр', 'Иван']);
  assert.ok(d.every((r) => r.sold_by === 'Анна (официант)'));
});

test('made-then-removed is credited by default and listed as anomaly', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  await db.query(`INSERT INTO product_rates (account_id, poster_product_id, rate) VALUES ($1, 10, 30)`, [v.accountId]);
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  await act(ivan, 'ready', [(await unitsOf(v, id))[0].id]);
  v.fake.remove(id, 10, 1);
  await poll();

  assert.equal((await reports.makers(range()))[0].earned, 30);
  assert.equal((await reports.anomalies(range())).removed.length, 1);

  await db.query(`UPDATE settings SET value = 'false' WHERE key = 'credit_made_then_removed'`);
  assert.equal((await reports.makers(range()))[0].earned, 0);
});

test('old checks never flood the screen but are kept for reports', async () => {
  const id = v.fake.open({ openedAt: Date.now() - 2 * 24 * 3600e3 });
  v.fake.add(id, 10, 2);
  await v.engine.pollFull();
  assert.equal((await unitsOf(v, id)).length, 0);
  const { rows } = await db.query('SELECT 1 FROM transactions WHERE poster_transaction_id = $1', [id]);
  assert.equal(rows.length, 1);
});

test('a product created after catalog sync is resolved by refreshing the catalog', async () => {
  v.fake.products.push({ product_id: '30', product_name: 'Апероль шприц', workshop: '1', modifications: [] });
  const id = v.fake.open();
  v.fake.add(id, 30, 1);
  await poll();
  assert.deepEqual((await unitsOf(v, id)).map((u) => u.name), ['Апероль шприц']);
});

test('quick-service: check paid and closed before the poll still reaches the screen', async () => {
  const id = v.fake.open();
  v.fake.add(id, 13, 2);
  v.fake.close(id);
  await v.engine.pollFull();
  assert.equal((await unitsOf(v, id)).length, 2);
});

test('a check closed in Poster is picked up by the next fast poll', async () => {
  const id = v.fake.open({ waiter: 2 });
  v.fake.add(id, 10, 1);
  await poll();
  v.fake.close(id);
  await poll();
  const { rows } = await db.query('SELECT status, payed_sum FROM transactions WHERE poster_transaction_id = $1', [id]);
  assert.deepEqual(rows[0], { status: 2, payed_sum: 500 });
});

// ---- restaurants: several stations and the pass ----------------------------

test('restaurant: kitchen and bar items split to their screens by workshop', async () => {
  const r = await venue({ preset: 'restaurant' });
  const kitchen = await r.screen('Кухня');
  const bar = await r.screen('Бар');
  const id = r.fake.open({ table: '12' });
  r.fake.add(id, 20, 2); // burger, workshop "Кухня"
  r.fake.add(id, 10, 1); // mojito, workshop "Бар"
  await poll(r);

  const k = await board(kitchen);
  const b = await board(bar);
  assert.deepEqual(k[0].units.map((u) => u.name), ['Бургер', 'Бургер']);
  assert.deepEqual(b[0].units.map((u) => u.name), ['Мохито']);
  assert.equal(k[0].id, b[0].id, 'same order, one ticket');
});

test('restaurant: kitchen finishing does not hide the order from the bar', async () => {
  const r = await venue({ preset: 'restaurant' });
  const kitchen = await r.screen('Кухня');
  const bar = await r.screen('Бар');
  const cook = await staff({ ...r, device: kitchen }, 'Повар', '3333');
  const id = r.fake.open();
  r.fake.add(id, 20, 1);
  r.fake.add(id, 10, 1);
  await poll(r);
  const burger = (await unitsOf(r, id)).find((u) => u.name === 'Бургер');
  await act(cook, 'ready', [burger.id]);
  assert.equal((await board(kitchen))[0].done, true);
  assert.equal((await board(bar))[0].done, false);
});

test('restaurant: expo sees the whole order and records who served it', async () => {
  const r = await venue({ preset: 'restaurant' });
  const expo = await r.screen('Раздача');
  const cook = await staff({ ...r, device: expo }, 'Повар', '3333');
  const runner = await staff({ ...r, device: expo }, 'Официант', '4444');
  const id = r.fake.open();
  r.fake.add(id, 20, 1);
  r.fake.add(id, 10, 1);
  await poll(r);
  await act(cook, 'ready', (await unitsOf(r, id)).map((u) => u.id));

  const [ticket] = await board(expo);
  assert.deepEqual(ticket.units.map((u) => u.station_name).sort(), ['Бар', 'Кухня']);
  assert.ok(ticket.units.every((u) => u.status === 'ready'));
  await serve(runner, ticket.id);
  assert.equal((await board(expo))[0].done, true);

  const rr = await reports.runners({ accountId: r.accountId, from: today(), to: today() });
  assert.deepEqual(rr.map((x) => [x.name, x.tickets]), [['Официант', 1]]);
  const st = await reports.stations({ accountId: r.accountId, from: today(), to: today() });
  assert.deepEqual(st.map((x) => [x.name, x.portions]), [['Бар', 1], ['Кухня', 1]]);
});

test('station routing: explicit workshops win, then name match, then catch-all', () => {
  const ws = new Map([[1, 'Бар'], [2, 'Кухня горячая'], [3, 'Кухня холодная'], [4, 'Пицца']]);
  const st = (id, name, workshop_ids = [], kind = 'prep') => ({ id, name, kind, workshop_ids, active: true, sort: id });
  const r1 = stationResolver([st(1, 'Кухня'), st(2, 'Бар')], ws);
  assert.deepEqual([1, 2, 3, 4].map(r1), [2, 1, 1, null], 'Пицца has no screen');
  const r2 = stationResolver([st(1, 'Кухня'), st(2, 'Бар'), st(3, 'Остальное')], ws);
  assert.equal(r2(4), 3, 'catch-all takes the rest');
  const r3 = stationResolver([st(1, 'Холодный цех', [3]), st(2, 'Кухня')], ws);
  assert.deepEqual([2, 3].map(r3), [2, 1]);
});

// ---- many venues on one installation ----------------------------------------

test('venues are isolated: data, PINs and actions never cross', async () => {
  const other = await venue({ name: 'Другой бар' });
  const ivan = await staff(v, 'Иван', '1111');
  const stranger = await staff(other, 'Чужой', '1111'); // same PIN, other venue
  assert.notEqual(ivan.id, stranger.id);

  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await poll();
  const otherId = other.fake.open();
  other.fake.add(otherId, 11, 1);
  await poll(other);
  assert.equal(id, otherId, 'both Poster accounts use the same check number');

  assert.deepEqual((await board(v.device)).flatMap((t) => t.units.map((u) => u.name)), ['Мохито']);
  assert.deepEqual((await board(other.device)).flatMap((t) => t.units.map((u) => u.name)), ['Негрони']);

  const [mine] = await unitsOf(v, id);
  await assert.rejects(act(stranger, 'ready', [mine.id]), /не найдена/);
  await assert.rejects(units.applyAction({ opId: 'x1', token: ivan.token, action: 'ready', unitIds: [mine.id], device: other.device }), /Смена не найдена/);
  assert.equal((await reports.makers({ accountId: other.accountId, from: today(), to: today() })).length, 0);
});
