import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, units, freshEnv, bartender, act, unitsOf } from './helpers.js';
import * as reports from '../src/reports.js';

let env;
beforeEach(async () => { env = await freshEnv(); });
after(() => db.pool.end());

const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10); // business day with 06:00 start
const poll = () => env.engine.pollOpen();

test('order reaches the KDS with table, waiter, only bar items', async () => {
  const id = env.fake.open({ table: '7', waiter: 1, comment: 'без льда' });
  env.fake.add(id, 10, 2);
  env.fake.add(id, 20, 1); // kitchen
  env.fake.add(id, 12, 1, '1');
  await poll();

  const us = await unitsOf(id);
  assert.deepEqual(us.map((u) => u.name), ['Мохито', 'Мохито', 'Латте']);
  assert.equal(us[2].modifiers, 'Овсяное молоко');
  const [ticket] = await units.getBoard();
  assert.equal(ticket.table_name, '7');
  assert.equal(ticket.waiter_name, 'Анна (официант)');
  assert.equal(ticket.comment, 'без льда');
  assert.equal(ticket.round, 1);
});

test('webhook + poll + full poll for the same check never duplicate portions', async () => {
  const id = env.fake.open();
  env.fake.add(id, 10, 1);
  await poll();
  env.engine.enqueue(id);
  await env.engine.drain();
  await env.engine.pollFull();
  await poll();
  assert.equal((await unitsOf(id)).length, 1);
});

test('additional order creates a second ticket ("дозаказ")', async () => {
  const id = env.fake.open();
  env.fake.add(id, 10, 1);
  await poll();
  env.fake.add(id, 10, 1);
  env.fake.add(id, 11, 1);
  await poll();
  const board = await units.getBoard();
  assert.deepEqual(board.map((t) => [t.round, t.units.length]), [[1, 1], [2, 2]]);
});

