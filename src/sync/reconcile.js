// The heart of the integration. Instead of trusting individual webhook events,
// every time we see a check we compare its *current* contents in Poster with
// the portions already on the KDS and apply the difference. Missed, duplicated
// or out-of-order events therefore can't create phantom or lost drinks.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { audit } from '../db.js';
import { refreshTickets } from '../units.js';

const hashProducts = (t) =>
  crypto.createHash('sha1')
    .update(JSON.stringify([t.status, t.products.map((p) => [p.key, p.num]).sort()]))
    .digest('hex');

// Which lines of the check belong to the bar, and how many portions of each.
export function desiredUnits(t, { catalog, barWorkshops, includeUnknown }) {
  const wanted = new Map(); // key -> { productId, name, modifiers, qtys: [] }
  const unknown = [];
  if (t.status === 3) return { wanted, unknown };

  for (const line of t.products) {
    if (!line.productId || !(line.num > 0)) continue;
    const product = catalog.get(line.productId);
    const workshopId = line.workshopId ?? product?.workshopId ?? null;
    if (!product && line.workshopId == null) {
      unknown.push(line.productId);
      if (!includeUnknown) continue;
    } else if (barWorkshops.length && !barWorkshops.includes(workshopId)) {
      continue;
    }

    const entry = wanted.get(line.key) ?? {
      productId: line.productId,
      name: product?.name ?? line.name ?? `Товар #${line.productId}`,
      modifiers: line.modKey === '0' ? null : (product?.modifications?.[line.modKey] ?? line.modName ?? null),
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

export async function reconcileTransaction(client, t, opts) {
  const { catalog, settings, now = new Date(), createUnits = true, includeUnknown = false, force = false } = opts;
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [t.id]);

  const hash = hashProducts(t);
  const prev = (await client.query(
    'SELECT status, products_hash FROM transactions WHERE poster_transaction_id = $1', [t.id],
  )).rows[0];

  await client.query(
    `INSERT INTO transactions (poster_transaction_id, status, table_name, hall_name, waiter_poster_id, waiter_name,
       spot_id, tablet_id, guests, comment, opened_at, closed_at, sum_total, payed_sum, products_hash, raw, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
     ON CONFLICT (poster_transaction_id) DO UPDATE SET
       status=EXCLUDED.status, table_name=EXCLUDED.table_name, hall_name=COALESCE(EXCLUDED.hall_name, transactions.hall_name),
       waiter_poster_id=EXCLUDED.waiter_poster_id, waiter_name=EXCLUDED.waiter_name, spot_id=EXCLUDED.spot_id,
       tablet_id=EXCLUDED.tablet_id, guests=EXCLUDED.guests, comment=EXCLUDED.comment,
       opened_at=COALESCE(EXCLUDED.opened_at, transactions.opened_at), closed_at=EXCLUDED.closed_at,
       sum_total=EXCLUDED.sum_total, payed_sum=EXCLUDED.payed_sum, products_hash=EXCLUDED.products_hash,
       raw=EXCLUDED.raw, updated_at=now()`,
    [t.id, t.status, t.tableName, t.hallName, t.waiterId, t.waiterName, t.spotId, t.tabletId, t.guests,
     t.comment, t.openedAt, t.closedAt, t.sum, t.payedSum, hash, t.raw],
  );

  if (t.waiterId) {
    await client.query(
      `INSERT INTO employees (poster_user_id, name) VALUES ($1, $2)
       ON CONFLICT (poster_user_id) DO NOTHING`,
      [t.waiterId, t.waiterName ?? `Сотрудник #${t.waiterId}`],
    );
  }

  const result = { changed: false, created: 0, cancelled: 0, unknown: [] };
  if (prev && prev.products_hash === hash && !force) return result;

  const barWorkshops = (settings.bar_workshop_ids ?? []).map(Number);
  const { wanted, unknown } = desiredUnits(t, { catalog, barWorkshops, includeUnknown });
  result.unknown = unknown;

  const existing = (await client.query(
    `SELECT id, ticket_id, item_key, status, ready_at, created_at FROM units
     WHERE transaction_id = $1 AND status <> 'cancelled' ORDER BY id FOR UPDATE`, [t.id],
  )).rows;
  const byKey = new Map();
  for (const u of existing) byKey.set(u.item_key, [...(byKey.get(u.item_key) ?? []), u]);

  // Too-old checks (first launch, backfill) only update reports, never the screen.
  const startedAt = settings.kds_started_at ? new Date(settings.kds_started_at) : null;
  const tooOld = (t.openedAt && t.openedAt < new Date(now - config.sync.maxAgeHours * 3600e3))
    || (t.status === 2 && !prev && startedAt && t.closedAt && t.closedAt < startedAt);
  const mayCreate = createUnits && !tooOld;

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
      'SELECT COALESCE(MAX(round), 0) + 1 AS r FROM tickets WHERE transaction_id = $1', [t.id],
    )).rows[0].r;
    const ticketId = (await client.query(
      'INSERT INTO tickets (transaction_id, round, created_at) VALUES ($1, $2, $3) RETURNING id', [t.id, round, now],
    )).rows[0].id;
    for (const u of toCreate) {
      await client.query(
        `INSERT INTO units (ticket_id, transaction_id, item_key, poster_product_id, name, modifiers, qty, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ticketId, t.id, u.key, u.productId, u.name, u.modifiers, u.qty, now],
      );
    }
    await audit(client, { actor: 'poster', action: round === 1 ? 'order_received' : 'order_added', transactionId: t.id,
      details: { ticketId, round, items: toCreate.map((u) => u.name) } });
    result.created = toCreate.length;
  }

  for (const u of toCancel) {
    const madeThenRemoved = u.status === 'ready';
    await client.query(
      `UPDATE units SET status='cancelled', cancelled_at=$2, made_then_removed=$3,
         cancel_reason=$4 WHERE id=$1`,
      [u.id, now, madeThenRemoved, t.status === 3 ? 'check_removed' : 'removed_from_check'],
    );
    await audit(client, { actor: 'poster', action: madeThenRemoved ? 'made_then_removed' : 'unit_cancelled',
      unitId: u.id, transactionId: t.id, details: { previousStatus: u.status } });
  }
  result.cancelled = toCancel.length;
  if (toCancel.length) await refreshTickets(client, [...new Set(toCancel.map((u) => u.ticket_id))]);

  // A ticket whose last open portion was just cancelled stays on screen
  // (shown as "ОТМЕНЁН") until a bartender dismisses it.
  result.changed = result.created > 0 || result.cancelled > 0;
  return result;
}
