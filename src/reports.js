// Payroll and accountability reports. Periods are business days: with
// day_start_hour = 6 the "27 October" report covers 27 Oct 06:00 – 28 Oct 06:00.
import { config } from './config.js';
import { query, getSettings } from './db.js';

async function period(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
    throw Object.assign(new Error('Укажите период: from и to в формате ГГГГ-ММ-ДД'), { status: 400 });
  }
  const s = await getSettings();
  const h = Number(s.day_start_hour ?? 6);
  const { rows } = await query(
    `SELECT (($1::date + make_interval(hours => $3)) AT TIME ZONE $4) AS a,
            (($2::date + 1 + make_interval(hours => $3)) AT TIME ZONE $4) AS b`,
    [from, to, h, config.timezone]);
  return { a: rows[0].a, b: rows[0].b, creditRemoved: s.credit_made_then_removed !== false };
}

// A portion counts for the bartender if it was made and is still on a check,
// or (by default) if it was made and the waiter removed it afterwards.
const CREDITED = `(u.status = 'ready' OR (u.made_then_removed AND $3))`;

export async function bartenders(from, to) {
  const p = await period(from, to);
  const { rows } = await query(
    `SELECT e.id, e.name,
        count(*) FILTER (WHERE ${CREDITED})                              AS portions,
        COALESCE(sum(u.rate) FILTER (WHERE ${CREDITED}), 0)              AS earned,
        count(*) FILTER (WHERE ${CREDITED} AND u.rate IS NULL)           AS without_rate,
        count(*) FILTER (WHERE u.made_then_removed)                      AS made_then_removed,
        round(avg(extract(epoch FROM u.ready_at - u.taken_at)) FILTER (WHERE ${CREDITED}))   AS avg_make_sec,
        round(avg(extract(epoch FROM u.ready_at - u.created_at)) FILTER (WHERE ${CREDITED})) AS avg_total_sec,
        count(DISTINCT u.transaction_id) FILTER (WHERE ${CREDITED})      AS checks
     FROM units u JOIN employees e ON e.id = u.ready_by
     WHERE u.ready_at >= $1 AND u.ready_at < $2
     GROUP BY e.id, e.name ORDER BY earned DESC, portions DESC`, [p.a, p.b, p.creditRemoved]);
  return rows;
}

export async function sellers(from, to) {
  const p = await period(from, to);
  const { rows } = await query(
    `SELECT COALESCE(e.id, 0) AS id, COALESCE(e.name, t.waiter_name, 'Без сотрудника') AS name,
        count(*)                          AS checks,
        COALESCE(sum(t.payed_sum), 0)     AS payed,
        COALESCE(sum(t.sum_total), 0)     AS total,
        round(avg(t.payed_sum), 2)        AS avg_check,
        COALESCE(sum(bar.portions), 0)    AS bar_portions
     FROM transactions t
     LEFT JOIN employees e ON e.poster_user_id = t.waiter_poster_id
     LEFT JOIN LATERAL (SELECT count(*) AS portions FROM units u
                        WHERE u.transaction_id = t.poster_transaction_id AND u.status <> 'cancelled') bar ON true
     WHERE t.status = 2 AND t.closed_at >= $1 AND t.closed_at < $2
     GROUP BY 1, 2 ORDER BY payed DESC`, [p.a, p.b]);
  return rows;
}

export async function products(from, to) {
  const p = await period(from, to);
  const { rows } = await query(
    `SELECT u.poster_product_id AS product_id, u.name,
        count(*) FILTER (WHERE ${CREDITED})                                                     AS portions,
        round(avg(extract(epoch FROM u.ready_at - u.created_at)) FILTER (WHERE ${CREDITED}))   AS avg_total_sec,
        count(*) FILTER (WHERE u.made_then_removed)                                            AS made_then_removed,
        max(u.rate)                                                                            AS rate
     FROM units u WHERE u.ready_at >= $1 AND u.ready_at < $2
     GROUP BY 1, 2 ORDER BY portions DESC`, [p.a, p.b, p.creditRemoved]);
  return rows;
}

// Every portion with who sold it, who took it and who made it.
export async function details(from, to, employeeId) {
  const p = await period(from, to);
  const { rows } = await query(
    `SELECT u.id, u.created_at, u.taken_at, u.ready_at, u.cancelled_at, u.status, u.made_then_removed,
        u.name, u.modifiers, u.qty, u.rate, t.poster_transaction_id AS check_id, t.table_name,
        t.waiter_name AS sold_by, tb.name AS taken_by, rb.name AS made_by,
        round(extract(epoch FROM u.ready_at - u.created_at)) AS total_sec
     FROM units u
     JOIN transactions t ON t.poster_transaction_id = u.transaction_id
     LEFT JOIN employees tb ON tb.id = u.taken_by
     LEFT JOIN employees rb ON rb.id = u.ready_by
     WHERE u.created_at >= $1 AND u.created_at < $2 AND ($3::int IS NULL OR u.ready_by = $3 OR u.taken_by = $3)
     ORDER BY u.created_at, u.id`, [p.a, p.b, employeeId ? Number(employeeId) : null]);
  return rows;
}

// Things the owner should look at: drinks made then removed from the check,
// portions never marked ready, portions picked up from another bartender.
export async function anomalies(from, to) {
  const p = await period(from, to);
  const removed = (await query(
    `SELECT u.id, u.name, u.ready_at, u.cancelled_at, rb.name AS made_by, t.waiter_name AS sold_by,
        t.table_name, t.poster_transaction_id AS check_id
     FROM units u JOIN transactions t ON t.poster_transaction_id = u.transaction_id
     LEFT JOIN employees rb ON rb.id = u.ready_by
     WHERE u.made_then_removed AND u.cancelled_at >= $1 AND u.cancelled_at < $2 ORDER BY u.cancelled_at`,
    [p.a, p.b])).rows;
  const unfinished = (await query(
    `SELECT u.id, u.name, u.status, u.created_at, tb.name AS taken_by, t.table_name, t.poster_transaction_id AS check_id
     FROM units u JOIN transactions t ON t.poster_transaction_id = u.transaction_id
     LEFT JOIN employees tb ON tb.id = u.taken_by
     WHERE u.status IN ('new','taken') AND u.created_at >= $1 AND u.created_at < $2
       AND u.created_at < now() - interval '30 minutes' ORDER BY u.created_at`, [p.a, p.b])).rows;
  const intercepted = (await query(
    `SELECT a.at, a.action, a.unit_id, u.name, e.name AS by_name, prev.name AS from_name
     FROM audit_log a JOIN units u ON u.id = a.unit_id
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN employees prev ON prev.id = (a.details->>'prevTakenBy')::int
     WHERE a.details ? 'prevTakenBy' AND a.at >= $1 AND a.at < $2 ORDER BY a.at`, [p.a, p.b])).rows;
  const corrections = (await query(
    `SELECT a.at, a.unit_id, a.details FROM audit_log a
     WHERE a.action = 'admin_reassign' AND a.at >= $1 AND a.at < $2 ORDER BY a.at`, [p.a, p.b])).rows;
  return { removed, unfinished, intercepted, corrections };
}

// CSV for Excel in Russian locale: ';' separator and a BOM so Cyrillic opens correctly.
export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) v = v.toLocaleString('ru-RU', { timeZone: config.timezone });
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(([, title]) => esc(title)).join(';');
  return '﻿' + [head, ...rows.map((r) => columns.map(([k]) => esc(r[k])).join(';'))].join('\r\n');
}
