// Randomised shifts. Waiters add, remove, close and delete in Poster while
// staff take, finish, undo and release portions; updates arrive by fast poll,
// full poll or webhook in any order. After every step the screens must agree
// with Poster exactly, and the reports with the screens.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb, venue, staff, act, unitsOf } from './helpers.js';
import * as reports from '../src/reports.js';

after(() => db.pool.end());

// Deterministic PRNG so a failing seed can be replayed.
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (arr) => arr[Math.floor(next() * arr.length)] };
}

const BAR_PRODUCTS = [[10, '0'], [11, '0'], [12, '1'], [12, '2'], [13, '0']];
const KITCHEN = [[20, '0']];
const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);

async function checkInvariants(v, cancelledEver, label) {
  for (const t of v.fake.transactions.values()) {
    const units = await unitsOf(v, Number(t.transaction_id));
    for (const u of units) {
      if (cancelledEver.has(u.id)) assert.equal(u.status, 'cancelled', `${label}: cancelled unit ${u.id} came back`);
      if (u.status === 'cancelled') cancelledEver.add(u.id);
      if (u.status === 'ready') assert.ok(u.ready_by && u.ready_at, `${label}: ready without who/when`);
      if (u.status === 'taken') assert.ok(u.taken_by, `${label}: taken without who`);
      assert.notEqual(u.poster_product_id, 20, `${label}: kitchen item on the bar screen`);
    }
    // Active portions per item equal what Poster has on the check.
    const want = new Map();
    if (t.status !== '3') {
      for (const p of t.products) {
        if (Number(p.product_id) === 20) continue;
        const key = `${p.product_id}:${p.modification_id}`;
        want.set(key, (want.get(key) ?? 0) + Number(p.num));
      }
    }
    const have = new Map();
    for (const u of units) if (u.status !== 'cancelled') have.set(u.item_key, (have.get(u.item_key) ?? 0) + 1);
    for (const key of new Set([...want.keys(), ...have.keys()])) {
      assert.equal(have.get(key) ?? 0, want.get(key) ?? 0, `${label}: check ${t.transaction_id} item ${key}`);
    }
  }
}

async function runShift(seed, steps) {
  await resetDb();
  const r = rng(seed);
  const v = await venue();
  await db.query(`INSERT INTO product_rates (account_id, poster_product_id, rate) VALUES ($1,10,30),($1,11,50),($1,12,20),($1,13,10)`, [v.accountId]);
  const people = [await staff(v, 'Иван', '1111'), await staff(v, 'Пётр', '2222'), await staff(v, 'Мария', '3333')];
  const cancelledEver = new Set();
  const open = () => [...v.fake.transactions.values()].filter((t) => t.status === '1').map((t) => Number(t.transaction_id));

  for (let step = 0; step < steps; step++) {
    const roll = r.next();
    const label = `seed ${seed} step ${step}`;
    if (roll < 0.15 || !open().length) {
      const id = v.fake.open({ table: String(1 + r.int(20)), waiter: 1 + r.int(2), tablet: 1 + r.int(3) });
      const [p, m] = r.pick(BAR_PRODUCTS);
      v.fake.add(id, p, 1 + r.int(3), m);
    } else if (roll < 0.35) {
      const [p, m] = r.next() < 0.85 ? r.pick(BAR_PRODUCTS) : r.pick(KITCHEN);
      v.fake.add(r.pick(open()), p, 1 + r.int(2), m);
    } else if (roll < 0.45) {
      const t = v.fake.transactions.get(String(r.pick(open())));
      const line = t.products.length ? r.pick(t.products) : null;
      if (line) v.fake.remove(t.transaction_id, line.product_id, 1 + r.int(Number(line.num)), line.modification_id);
    } else if (roll < 0.52) {
      v.fake.close(r.pick(open()));
    } else if (roll < 0.55) {
      v.fake.delete(r.pick(open()));
    } else {
      // Staff act on whatever is on the screen right now.
      const { rows } = await db.query(`SELECT id, status, taken_by, ready_by FROM units WHERE account_id = $1 AND status <> 'cancelled'`, [v.accountId]);
      if (rows.length) {
        const who = r.pick(people);
        const u = r.pick(rows);
        const action = u.status === 'new' ? r.pick(['take', 'ready'])
          : u.status === 'taken' ? r.pick(['ready', 'ready', 'release', 'take'])
            : 'undo';
        await act(who, action, [u.id], { force: r.next() < 0.5 }).catch((err) => {
          // Business refusals are fine (someone else's undo, already taken); anything else is a bug.
          assert.ok([403, 409].includes(err.status), `${label}: unexpected ${err.message}`);
        });
      }
    }

    // Deliver Poster's state by a random path; sometimes not at all this step.
    const path = r.next();
    if (path < 0.4) await v.engine.pollOpen();
    else if (path < 0.6) await v.engine.pollFull();
    else if (path < 0.85) {
      for (const id of [...v.fake.transactions.keys()]) if (r.next() < 0.5) v.engine.enqueue(Number(id));
      await v.engine.idle();
    }
    if (step % 10 === 9 || step === steps - 1) {
      await v.engine.pollFull();
      await checkInvariants(v, cancelledEver, label);
    }
  }

  // Reports agree with the portions themselves.
  const made = (await db.query(
    `SELECT count(*)::int AS n, COALESCE(sum(rate), 0)::float AS earned FROM units
     WHERE account_id = $1 AND ready_by IS NOT NULL AND (status = 'ready' OR made_then_removed)`, [v.accountId])).rows[0];
  const makers = await reports.makers({ accountId: v.accountId, from: today(), to: today() });
  assert.equal(makers.reduce((s, m) => s + m.portions, 0), made.n, `seed ${seed}: portions in report`);
  assert.equal(Math.round(makers.reduce((s, m) => s + m.earned, 0)), Math.round(made.earned), `seed ${seed}: earnings in report`);

  const closed = [...v.fake.transactions.values()].filter((t) => t.status === '2');
  const sellers = await reports.sellers({ accountId: v.accountId, from: today(), to: today() });
  assert.equal(sellers.reduce((s, x) => s + x.checks, 0), closed.length, `seed ${seed}: closed checks`);
  assert.equal(sellers.reduce((s, x) => s + x.payed, 0), closed.reduce((s, t) => s + Number(t.payed_sum) / 100, 0), `seed ${seed}: paid sum`);

  // Every "ready" in the audit log belongs to one portion and nobody got credit twice.
  const dup = (await db.query(
    `SELECT unit_id FROM audit_log WHERE account_id = $1 AND action = 'ready' GROUP BY unit_id
     HAVING count(*) > 1 + (SELECT count(*) FROM audit_log a2 WHERE a2.unit_id = audit_log.unit_id AND a2.action = 'undo')`,
    [v.accountId])).rows;
  assert.deepEqual(dup, [], `seed ${seed}: a portion marked ready twice without undo`);
}

for (const seed of [1, 2, 3, 7, 11, 42, 99, 123, 2024, 31337]) {
  test(`random shift, seed ${seed}`, { timeout: 120000 }, () => runShift(seed, 120));
}
