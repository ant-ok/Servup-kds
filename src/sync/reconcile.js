// The heart of the integration. Instead of trusting individual webhook events,
// every time we see a check we compare its *current* contents in Poster with
// the portions already on the KDS and apply the difference. Missed, duplicated
// or out-of-order events therefore can't create phantom or lost orders.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { audit } from '../db.js';
import { modifierName } from '../poster/normalize.js';

// The "send to workshop" count only matters in that release mode; elsewhere it
// is left out so a check fetched with and without history hashes the same.
const hashProducts = (t, withSent) =>
  crypto.createHash('sha1')
    .update(JSON.stringify([t.status, withSent ? t.sentCount ?? null : null, t.products.map((p) => [p.key, p.num]).sort()]))
    .digest('hex');

const norm = (s) => String(s ?? '').trim().toLowerCase();

// Which prep station makes products of a Poster workshop:
//  1. a station that lists the workshop explicitly;
//  2. otherwise a station without explicit workshops whose name matches the
//     workshop's ("Кухня" ↔ "Кухня горячая") — works with no setup at all;
//  3. otherwise the first station with no workshops and no name match (catch-all);
//  4. otherwise nobody: the product isn't shown on any screen.
export function stationResolver(stations, workshops) {
  const prep = stations.filter((s) => s.kind === 'prep' && s.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const claimed = new Map();
  for (const s of prep) for (const w of s.workshop_ids) if (!claimed.has(w)) claimed.set(w, s.id);
  const open = prep.filter((s) => !s.workshop_ids.length);
  const matches = (s, wName) => {
    const a = norm(s.name);
    const b = norm(wName);
    return !!a && !!b && (b.includes(a) || a.includes(b));
  };
  const names = [...workshops.values()];
  const catchAll = open.find((s) => !names.some((n) => matches(s, n)))?.id ?? null;
  return (workshopId) => {
    if (workshopId != null && claimed.has(workshopId)) return claimed.get(workshopId);
    const wName = workshops.get(workshopId);
    return open.find((s) => matches(s, wName))?.id ?? catchAll;
  };
}

// Which lines of the check go to which station, and how many portions of each.
export function desiredUnits(t, { catalog, stationFor, includeUnknown }) {
  const wanted = new Map(); // key -> { productId, stationId, name, modifiers, qtys: [] }
  const unknown = [];
  if (t.status === 3) return { wanted, unknown };

  for (const line of t.products) {
    if (!line.productId || !(line.num > 0)) continue;
    const product = catalog.get(line.productId);
    if (!product && line.workshopId == null) {
      unknown.push(line.productId);
      if (!includeUnknown) continue;
    }
    const stationId = stationFor(line.workshopId ?? product?.workshopId ?? null);
    if (!stationId) continue;

    const entry = wanted.get(line.key) ?? {
      productId: line.productId,
      stationId,
      name: product?.name ?? line.name ?? `Товар #${line.productId}`,
      modifiers: modifierName(product, line.modKey, line.modName),
      qtys: [],
    };
    // Whole portions become separate units; a weighed amount (0.05 l) is one unit.
    if (Number.isInteger(line.num)) for (let i = 0; i < line.num; i++) entry.qtys.push(1);
    else entry.qtys.push(line.num);
    wanted.set(line.key, entry);
  }
  return { wanted, unknown };
}

const CANCEL_PRIORITY = { new: 0, taken: 1, ready: 2 };

export async function reconcileTransaction(client, accountId, t, opts) {
  const { catalog, stationFor, settings, now = new Date(), createUnits = true, includeUnknown = false, force = false,
    historyFallback = false } = opts;
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [accountId, t.id % 2147483647]);

  const hash = hashProducts(t, settings.release_mode === 'on_send');
  const prev = (await client.query(
    'SELECT id, status, products_hash, released_sent FROM transactions WHERE account_id = $1 AND poster_transaction_id = $2', [accountId, t.id],
  )).rows[0];

  const txId = (await client.query(
    `INSERT INTO transactions (account_id, poster_transaction_id, status, table_name, hall_name, waiter_poster_id, waiter_name,
       spot_id, tablet_id, guests, comment, opened_at, closed_at, sum_total, payed_sum, products_hash, raw, sent_count, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
     ON CONFLICT (account_id, poster_transaction_id) DO UPDATE SET
       status=EXCLUDED.status, table_name=EXCLUDED.table_name, hall_name=COALESCE(EXCLUDED.hall_name, transactions.hall_name),
       waiter_poster_id=EXCLUDED.waiter_poster_id, waiter_name=EXCLUDED.waiter_name, spot_id=EXCLUDED.spot_id,
       tablet_id=COALESCE(EXCLUDED.tablet_id, transactions.tablet_id), sent_count=COALESCE(EXCLUDED.sent_count, transactions.sent_count), guests=EXCLUDED.guests, comment=EXCLUDED.comment,
       opened_at=COALESCE(EXCLUDED.opened_at, transactions.opened_at), closed_at=EXCLUDED.closed_at,
       sum_total=EXCLUDED.sum_total, payed_sum=EXCLUDED.payed_sum, products_hash=EXCLUDED.products_hash,
       raw=EXCLUDED.raw, updated_at=now()
     RETURNING id`,
    [accountId, t.id, t.status, t.tableName, t.hallName, t.waiterId, t.waiterName, t.spotId, t.tabletId, t.guests,
     t.comment, t.openedAt, t.closedAt, t.sum, t.payedSum, hash, t.raw, t.sentCount],
  )).rows[0].id;

  if (t.waiterId) {
    await client.query(
      `INSERT INTO employees (account_id, poster_user_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, poster_user_id) DO NOTHING`,
      [accountId, t.waiterId, t.waiterName ?? `Сотрудник #${t.waiterId}`],
    );
  }

  const result = { changed: false, created: 0, cancelled: 0, unknown: [] };
  if (prev && prev.products_hash === hash && !force) return result;

  const { wanted, unknown } = desiredUnits(t, { catalog, stationFor, includeUnknown });
  result.unknown = unknown;

  const existing = (await client.query(
    `SELECT id, ticket_id, item_key, status FROM units
     WHERE transaction_id = $1 AND status <> 'cancelled' ORDER BY id FOR UPDATE`, [txId],
  )).rows;
  const byKey = new Map();
  for (const u of existing) byKey.set(u.item_key, [...(byKey.get(u.item_key) ?? []), u]);

  // Too-old checks (first launch, backfill) only update reports, never the screen.
  const startedAt = settings.kds_started_at ? new Date(settings.kds_started_at) : null;
  const tooOld = (t.openedAt && t.openedAt < new Date(now - config.sync.maxAgeHours * 3600e3))
    || (t.status === 2 && !prev && startedAt && t.closedAt && t.closedAt < startedAt);
  // Release mode "on_send": portions reach the screens only after the waiter
  // presses "send to workshop" in Poster, or once the check is paid (quick
  // service, where nobody presses it). Without history we can't tell: the
  // engine re-fetches the check with history, and as a last resort releases.
  let released = true;
  if (settings.release_mode === 'on_send' && t.status !== 2) {
    if (t.sentCount === null || t.sentCount === undefined) {
      released = historyFallback;
      if (!historyFallback) result.needsHistory = true;
    } else {
      released = t.sentCount > (prev?.released_sent ?? 0);
    }
  }
  const mayCreate = createUnits && !tooOld && released;

  const toCreate = [];
  const toCancel = [];
  for (const key of new Set([...wanted.keys(), ...byKey.keys()])) {
    const want = wanted.get(key);
    const have = byKey.get(key) ?? [];
    const diff = (want?.qtys.length ?? 0) - have.length;
    if (diff > 0 && mayCreate) {
      for (const qty of want.qtys.slice(have.length)) toCreate.push({ key, ...want, qty });
    } else if (diff < 0) {
      // Cancel what costs least: untouched portions first, then in-progress, then made.
      const order = [...have].sort((a, b) =>
        CANCEL_PRIORITY[a.status] - CANCEL_PRIORITY[b.status] || Number(b.id) - Number(a.id));
      toCancel.push(...order.slice(0, -diff));
    }
  }

  if (toCreate.length) {
    const round = (await client.query(
      'SELECT COALESCE(MAX(round), 0) + 1 AS r FROM tickets WHERE transaction_id = $1', [txId],
    )).rows[0].r;
    const ticketId = (await client.query(
      'INSERT INTO tickets (account_id, transaction_id, round, created_at) VALUES ($1,$2,$3,$4) RETURNING id',
      [accountId, txId, round, now],
    )).rows[0].id;
    for (const u of toCreate) {
      await client.query(
        `INSERT INTO units (account_id, ticket_id, transaction_id, station_id, item_key, poster_product_id, name, modifiers, qty, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [accountId, ticketId, txId, u.stationId, u.key, u.productId, u.name, u.modifiers, u.qty, now],
      );
    }
    if (t.sentCount != null) await client.query('UPDATE transactions SET released_sent = $2 WHERE id = $1', [txId, t.sentCount]);
    await audit(client, { accountId, actor: 'poster', action: round === 1 ? 'order_received' : 'order_added', transactionId: t.id,
      details: { ticketId, round, items: toCreate.map((u) => u.name) } });
    result.created = toCreate.length;
  }

  for (const u of toCancel) {
    const madeThenRemoved = u.status === 'ready';
    await client.query(
      `UPDATE units SET status='cancelled', cancelled_at=$2, made_then_removed=$3, cancel_reason=$4,
         cancel_ack = $3  -- a made portion needs no attention on the screen
       WHERE id=$1`,
      [u.id, now, madeThenRemoved, t.status === 3 ? 'check_removed' : 'removed_from_check'],
    );
    await audit(client, { accountId, actor: 'poster', action: madeThenRemoved ? 'made_then_removed' : 'unit_cancelled',
      unitId: u.id, transactionId: t.id, details: { previousStatus: u.status } });
  }
  result.cancelled = toCancel.length;

  result.changed = result.created > 0 || result.cancelled > 0;
  return result;
}