test('removing from check cancels untouched portions first, made ones are flagged', async () => {
  const a = await bartender('Иван', '1111', env.device);
  const id = env.fake.open();
  env.fake.add(id, 10, 3);
  await poll();
  const [u1, u2] = await unitsOf(id);
  await act(a, 'ready', [u1.id]);
  await act(a, 'take', [u2.id]);

  env.fake.remove(id, 10, 1);
  await poll();
  let us = await unitsOf(id);
  assert.deepEqual(us.map((u) => u.status), ['ready', 'taken', 'cancelled']);

  env.fake.remove(id, 10, 2);
  await poll();
  us = await unitsOf(id);
  assert.deepEqual(us.map((u) => u.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(us[0].made_then_removed, true);
  assert.equal(us[0].ready_by, a.id, 'who made it is preserved');
});

test('deleted check cancels everything still open', async () => {
  const id = env.fake.open();
  env.fake.add(id, 10, 2);
  await poll();
  env.fake.delete(id);
  await env.engine.pollFull();
  assert.ok((await unitsOf(id)).every((u) => u.status === 'cancelled'));
  const [ticket] = await units.getBoard();
  assert.equal(ticket.bumped_at, null, 'stays on screen as cancelled until dismissed');
  await units.dismissTicket(ticket.id, env.device);
  assert.equal((await units.getBoard())[0].bumped_at !== null, true);
});

test('anyone can make it; credit goes to who marks ready; interception is audited', async () => {
  const ivan = await bartender('Иван', '1111', env.device);
  const petr = await bartender('Пётр', '2222', env.device);
  const id = env.fake.open();
  env.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(id);

  await act(ivan, 'take', [u.id]);
  await assert.rejects(act(petr, 'take', [u.id]), /Уже взято/);
  await act(petr, 'ready', [u.id]);

  const [after1] = await unitsOf(id);
  assert.equal(after1.ready_by, petr.id);
  assert.equal(after1.taken_by, ivan.id);
  const { rows } = await db.query(`SELECT details FROM audit_log WHERE action='ready' AND unit_id=$1`, [u.id]);
  assert.equal(rows[0].details.prevTakenBy, ivan.id);
});

test('a retried tap with the same op_id is applied once', async () => {
  const ivan = await bartender('Иван', '1111', env.device);
  const id = env.fake.open();
  env.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(id);
  const r1 = await units.applyAction({ opId: 'same', token: ivan.token, action: 'ready', unitIds: [u.id] });
  await units.applyAction({ opId: 'same', token: ivan.token, action: 'undo', unitIds: [u.id] }).catch(() => {});
  const r2 = await units.applyAction({ opId: 'same', token: ivan.token, action: 'ready', unitIds: [u.id] });
  assert.deepEqual(r1, r2);
  assert.equal((await unitsOf(id))[0].status, 'ready');
});

test('simultaneous taps by two bartenders credit exactly one', async () => {
  const ivan = await bartender('Иван', '1111', env.device);
  const petr = await bartender('Пётр', '2222', env.device);
  const id = env.fake.open();
  env.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(id);
  const res = await Promise.all([act(ivan, 'ready', [u.id]), act(petr, 'ready', [u.id])]);
  assert.equal(res.reduce((s, r) => s + r.changed, 0), 1);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action='ready'`);
  assert.equal(rows[0].n, 1);
});

test('undo only by the same bartender', async () => {
  const ivan = await bartender('Иван', '1111', env.device);
  const petr = await bartender('Пётр', '2222', env.device);
  const id = env.fake.open();
  env.fake.add(id, 10, 1);
  await poll();
  const [u] = await unitsOf(id);
  await act(ivan, 'ready', [u.id]);
  await assert.rejects(act(petr, 'undo', [u.id]), /только тот/);
  await act(ivan, 'undo', [u.id]);
  assert.equal((await unitsOf(id))[0].status, 'taken');
  assert.equal((await units.getBoard())[0].bumped_at, null, 'ticket returns to the board');
});

test('ticket leaves the board when everything is ready', async () => {
  const ivan = await bartender('Иван', '1111', env.device);
  const id = env.fake.open();
  env.fake.add(id, 10, 2);
  await poll();
  await act(ivan, 'ready', (await unitsOf(id)).map((u) => u.id));
  const { rows } = await db.query('SELECT bumped_at FROM tickets');
  assert.ok(rows[0].bumped_at);
});

test('reports: piece rates are snapshotted, sellers get closed-check sums', async () => {
  const ivan = await bartender('Иван', '1111', env.device);
  const petr = await bartender('Пётр', '2222', env.device);
  await db.query(`INSERT INTO product_rates VALUES (10, 30), (11, 50)`);

  const id = env.fake.open({ waiter: 1 });
  env.fake.add(id, 10, 2);
  env.fake.add(id, 11, 1);
  await poll();
  const [m1, m2, n1] = await unitsOf(id);
  await act(ivan, 'ready', [m1.id, n1.id]);
  await act(petr, 'ready', [m2.id]);
  await db.query(`UPDATE product_rates SET rate = 999`);

  env.fake.close(id);
  await env.engine.pollFull();

  const b = await reports.bartenders(today(), today());
  assert.deepEqual(b.map((r) => [r.name, r.portions, r.earned]), [['Иван', 2, 80], ['Пётр', 1, 30]]);

  const s = await reports.sellers(today(), today());
  assert.equal(s.length, 1);
  assert.equal(s[0].name, 'Анна (официант)');
  assert.equal(s[0].checks, 1);
  assert.equal(s[0].payed, 1500); // 3 × 500 ₽, Poster sends kopecks
  assert.equal(s[0].bar_portions, 3);

  const d = await reports.details(today(), today());
  assert.deepEqual(d.map((r) => r.made_by), ['Иван', 'Пётр', 'Иван']);
  assert.ok(d.every((r) => r.sold_by === 'Анна (официант)'));
});

test('made-then-removed is credited by default and listed as anomaly', async () => {
  const ivan = await bartender('Иван', '1111', env.device);
  await db.query(`INSERT INTO product_rates VALUES (10, 30)`);
  const id = env.fake.open();
  env.fake.add(id, 10, 1);
  await poll();
  await act(ivan, 'ready', [(await unitsOf(id))[0].id]);
  env.fake.remove(id, 10, 1);
  await poll();

  assert.equal((await reports.bartenders(today(), today()))[0].earned, 30);
  assert.equal((await reports.anomalies(today(), today())).removed.length, 1);

  await db.query(`UPDATE settings SET value = 'false' WHERE key = 'credit_made_then_removed'`);
  assert.equal((await reports.bartenders(today(), today()))[0].earned, 0);
});

test('old checks never flood the screen', async () => {
  const id = env.fake.open({ openedAt: Date.now() - 2 * 24 * 3600e3 });
  env.fake.add(id, 10, 2);
  await env.engine.pollFull();
  assert.equal((await unitsOf(id)).length, 0);
  const { rows } = await db.query('SELECT status FROM transactions WHERE poster_transaction_id = $1', [id]);
  assert.equal(rows.length, 1, 'still stored for seller reports');
});

test('a product created after catalog sync is resolved by refreshing the catalog', async () => {
  env.fake.products.push({ product_id: '30', product_name: 'Апероль шприц', workshop: '1', modifications: [] });
  const id = env.fake.open();
  env.fake.add(id, 30, 1);
  await poll();
  assert.deepEqual((await unitsOf(id)).map((u) => u.name), ['Апероль шприц']);
});

test('quick-service: check paid and closed before the poll still reaches the bar', async () => {
  const id = env.fake.open();
  env.fake.add(id, 13, 2);
  env.fake.close(id);
  await env.engine.pollFull();
  assert.equal((await unitsOf(id)).length, 2);
});

test('a check closed in Poster is picked up by the next fast poll', async () => {
  const id = env.fake.open({ waiter: 2 });
  env.fake.add(id, 10, 1);
  await poll();
  env.fake.close(id);
  await poll();
  const { rows } = await db.query('SELECT status, payed_sum FROM transactions WHERE poster_transaction_id = $1', [id]);
  assert.deepEqual(rows[0], { status: 2, payed_sum: 500 });
});
