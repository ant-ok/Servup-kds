// What happens when things go wrong: the database drops connections, Poster
// fails or sends garbage, staff hammer the screen, webhooks flood in.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, units, resetDb, venue, staff, act, unitsOf, board } from './helpers.js';
import { SyncEngine } from '../src/sync/engine.js';

let v;
beforeEach(async () => { await resetDb(); v = await venue(); });
after(() => db.pool.end());

test('database connections killed mid-shift: the next requests just work', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const id = v.fake.open();
  v.fake.add(id, 10, 2);
  await v.engine.pollOpen();
  // Warm the pool, then kill every connection it holds (like a DB restart).
  await Promise.all(Array.from({ length: 5 }, () => db.query('SELECT pg_sleep(0.05)')));
  await db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                  WHERE datname = current_database() AND pid <> pg_backend_pid() AND application_name = ''`).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    try { await act(ivan, 'ready', [(await unitsOf(v, id))[0].id]); ok = true; } catch { /* a dead connection may fail once */ }
  }
  assert.ok(ok, 'recovered after the connections were killed');
  v.fake.add(id, 11, 1);
  await v.engine.pollOpen();
  assert.equal((await unitsOf(v, id)).length, 3);
});

test('Poster outage: health turns red, missed changes arrive after recovery', async () => {
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await v.engine.pollOpen();
  const real = v.fake.getTransactions.bind(v.fake);
  v.fake.getTransactions = async () => { throw Object.assign(new Error('fetch failed'), { retryable: true }); };
  v.fake.add(id, 11, 2);        // happens while we can't see Poster
  v.fake.remove(id, 10, 1);
  await assert.rejects(v.engine.pollOpen());
  v.engine.health.lastPollOkAt = new Date(Date.now() - 60e3).toISOString();
  assert.equal(v.engine.getHealth().ok, false);

  v.fake.getTransactions = real;
  await v.engine.pollOpen();
  assert.equal(v.engine.getHealth().ok, true);
  const us = await unitsOf(v, id);
  assert.deepEqual(us.filter((u) => u.status !== 'cancelled').map((u) => u.name), ['Негрони', 'Негрони']);
});

test('the poll loop backs off while Poster fails and recovers on the first success', async () => {
  const e = new SyncEngine({ accountId: v.accountId, poster: v.fake });
  let calls = 0;
  let failing = true;
  e.loop('test', 20, async () => {
    calls++;
    if (failing) throw new Error('down');
  });
  await new Promise((r) => setTimeout(r, 700));
  const whileDown = calls;
  assert.ok(whileDown <= 8, `backed off: ${whileDown} calls in 700 ms instead of ~35`);
  failing = false;
  await new Promise((r) => setTimeout(r, 1500));
  const afterUp = calls;
  await new Promise((r) => setTimeout(r, 300));
  e.stop();
  assert.ok(calls - afterUp >= 8, `back to normal speed: ${calls - afterUp} calls in 300 ms`);
});

test('garbage from Poster never crashes the sync and never invents portions', async () => {
  const junk = [
    null, 42, 'text', {}, { transaction_id: 'abc' },
    { transaction_id: '5001', status: '1', products: 'not a list' },
    { transaction_id: '5002', status: '1', products: [null, {}, { product_id: 'x', num: '2' }, { product_id: '10', num: '-1' }, { product_id: '10', num: 'NaN' }] },
    { transaction_id: '5003', status: '1', products: [{ product_id: '10', num: '1' }], date_start: 'yesterday-ish', history: 'nope' },
  ];
  const real = v.fake.getTransactions.bind(v.fake);
  v.fake.getTransactions = async () => junk.filter((t) => t && typeof t === 'object');
  v.fake.getTransaction = async (id) => junk.find((t) => t?.transaction_id === String(id)) ?? null;
  await v.engine.pollOpen().catch(() => {});
  await v.engine.idle();
  const { rows } = await db.query('SELECT poster_product_id, count(*)::int AS n FROM units WHERE account_id = $1 GROUP BY 1', [v.accountId]);
  assert.deepEqual(rows, [{ poster_product_id: 10, n: 1 }], 'only the one valid line of 5003 became a portion');
  v.fake.getTransactions = real;
  await v.engine.pollOpen();
});

test('a storm of simultaneous taps: every portion ends up made exactly once', async () => {
  const people = await Promise.all(['А', 'Б', 'В', 'Г', 'Д', 'Е'].map((n, i) => staff(v, n, String(1000 + i))));
  for (let i = 0; i < 5; i++) v.fake.add(v.fake.open(), 10, 4);
  await v.engine.pollOpen();
  const ids = (await db.query('SELECT id FROM units WHERE account_id = $1', [v.accountId])).rows.map((r) => r.id);
  assert.equal(ids.length, 20);
  const taps = [];
  for (let i = 0; i < 300; i++) {
    const who = people[i % people.length];
    const unit = ids[(i * 7) % ids.length];
    const action = ['take', 'ready', 'ready', 'release'][i % 4];
    taps.push(act(who, action, [unit], { force: i % 3 === 0 }).catch((err) => err.status));
  }
  const results = await Promise.all(taps);
  assert.ok(results.every((r) => typeof r === 'object' || [403, 409].includes(r)), 'only business refusals');
  // Finish whatever is left, then check the books.
  await act(people[0], 'ready', ids, { force: true });
  const rows = (await db.query('SELECT status, ready_by FROM units WHERE account_id = $1', [v.accountId])).rows;
  assert.ok(rows.every((r) => r.status === 'ready' && r.ready_by));
  const credited = (await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'ready'`, [v.accountId])).rows[0].n;
  const undone = (await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1 AND action = 'undo'`, [v.accountId])).rows[0].n;
  assert.equal(credited - undone, 20, 'one net "ready" per portion');
});

test('the same check reconciled from 20 directions at once: no duplicates', async () => {
  const id = v.fake.open();
  v.fake.add(id, 10, 3);
  v.fake.add(id, 11, 2);
  const t = (await import('../src/poster/normalize.js')).normalizeTransaction(await v.fake.getTransaction(id));
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? v.engine.apply(t) : v.engine.pollOpen())));
  assert.equal((await unitsOf(v, id)).length, 5);
  const tickets = (await db.query('SELECT count(*)::int AS n FROM tickets WHERE account_id = $1', [v.accountId])).rows[0].n;
  assert.equal(tickets, 1);
});

test('a webhook flood for one check is collapsed into a handful of fetches', async () => {
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  let fetches = 0;
  const real = v.fake.getTransaction.bind(v.fake);
  v.fake.getTransaction = async (x) => { fetches++; await new Promise((r) => setTimeout(r, 20)); return real(x); };
  for (let i = 0; i < 200; i++) v.engine.enqueue(id);
  await v.engine.idle();
  assert.ok(fetches <= 3, `${fetches} fetches for 200 webhooks`);
  assert.equal((await unitsOf(v, id)).length, 1);
});

test('one failing check does not block the others', async () => {
  const good = v.fake.open();
  v.fake.add(good, 10, 1);
  const bad = v.fake.open();
  v.fake.add(bad, 11, 1);
  const real = v.fake.getTransaction.bind(v.fake);
  v.fake.getTransaction = async (x) => (Number(x) === bad ? Promise.reject(new Error('boom')) : real(x));
  v.engine.enqueue(bad);
  v.engine.enqueue(good);
  await v.engine.idle();
  assert.equal((await unitsOf(v, good)).length, 1);
  assert.match(v.engine.health.lastError, /boom/);
});

test('speed: 300 open checks sync in seconds, an unchanged poll is cheap', async () => {
  for (let i = 0; i < 300; i++) {
    const id = v.fake.open({ table: String(i) });
    v.fake.add(id, 10 + (i % 4), 1 + (i % 3));
  }
  let t0 = Date.now();
  await v.engine.pollOpen();
  const first = Date.now() - t0;
  t0 = Date.now();
  await v.engine.pollOpen();
  const second = Date.now() - t0;
  const n = (await db.query('SELECT count(*)::int AS n FROM units WHERE account_id = $1', [v.accountId])).rows[0].n;
  assert.equal(n, 600);
  assert.ok(first < 15000, `first sync ${first} ms`);
  assert.ok(second < 3000, `unchanged poll ${second} ms`);
  t0 = Date.now();
  const b = await board(v.device);
  assert.equal(b.length, 300);
  assert.ok(Date.now() - t0 < 2000, `board of 300 orders in ${Date.now() - t0} ms`);
});

test('a stopped engine stops polling', async () => {
  const e = new SyncEngine({ accountId: v.accountId, poster: v.fake });
  let calls = 0;
  e.loop('x', 10, async () => { calls++; });
  await new Promise((r) => setTimeout(r, 100));
  e.stop();
  const atStop = calls;
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(calls - atStop <= 1);
});

test('an action on a portion cancelled a moment earlier is a harmless no-op', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await v.engine.pollOpen();
  const [u] = await unitsOf(v, id);
  v.fake.remove(id, 10, 1);
  await v.engine.pollOpen();
  const r = await act(ivan, 'ready', [u.id]);
  assert.equal(r.changed, 0);
  assert.equal((await unitsOf(v, id))[0].status, 'cancelled');
  assert.equal((await units.getBoard(v.device)).tickets[0].done, false, 'still shown as cancelled');
});
