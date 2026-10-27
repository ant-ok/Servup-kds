// What the Poster register app asks: how far along is this order?
import { query } from './db.js';

// The register knows its local order; Poster's server knows the check.
// We try the ids the register gave us, then the newest open check at that
// table, preferring the same register.
export async function findCheck(accountId, { ids = [], table = null, tablet = null }) {
  const numeric = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (numeric.length) {
    const byId = (await query(
      `SELECT * FROM transactions WHERE account_id = $1 AND poster_transaction_id = ANY($2::bigint[])
       ORDER BY updated_at DESC LIMIT 1`, [accountId, numeric])).rows[0];
    if (byId) return byId;
  }
  if (table) {
    return (await query(
      `SELECT * FROM transactions WHERE account_id = $1 AND table_name = $2 AND status = 1
         AND opened_at > now() - interval '24 hours'
       ORDER BY (tablet_id IS NOT DISTINCT FROM $3::int) DESC, opened_at DESC LIMIT 1`,
      [accountId, String(table), tablet == null ? null : Number(tablet)])).rows[0] ?? null;
  }
  return null;
}

export async function orderStatus(accountId, hints) {
  const t = await findCheck(accountId, hints);
  if (!t) return { found: false };
  const units = (await query(
    `SELECT u.id, u.name, u.modifiers, u.status, u.created_at, u.ready_at, s.name AS station,
            tb.name AS taken_by, rb.name AS ready_by, tk.served_at, sb.name AS served_by
     FROM units u JOIN tickets tk ON tk.id = u.ticket_id
     LEFT JOIN stations s ON s.id = u.station_id
     LEFT JOIN employees tb ON tb.id = u.taken_by
     LEFT JOIN employees rb ON rb.id = u.ready_by
     LEFT JOIN employees sb ON sb.id = tk.served_by
     WHERE u.transaction_id = $1 AND u.status <> 'cancelled' ORDER BY s.sort NULLS LAST, u.id`, [t.id])).rows;

  const stations = new Map();
  for (const u of units) {
    const key = u.station ?? 'Без станции';
    const st = stations.get(key) ?? { name: key, total: 0, ready: 0, taken: 0, waiting: 0 };
    st.total++;
    if (u.status === 'ready') st.ready++;
    else if (u.status === 'taken') st.taken++;
    else st.waiting++;
    stations.set(key, st);
  }
  const ready = units.filter((u) => u.status === 'ready').length;
  const first = units.reduce((m, u) => (!m || u.created_at < m ? u.created_at : m), null);
  return {
    found: true,
    check: { id: t.poster_transaction_id, table: t.table_name, waiter: t.waiter_name, status: t.status },
    total: units.length,
    ready,
    allReady: units.length > 0 && ready === units.length,
    served: units.length > 0 && units.every((u) => u.served_at),
    servedBy: units.find((u) => u.served_by)?.served_by ?? null,
    waitingSec: first ? Math.round((Date.now() - new Date(first)) / 1000) : 0,
    stations: [...stations.values()],
    units: units.map((u) => ({ name: u.name, modifiers: u.modifiers, status: u.status, station: u.station,
      takenBy: u.taken_by, readyBy: u.ready_by })),
  };
}
