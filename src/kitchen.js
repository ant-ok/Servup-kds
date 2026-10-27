// Helpers for the people at the station: what to make in total, how to make it,
// and how long it should take.
import { query } from './db.js';

const scope = (device, station) => (station?.kind === 'prep' ? station.id : null);

async function stationOf(device) {
  if (!device.station_id) return null;
  return (await query('SELECT id, kind FROM stations WHERE id = $1 AND account_id = $2', [device.station_id, device.account_id])).rows[0] ?? null;
}

// "Сколько всего сделать": open portions of this station grouped by item,
// plus the ingredients they need according to the Poster tech cards.
export async function getSummary(device, engine) {
  const stationId = scope(device, await stationOf(device));
  const a = device.account_id;
  const open = `u.account_id = $1 AND u.status IN ('new','taken') AND u.created_at > now() - interval '24 hours'
                AND ($2::int IS NULL OR u.station_id = $2)`;
  const items = (await query(
    `SELECT u.poster_product_id AS product_id, u.name, u.modifiers, u.item_key,
            count(*)::int AS portions, count(*) FILTER (WHERE u.status = 'taken')::int AS taken, sum(u.qty) AS qty
     FROM units u WHERE ${open}
     GROUP BY 1, 2, 3, 4 ORDER BY portions DESC, u.name`, [a, stationId])).rows;

  if (engine && items.length) await engine.ensureRecipes([...new Set(items.map((i) => i.product_id))]);
  const ingredients = items.length ? (await query(
    `SELECT ing->>'name' AS name, ing->>'unit' AS unit, round(sum((ing->>'netto')::numeric * u.qty), 2) AS amount
     FROM units u JOIN products p ON p.account_id = u.account_id AND p.poster_product_id = u.poster_product_id
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.recipe, '[]')) ing
     WHERE ${open} GROUP BY 1, 2 ORDER BY 1`, [a, stationId])).rows : [];
  const withoutRecipe = items.length ? (await query(
    `SELECT DISTINCT u.name FROM units u JOIN products p ON p.account_id = u.account_id AND p.poster_product_id = u.poster_product_id
     WHERE ${open} AND jsonb_array_length(COALESCE(p.recipe, '[]')) = 0`, [a, stationId])).rows.map((r) => r.name) : [];

  return { items, ingredients, withoutRecipe, total: items.reduce((s, i) => s + i.portions, 0) };
}

const photoUrl = (photo, posterAccount) => {
  if (!photo) return null;
  if (/^https?:\/\//.test(photo)) return photo;
  return posterAccount ? `https://${posterAccount}.joinposter.com${photo.startsWith('/') ? '' : '/'}${photo}` : null;
};

export async function getRecipe(accountId, productId, engine) {
  if (engine) await engine.ensureRecipes([productId]);
  const row = (await query(
    `SELECT p.poster_product_id AS id, p.name, p.category_name, p.recipe, p.photo, a.poster_account,
            COALESCE(i.norm_seconds, p.cooking_seconds) AS norm_seconds, i.recipe_note, p.description
     FROM products p JOIN accounts a ON a.id = p.account_id
     LEFT JOIN product_info i ON i.account_id = p.account_id AND i.poster_product_id = p.poster_product_id
     WHERE p.account_id = $1 AND p.poster_product_id = $2`, [accountId, productId])).rows[0];
  if (!row) return null;
  return {
    id: row.id, name: row.name, category: row.category_name, ingredients: row.recipe ?? [],
    note: row.recipe_note, description: row.description, normSeconds: row.norm_seconds,
    photo: photoUrl(row.photo, row.poster_account),
  };
}

// Norms from real data: 75% of portions over the last 30 days were made
// faster than this. Only for products with enough history and no norm yet.
export async function suggestNorms(accountId, { overwrite = false, minSamples = 5 } = {}) {
  const { rows } = await query(
    `INSERT INTO product_info (account_id, poster_product_id, norm_seconds)
     SELECT u.account_id, u.poster_product_id,
            GREATEST(30, ceil(percentile_cont(0.75) WITHIN GROUP (ORDER BY extract(epoch FROM u.ready_at - u.taken_at)) / 15) * 15)::int
     FROM units u
     WHERE u.account_id = $1 AND u.status = 'ready' AND u.taken_at IS NOT NULL AND u.ready_at > now() - interval '30 days'
       AND u.ready_at > u.taken_at
     GROUP BY u.account_id, u.poster_product_id HAVING count(*) >= $3
     ON CONFLICT (account_id, poster_product_id) DO UPDATE SET norm_seconds = EXCLUDED.norm_seconds, updated_at = now()
       WHERE $2 OR product_info.norm_seconds IS NULL
     RETURNING poster_product_id`, [accountId, overwrite, minSamples]);
  return rows.length;
}
