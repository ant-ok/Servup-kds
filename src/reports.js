// Payroll and accountability reports for one venue. Periods are business days:
// with day_start_hour = 6 the "27 October" report covers 27 Oct 06:00 – 28 Oct 06:00.
// Every report takes { accountId, from, to, stationId?, employeeId? }.
import { config } from './config.js';
import { query, getSettings } from './db.js';

async function period({ accountId, from, to }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
    throw Object.assign(new Error('Укажите период: from и to в формате ГГГГ-ММ-ДД'), { status: 400 });
  }
  const s = await getSettings(accountId);
  const h = Number(s.day_start_hour ?? 6);
  const { rows } = await query(
    `SELECT (($1::date + make_interval(hours => $3)) AT TIME ZONE $4) AS a,
            (($2::date + 1 + make_interval(hours => $3)) AT TIME ZONE $4) AS b`,
    [from, to, h, config.timezone]);
  return { a: rows[0].a, b: rows[0].b, creditRemoved: s.credit_made_then_removed !== false };
}

const station = (v) => (v ? Number(v) : null);

// A portion counts for its maker if it was made and is still on a check,
// or (by default) if it was made and the waiter removed it afterwards.
const CREDITED = `(u.status = 'ready' OR (u.made_then_removed AND $4))`;

export async function makers(q) {
  const p = await period(q);
  const { rows } = await query(
    `SELECT e.id, e.name,
        count(*) FILTER (WHERE ${CREDITED})                              AS portions,
        COALESCE(sum(u.rate) FILTER (WHERE ${CREDITED}), 0)              AS earned,
        count(*) FILTER (WHERE ${CREDITED} AND u.rate IS NULL)           AS without_rate,
        count(*) FILTER (WHERE u.made_then_removed)                      AS made_then_removed,
        round(avg(extract(epoch FROM u.ready_at - u.taken_at)) FILTER (WHERE ${CREDITED}))   AS avg_make_sec,
        round(avg(extract(epoch FROM u.ready_at - u.created_at)) FILTER (WHERE ${CREDITED})) AS avg_total_sec,
        count(DISTINCT u.transaction_id) FILTER (WHERE ${CREDITED})      AS checks,
        string_agg(DISTINCT s.name, ', ')                                AS stations,
        round(100.0 * count(*) FILTER (WHERE ${CREDITED} AND u.ready_at - u.taken_at <= make_interval(secs => pi.norm_seconds))
              / NULLIF(count(*) FILTER (WHERE ${CREDITED} AND pi.norm_seconds IS NOT NULL), 0)) AS within_norm_pct
     FROM units u JOIN employees e ON e.id = u.ready_by LEFT JOIN stations s ON s.id = u.station_id
     LEFT JOIN product_info pi ON pi.account_id = u.account_id AND pi.poster_product_id = u.poster_product_id
     WHERE u.account_id = $1 AND u.ready_at >= $2 AND u.ready_at < $3 AND ($5::int IS NULL OR u.station_id = $5)
     GROUP BY e.id, e.name ORDER BY earned DESC, portions DESC`,
    [q.accountId, p.a, p.b, p.creditRemoved, station(q.stationId)]);
  return rows;
}

export async function sellers(q) {
  const p = await period(q);
  const { rows } = await query(
    `SELECT COALESCE(e.id, 0) AS id, COALESCE(e.name, t.waiter_name, 'Без сотрудника') AS name,
        count(*)                          AS checks,
        COALESCE(sum(t.payed_sum), 0)     AS payed,
        COALESCE(sum(t.sum_total), 0)     AS total,
        round(avg(t.payed_sum), 2)        AS avg_check,
        COALESCE(sum(k.portions), 0)      AS kds_portions
     FROM transactions t
     LEFT JOIN employees e ON e.account_id = t.account_id AND e.poster_user_id = t.waiter_poster_id
     LEFT JOIN LATERAL (SELECT count(*) AS portions FROM units u
                        WHERE u.transaction_id = t.id AND u.status <> 'cancelled'
                          AND ($4::int IS NULL OR u.station_id = $4)) k ON true
     WHERE t.account_id = $1 AND t.status = 2 AND t.closed_at >= $2 AND t.closed_at < $3
     GROUP BY 1, 2 ORDER BY payed DESC`, [q.accountId, p.a, p.b, station(q.stationId)]);
  return rows;
}

