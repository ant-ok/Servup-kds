// What bartenders do on the screen. Each unit is one portion; whoever marks it
// "ready" gets the credit and the piece rate in force at that moment.
import { config } from './config.js';
import { tx, audit } from './db.js';
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
      'SELECT id, name FROM employees WHERE pin_lookup = $1 AND active AND is_bartender', [pinLookup(pin)],
    )).rows[0];
    if (!emp) return null;
    const token = newToken();
    await c.query(
      `INSERT INTO kds_sessions (token_hash, employee_id, device_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
      [hmac(token), emp.id, device.id, config.kds.sessionHours],
    );
    await audit(c, { actor: 'employee', employeeId: emp.id, deviceId: device.id, action: 'shift_login' });
    return { token, employee: emp };
  });
}

export async function endSession(token) {
  await tx((c) => c.query('DELETE FROM kds_sessions WHERE token_hash = $1', [hmac(token ?? '')]));
}

async function sessionEmployee(c, token) {
  const row = (await c.query(
    `SELECT e.id, e.name FROM kds_sessions s JOIN employees e ON e.id = s.employee_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND e.active`, [hmac(token ?? '')],
  )).rows[0];
  if (!row) throw new ActionError('Смена не найдена — войдите по PIN заново', 401);
  return row;
}

// Close a ticket once nothing on it is left to make, reopen it on undo.
export async function refreshTickets(c, ticketIds) {
  await c.query(
    `UPDATE tickets t SET bumped_at = CASE
        WHEN NOT EXISTS (SELECT 1 FROM units u WHERE u.ticket_id = t.id AND u.status IN ('new','taken'))
             AND EXISTS (SELECT 1 FROM units u WHERE u.ticket_id = t.id AND u.status = 'ready')
          THEN COALESCE(t.bumped_at, now())
        WHEN EXISTS (SELECT 1 FROM units u WHERE u.ticket_id = t.id AND u.status IN ('new','taken'))
          THEN NULL
        ELSE t.bumped_at END
     WHERE t.id = ANY($1)`, [ticketIds]);
}

const ACTIONS = {
  // new -> taken (by me). Taking someone else's portion needs `force`.
  async take(c, u, emp, { force }) {
    if (u.status === 'taken' && u.taken_by === emp.id) return false;
    if (u.status === 'taken' && !force) throw new ActionError('Уже взято другим барменом', 409);
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
         rate=(SELECT rate FROM product_rates WHERE poster_product_id = units.poster_product_id)
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

export async function applyAction({ opId, token, action, unitIds, force = false, device }) {
  if (!ACTIONS[action]) throw new ActionError('Неизвестное действие', 400);
  if (!Array.isArray(unitIds) || !unitIds.length) throw new ActionError('Не выбраны позиции', 400);
  if (!opId) throw new ActionError('Нет op_id', 400);

  return tx(async (c) => {
    const done = (await c.query('SELECT result FROM applied_ops WHERE op_id = $1', [opId])).rows[0];
    if (done) return done.result;

    const emp = await sessionEmployee(c, token);
    const units = (await c.query(
      'SELECT * FROM units WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [unitIds],
    )).rows;
    if (units.length !== new Set(unitIds.map(String)).size) throw new ActionError('Позиция не найдена', 404);

    let changed = 0;
    for (const u of units) {
      if (u.status === 'cancelled') continue;
      const r = await ACTIONS[action](c, u, emp, { force });
      if (!r) continue;
      changed++;
      await audit(c, { actor: 'employee', employeeId: emp.id, deviceId: device?.id, action,
        unitId: u.id, transactionId: u.transaction_id, details: typeof r === 'object' ? r : null });
    }
    await refreshTickets(c, [...new Set(units.map((u) => u.ticket_id))]);

    const result = { ok: true, changed, employee: emp };
    await c.query('INSERT INTO applied_ops (op_id, result) VALUES ($1, $2)', [opId, result]);
    return result;
  });
}

// Dismiss a ticket that has nothing left to make (e.g. fully cancelled).
export async function dismissTicket(ticketId, device) {
  return tx(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE tickets SET bumped_at = now() WHERE id = $1 AND bumped_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM units WHERE ticket_id = $1 AND status IN ('new','taken'))`, [ticketId]);
    if (rowCount) await audit(c, { actor: 'device', deviceId: device?.id, action: 'ticket_dismissed', details: { ticketId } });
    return rowCount > 0;
  });
}

export async function getBoard(client) {
  const run = (q, p) => (client ? client.query(q, p) : tx((c) => c.query(q, p)));
  const tickets = (await run(
    `SELECT tk.id, tk.round, tk.created_at, tk.bumped_at, t.poster_transaction_id AS transaction_id,
            t.table_name, t.hall_name, t.waiter_name, t.guests, t.comment, t.status AS check_status, t.tablet_id
     FROM tickets tk JOIN transactions t ON t.poster_transaction_id = tk.transaction_id
     WHERE tk.bumped_at IS NULL
        OR tk.bumped_at > now() - make_interval(secs => (SELECT (value)::text::int FROM settings WHERE key='ready_visible_seconds'))
     ORDER BY tk.created_at, tk.id`)).rows;
  const units = tickets.length ? (await run(
    `SELECT u.id, u.ticket_id, u.item_key, u.name, u.modifiers, u.qty, u.status, u.taken_at, u.ready_at, u.cancelled_at,
            u.taken_by, tb.name AS taken_by_name, u.ready_by, rb.name AS ready_by_name, u.made_then_removed
     FROM units u LEFT JOIN employees tb ON tb.id = u.taken_by LEFT JOIN employees rb ON rb.id = u.ready_by
     WHERE u.ticket_id = ANY($1) ORDER BY u.id`, [tickets.map((t) => t.id)])).rows : [];
  const byTicket = new Map(tickets.map((t) => [t.id, { ...t, units: [] }]));
  for (const u of units) byTicket.get(u.ticket_id).units.push(u);
  return [...byTicket.values()];
}
