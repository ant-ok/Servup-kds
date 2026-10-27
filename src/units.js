// What staff do on the screens. Each unit is one portion; whoever marks it
// "ready" gets the credit and the piece rate in force at that moment.
import { config } from './config.js';
import { tx, query, audit, getSettings } from './db.js';
import { hmac, newToken, pinLookup } from './auth.js';

export class ActionError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

export async function startSession(pin, device) {
  return tx(async (c) => {
    const emp = (await c.query(
      'SELECT id, name FROM employees WHERE account_id = $1 AND pin_lookup = $2 AND active AND kds_access',
      [device.account_id, pinLookup(device.account_id, pin)],
    )).rows[0];
    if (!emp) return null;
    const token = newToken();
    await c.query(
      `INSERT INTO kds_sessions (token_hash, employee_id, device_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [hmac(token), emp.id, device.id, config.kds.sessionHours],
    );
    await audit(c, { accountId: device.account_id, actor: 'employee', employeeId: emp.id, deviceId: device.id, action: 'shift_login' });
    return { token, employee: emp };
  });
}

export async function endSession(token) {
  await query('DELETE FROM kds_sessions WHERE token_hash = $1', [hmac(token ?? '')]);
}

async function sessionEmployee(c, token, accountId) {
  const row = (await c.query(
    `SELECT e.id, e.name FROM kds_sessions s JOIN employees e ON e.id = s.employee_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND e.active AND e.account_id = $2`, [hmac(token ?? ''), accountId],
  )).rows[0];
  if (!row) throw new ActionError('Смена не найдена — войдите по PIN заново', 401);
  return row;
}

const ACTIONS = {
  // new -> taken (by me). Taking someone else's portion needs `force`.
  async take(c, u, emp, { force }) {
    if (u.status === 'taken' && u.taken_by === emp.id) return false;
    if (u.status === 'taken' && !force) throw new ActionError('Уже взято другим сотрудником', 409);
    if (u.status !== 'new' && u.status !== 'taken') return false;
    await c.query(`UPDATE units SET status='taken', taken_by=$2, taken_at=now() WHERE id=$1`, [u.id, emp.id]);
    return u.status === 'taken' ? { prevTakenBy: u.taken_by } : true;
  },
  // new|taken -> ready. Credit goes to whoever marks it ready.
  async ready(c, u, emp) {
    if (u.status !== 'new' && u.status !== 'taken') return false;
    await c.query(
      `UPDATE units SET status='ready', ready_by=$2, ready_at=now(),
         taken_by=COALESCE(taken_by, $2), taken_at=COALESCE(taken_at, now()),
         rate=(SELECT rate FROM product_rates r WHERE r.account_id = units.account_id AND r.poster_product_id = units.poster_product_id)
       WHERE id=$1`, [u.id, emp.id]);
    return u.status === 'taken' && u.taken_by !== emp.id ? { prevTakenBy: u.taken_by } : true;
  },
  // taken -> new: "I can't do it, give it back".
  async release(c, u) {
    if (u.status !== 'taken') return false;
    await c.query(`UPDATE units SET status='new', taken_by=NULL, taken_at=NULL WHERE id=$1`, [u.id]);
    return true;
  },
  // ready -> taken, only by the same person and only shortly after.
  async undo(c, u, emp) {
    if (u.status !== 'ready') return false;
    if (u.ready_by !== emp.id) throw new ActionError('Отменить отметку может только тот, кто её поставил', 403);
    if (Date.now() - new Date(u.ready_at) > config.kds.undoWindowSec * 1000) {
      throw new ActionError('Время на отмену вышло — обратитесь к администратору', 403);
    }
    await c.query(`UPDATE units SET status='taken', ready_by=NULL, ready_at=NULL, rate=NULL WHERE id=$1`, [u.id]);
    return true;
  },
};

// Runs fn once per op_id: a retried tap (bad Wi-Fi) returns the first result.
async function once(c, opId, fn) {
  if (!opId) throw new ActionError('Нет op_id', 400);
  const done = (await c.query('SELECT result FROM applied_ops WHERE op_id = $1', [opId])).rows[0];
  if (done) return done.result;
  const result = await fn();
  await c.query('INSERT INTO applied_ops (op_id, result) VALUES ($1, $2)', [opId, result]);
  return result;
}

export async function applyAction({ opId, token, action, unitIds, force = false, device }) {
  if (!ACTIONS[action]) throw new ActionError('Неизвестное действие', 400);
  if (!Array.isArray(unitIds) || !unitIds.length) throw new ActionError('Не выбраны позиции', 400);
  const accountId = device.account_id;

  return tx((c) => once(c, opId, async () => {
    const emp = await sessionEmployee(c, token, accountId);
    const units = (await c.query(
      'SELECT * FROM units WHERE id = ANY($1::bigint[]) AND account_id = $2 ORDER BY id FOR UPDATE', [unitIds, accountId],
    )).rows;
    if (units.length !== new Set(unitIds.map(String)).size) throw new ActionError('Позиция не найдена', 404);
    const checks = new Map((await c.query(
      'SELECT id, poster_transaction_id FROM transactions WHERE id = ANY($1)', [[...new Set(units.map((u) => u.transaction_id))]],
    )).rows.map((r) => [r.id, r.poster_transaction_id]));

    let changed = 0;
    for (const u of units) {
      if (u.status === 'cancelled') continue;
      const r = await ACTIONS[action](c, u, emp, { force });
      if (!r) continue;
      changed++;
      await audit(c, { accountId, actor: 'employee', employeeId: emp.id, deviceId: device.id, action,
        unitId: u.id, transactionId: checks.get(u.transaction_id), details: typeof r === 'object' ? r : null });
    }
    return { ok: true, changed, employee: emp };
  }));
}

// Expo: the order was handed to the guest (or undo that).
export async function serveTicket({ opId, token, ticketId, undo = false, device }) {
  const accountId = device.account_id;
  return tx((c) => once(c, opId, async () => {
    const emp = await sessionEmployee(c, token, accountId);
    const t = (await c.query(
      `SELECT tk.*, t.poster_transaction_id FROM tickets tk JOIN transactions t ON t.id = tk.transaction_id
       WHERE tk.id = $1 AND tk.account_id = $2 FOR UPDATE OF tk`, [ticketId, accountId])).rows[0];
    if (!t) throw new ActionError('Заказ не найден', 404);
    if (undo) {
      if (!t.served_at) return { ok: true, changed: 0 };
      if (Date.now() - new Date(t.served_at) > config.kds.undoWindowSec * 1000) throw new ActionError('Время на отмену вышло', 403);
      await c.query('UPDATE tickets SET served_at = NULL, served_by = NULL WHERE id = $1', [ticketId]);
    } else {
      if (t.served_at) return { ok: true, changed: 0 };
      await c.query('UPDATE tickets SET served_at = now(), served_by = $2 WHERE id = $1', [ticketId, emp.id]);
    }
    await audit(c, { accountId, actor: 'employee', employeeId: emp.id, deviceId: device.id,
      action: undo ? 'unserved' : 'served', transactionId: t.poster_transaction_id, details: { ticketId } });
    return { ok: true, changed: 1, employee: emp };
  }));
}

// The station saw the cancellation; the card can leave its screen.
export async function dismissTicket(ticketId, device) {
  return tx(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE units SET cancel_ack = true
       WHERE ticket_id = $1 AND account_id = $2 AND status = 'cancelled' AND NOT cancel_ack
         AND ($3::int IS NULL OR station_id = $3)`, [ticketId, device.account_id, device.station_id]);
    if (rowCount) await audit(c, { accountId: device.account_id, actor: 'device', deviceId: device.id, action: 'ticket_dismissed', details: { ticketId } });
    return rowCount > 0;
  });
}