// Who handed orders out at the pass, and how long finished food waited there.
export async function runners(q) {
  const p = await period(q);
  const { rows } = await query(
    `SELECT e.id, e.name, count(*) AS tickets,
        round(avg(extract(epoch FROM tk.served_at - r.last_ready)) FILTER (WHERE r.last_ready <= tk.served_at)) AS avg_wait_sec,
        round(avg(extract(epoch FROM tk.served_at - tk.created_at))) AS avg_total_sec
     FROM tickets tk JOIN employees e ON e.id = tk.served_by
     JOIN LATERAL (SELECT max(u.ready_at) AS last_ready FROM units u WHERE u.ticket_id = tk.id) r ON true
     WHERE tk.account_id = $1 AND tk.served_at >= $2 AND tk.served_at < $3
     GROUP BY e.id, e.name ORDER BY tickets DESC`, [q.accountId, p.a, p.b]);
  return rows;
}

export async function stations(q) {
  const p = await period(q);
  const { rows } = await query(
    `SELECT s.id, s.name,
        count(*) FILTER (WHERE ${CREDITED})                                                     AS portions,
        round(avg(extract(epoch FROM u.ready_at - u.created_at)) FILTER (WHERE ${CREDITED}))   AS avg_total_sec,
        round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM u.ready_at - u.created_at))
              FILTER (WHERE ${CREDITED}))                                                       AS p90_total_sec,
        COALESCE(sum(u.rate) FILTER (WHERE ${CREDITED}), 0)                                     AS earned,
        count(DISTINCT u.ready_by)                                                              AS people
     FROM units u JOIN stations s ON s.id = u.station_id
     WHERE u.account_id = $1 AND u.ready_at >= $2 AND u.ready_at < $3 AND ($5::int IS NULL OR u.station_id = $5)
     GROUP BY s.id, s.name ORDER BY s.name`, [q.accountId, p.a, p.b, p.creditRemoved, station(q.stationId)]);
  return rows;
}

export async function products(q) {
  const p = await period(q);
  const { rows } = await query(
    `SELECT u.poster_product_id AS product_id, u.name, s.name AS station,
        count(*) FILTER (WHERE ${CREDITED})                                                     AS portions,
        round(avg(extract(epoch FROM u.ready_at - u.created_at)) FILTER (WHERE ${CREDITED}))   AS avg_total_sec,
        count(*) FILTER (WHERE u.made_then_removed)                                            AS made_then_removed,
        max(u.rate)                                                                            AS rate,
        max(pi.norm_seconds)                                                                   AS norm_sec,
        round(avg(extract(epoch FROM u.ready_at - u.taken_at)) FILTER (WHERE ${CREDITED}))     AS avg_make_sec,
        round(100.0 * count(*) FILTER (WHERE ${CREDITED} AND u.ready_at - u.taken_at <= make_interval(secs => pi.norm_seconds))
              / NULLIF(count(*) FILTER (WHERE ${CREDITED} AND pi.norm_seconds IS NOT NULL), 0))        AS within_norm_pct
     FROM units u LEFT JOIN stations s ON s.id = u.station_id
     LEFT JOIN product_info pi ON pi.account_id = u.account_id AND pi.poster_product_id = u.poster_product_id
     WHERE u.account_id = $1 AND u.ready_at >= $2 AND u.ready_at < $3 AND ($5::int IS NULL OR u.station_id = $5)
     GROUP BY 1, 2, 3 ORDER BY portions DESC`, [q.accountId, p.a, p.b, p.creditRemoved, station(q.stationId)]);
  return rows;
}

