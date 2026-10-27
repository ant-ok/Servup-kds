// Keeps the KDS in step with Poster through three independent paths:
//  1. webhooks: instant, but may be delayed or lost;
//  2. fast poll of open checks every few seconds: the safety net;
//  3. full poll of today's checks every minute: catches closes and removals.
// All paths feed the same idempotent reconcile, so overlap is harmless.
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { query, tx, getSettings } from '../db.js';
import { createPosterClient } from '../poster/client.js';
import { normalizeTransaction, normalizeCatalogProduct, normalizeRecipe } from '../poster/normalize.js';
import { reconcileTransaction, stationResolver } from './reconcile.js';

// Syncs one venue.
export class SyncEngine extends EventEmitter {
  constructor({ accountId, poster }) {
    super();
    this.accountId = accountId;
    this.poster = poster;
    this.catalog = new Map();
    this.stationFor = () => null;
    this.queue = new Set();
    this.working = false;
    this.timers = [];
    this.health = { lastPollOkAt: null, lastFullOkAt: null, lastCatalogAt: null, lastError: null, lastErrorAt: null, lastWebhookAt: null };
  }

  async start() {
    this.startedAt = new Date();
    await this.loadCatalogFromDb();
    this.syncCatalog().catch(() => {});
    this.loop('open', config.sync.pollOpenMs, () => this.pollOpen());
    this.loop('full', config.sync.pollFullMs, () => this.pollFull());
    this.loop('catalog', config.sync.catalogMs, () => this.syncCatalog());
    this.loop('nightly', 10 * 60000, () => this.maybeNightlyResync());
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.stopped = true;
  }