const TICKET_FIELDS = `tk.id, tk.round, tk.created_at, tk.served_at, sb.name AS served_by_name,
  t.poster_transaction_id AS transaction_id, t.table_name, t.hall_name, t.waiter_name, t.guests, t.comment,
  t.status AS check_status, t.tablet_id`;

async function unitsFor(ticketIds, stationId) {
  if (!ticketIds.length) return [];
  return (await query(
    `SELECT u.id, u.ticket_id, u.station_id, s.name AS station_name, u.item_key, u.name, u.modifiers, u.qty, u.status,
            u.created_at, u.taken_at, u.ready_at, u.cancelled_at, u.cancel_ack, u.made_then_removed,
            u.taken_by, tb.name AS taken_by_name, u.ready_by, rb.name AS ready_by_name,
            u.poster_product_id AS product_id, COALESCE(pi.norm_seconds, pr.cooking_seconds) AS norm_seconds
     FROM units u LEFT JOIN stations s ON s.id = u.station_id
     LEFT JOIN product_info pi ON pi.account_id = u.account_id AND pi.poster_product_id = u.poster_product_id
     LEFT JOIN products pr ON pr.account_id = u.account_id AND pr.poster_product_id = u.poster_product_id
     LEFT JOIN employees tb ON tb.id = u.taken_by LEFT JOIN employees rb ON rb.id = u.ready_by
     WHERE u.ticket_id = ANY($1) AND ($2::int IS NULL OR u.station_id = $2) ORDER BY u.id`,
    [ticketIds, stationId])).rows;
}

