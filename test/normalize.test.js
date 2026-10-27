// Pure functions: parsing Poster payloads, signatures, station routing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.POSTER_APP_SECRET ??= 'poster-secret';
const n = await import('../src/poster/normalize.js');
const { verifyWebhook, classifyWebhook, webhookData } = await import('../src/poster/webhook.js');
const { stationResolver, desiredUnits } = await import('../src/sync/reconcile.js');

test('parseDate: ms, seconds, SQL datetime, empty and "0"', () => {
  assert.equal(n.parseDate('1700000000000').toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(n.parseDate(1700000000).toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(n.parseDate('2024-01-02 03:04:05').getFullYear(), 2024);
  for (const v of [null, undefined, '', '0', 0, 'nonsense']) assert.equal(n.parseDate(v), null, String(v));
});

test('modificationKey: none, variant id, dish JSON', () => {
  assert.equal(n.modificationKey({ modification_id: '0' }), '0');
  assert.equal(n.modificationKey({}), '0');
  assert.equal(n.modificationKey({ modification_id: '7' }), '7');
  assert.equal(n.modificationKey({ modification: '[]' }), '0');
  assert.equal(n.modificationKey({ modification: [{ m: 1, a: 1 }] }), '[{"m":1,"a":1}]');
});

test('normalizeProductLine reads alternate field names', () => {
  const l = n.normalizeProductLine({ dish_id: '5', count: '3', product_name: 'Суп', workshop_id: '2', modificator_name: 'Острый' });
  assert.deepEqual([l.productId, l.num, l.name, l.workshopId, l.modName, l.key], [5, 3, 'Суп', 2, 'Острый', '5:0']);
});

test('normalizeTransaction: fields, money in kopecks, register from history, sends counted', () => {
  const t = n.normalizeTransaction({
    transaction_id: '42', status: '2', table_name: '7', user_id: '3', name: 'Анна', guests_count: '4',
    transaction_comment: 'без льда', date_start: '1700000000000', date_close: '1700000600000',
    sum: '150000', payed_sum: '149950', spot_id: '1',
    products: [{ product_id: '10', modification_id: '0', num: '2' }],
    history: [
      { type_history: 'open', spot_tablet_id: '3', time: '1700000000000' },
      { type_history: 'sendtokitchen', time: '1700000100000' },
      { type_history: 'additem', time: '1700000200000' },
      { type_history: 'sendtokitchen', time: '1700000300000' },
    ],
  });
  assert.equal(t.id, 42);
  assert.equal(t.status, 2);
  assert.equal(t.sum, 1500);
  assert.equal(t.payedSum, 1499.5);
  assert.equal(t.tabletId, 3);
  assert.equal(t.sentCount, 2);
  assert.equal(t.guests, 4);
  assert.equal(t.closedAt.toISOString(), '2023-11-14T22:23:20.000Z');
  assert.equal(t.products[0].num, 2);
});

test('normalizeTransaction without history: sentCount unknown, no register', () => {
  const t = n.normalizeTransaction({ transaction_id: '1', products: [] });
  assert.equal(t.sentCount, null);
  assert.equal(t.tabletId, null);
  assert.equal(t.status, 1, 'missing status defaults to open');
});

test('catalog product: variants, dish modifiers, photo, cooking time, description', () => {
  const p = n.normalizeCatalogProduct({
    product_id: '9', product_name: 'Паста', category_name: 'Горячее', workshop: '2', hidden: '1',
    modifications: [{ modificator_id: '1', modificator_name: 'Большая' }],
    group_modifications: [{ modifications: [{ dish_modification_id: 4, name: 'Сыр' }] }],
    photo_origin: '/upload/p.jpg', cooking_time: '600', product_production_description: 'Варить 8 минут',
  });
  assert.equal(p.hidden, true);
  assert.deepEqual(p.modifications, { 1: 'Большая', d4: 'Сыр' });
  assert.equal(p.photo, '/upload/p.jpg');
  assert.equal(p.cookingSeconds, 600);
  assert.equal(p.description, 'Варить 8 минут');
  assert.equal(p.recipe, null, 'no tech card in the list');
});

test('cookingSeconds: minutes when small, seconds when large, null when absent', () => {
  assert.equal(n.cookingSeconds('5'), 300);
  assert.equal(n.cookingSeconds('60'), 3600);
  assert.equal(n.cookingSeconds('90'), 90);
  assert.equal(n.cookingSeconds('0'), null);
  assert.equal(n.cookingSeconds(undefined), null);
  assert.equal(n.cookingSeconds('abc'), null);
});

test('normalizeRecipe: units, zero amounts dropped, missing list', () => {
  const r = n.normalizeRecipe({ ingredients: [
    { ingredient_name: 'Ром', structure_unit: 'ml', structure_netto: '50' },
    { ingredient_name: 'Сахар', structure_unit: 'kg', structure_netto: '0.01' },
    { ingredient_name: 'Лёд', structure_unit: 'p', structure_netto: '0' },
    { name: 'Сироп', unit: 'l', netto: '0.02' },
  ] });
  assert.deepEqual(r, [
    { name: 'Ром', netto: 50, unit: 'мл' }, { name: 'Сахар', netto: 0.01, unit: 'кг' }, { name: 'Сироп', netto: 0.02, unit: 'л' }]);
  assert.deepEqual(n.normalizeRecipe(null), []);
  assert.deepEqual(n.normalizeRecipe({}), []);
});

test('modifierName: variant, dish JSON with counts, unknown ids, fallback', () => {
  const product = { modifications: { 3: '0,5 л', d5: 'Сыр', d6: 'Бекон' } };
  assert.equal(n.modifierName(product, '0', 'x'), 'x');
  assert.equal(n.modifierName(product, '3'), '0,5 л');
  assert.equal(n.modifierName(product, '[{"m":5,"a":2},{"m":6,"a":1}]'), 'Сыр ×2, Бекон');
  assert.equal(n.modifierName(product, '[{"m":99,"a":1}]', 'Из чека'), 'Из чека');
  assert.equal(n.modifierName(product, '[broken', 'Из чека'), 'Из чека');
  assert.equal(n.modifierName(undefined, '3', null), null);
});

const sign = (b, secret = 'poster-secret') => crypto.createHash('md5')
  .update([b.account, b.object, b.object_id, b.action, ...(b.data ? [typeof b.data === 'string' ? b.data : JSON.stringify(b.data)] : []), b.time, secret].join(';'))
  .digest('hex');

test('verifyWebhook: valid, tampered, wrong secret, data as string or object, no verify', () => {
  const body = { account: 'bar', object: 'transaction', object_id: 5, action: 'changed', time: '123' };
  assert.equal(verifyWebhook({ ...body, verify: sign(body) }), true);
  assert.equal(verifyWebhook({ ...body, verify: sign(body).toUpperCase() }), true, 'case-insensitive');
  assert.equal(verifyWebhook({ ...body, object_id: 6, verify: sign(body) }), false);
  assert.equal(verifyWebhook({ ...body, verify: sign(body, 'other') }), false);
  assert.equal(verifyWebhook(body), false);
  const withData = { ...body, data: '{"a":1}' };
  assert.equal(verifyWebhook({ ...withData, verify: sign(withData) }), true);
  assert.equal(verifyWebhook({ ...withData, data: { a: 1 }, verify: sign(withData) }), true, 'parsed JSON is re-serialized');
});

test('classifyWebhook and webhookData', () => {
  assert.deepEqual(classifyWebhook({ object: 'transaction', object_id: '7' }), { kind: 'transaction', id: 7 });
  assert.equal(classifyWebhook({ object: 'incoming_order', object_id: 7 }).kind, 'ignore');
  assert.equal(classifyWebhook({ object: 'product' }).kind, 'catalog');
  assert.equal(classifyWebhook({ object: 'settings' }).kind, 'catalog');
  assert.deepEqual(classifyWebhook({ object: 'application', action: 'removed' }), { kind: 'application', action: 'removed' });
  assert.equal(classifyWebhook({}).kind, 'ignore');
  assert.deepEqual(webhookData({ data: '{"access_token":"t"}' }), { access_token: 't' });
  assert.deepEqual(webhookData({ data: { x: 1 } }), { x: 1 });
  assert.deepEqual(webhookData({ data: 'not json' }), {});
  assert.deepEqual(webhookData({}), {});
});

const st = (id, name, workshop_ids = [], extra = {}) => ({ id, name, kind: 'prep', workshop_ids, active: true, sort: id, ...extra });

test('stationResolver: inactive and expo stations never receive products', () => {
  const ws = new Map([[1, 'Бар'], [2, 'Кухня']]);
  const r = stationResolver([st(1, 'Бар', [], { active: false }), st(2, 'Раздача', [], { kind: 'expo' }), st(3, 'Кухня')], ws);
  assert.equal(r(1), null);
  assert.equal(r(2), 3);
});

test('stationResolver: with no Poster workshops at all, the first station takes everything', () => {
  const r = stationResolver([st(1, 'Кухня'), st(2, 'Бар')], new Map());
  assert.equal(r(null), 1);
  assert.equal(r(77), 1);
});

test('stationResolver: a workshop claimed twice goes to the first station by sort order', () => {
  const r = stationResolver([st(2, 'B', [5], { sort: 2 }), st(1, 'A', [5], { sort: 1 })], new Map([[5, 'X']]));
  assert.equal(r(5), 1);
});

test('desiredUnits: whole portions split, weighed amounts stay one unit, removed check wants nothing', () => {
  const catalog = new Map([[1, { name: 'Пиво', workshopId: 1, modifications: {} }], [2, { name: 'Виски', workshopId: 1, modifications: {} }]]);
  const t = { status: 1, products: [
    { productId: 1, modKey: '0', key: '1:0', num: 3 }, { productId: 2, modKey: '0', key: '2:0', num: 0.05 },
    { productId: 1, modKey: '0', key: '1:0', num: 1 }, { productId: 3, modKey: '0', key: '3:0', num: 1 },
    { productId: 2, modKey: '0', key: '2:0', num: 0 },
  ] };
  const { wanted, unknown } = desiredUnits(t, { catalog, stationFor: () => 1, includeUnknown: false });
  assert.deepEqual(wanted.get('1:0').qtys, [1, 1, 1, 1], 'same product on two lines adds up');
  assert.deepEqual(wanted.get('2:0').qtys, [0.05]);
  assert.deepEqual(unknown, [3]);
  assert.equal(desiredUnits({ ...t, status: 3 }, { catalog, stationFor: () => 1 }).wanted.size, 0);
  assert.equal(desiredUnits(t, { catalog, stationFor: () => null }).wanted.size, 0, 'no station, no units');
});