  // Runs fn every `ms`. While Poster keeps failing the interval doubles up to
  // a minute, so an outage doesn't turn into a flood of requests; the first
  // success brings it straight back. Venues start spread out over the interval.
  loop(name, ms, fn) {
    let failures = 0;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await fn();
        failures = 0;
      } catch (err) {
        failures++;
        this.fail(name, err);
      }
      const delay = failures ? Math.min(ms * 2 ** failures, Math.max(ms, 60000)) : ms;
      if (!this.stopped) this.timers.push(setTimeout(tick, delay));
    };
    this.timers.push(setTimeout(tick, name === 'catalog' ? ms : Math.floor(Math.random() * Math.min(ms, 3000))));
  }

  fail(where, err) {
    this.health.lastError = `${where}: ${err.message}`;
    this.health.lastErrorAt = new Date().toISOString();
    console.error(`[sync ${this.accountId}] ${where}:`, err.message);
    this.emit('health', this.getHealth());
  }

  getHealth() {
    const age = this.health.lastPollOkAt ? Date.now() - new Date(this.health.lastPollOkAt) : Infinity;
    return { ...this.health, ok: age < Math.max(config.sync.pollOpenMs * 5, 20000), queue: this.queue.size };
  }

  async loadCatalogFromDb() {
    const a = this.accountId;
    const { rows } = await query('SELECT * FROM products WHERE account_id = $1', [a]);
    this.catalog = new Map(rows.map((r) => [r.poster_product_id, {
      id: r.poster_product_id, name: r.name, workshopId: r.workshop_id, modifications: r.modifications,
    }]));
    await this.loadStations();
  }

  // Called again whenever stations are edited in the admin panel.
  async loadStations() {
    const a = this.accountId;
    const stations = (await query('SELECT * FROM stations WHERE account_id = $1', [a])).rows;
    const workshops = new Map((await query('SELECT * FROM workshops WHERE account_id = $1', [a])).rows
      .map((w) => [w.poster_workshop_id, w.name]));
    this.stationFor = stationResolver(stations, workshops);
  }

  async syncCatalog() {
    const [products, workshops, employees] = await Promise.all([
      this.poster.getProducts(),
      this.poster.getWorkshops().catch(() => []),
      this.poster.getEmployees().catch(() => []),
    ]);
    await tx(async (c) => {
      for (const raw of products) {
        const p = normalizeCatalogProduct(raw);
        if (!p.id) continue;
        await c.query(
          `INSERT INTO products (account_id, poster_product_id, name, category_name, workshop_id, modifications, hidden, photo,
             recipe, recipe_fetched_at, updated_at)
           VALUES ($7,$1,$2,$3,$4,$5,$6,$8,$9, CASE WHEN $9::jsonb IS NULL THEN NULL ELSE now() END, now())
           ON CONFLICT (account_id, poster_product_id) DO UPDATE SET name=EXCLUDED.name, category_name=EXCLUDED.category_name,
             workshop_id=EXCLUDED.workshop_id, modifications=EXCLUDED.modifications, hidden=EXCLUDED.hidden, photo=EXCLUDED.photo,
             recipe=COALESCE(EXCLUDED.recipe, products.recipe),
             recipe_fetched_at=COALESCE(EXCLUDED.recipe_fetched_at, products.recipe_fetched_at), updated_at=now()`,
          [p.id, p.name, p.category, p.workshopId, p.modifications, p.hidden, this.accountId, p.photo,
           p.recipe ? JSON.stringify(p.recipe) : null],
        );
      }
      for (const w of workshops) {
        const id = Number(w.workshop_id ?? w.id);
        if (!id) continue;
        await c.query(
          `INSERT INTO workshops (account_id, poster_workshop_id, name) VALUES ($3,$1,$2)
           ON CONFLICT (account_id, poster_workshop_id) DO UPDATE SET name=EXCLUDED.name`,
          [id, w.workshop_name ?? w.name ?? `Цех ${id}`, this.accountId],
        );
      }
      for (const e of employees) {
        const id = Number(e.user_id ?? e.id);
        if (!id) continue;
        await c.query(
          `INSERT INTO employees (account_id, poster_user_id, name, role_name) VALUES ($4,$1,$2,$3)
           ON CONFLICT (account_id, poster_user_id) DO UPDATE SET name=EXCLUDED.name, role_name=EXCLUDED.role_name, updated_at=now()`,
          [id, e.name ?? `Сотрудник #${id}`, e.role_name ?? null, this.accountId],
        );
      }
    });
    await this.loadCatalogFromDb();
    this.health.lastCatalogAt = new Date().toISOString();
  }

  // Tech cards are fetched from Poster on first use and refreshed twice a day.
  // Products without a tech card (a bottle of beer) cache an empty recipe.
  async ensureRecipes(productIds) {
    const { rows } = await query(
      `SELECT poster_product_id AS id FROM products WHERE account_id = $1 AND poster_product_id = ANY($2)
         AND (recipe_fetched_at IS NULL OR recipe_fetched_at < now() - interval '12 hours')`,
      [this.accountId, productIds]);
    for (const { id } of rows.slice(0, 20)) {
      try {
        const raw = await this.poster.getProduct(id);
        const recipe = normalizeRecipe(Array.isArray(raw) ? raw[0] : raw);
        await query('UPDATE products SET recipe = $3, recipe_fetched_at = now() WHERE account_id = $1 AND poster_product_id = $2',
          [this.accountId, id, JSON.stringify(recipe)]);
      } catch (err) {
        this.fail(`recipe ${id}`, err);
      }
    }
  }

  // Business days cross midnight, so always look at yesterday and today.
  window() {
    const to = new Date();
    return { from: new Date(to - 24 * 3600e3), to };
  }

  async pollOpen() {
    const list = await this.poster.getTransactions({ ...this.window(), status: 1 });
    await this.applyList(list);
    await this.recheckMissing(list);
    this.health.lastPollOkAt = new Date().toISOString();
    this.emit('health', this.getHealth());
  }

  async pollFull() {
    const list = await this.poster.getTransactions({ ...this.window(), status: 0 });
    await this.applyList(list);
    await this.recheckMissing(list);
    this.health.lastFullOkAt = new Date().toISOString();
  }

  // Open on our side but gone from Poster's list of open checks: it was just
  // closed, removed or merged. Fetch it individually right away.
  async recheckMissing(list) {
    const seen = new Set(list.map((t) => Number(t.transaction_id ?? t.id)));
    const { rows } = await query(
      `SELECT poster_transaction_id AS id FROM transactions
       WHERE account_id = $1 AND status = 1 AND updated_at > now() - interval '2 days'`, [this.accountId]);
    for (const r of rows) if (!seen.has(r.id)) this.enqueue(r.id);
    await this.idle();
  }

  async idle() {
    while (this.working || this.queue.size) await new Promise((r) => setTimeout(r, 20));
  }

  async applyList(list) {
    for (const raw of list) {
      const t = normalizeTransaction(raw);
      if (!t.id) continue;
      if (!Array.isArray(raw.products)) { this.enqueue(t.id); continue; }
      await this.apply(t);
    }
  }

  enqueue(id) {
    this.queue.add(Number(id));
    this.drain();
  }

  async drain() {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.size) {
        const [id] = this.queue;
        this.queue.delete(id);
        try {
          const raw = await this.poster.getTransaction(id);
          if (raw) await this.apply(normalizeTransaction(raw));
        } catch (err) {
          this.fail(`transaction ${id}`, err);
          // The pollers will pick it up again; no tight retry loop here.
        }
      }
    } finally {
      this.working = false;
    }
  }

  async apply(t, { createUnits = true } = {}) {
    const settings = await getSettings(this.accountId);
    const opts = { settings, createUnits };
    const run = (extra) => tx((c) => reconcileTransaction(c, this.accountId, t,
      { ...opts, catalog: this.catalog, stationFor: this.stationFor, ...extra }));
    let res = await run();
    if (res.unknown.length) {
      // A product created after the last catalog sync: refresh and decide again.
      // If it's still unknown, show it rather than risk losing an order.
      await this.syncCatalog().catch((err) => this.fail('catalog', err));
      res = await run({ includeUnknown: true, force: true });
    }
    if (res.changed) this.emit('changed', { transactionId: t.id, ...res });
    return res;
  }

  // Once a day, at the start of the business day, re-read the last two days of
  // closed checks from Poster. Whatever drifted (a missed close, a refund, an
  // edited check) is corrected before anyone builds a payroll report.
  async maybeNightlyResync(now = new Date()) {
    const s = await getSettings(this.accountId);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: config.timezone }).format(now));
    const last = s.nightly_resync_at ? new Date(s.nightly_resync_at) : null;
    if (hour !== Number(s.day_start_hour ?? 6) || (last && now - last < 20 * 3600e3)) return false;
    const checks = await this.backfill(new Date(now - 2 * 24 * 3600e3), now);
    await query(
      `INSERT INTO settings (account_id, key, value) VALUES ($1, 'nightly_resync_at', $2)
       ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.accountId, JSON.stringify(now.toISOString())]);
    this.health.lastNightlyAt = now.toISOString();
    console.log(`[sync ${this.accountId}] nightly resync: ${checks} checks`);
    return true;
  }

  // Pull closed checks for a past period so seller reports are complete.
  async backfill(from, to) {
    let count = 0;
    for (let d = new Date(from); d <= to; d = new Date(+d + 24 * 3600e3)) {
      const list = await this.poster.getTransactions({ from: d, to: d, status: 0 });
      for (const raw of list) {
        if (!Array.isArray(raw.products) || Number(raw.status) === 1) continue;
        await this.apply(normalizeTransaction(raw), { createUnits: false });
        count++;
      }
    }
    return count;
  }
}

// All venues of this installation: one SyncEngine per account with a Poster token.
export class EngineManager extends EventEmitter {
  constructor({ posterFor = createPosterClient } = {}) {
    super();
    this.posterFor = posterFor;
    this.engines = new Map();
  }

  async startAll() {
    const { rows } = await query('SELECT id FROM accounts WHERE active AND poster_token IS NOT NULL');
    for (const r of rows) await this.restart(r.id);
  }

  // (Re)start after the account was created, reconnected or re-enabled.
  async restart(accountId) {
    this.engines.get(accountId)?.stop();
    this.engines.delete(accountId);
    const acc = (await query('SELECT poster_token, active FROM accounts WHERE id = $1', [accountId])).rows[0];
    if (!acc?.active || !acc.poster_token) return null;
    const engine = new SyncEngine({ accountId, poster: this.posterFor(acc.poster_token) });
    engine.on('changed', (e) => this.emit('changed', { accountId, ...e }));
    engine.on('health', (h) => this.emit('health', { accountId, health: h }));
    this.engines.set(accountId, engine);
    await engine.start();
    return engine;
  }

  get(accountId) { return this.engines.get(accountId) ?? null; }

  health(accountId) {
    return this.get(accountId)?.getHealth() ?? { ok: false, lastError: 'Poster не подключён', queue: 0 };
  }

  stopAll() { for (const e of this.engines.values()) e.stop(); }
}
