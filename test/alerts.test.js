import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db, resetDb, venue, unitsOf } from './helpers.js';
import { AlertMonitor, createLinkCode, handleBotMessage } from '../src/alerts.js';

let v;
let sent;
let monitor;
beforeEach(async () => {
  await resetDb();
  v = await venue({ name: 'Бар «Тест»' });
  await db.query(`UPDATE accounts SET telegram_chat_id = 'venue-chat' WHERE id = $1`, [v.accountId]);
  sent = [];
  const engines = { get: () => v.engine, health: () => v.engine.getHealth() };
  monitor = new AlertMonitor({ engines, send: async (chat, text) => sent.push([chat, text]), platformChatId: 'owner-chat',
    limits: { posterDownMin: 3, screenOfflineMin: 5, stuckOrderMin: 30 } });
});
after(() => db.pool.end());

test('Poster outage alerts the venue and the platform once, then reports recovery', async () => {
  v.engine.health.lastPollOkAt = new Date(Date.now() - 10 * 60e3).toISOString();
  await monitor.check();
  await monitor.check();
  assert.equal(sent.length, 2, 'once per chat, no repeats');
  assert.deepEqual(sent.map(([c]) => c).sort(), ['owner-chat', 'venue-chat']);
  assert.match(sent.find(([c]) => c === 'owner-chat')[1], /^\[Бар «Тест»\] ⚠️ Нет связи с Poster/);

  v.engine.health.lastPollOkAt = new Date().toISOString();
  sent = [];
  await monitor.check();
  assert.ok(sent.every(([, t]) => t.includes('восстановлена')));
});

test('a screen going silent alerts only while the venue is working', async () => {
  v.engine.health.lastPollOkAt = new Date().toISOString();
  await db.query(`UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`, [v.device.id]);
  await monitor.check();
  assert.equal(sent.length, 0, 'no orders recently: closed for the night');

  const id = v.fake.open();
  v.fake.add(id, 10, 1);
  await v.engine.pollOpen();
  await monitor.check();
  assert.ok(sent.some(([, t]) => t.includes('Экран «Бар» не на связи')));

  sent = [];
  await db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [v.device.id]);
  await monitor.check();
  assert.ok(sent.some(([, t]) => t.includes('снова на связи')));
});

test('orders waiting longer than the limit are reported', async () => {
  v.engine.health.lastPollOkAt = new Date().toISOString();
  const id = v.fake.open({ table: '7' });
  v.fake.add(id, 10, 2);
  await v.engine.pollOpen();
  await db.query(`UPDATE units SET created_at = now() - interval '40 minutes' WHERE id = $1`, [(await unitsOf(v, id))[0].id]);
  await monitor.check();
  assert.ok(sent.some(([, t]) => /Не готово дольше 30 мин: 1 порц\. \(например, стол 7\)/.test(t)));
});

test('a venue links its Telegram chat with a one-time code and can unlink', async () => {
  await db.query(`UPDATE accounts SET telegram_chat_id = NULL WHERE id = $1`, [v.accountId]);
  const replies = [];
  const send = async (chat, text) => replies.push([chat, text]);

  await handleBotMessage({ chat: { id: 42 }, text: '/start 000000' }, send);
  assert.match(replies.at(-1)[1], /не подошёл/);

  const code = await createLinkCode(v.accountId);
  await handleBotMessage({ chat: { id: 42 }, text: `/start ${code}` }, send);
  assert.match(replies.at(-1)[1], /Подключено: Бар «Тест»/);
  let { rows } = await db.query('SELECT telegram_chat_id FROM accounts WHERE id = $1', [v.accountId]);
  assert.equal(rows[0].telegram_chat_id, '42');

  await handleBotMessage({ chat: { id: 42 }, text: `/start ${code}` }, send);
  assert.match(replies.at(-1)[1], /не подошёл/, 'a code works once');

  await handleBotMessage({ chat: { id: 42 }, text: '/stop' }, send);
  ({ rows } = await db.query('SELECT telegram_chat_id FROM accounts WHERE id = $1', [v.accountId]));
  assert.equal(rows[0].telegram_chat_id, null);
});
