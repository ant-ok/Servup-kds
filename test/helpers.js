// Tests run against a throwaway database (kds_test by default).
process.env.DATABASE_URL ??= 'postgres://kds:kds@localhost:5432/kds_test';
process.env.APP_SECRET ??= 'test-secret';

const db = await import('../src/db.js');
const { SyncEngine } = await import('../src/sync/engine.js');
const { FakePoster } = await import('./fake-poster.js');
const { createAccount } = await import('../src/accounts.js');
const units = await import('../src/units.js');
const auth = await import('../src/auth.js');

export { db, units, FakePoster };

export async function resetDb() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
}

// A venue with its own fake Poster account, synced catalog and screens.
export async function venue({ preset = 'bar', name = 'Тест' } = {}) {
  const acc = await createAccount({ name, posterAccount: `p${Math.random().toString(36).slice(2, 8)}`, token: 't', preset });
  const fake = new FakePoster();
  const engine = new SyncEngine({ accountId: acc.id, poster: fake });
  await engine.syncCatalog();
  const stations = Object.fromEntries((await db.query('SELECT id, name FROM stations WHERE account_id = $1', [acc.id])).rows
    .map((s) => [s.name, s.id]));
  const screen = async (stationName) => (await db.query(
    `INSERT INTO devices (account_id, name, station_id, token_hash) VALUES ($1, $2, $3, $4) RETURNING id, account_id, station_id`,
    [acc.id, stationName ?? 'все', stationName ? stations[stationName] : null, Math.random().toString()])).rows[0];
  const device = await screen(preset === 'bar' ? 'Бар' : null);
  return { accountId: acc.id, fake, engine, device, stations, screen };
}

export async function staff(v, name, pin) {
  const { rows } = await db.query(
    'INSERT INTO employees (account_id, name, kds_access, pin_lookup) VALUES ($1, $2, true, $3) RETURNING id',
    [v.accountId, name, auth.pinLookup(v.accountId, pin)]);
  const s = await units.startSession(pin, v.device);
  return { id: rows[0].id, token: s.token, device: v.device };
}

let op = 0;
export const act = (who, action, unitIds, extra = {}) =>
  units.applyAction({ opId: `op-${Date.now()}-${op++}`, token: who.token, action, unitIds, device: who.device, ...extra });

export const serve = (who, ticketId, extra = {}) =>
  units.serveTicket({ opId: `op-${Date.now()}-${op++}`, token: who.token, ticketId, device: who.device, ...extra });

export const unitsOf = async (v, posterTxId) =>
  (await db.query(
    `SELECT u.* FROM units u JOIN transactions t ON t.id = u.transaction_id
     WHERE t.account_id = $1 AND t.poster_transaction_id = $2 ORDER BY u.id`, [v.accountId, posterTxId])).rows;

export const board = async (device) => (await units.getBoard(device)).tickets;