function attach(tickets, units) {
  const byTicket = new Map(tickets.map((t) => [t.id, { ...t, units: [] }]));
  for (const u of units) byTicket.get(u.ticket_id)?.units.push(u);
  return [...byTicket.values()];
}

// A prep station sees its own portions: open ones, unseen cancellations,
// and for a short while what it has just finished. stationId null = all stations.
export async function getPrepBoard(accountId, stationId) {
  const s = await getSettings(accountId);
  const tickets = (await query(
    `SELECT ${TICKET_FIELDS}, (agg.open_cnt = 0 AND agg.unacked = 0) AS done
     FROM tickets tk JOIN transactions t ON t.id = tk.transaction_id
     LEFT JOIN employees sb ON sb.id = tk.served_by
     JOIN LATERAL (
       SELECT count(*) FILTER (WHERE u.status IN ('new','taken')) AS open_cnt,
              count(*) FILTER (WHERE u.status = 'cancelled' AND NOT u.cancel_ack) AS unacked,
              max(u.ready_at) AS last_ready, count(*) AS total
       FROM units u WHERE u.ticket_id = tk.id AND ($2::int IS NULL OR u.station_id = $2)) agg ON agg.total > 0
     WHERE tk.account_id = $1 AND tk.created_at > now() - interval '24 hours'
       AND (agg.open_cnt > 0 OR agg.unacked > 0 OR agg.last_ready > now() - make_interval(secs => $3))
     ORDER BY tk.created_at, tk.id`, [accountId, stationId, Number(s.ready_visible_seconds ?? 60)])).rows;
  return attach(tickets, await unitsFor(tickets.map((t) => t.id), stationId));
}

// The pass sees every order not yet handed out, with the state of each station.
export async function getExpoBoard(accountId) {
  const s = await getSettings(accountId);
  const tickets = (await query(
    `SELECT ${TICKET_FIELDS}, (tk.served_at IS NOT NULL) AS done
     FROM tickets tk JOIN transactions t ON t.id = tk.transaction_id
     LEFT JOIN employees sb ON sb.id = tk.served_by
     WHERE tk.account_id = $1 AND tk.created_at > now() - make_interval(hours => $2)
       AND EXISTS (SELECT 1 FROM units u WHERE u.ticket_id = tk.id AND u.status <> 'cancelled')
       AND (tk.served_at IS NULL OR tk.served_at > now() - make_interval(secs => $3))
     ORDER BY tk.created_at, tk.id`, [accountId, config.sync.maxAgeHours, Number(s.ready_visible_seconds ?? 60)])).rows;
  return attach(tickets, await unitsFor(tickets.map((t) => t.id), null));
}

export async function getBoard(device) {
  const station = device.station_id
    ? (await query('SELECT id, name, kind, group_items FROM stations WHERE id = $1 AND account_id = $2', [device.station_id, device.account_id])).rows[0]
    : null;
  const tickets = station?.kind === 'expo'
    ? await getExpoBoard(device.account_id)
    : await getPrepBoard(device.account_id, station?.id ?? null);
  return { station: station ?? { id: null, name: 'Все станции', kind: 'prep', group_items: false }, tickets };
}
