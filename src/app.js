import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { query, tx, audit, getSettings } from './db.js';
import { adminLogin, setAdminCookie, requireAdmin, requireDevice, pinAttemptAllowed, pinFailed, pinLookup, newToken, hmac } from './auth.js';
import { applyAction, startSession, endSession, dismissTicket, getBoard, ActionError } from './units.js';
import * as reports from './reports.js';
import { verifyWebhook, classifyWebhook } from './poster/webhook.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ engine, notify }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (req, res) => res.redirect('/kds/'));
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get('/health', (req, res) => res.json(engine.getHealth()));

  // ---- Poster webhooks ------------------------------------------------------
  app.post('/webhooks/poster', async (req, res) => {
    const body = req.body ?? {};
    const verified = verifyWebhook(body);
    engine.health.lastWebhookAt = new Date().toISOString();
    await query('INSERT INTO webhook_log (payload, verified) VALUES ($1, $2)', [body, verified]).catch(() => {});
    // Answer immediately; the payload is only a hint, data is always re-fetched from the API.
    res.json({ ok: true });
    if (!verified && config.poster.webhookStrict) return;
    const what = classifyWebhook(body);
    if (what.kind === 'transaction' && what.id) engine.enqueue(what.id);
    if (what.kind === 'catalog') engine.syncCatalog().catch((err) => engine.fail('catalog', err));
  });

  // ---- KDS screens ----------------------------------------------------------
  const kds = express.Router();
  kds.use(requireDevice);

  kds.get('/me', async (req, res) => {
    const s = await getSettings();
    res.json({
      device: req.device,
      settings: { warnMinutes: Number(s.warn_minutes), criticalMinutes: Number(s.critical_minutes), undoWindowSec: config.kds.undoWindowSec },
      health: engine.getHealth(),
    });
  });

  kds.get('/board', async (req, res) => res.json({ tickets: await getBoard(), serverTime: new Date().toISOString(), health: engine.getHealth() }));

  kds.post('/login', async (req, res) => {
    if (!pinAttemptAllowed(req.device.id)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
    const s = await startSession(String(req.body?.pin ?? ''), req.device);
    if (!s) {
      pinFailed(req.device.id);
      return res.status(401).json({ error: 'Неверный PIN' });
    }
    res.json(s);
  });

  kds.post('/logout', async (req, res) => {
    await endSession(req.body?.token);
    res.json({ ok: true });
  });

  kds.post('/action', async (req, res) => {
    const b = req.body ?? {};
    const result = await applyAction({ opId: b.op_id, token: b.token, action: b.action, unitIds: b.unit_ids, force: !!b.force, device: req.device });
    notify();
    res.json(result);
  });

  kds.post('/tickets/:id/dismiss', async (req, res) => {
    await dismissTicket(Number(req.params.id), req.device);
    notify();
    res.json({ ok: true });
  });

  app.use('/api/kds', kds);

  // ---- Admin ----------------------------------------------------------------
  app.post('/api/admin/login', (req, res) => {
    const v = adminLogin(req.body?.password);
    if (!v) return res.status(401).json({ error: 'Неверный пароль' });
    setAdminCookie(res, v);
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', (req, res) => {
    setAdminCookie(res, 'x');
    res.json({ ok: true });
  });

  const admin = express.Router();
  admin.use(requireAdmin);

  admin.get('/status', async (req, res) => {
    const counts = (await query(
      `SELECT (SELECT count(*) FROM units WHERE status IN ('new','taken')) AS open_units,
              (SELECT count(*) FROM products) AS products,
              (SELECT count(*) FROM employees WHERE is_bartender AND active) AS bartenders,
              (SELECT count(*) FROM employees WHERE is_bartender AND active AND pin_lookup IS NULL) AS bartenders_without_pin,
              (SELECT count(*) FROM devices WHERE active) AS devices,
              (SELECT count(*) FROM webhook_log WHERE received_at > now() - interval '1 day') AS webhooks_24h,
              (SELECT count(*) FROM webhook_log WHERE received_at > now() - interval '1 day' AND NOT verified) AS webhooks_unverified_24h`)).rows[0];
    const s = await getSettings();
    res.json({ health: engine.getHealth(), counts, posterConfigured: !!config.poster.token, barWorkshops: s.bar_workshop_ids });
  });

  const EDITABLE = ['bar_workshop_ids', 'credit_made_then_removed', 'warn_minutes', 'critical_minutes', 'ready_visible_seconds', 'day_start_hour'];
  admin.get('/settings', async (req, res) => res.json(await getSettings()));
  admin.put('/settings', async (req, res) => {
    await tx(async (c) => {
      for (const k of EDITABLE) {
        if (req.body?.[k] === undefined) continue;
        await c.query(`UPDATE settings SET value = $2, updated_at = now() WHERE key = $1`, [k, JSON.stringify(req.body[k])]);
      }
      await audit(c, { actor: 'admin', action: 'settings_changed', details: req.body });
    });
    notify();
    res.json(await getSettings());
  });

  admin.get('/workshops', async (req, res) => res.json((await query('SELECT * FROM workshops ORDER BY name')).rows));

  admin.get('/employees', async (req, res) => {
    res.json((await query(
      `SELECT id, poster_user_id, name, role_name, is_bartender, active, pin_lookup IS NOT NULL AS has_pin
       FROM employees ORDER BY active DESC, is_bartender DESC, name`)).rows);
  });
  admin.post('/employees', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Укажите имя' });
    const { rows } = await query(`INSERT INTO employees (name, is_bartender) VALUES ($1, true) RETURNING id`, [name]);
    res.json(rows[0]);
  });
  admin.patch('/employees/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    await tx(async (c) => {
      if (b.pin !== undefined) {
        if (b.pin === null || b.pin === '') {
          await c.query('UPDATE employees SET pin_lookup = NULL WHERE id = $1', [id]);
        } else {
          if (!/^\d{4,8}$/.test(String(b.pin))) throw new ActionError('PIN — от 4 до 8 цифр', 400);
          const taken = (await c.query('SELECT id FROM employees WHERE pin_lookup = $1 AND id <> $2', [pinLookup(b.pin), id])).rows[0];
          if (taken) throw new ActionError('Такой PIN уже у другого сотрудника', 409);
          await c.query('UPDATE employees SET pin_lookup = $2 WHERE id = $1', [id, pinLookup(b.pin)]);
        }
      }
      for (const k of ['name', 'is_bartender', 'active']) {
        if (b[k] !== undefined) await c.query(`UPDATE employees SET ${k} = $2, updated_at = now() WHERE id = $1`, [id, b[k]]);
      }
      if (b.active === false || b.pin !== undefined) await c.query('DELETE FROM kds_sessions WHERE employee_id = $1', [id]);
      await audit(c, { actor: 'admin', action: 'employee_changed', employeeId: id, details: { ...b, pin: b.pin === undefined ? undefined : '***' } });
    });
    res.json({ ok: true });
  });

  admin.get('/products', async (req, res) => {
    const s = await getSettings();
    const ws = (s.bar_workshop_ids ?? []).map(Number);
    res.json((await query(
      `SELECT p.poster_product_id AS id, p.name, p.category_name, p.workshop_id, w.name AS workshop_name, r.rate
       FROM products p LEFT JOIN workshops w ON w.poster_workshop_id = p.workshop_id
       LEFT JOIN product_rates r ON r.poster_product_id = p.poster_product_id
       WHERE NOT p.hidden AND (cardinality($1::int[]) = 0 OR p.workshop_id = ANY($1))
       ORDER BY p.category_name NULLS LAST, p.name`, [ws])).rows);
  });
  admin.put('/rates/:productId', async (req, res) => {
    const rate = Number(req.body?.rate);
    if (!(rate >= 0)) return res.status(400).json({ error: 'Ставка должна быть числом ≥ 0' });
    await tx(async (c) => {
      await c.query(
        `INSERT INTO product_rates (poster_product_id, rate) VALUES ($1, $2)
         ON CONFLICT (poster_product_id) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now()`,
        [Number(req.params.productId), rate]);
      await audit(c, { actor: 'admin', action: 'rate_changed', details: { productId: Number(req.params.productId), rate } });
    });
    res.json({ ok: true });
  });

  admin.get('/devices', async (req, res) => res.json((await query('SELECT id, name, active, created_at, last_seen_at FROM devices ORDER BY id')).rows));
  admin.post('/devices', async (req, res) => {
    const token = newToken();
    const name = String(req.body?.name ?? '').trim() || 'Экран бара';
    const { rows } = await query('INSERT INTO devices (name, token_hash) VALUES ($1, $2) RETURNING id, name', [name, hmac(token)]);
    res.json({ ...rows[0], token });
  });
  admin.delete('/devices/:id', async (req, res) => {
    await query('UPDATE devices SET active = false WHERE id = $1', [Number(req.params.id)]);
    await query('DELETE FROM kds_sessions WHERE device_id = $1', [Number(req.params.id)]);
    res.json({ ok: true });
  });

  const REPORT_COLUMNS = {
    bartenders: [['name', 'Бармен'], ['portions', 'Порций сделано'], ['earned', 'Начислено'], ['without_rate', 'Порций без ставки'],
      ['checks', 'Чеков'], ['avg_make_sec', 'Ср. приготовление, сек'], ['avg_total_sec', 'Ср. от заказа до готовности, сек'],
      ['made_then_removed', 'Сделано, затем удалено из чека']],
    sellers: [['name', 'Сотрудник'], ['checks', 'Закрыто чеков'], ['payed', 'Оплачено'], ['total', 'Сумма чеков'],
      ['avg_check', 'Средний чек'], ['bar_portions', 'Барных порций продано']],
    products: [['name', 'Позиция'], ['portions', 'Порций'], ['avg_total_sec', 'Ср. время, сек'], ['rate', 'Ставка'],
      ['made_then_removed', 'Сделано, затем удалено']],
    details: [['created_at', 'Заказано'], ['ready_at', 'Готово'], ['check_id', 'Чек'], ['table_name', 'Стол'], ['name', 'Позиция'],
      ['modifiers', 'Модификатор'], ['sold_by', 'Продал'], ['taken_by', 'Взял'], ['made_by', 'Сделал'], ['status', 'Статус'],
      ['made_then_removed', 'Удалено после приготовления'], ['total_sec', 'Время, сек'], ['rate', 'Ставка']],
  };
  admin.get('/reports/:kind', async (req, res) => {
    const { kind } = req.params;
    const { from, to, employee_id: employeeId, format } = req.query;
    if (!reports[kind] || kind === 'toCsv') return res.status(404).json({ error: 'Нет такого отчёта' });
    const data = await reports[kind](from, to, employeeId);
    if (format === 'csv' && REPORT_COLUMNS[kind]) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${kind}_${from}_${to}.csv"`);
      return res.send(reports.toCsv(data, REPORT_COLUMNS[kind]));
    }
    res.json(data);
  });

  // Manual correction, e.g. "Ivan made it but Petr tapped by mistake". Always audited.
  admin.post('/units/:id/reassign', async (req, res) => {
    const id = Number(req.params.id);
    const employeeId = Number(req.body?.employee_id);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Укажите причину исправления' });
    await tx(async (c) => {
      const u = (await c.query('SELECT id, ready_by, status, transaction_id FROM units WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!u || !u.ready_by) throw new ActionError('Позиция ещё не отмечена готовой', 409);
      await c.query('UPDATE units SET ready_by = $2 WHERE id = $1', [id, employeeId]);
      await audit(c, { actor: 'admin', action: 'admin_reassign', unitId: id, transactionId: u.transaction_id,
        details: { from: u.ready_by, to: employeeId, reason } });
    });
    res.json({ ok: true });
  });

  admin.post('/sync/catalog', async (req, res) => {
    await engine.syncCatalog();
    res.json({ ok: true });
  });
  admin.post('/sync/backfill', async (req, res) => {
    const from = new Date(req.body?.from);
    const to = new Date(req.body?.to);
    if (Number.isNaN(+from) || Number.isNaN(+to) || to < from || to - from > 93 * 24 * 3600e3) {
      return res.status(400).json({ error: 'Период до 3 месяцев' });
    }
    res.json({ ok: true, checks: await engine.backfill(from, to) });
  });

  admin.get('/webhooks', async (req, res) => res.json((await query('SELECT * FROM webhook_log ORDER BY id DESC LIMIT 100')).rows));
  admin.get('/audit', async (req, res) => {
    res.json((await query(
      `SELECT a.*, e.name AS employee_name, d.name AS device_name, u.name AS unit_name
       FROM audit_log a LEFT JOIN employees e ON e.id = a.employee_id
       LEFT JOIN devices d ON d.id = a.device_id LEFT JOIN units u ON u.id = a.unit_id
       WHERE ($1::bigint IS NULL AND $2::bigint IS NULL) OR a.unit_id = $1 OR a.transaction_id = $2
       ORDER BY a.id DESC LIMIT 300`, [req.query.unit_id ?? null, req.query.check_id ?? null])).rows);
  });

  app.use('/api/admin', admin);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[http]', err);
    res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message });
  });

  return app;
}
