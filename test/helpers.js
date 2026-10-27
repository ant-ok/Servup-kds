// Tests run against a throwaway database (kds_test by default).
process.env.DATABASE_URL ??= 'postgres://kds:kds@localhost:5432/kds_test';
process.env.POSTER_TOKEN ??= 'test';
process.env.APP_SECRET ??= 'test-secret';

const db = await import('../src/db.js');
const { SyncEngine } = await import('../src/sync/engine.js');
const { FakePoster } = await import('./fake-poster.js');
const units = await import('../src/units.js');
const auth = await import('../src/auth.js');

export { db, units };

export async function freshEnv({ barOnly = true } = {}) {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  const fake = new FakePoster();
  const engine = new SyncEngine({ poster: fake });
  await engine.syncCatalog();
  if (barOnly) await db.query(`UPDATE settings SET value = '[1]' WHERE key = 'bar_workshop_ids'`);
  const device = (await db.query(`INSERT INTO devices (name, token_hash) VALUES ('test', 'x') RETURNING id`)).rows[0];
  return { fake, engine, device };
}

export async function bartender(name, pin, device) {
  const { rows } = await db.query(
    'INSERT INTO employees (name, is_bartender, pin_lookup) VALUES ($1, true, $2) RETURNING id', [name, auth.pinLookup(pin)]);
  const s = await units.startSession(pin, device);
  return { id: rows[0].id, token: s.token };
}

let op = 0;
export const act = (who, action, unitIds, extra = {}) =>
  units.applyAction({ opId: `op-${Date.now()}-${op++}`, token: who.token, action, unitIds, ...extra });

export const unitsOf = async (txId) =>
  (await db.query('SELECT * FROM units WHERE transaction_id = $1 ORDER BY id', [txId])).rows;
