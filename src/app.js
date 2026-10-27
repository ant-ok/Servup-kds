import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { query, tx, audit, getSettings } from './db.js';
import {
  requireAdmin, requireDevice, requirePlatform, signSession, setSessionCookie, platformLogin, verifyPassword,
  hashPassword, pinAttemptAllowed, pinFailed, pinLookup, newToken, hmac, oauthState, checkOauthState,
} from './auth.js';
import { applyAction, serveTicket, startSession, endSession, dismissTicket, getBoard, ActionError } from './units.js';
import { REPORTS, toCsv } from './reports.js';
import { getSummary, getRecipe, suggestNorms } from './kitchen.js';
import { createAccount, DEFAULT_SETTINGS } from './accounts.js';
import { stationResolver } from './sync/reconcile.js';
import { verifyWebhook, classifyWebhook } from './poster/webhook.js';
import { exchangeOAuthCode } from './poster/client.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PRESETS = ['bar', 'restaurant'];

export function createApp({ engines, notify, exchangeCode = exchangeOAuthCode }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get('/health', (req, res) => res.json({ ok: true, venues: engines.engines.size }));

  // ---- Poster webhooks: one URL for every venue, routed by `account` -------
  app.post('/webhooks/poster', async (req, res) => {
    const body = req.body ?? {};
    const verified = verifyWebhook(body);
    const acc = body.account
      ? (await query('SELECT id FROM accounts WHERE poster_account = $1 AND active', [String(body.account)])).rows[0]
      : null;
    await query('INSERT INTO webhook_log (account_id, payload, verified, error) VALUES ($1, $2, $3, $4)',
      [acc?.id ?? null, body, verified, acc ? null : 'unknown account']).catch(() => {});
    // Answer immediately; the payload is only a hint, data is always re-fetched from the API.
    res.json({ ok: true });
    const engine = acc && engines.get(acc.id);
    if (!engine || (!verified && config.poster.webhookStrict)) return;
    engine.health.lastWebhookAt = new Date().toISOString();
    const what = classifyWebhook(body);
    if (what.kind === 'transaction' && what.id) engine.enqueue(what.id);
    if (what.kind === 'catalog') engine.syncCatalog().catch((err) => engine.fail('catalog', err));
  });

  // ---- Venue self-onboarding through Poster OAuth --------------------------
  app.get('/auth/poster/start', (req, res) => {
    if (!config.poster.appId) return res.status(503).send('Подключение через Poster не настроено (POSTER_APP_ID)');
    const preset = PRESETS.includes(req.query.preset) ? req.query.preset : 'bar';
    const url = new URL(config.poster.oauthAuthorizeUrl);
    url.searchParams.set('application_id', config.poster.appId);
    url.searchParams.set('redirect_uri', `${config.publicUrl}/auth/poster/callback`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', oauthState(preset));
    res.redirect(url.toString());
  });

  app.get('/auth/poster/callback', async (req, res) => {
    const { code, account } = req.query;
    const preset = checkOauthState(req.query.state);
    if (!code || !account || preset === null) return res.status(400).send('Неверный ответ от Poster. Попробуйте подключиться ещё раз.');
    let data;
    try {
      data = await exchangeCode({ account: String(account), code: String(code) });
    } catch (err) {
      console.error('[oauth]', err.message);
      return res.status(502).send(`Poster не выдал доступ: ${err.message}`);
    }
    const posterAccount = String(data.account ?? account);
    let acc = (await query('SELECT id FROM accounts WHERE poster_account = $1', [posterAccount])).rows[0];
    if (acc) {
      await query('UPDATE accounts SET poster_token = $2, active = true, updated_at = now() WHERE id = $1', [acc.id, data.access_token]);
    } else {
      acc = await createAccount({ name: data.ownerInfo?.company_name || posterAccount, posterAccount, token: data.access_token, preset });
    }
    await engines.restart(acc.id);
    setSessionCookie(res, 'admin', signSession('admin', acc.id));
    res.redirect('/admin/');
  });

  // ---- KDS screens ------------------------------------------------------------
  const kds = express.Router();
  kds.use(requireDevice);

  kds.get('/me', async (req, res) => {
    const s = await getSettings(req.device.account_id);
    res.json({
      device: req.device,
      settings: { warnMinutes: Number(s.warn_minutes), criticalMinutes: Number(s.critical_minutes),
        undoWindowSec: config.kds.undoWindowSec, makerTitle: s.maker_title ?? DEFAULT_SETTINGS.maker_title },
      health: engines.health(req.device.account_id),
    });
  });

  kds.get('/board', async (req, res) => {
    res.json({ ...(await getBoard(req.device)), serverTime: new Date().toISOString(), health: engines.health(req.device.account_id) });
  });

  kds.get('/summary', async (req, res) => res.json(await getSummary(req.device, engines.get(req.device.account_id))));

  kds.get('/recipe/:productId', async (req, res) => {
    const r = await getRecipe(req.device.account_id, Number(req.params.productId), engines.get(req.device.account_id));
    if (!r) return res.status(404).json({ error: 'Позиция не найдена' });
    res.json(r);
  });

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
    notify(req.device.account_id);
    res.json(result);
  });

  kds.post('/tickets/:id/serve', async (req, res) => {
    const b = req.body ?? {};
    const result = await serveTicket({ opId: b.op_id, token: b.token, ticketId: Number(req.params.id), undo: !!b.undo, device: req.device });
    notify(req.device.account_id);
    res.json(result);
  });

  kds.post('/tickets/:id/dismiss', async (req, res) => {
    await dismissTicket(Number(req.params.id), req.device);
    notify(req.device.account_id);
    res.json({ ok: true });
  });

  app.use('/api/kds', kds);

  // ---- Venue admin --------------------------------------------------------------
  // Sign in by Poster account name (or venue id) and password; or via Poster OAuth.
  app.post('/api/admin/login', async (req, res) => {
    const login = String(req.body?.account ?? '').trim().toLowerCase();
    const acc = (await query(
      `SELECT id, admin_password FROM accounts WHERE active AND (lower(poster_account) = $1 OR id::text = $1)`, [login])).rows[0];
    if (!acc || !(await verifyPassword(req.body?.password, acc.admin_password))) {
      return res.status(401).json({ error: 'Неверное заведение или пароль' });
    }
    setSessionCookie(res, 'admin', signSession('admin', acc.id));
    res.json({ ok: true });
  });
  app.post('/api/admin/logout', (req, res) => {
    setSessionCookie(res, 'admin', 'x', 0);
    res.json({ ok: true });
  });
  app.get('/api/admin/oauth', (req, res) => res.json({ enabled: !!config.poster.appId }));

  const admin = express.Router();
  admin.use(requireAdmin);
  const A = (req) => req.account.id;

  admin.get('/status', async (req, res) => {
    const a = A(req);
    const counts = (await query(
      `SELECT (SELECT count(*) FROM units WHERE account_id = $1 AND status IN ('new','taken')) AS open_units,
              (SELECT count(*) FROM products WHERE account_id = $1) AS products,
              (SELECT count(*) FROM employees WHERE account_id = $1 AND kds_access AND active) AS kds_staff,
              (SELECT count(*) FROM employees WHERE account_id = $1 AND kds_access AND active AND pin_lookup IS NULL) AS kds_staff_without_pin,
              (SELECT count(*) FROM devices WHERE account_id = $1 AND active) AS devices,
              (SELECT count(*) FROM webhook_log WHERE account_id = $1 AND received_at > now() - interval '1 day') AS webhooks_24h,
              (SELECT count(*) FROM webhook_log WHERE account_id = $1 AND received_at > now() - interval '1 day' AND NOT verified) AS webhooks_unverified_24h`,
      [a])).rows[0];
    const acc = (await query('SELECT poster_token IS NOT NULL AS connected, admin_password IS NOT NULL AS has_password FROM accounts WHERE id = $1', [a])).rows[0];
    const resolver = await resolverFor(a);
    const workshops = (await query('SELECT poster_workshop_id AS id, name FROM workshops WHERE account_id = $1', [a])).rows;
    res.json({
      account: req.account, health: engines.health(a), counts, posterConnected: acc.connected, hasPassword: acc.has_password,
      webhookUrl: `${config.publicUrl}/webhooks/poster`,
      // Workshops whose products appear on no screen at all.
      unroutedWorkshops: workshops.filter((w) => !resolver(w.id)).map((w) => w.name),
    });
  });

  admin.get('/account', async (req, res) => res.json(req.account));
  admin.patch('/account', async (req, res) => {
    const b = req.body ?? {};
    if (b.name) await query('UPDATE accounts SET name = $2, updated_at = now() WHERE id = $1', [A(req), String(b.name)]);
    if (b.password) {
      if (String(b.password).length < 8) throw new ActionError('Пароль — минимум 8 символов', 400);
      await query('UPDATE accounts SET admin_password = $2, updated_at = now() WHERE id = $1', [A(req), await hashPassword(String(b.password))]);
    }
    res.json({ ok: true });
  });

  const EDITABLE = ['credit_made_then_removed', 'warn_minutes', 'critical_minutes', 'ready_visible_seconds', 'day_start_hour', 'maker_title'];
  admin.get('/settings', async (req, res) => res.json(await getSettings(A(req))));
  admin.put('/settings', async (req, res) => {
    await tx(async (c) => {
      for (const k of EDITABLE) {
        if (req.body?.[k] === undefined) continue;
        await c.query(
          `INSERT INTO settings (account_id, key, value) VALUES ($1,$2,$3)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [A(req), k, JSON.stringify(req.body[k])]);
      }
      await audit(c, { accountId: A(req), actor: 'admin', action: 'settings_changed', details: req.body });
    });
    notify(A(req));
    res.json(await getSettings(A(req)));
  });

  // -- stations
  async function resolverFor(accountId) {
    const stations = (await query('SELECT * FROM stations WHERE account_id = $1', [accountId])).rows;
    const ws = new Map((await query('SELECT * FROM workshops WHERE account_id = $1', [accountId])).rows.map((w) => [w.poster_workshop_id, w.name]));
    return stationResolver(stations, ws);
  }
  const stationChanged = async (accountId) => {
    await engines.get(accountId)?.loadStations();
    notify(accountId);
  };

  admin.get('/stations', async (req, res) => {
    res.json((await query('SELECT * FROM stations WHERE account_id = $1 AND active ORDER BY sort, id', [A(req)])).rows);
  });
  admin.post('/stations', async (req, res) => {
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    if (!name) throw new ActionError('Укажите название станции', 400);
    const { rows } = await query(
      `INSERT INTO stations (account_id, name, kind, workshop_ids, group_items, sort)
       VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(sort),0)+1 FROM stations WHERE account_id = $1)) RETURNING *`,
      [A(req), name, b.kind === 'expo' ? 'expo' : 'prep', (b.workshop_ids ?? []).map(Number), !!b.group_items]);
    await stationChanged(A(req));
    res.json(rows[0]);
  });
  admin.patch('/stations/:id', async (req, res) => {
    const b = req.body ?? {};
    const id = Number(req.params.id);
    const fields = { name: b.name, workshop_ids: b.workshop_ids?.map(Number), group_items: b.group_items, sort: b.sort };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) await query(`UPDATE stations SET ${k} = $3 WHERE id = $1 AND account_id = $2`, [id, A(req), v]);
    }
    await stationChanged(A(req));
    res.json({ ok: true });
  });
  admin.delete('/stations/:id', async (req, res) => {
    await query('UPDATE stations SET active = false WHERE id = $1 AND account_id = $2', [Number(req.params.id), A(req)]);
    await query('UPDATE devices SET station_id = NULL WHERE station_id = $1 AND account_id = $2', [Number(req.params.id), A(req)]);
    await stationChanged(A(req));
    res.json({ ok: true });
  });

  admin.get('/workshops', async (req, res) => {
    const resolve = await resolverFor(A(req));
    const rows = (await query('SELECT poster_workshop_id AS id, name FROM workshops WHERE account_id = $1 ORDER BY name', [A(req)])).rows;
    res.json(rows.map((w) => ({ ...w, station_id: resolve(w.id) })));
  });

  // -- employees
  admin.get('/employees', async (req, res) => {
    res.json((await query(
      `SELECT id, poster_user_id, name, role_name, kds_access, active, pin_lookup IS NOT NULL AS has_pin
       FROM employees WHERE account_id = $1 ORDER BY active DESC, kds_access DESC, name`, [A(req)])).rows);
  });
  admin.post('/employees', async (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'Укажите имя' });
    const { rows } = await query(`INSERT INTO employees (account_id, name, kds_access) VALUES ($1, $2, true) RETURNING id`, [A(req), name]);
    res.json(rows[0]);
  });
  admin.patch('/employees/:id', async (req, res) => {
    const id = Number(req.params.id);
    const a = A(req);
    const b = req.body ?? {};
    await tx(async (c) => {
      const own = (await c.query('SELECT id FROM employees WHERE id = $1 AND account_id = $2', [id, a])).rows[0];
      if (!own) throw new ActionError('Сотрудник не найден', 404);
      if (b.pin !== undefined) {
        if (b.pin === null || b.pin === '') {
          await c.query('UPDATE employees SET pin_lookup = NULL WHERE id = $1', [id]);
        } else {
          if (!/^\d{4,8}$/.test(String(b.pin))) throw new ActionError('PIN — от 4 до 8 цифр', 400);
          const lookup = pinLookup(a, b.pin);
          const taken = (await c.query('SELECT id FROM employees WHERE account_id = $1 AND pin_lookup = $2 AND id <> $3', [a, lookup, id])).rows[0];
          if (taken) throw new ActionError('Такой PIN уже у другого сотрудника', 409);
          await c.query('UPDATE employees SET pin_lookup = $2 WHERE id = $1', [id, lookup]);
        }
      }
      for (const k of ['name', 'kds_access', 'active']) {
        if (b[k] !== undefined) await c.query(`UPDATE employees SET ${k} = $2, updated_at = now() WHERE id = $1`, [id, b[k]]);
      }
      if (b.active === false || b.kds_access === false || b.pin !== undefined) await c.query('DELETE FROM kds_sessions WHERE employee_id = $1', [id]);
      await audit(c, { accountId: a, actor: 'admin', action: 'employee_changed', employeeId: id,
        details: { ...b, pin: b.pin === undefined ? undefined : '***' } });
    });
    res.json({ ok: true });
  });

  // -- products & rates
  admin.get('/products', async (req, res) => {
    const resolve = await resolverFor(A(req));
    const rows = (await query(
      `SELECT p.poster_product_id AS id, p.name, p.category_name, p.workshop_id, w.name AS workshop_name, r.rate,
              i.norm_seconds, i.recipe_note, jsonb_array_length(COALESCE(p.recipe, '[]')) AS ingredients,
              fact.median_sec, fact.samples
       FROM products p LEFT JOIN workshops w ON w.account_id = p.account_id AND w.poster_workshop_id = p.workshop_id
       LEFT JOIN product_rates r ON r.account_id = p.account_id AND r.poster_product_id = p.poster_product_id
       LEFT JOIN product_info i ON i.account_id = p.account_id AND i.poster_product_id = p.poster_product_id
       LEFT JOIN LATERAL (
         SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM u.ready_at - u.taken_at)))::int AS median_sec,
                count(*)::int AS samples
         FROM units u WHERE u.account_id = p.account_id AND u.poster_product_id = p.poster_product_id
           AND u.status = 'ready' AND u.ready_at > u.taken_at AND u.ready_at > now() - interval '30 days') fact ON true
       WHERE p.account_id = $1 AND NOT p.hidden ORDER BY p.category_name NULLS LAST, p.name`, [A(req)])).rows;
    const stationId = req.query.station_id ? Number(req.query.station_id) : null;
    res.json(rows.map((p) => ({ ...p, station_id: resolve(p.workshop_id) }))
      .filter((p) => p.station_id && (!stationId || p.station_id === stationId)));
  });
  admin.put('/rates/:productId', async (req, res) => {
    const rate = Number(req.body?.rate);
    if (!(rate >= 0)) return res.status(400).json({ error: 'Ставка должна быть числом ≥ 0' });
    await tx(async (c) => {
      await c.query(
        `INSERT INTO product_rates (account_id, poster_product_id, rate) VALUES ($1, $2, $3)
         ON CONFLICT (account_id, poster_product_id) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now()`,
        [A(req), Number(req.params.productId), rate]);
      await audit(c, { accountId: A(req), actor: 'admin', action: 'rate_changed', details: { productId: Number(req.params.productId), rate } });
    });
    res.json({ ok: true });
  });

  // Norm (seconds from "taken" to "ready") and the venue's own recipe note.
  admin.put('/products/:productId/info', async (req, res) => {
    const b = req.body ?? {};
    const norm = b.norm_seconds === null || b.norm_seconds === '' ? null : Number(b.norm_seconds);
    if (norm !== null && norm !== undefined && !(norm > 0 && norm < 24 * 3600)) throw new ActionError('Норма — число секунд больше нуля', 400);
    await query(
      `INSERT INTO product_info (account_id, poster_product_id, norm_seconds, recipe_note) VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id, poster_product_id) DO UPDATE SET
         norm_seconds = CASE WHEN $5 THEN EXCLUDED.norm_seconds ELSE product_info.norm_seconds END,
         recipe_note = CASE WHEN $6 THEN EXCLUDED.recipe_note ELSE product_info.recipe_note END, updated_at = now()`,
      [A(req), Number(req.params.productId), norm ?? null, b.recipe_note ?? null, b.norm_seconds !== undefined, b.recipe_note !== undefined]);
    notify(A(req));
    res.json({ ok: true });
  });
  admin.post('/products/norms/suggest', async (req, res) => {
    res.json({ ok: true, updated: await suggestNorms(A(req), { overwrite: !!req.body?.overwrite }) });
  });
  admin.get('/products/:productId/recipe', async (req, res) => {
    const r = await getRecipe(A(req), Number(req.params.productId), engines.get(A(req)));
    if (!r) return res.status(404).json({ error: 'Позиция не найдена' });
    res.json(r);
  });

  // -- devices
  admin.get('/devices', async (req, res) => {
    res.json((await query(
      `SELECT d.id, d.name, d.station_id, s.name AS station_name, d.active, d.created_at, d.last_seen_at
       FROM devices d LEFT JOIN stations s ON s.id = d.station_id WHERE d.account_id = $1 ORDER BY d.id`, [A(req)])).rows);
  });
  const ownStation = async (accountId, stationId) => {
    if (stationId == null || stationId === '') return null;
    const s = (await query('SELECT id FROM stations WHERE id = $1 AND account_id = $2 AND active', [Number(stationId), accountId])).rows[0];
    if (!s) throw new ActionError('Станция не найдена', 404);
    return s.id;
  };
  admin.post('/devices', async (req, res) => {
    const token = newToken();
    const name = String(req.body?.name ?? '').trim() || 'Экран';
    const stationId = await ownStation(A(req), req.body?.station_id);
    const { rows } = await query(
      'INSERT INTO devices (account_id, name, station_id, token_hash) VALUES ($1,$2,$3,$4) RETURNING id, name',
      [A(req), name, stationId, hmac(token)]);
    res.json({ ...rows[0], token });
  });
  admin.patch('/devices/:id', async (req, res) => {
    const stationId = await ownStation(A(req), req.body?.station_id);
    await query('UPDATE devices SET station_id = $3 WHERE id = $1 AND account_id = $2', [Number(req.params.id), A(req), stationId]);
    notify(A(req));
    res.json({ ok: true });
  });
  admin.delete('/devices/:id', async (req, res) => {
    await query('UPDATE devices SET active = false WHERE id = $1 AND account_id = $2', [Number(req.params.id), A(req)]);
    await query('DELETE FROM kds_sessions WHERE device_id IN (SELECT id FROM devices WHERE id = $1 AND account_id = $2)', [Number(req.params.id), A(req)]);
    res.json({ ok: true });
  });

  // -- reports
  const REPORT_COLUMNS = {
    makers: [['name', 'Сотрудник'], ['stations', 'Станции'], ['portions', 'Порций сделано'], ['earned', 'Начислено'],
      ['without_rate', 'Порций без ставки'], ['checks', 'Чеков'], ['avg_make_sec', 'Ср. приготовление, сек'],
      ['avg_total_sec', 'Ср. от заказа до готовности, сек'], ['within_norm_pct', 'В норму, %'],
      ['made_then_removed', 'Сделано, затем удалено из чека']],
    sellers: [['name', 'Сотрудник'], ['checks', 'Закрыто чеков'], ['payed', 'Оплачено'], ['total', 'Сумма чеков'],
      ['avg_check', 'Средний чек'], ['kds_portions', 'Порций через KDS']],
    runners: [['name', 'Сотрудник'], ['tickets', 'Выдано заказов'], ['avg_wait_sec', 'Ср. ожидание на раздаче, сек'],
      ['avg_total_sec', 'Ср. от заказа до выдачи, сек']],
    stations: [['name', 'Станция'], ['portions', 'Порций'], ['avg_total_sec', 'Ср. время, сек'], ['p90_total_sec', '90% заказов быстрее, сек'],
      ['earned', 'Начислено'], ['people', 'Сотрудников']],
    products: [['name', 'Позиция'], ['station', 'Станция'], ['portions', 'Порций'], ['avg_total_sec', 'Ср. время, сек'],
      ['avg_make_sec', 'Ср. приготовление, сек'], ['norm_sec', 'Норма, сек'], ['within_norm_pct', 'В норму, %'], ['rate', 'Ставка'],
      ['made_then_removed', 'Сделано, затем удалено']],
    details: [['created_at', 'Заказано'], ['ready_at', 'Готово'], ['station', 'Станция'], ['check_id', 'Чек'], ['table_name', 'Стол'],
      ['name', 'Позиция'], ['modifiers', 'Модификатор'], ['sold_by', 'Продал'], ['taken_by', 'Взял'], ['made_by', 'Сделал'],
      ['served_by', 'Выдал'], ['status', 'Статус'], ['made_then_removed', 'Удалено после приготовления'], ['total_sec', 'Время, сек'],
      ['rate', 'Ставка']],
  };
  admin.get('/reports/:kind', async (req, res) => {
    const fn = REPORTS[req.params.kind];
    if (!fn) return res.status(404).json({ error: 'Нет такого отчёта' });
    const { from, to, employee_id: employeeId, station_id: stationId, format } = req.query;
    const data = await fn({ accountId: A(req), from, to, employeeId, stationId });
    if (format === 'csv' && REPORT_COLUMNS[req.params.kind]) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.kind}_${from}_${to}.csv"`);
      return res.send(toCsv(data, REPORT_COLUMNS[req.params.kind]));
    }
    res.json(data);
  });

  // Manual correction, e.g. "Ivan made it but Petr tapped by mistake". Always audited.
  admin.post('/units/:id/reassign', async (req, res) => {
    const id = Number(req.params.id);
    const a = A(req);
    const employeeId = Number(req.body?.employee_id);
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return res.status(400).json({ error: 'Укажите причину исправления' });
    await tx(async (c) => {
      const u = (await c.query(
        `SELECT u.id, u.ready_by, t.poster_transaction_id FROM units u JOIN transactions t ON t.id = u.transaction_id
         WHERE u.id = $1 AND u.account_id = $2 FOR UPDATE OF u`, [id, a])).rows[0];
      if (!u || !u.ready_by) throw new ActionError('Позиция ещё не отмечена готовой', 409);
      const emp = (await c.query('SELECT id FROM employees WHERE id = $1 AND account_id = $2', [employeeId, a])).rows[0];
      if (!emp) throw new ActionError('Сотрудник не найден', 404);
      await c.query('UPDATE units SET ready_by = $2 WHERE id = $1', [id, employeeId]);
      await audit(c, { accountId: a, actor: 'admin', action: 'admin_reassign', unitId: id, transactionId: u.poster_transaction_id,
        details: { from: u.ready_by, to: employeeId, reason } });
    });
    res.json({ ok: true });
  });

  // -- sync & diagnostics
  const engineOf = (req) => {
    const e = engines.get(A(req));
    if (!e) throw new ActionError('Poster не подключён', 409);
    return e;
  };
  admin.post('/sync/catalog', async (req, res) => {
    await engineOf(req).syncCatalog();
    res.json({ ok: true });
  });
  admin.post('/sync/backfill', async (req, res) => {
    const from = new Date(req.body?.from);
    const to = new Date(req.body?.to);
    if (Number.isNaN(+from) || Number.isNaN(+to) || to < from || to - from > 93 * 24 * 3600e3) {
      return res.status(400).json({ error: 'Период до 3 месяцев' });
    }
    res.json({ ok: true, checks: await engineOf(req).backfill(from, to) });
  });

  admin.get('/webhooks', async (req, res) => {
    res.json((await query('SELECT * FROM webhook_log WHERE account_id = $1 ORDER BY id DESC LIMIT 100', [A(req)])).rows);
  });
  admin.get('/audit', async (req, res) => {
    res.json((await query(
      `SELECT a.*, e.name AS employee_name, d.name AS device_name, u.name AS unit_name
       FROM audit_log a LEFT JOIN employees e ON e.id = a.employee_id
       LEFT JOIN devices d ON d.id = a.device_id LEFT JOIN units u ON u.id = a.unit_id
       WHERE a.account_id = $1 AND (($2::bigint IS NULL AND $3::bigint IS NULL) OR a.unit_id = $2 OR a.transaction_id = $3)
       ORDER BY a.id DESC LIMIT 300`, [A(req), req.query.unit_id ?? null, req.query.check_id ?? null])).rows);
  });

  app.use('/api/admin', admin);

  // ---- Platform owner: all venues of this installation ----------------------------
  app.post('/api/platform/login', (req, res) => {
    const v = platformLogin(req.body?.password);
    if (!v) return res.status(401).json({ error: 'Неверный пароль' });
    setSessionCookie(res, 'platform', v);
    res.json({ ok: true });
  });
  const platform = express.Router();
  platform.use(requirePlatform);
  platform.get('/accounts', async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.name, a.poster_account, a.active, a.created_at, a.poster_token IS NOT NULL AS connected,
         (SELECT count(*) FROM devices d WHERE d.account_id = a.id AND d.active) AS devices,
         (SELECT max(d.last_seen_at) FROM devices d WHERE d.account_id = a.id) AS last_screen_at,
         (SELECT count(*) FROM units u WHERE u.account_id = a.id AND u.created_at > now() - interval '1 day') AS portions_24h
       FROM accounts a ORDER BY a.id`);
    res.json(rows.map((r) => ({ ...r, health: engines.health(r.id) })));
  });
  platform.post('/accounts', async (req, res) => {
    const b = req.body ?? {};
    if (!String(b.name ?? '').trim()) throw new ActionError('Укажите название', 400);
    const acc = await createAccount({
      name: String(b.name).trim(), posterAccount: b.poster_account ? String(b.poster_account).trim() : null,
      token: b.token || null, password: b.password || null, preset: PRESETS.includes(b.preset) ? b.preset : 'bar',
    });
    await engines.restart(acc.id);
    res.json(acc);
  });
  platform.patch('/accounts/:id', async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    if (b.active !== undefined) await query('UPDATE accounts SET active = $2, updated_at = now() WHERE id = $1', [id, !!b.active]);
    if (b.token) await query('UPDATE accounts SET poster_token = $2, updated_at = now() WHERE id = $1', [id, String(b.token)]);
    if (b.password) await query('UPDATE accounts SET admin_password = $2 WHERE id = $1', [id, await hashPassword(String(b.password))]);
    await engines.restart(id);
    res.json({ ok: true });
  });
  // Open a venue's admin panel to help them set it up.
  platform.post('/accounts/:id/impersonate', async (req, res) => {
    setSessionCookie(res, 'admin', signSession('admin', Number(req.params.id)));
    res.json({ ok: true });
  });
  app.use('/api/platform', platform);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status ?? 500;
    if (status >= 500) console.error('[http]', err);
    res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message });
  });

  return app;
}
