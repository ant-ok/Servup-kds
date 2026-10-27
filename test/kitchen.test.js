import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb, venue, staff, act, unitsOf } from './helpers.js';
import { getSummary, getRecipe, suggestNorms } from '../src/kitchen.js';
import * as reports from '../src/reports.js';

let v;
beforeEach(async () => { await resetDb(); v = await venue(); });
after(() => db.pool.end());
const today = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);

test('summary: open portions of the station grouped, with ingredients from tech cards', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const a = v.fake.open({ table: '1' });
  v.fake.add(a, 10, 2);
  v.fake.add(a, 11, 1);
  const b = v.fake.open({ table: '2' });
  v.fake.add(b, 10, 1);
  v.fake.add(b, 13, 1); // beer: no tech card
  await v.engine.pollOpen();
  await act(ivan, 'take', [(await unitsOf(v, a))[0].id]);

  const s = await getSummary(v.device, v.engine);
  assert.equal(s.total, 5);
  assert.deepEqual(s.items.map((i) => [i.name, i.portions, i.taken]), [['Мохито', 3, 1], ['Негрони', 1, 0], ['Пиво разливное', 1, 0]]);
  const ing = Object.fromEntries(s.ingredients.map((i) => [`${i.name}, ${i.unit}`, i.amount]));
  assert.equal(ing['Ром белый, мл'], 150);
  assert.equal(ing['Лайм, шт'], 1.5);
  assert.equal(ing['Джин, мл'], 30);
  assert.deepEqual(s.withoutRecipe, ['Пиво разливное']);

  // Made portions leave the summary.
  await act(ivan, 'ready', (await unitsOf(v, a)).map((u) => u.id));
  assert.equal((await getSummary(v.device, v.engine)).total, 2);
});

test('recipe: fetched from Poster once and cached, with the venue note', async () => {
  await db.query(`INSERT INTO product_info (account_id, poster_product_id, recipe_note, norm_seconds) VALUES ($1, 10, 'Подавать с трубочкой', 120)`, [v.accountId]);
  const r = await getRecipe(v.accountId, 10, v.engine);
  assert.deepEqual(r.ingredients.map((i) => i.name), ['Ром белый', 'Лайм', 'Мята']);
  assert.equal(r.note, 'Подавать с трубочкой');
  assert.equal(r.normSeconds, 120);
  const calls = v.fake.productCalls;
  await getRecipe(v.accountId, 10, v.engine);
  assert.equal(v.fake.productCalls, calls, 'served from cache');
});

test('norms are suggested from real history and show up in reports', async () => {
  const ivan = await staff(v, 'Иван', '1111');
  const id = v.fake.open();
  v.fake.add(id, 10, 6);
  await v.engine.pollOpen();
  const us = await unitsOf(v, id);
  await act(ivan, 'ready', us.map((u) => u.id));
  // Pretend each portion took 60..110 seconds.
  for (const [i, u] of us.entries()) {
    await db.query(`UPDATE units SET taken_at = ready_at - make_interval(secs => $2) WHERE id = $1`, [u.id, 60 + i * 10]);
  }
  assert.equal(await suggestNorms(v.accountId), 1);
  const { rows } = await db.query('SELECT norm_seconds FROM product_info WHERE poster_product_id = 10');
  assert.equal(rows[0].norm_seconds, 105); // 75th percentile 97.5 s, rounded up to 15 s

  assert.equal(await suggestNorms(v.accountId), 0, 'an existing norm is kept');
  const p = await reports.products({ accountId: v.accountId, from: today(), to: today() });
  assert.equal(p[0].norm_sec, 105);
  assert.equal(p[0].within_norm_pct, 83); // 5 of 6 within 105 s
});