// Every portion with who sold it, who took it, who made it and who served it.
export async function details(q) {
  const p = await period(q);
  const { rows } = await query(
    `SELECT u.id, u.created_at, u.taken_at, u.ready_at, u.cancelled_at, u.status, u.made_then_removed,
        u.name, u.modifiers, u.qty, u.rate, s.name AS station, t.poster_transaction_id AS check_id, t.table_name,
        t.waiter_name AS sold_by, tb.name AS taken_by, rb.name AS made_by, sb.name AS served_by,
        round(extract(epoch FROM u.ready_at - u.created_at)) AS total_sec
     FROM units u
     JOIN transactions t ON t.id = u.transaction_id
     JOIN tickets tk ON tk.id = u.ticket_id
     LEFT JOIN stations s ON s.id = u.station_id
     LEFT JOIN employees tb ON tb.id = u.taken_by
     LEFT JOIN employees rb ON rb.id = u.ready_by
     LEFT JOIN employees sb ON sb.id = tk.served_by
     WHERE u.account_id = $1 AND u.created_at >= $2 AND u.created_at < $3
       AND ($4::int IS NULL OR u.ready_by = $4 OR u.taken_by = $4) AND ($5::int IS NULL OR u.station_id = $5)
     ORDER BY u.created_at, u.id`,
    [q.accountId, p.a, p.b, q.employeeId ? Number(q.employeeId) : null, station(q.stationId)]);
  return rows;
}

// Things the owner should look at: portions made then removed from the check,
// portions never marked ready, portions picked up from someone else, manual fixes.
export async function anomalies(q) {
  const p = await period(q);
  const args = [q.accountId, p.a, p.b];
  const removed = (await query(
    `SELECT u.id, u.name, s.name AS station, u.ready_at, u.cancelled_at, rb.name AS made_by, t.waiter_name AS sold_by,
        t.table_name, t.poster_transaction_id AS check_id
     FROM units u JOIN transactions t ON t.id = u.transaction_id
     LEFT JOIN stations s ON s.id = u.station_id LEFT JOIN employees rb ON rb.id = u.ready_by
     WHERE u.account_id = $1 AND u.made_then_removed AND u.cancelled_at >= $2 AND u.cancelled_at < $3 ORDER BY u.cancelled_at`,
    args)).rows;
  const unfinished = (await query(
    `SELECT u.id, u.name, s.name AS station, u.status, u.created_at, tb.name AS taken_by, t.table_name, t.poster_transaction_id AS check_id
     FROM units u JOIN transactions t ON t.id = u.transaction_id
     LEFT JOIN stations s ON s.id = u.station_id LEFT JOIN employees tb ON tb.id = u.taken_by
     WHERE u.account_id = $1 AND u.status IN ('new','taken') AND u.created_at >= $2 AND u.created_at < $3
       AND u.created_at < now() - interval '30 minutes' ORDER BY u.created_at`, args)).rows;
  const intercepted = (await query(
    `SELECT a.at, a.action, a.unit_id, u.name, e.name AS by_name, prev.name AS from_name
     FROM audit_log a JOIN units u ON u.id = a.unit_id
     JOIN employees e ON e.id = a.employee_id
     LEFT JOIN employees prev ON prev.id = (a.details->>'prevTakenBy')::int
     WHERE a.account_id = $1 AND a.details ? 'prevTakenBy' AND a.at >= $2 AND a.at < $3 ORDER BY a.at`, args)).rows;
  const corrections = (await query(
    `SELECT a.at, a.unit_id, a.details FROM audit_log a
     WHERE a.account_id = $1 AND a.action = 'admin_reassign' AND a.at >= $2 AND a.at < $3 ORDER BY a.at`, args)).rows;
  return { removed, unfinished, intercepted, corrections };
}

export const REPORTS = { makers, sellers, runners, stations, products, details, anomalies };

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
