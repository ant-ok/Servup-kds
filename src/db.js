import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

// numeric -> JS number; amounts here stay far below float precision limits.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  connectionTimeoutMillis: 5000,   // fail fast instead of hanging when the DB is unreachable
  statement_timeout: 15000,        // one bad query must never block a screen for long
  idle_in_transaction_session_timeout: 30000,
});
// An idle client losing its connection (DB restart, network blip) emits here;
// without a handler that would crash the whole process.
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function migrate() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
  const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    await tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    console.log(`[db] applied ${file}`);
  }
}

export async function getSettings(accountId, client = pool) {
  const { rows } = await client.query('SELECT key, value FROM settings WHERE account_id = $1', [accountId]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function audit(client, entry) {
  await client.query(
    `INSERT INTO audit_log (account_id, actor, employee_id, device_id, action, unit_id, transaction_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entry.accountId, entry.actor, entry.employeeId ?? null, entry.deviceId ?? null, entry.action,
     entry.unitId ?? null, entry.transactionId ?? null, entry.details ?? null],
  );
}
