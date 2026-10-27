// Keeps the KDS in step with Poster through three independent paths:
//  1. webhooks: instant, but may be delayed or lost;
//  2. fast poll of open checks every few seconds: the safety net;
//  3. full poll of today's checks every minute: catches closes and removals.
// All paths feed the same idempotent reconcile, so overlap is harmless.
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { query, tx, getSettings } from '../db.js';
import { poster as defaultPoster } from '../poster/client.js';
import { normalizeTransaction, normalizeCatalogProduct } from '../poster/normalize.js';
import { reconcileTransaction } from './reconcile.js';

export class SyncEngine extends EventEmitter {
  constructor({ poster = defaultPoster } = {}) {
    super();
    this.poster = poster;
    this.catalog = new Map();
    this.queue = new Set();
    this.working = false;
    this.timers = [];
    this.health = { lastPollOkAt: null, lastFullOkAt: null, lastCatalogAt: null, lastError: null, lastErrorAt: null, lastWebhookAt: null };
  }

  async start() {
    await this.loadCatalogFromDb();
    const s = await getSettings();
    if (!s.kds_started_at) {
      await query(`INSERT INTO settings (key, value) VALUES ('kds_started_at', $1) ON CONFLICT DO NOTHING`,
        [JSON.stringify(new Date().toISOString())]);
    }
    this.syncCatalog().catch(() => {});
    this.loop('open', config.sync.pollOpenMs, () => this.pollOpen());
    this.loop('full', config.sync.pollFullMs, () => this.pollFull());
    this.loop('catalog', config.sync.catalogMs, () => this.syncCatalog());
  }

  stop() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.stopped = true;
  }

  loop(name, ms, fn) {
    const tick = async () => {
      if (this.stopped) return;
      try { await fn(); } catch (err) { this.fail(name, err); }
      if (!this.stopped) this.timers.push(setTimeout(tick, ms));
    };
    this.timers.push(setTimeout(tick, name === 'catalog' ? ms : 0));
  }

  fail(where, err) {
    this.health.lastError = `${where}: ${err.message}`;
    this.health.lastErrorAt = new Date().toISOString();
    console.error(`[sync] ${where}:`, err.message);
    this.emit('health', this.getHealth());
  }

  getHealth() {
    const age = this.health.lastPollOkAt ? Date.now() - new Date(this.health.lastPollOkAt) : Infinity;
    return { ...this.health, ok: age < Math.max(config.sync.pollOpenMs * 5, 20000), queue: this.queue.size };
  }

  async loadCatalogFromDb() {
    const { rows } = await query('SELECT * FROM products');
    this.catalog = new Map(rows.map((r) => [r.poster_product_id, {
      id: r.poster_product_id, name: r.name, workshopId: r.workshop_id, modifications: r.modifications,
    }]));
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
          `INSERT INTO products (poster_product_id, name, category_name, workshop_id, modifications, hidden, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6, now())
           ON CONFLICT (poster_product_id) DO UPDATE SET name=EXCLUDED.name, category_name=EXCLUDED.category_name,
             workshop_id=EXCLUDED.workshop_id, modifications=EXCLUDED.modifications, hidden=EXCLUDED.hidden, updated_at=now()`,
          [p.id, p.name, p.category, p.workshopId, p.modifications, p.hidden],
        );
      }
      for (const w of workshops) {
        const id = Number(w.workshop_id ?? w.id);
        if (!id) continue;
        await c.query(
          `INSERT INTO workshops (poster_workshop_id, name) VALUES ($1,$2)
           ON CONFLICT (poster_workshop_id) DO UPDATE SET name=EXCLUDED.name`,
          [id, w.workshop_name ?? w.name ?? `Цех ${id}`],
        );
      }
      for (const e of employees) {
        const id = Number(e.user_id ?? e.id);
        if (!id) continue;
        await c.query(
          `INSERT INTO employees (poster_user_id, name, role_name) VALUES ($1,$2,$3)
           ON CONFLICT (poster_user_id) DO UPDATE SET name=EXCLUDED.name, role_name=EXCLUDED.role_name, updated_at=now()`,
          [id, e.name ?? `Сотрудник #${id}`, e.role_name ?? null],
        );
      }
    });
    await this.loadCatalogFromDb();
    this.health.lastCatalogAt = new Date().toISOString();
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
      `SELECT poster_transaction_id AS id FROM transactions WHERE status = 1 AND updated_at > now() - interval '2 days'`);
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
    const settings = await getSettings();
    let res = await tx((c) => reconcileTransaction(c, t, { catalog: this.catalog, settings, createUnits }));
    if (res.unknown.length) {
      // A product created after the last catalog sync: refresh and decide again.
      // If it's still unknown, show it rather than risk losing an order.
      await this.syncCatalog().catch((err) => this.fail('catalog', err));
      res = await tx((c) => reconcileTransaction(
        c, t, { catalog: this.catalog, settings, createUnits, includeUnknown: true, force: true }));
    }
    if (res.changed) this.emit('changed', { transactionId: t.id, ...res });
    return res;
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
