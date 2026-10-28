// Venues (tenants). Creating one also creates its default settings and stations.
import { tx, audit } from './db.js';
import { hashPassword } from './auth.js';

export const DEFAULT_SETTINGS = {
  credit_made_then_removed: true, // pay for a portion made and later removed from the check
  warn_minutes: 5,
  critical_minutes: 10,
  ready_visible_seconds: 60,
  day_start_hour: 6,              // business day boundary for reports (venues work past midnight)
  maker_title: 'Сотрудник',       // what the screen calls people: «Бармен», «Повар»...
  release_mode: 'on_add',         // on_add: as soon as it's on the check; on_send: after "send to workshop" in Poster
  quick_service: false,           // fast food: order numbers instead of tables, checks paid at once, pickup screen for guests
};

// preset 'bar': one bar screen. 'restaurant': kitchen + bar + expo pass. 'fastfood': kitchen + pickup counter.
export async function createAccount({ name, posterAccount = null, token = null, password = null, preset = 'bar' }, client) {
  const run = async (c) => {
    const acc = (await c.query(
      `INSERT INTO accounts (name, poster_account, poster_token, admin_password) VALUES ($1,$2,$3,$4) RETURNING id, name`,
      [name, posterAccount, token, password ? await hashPassword(password) : null])).rows[0];
    const settings = { ...DEFAULT_SETTINGS, kds_started_at: new Date().toISOString(),
      maker_title: { restaurant: 'Сотрудник', fastfood: 'Повар' }[preset] ?? 'Бармен',
      quick_service: preset === 'fastfood' };
    for (const [k, v] of Object.entries(settings)) {
      await c.query('INSERT INTO settings (account_id, key, value) VALUES ($1,$2,$3)', [acc.id, k, JSON.stringify(v)]);
    }
    const stations = {
      restaurant: [['Кухня', 'prep', true], ['Бар', 'prep', false], ['Раздача', 'expo', false]],
      fastfood: [['Кухня', 'prep', true], ['Выдача', 'expo', false]],
    }[preset] ?? [['Бар', 'prep', false]];
    for (const [i, [sName, kind, group]] of stations.entries()) {
      await c.query('INSERT INTO stations (account_id, name, kind, group_items, sort) VALUES ($1,$2,$3,$4,$5)',
        [acc.id, sName, kind, group, i]);
    }
    await audit(c, { accountId: acc.id, actor: 'platform', action: 'account_created', details: { preset, posterAccount } });
    return acc;
  };
  return client ? run(client) : tx(run);
}
