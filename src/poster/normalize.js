// Poster field names vary a little between methods and API versions, so every
// read goes through here with fallbacks. The raw payload is stored as well.
import { config } from '../config.js';

const first = (obj, ...keys) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

const int = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function parseDate(v) {
  if (v === undefined || v === null || v === '' || v === '0' || v === 0) return null;
  const n = Number(v);
  if (!Number.isNaN(n)) return new Date(n > 1e12 ? n : n * 1000);
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

const money = (v) => (int(v) === null ? null : Number(v) / config.poster.moneyDivisor);

export function modificationKey(p) {
  const raw = first(p, 'modification_id', 'modificator_id', 'modification');
  if (raw === undefined || raw === '0' || raw === 0 || raw === '[]') return '0';
  return typeof raw === 'string' ? raw : JSON.stringify(raw);
}

export function normalizeProductLine(p) {
  const productId = int(first(p, 'product_id', 'dish_id'));
  return {
    productId,
    modKey: modificationKey(p),
    key: `${productId}:${modificationKey(p)}`,
    num: Number(first(p, 'num', 'count', 'amount') ?? 1),
    name: first(p, 'product_name', 'name'),
    modName: first(p, 'modificator_name', 'modification_name'),
    workshopId: int(first(p, 'workshop', 'workshop_id')),
  };
}

export function normalizeTransaction(t) {
  return {
    id: int(first(t, 'transaction_id', 'id')),
    status: int(first(t, 'status')) ?? 1,
    tableName: first(t, 'table_name', 'table_num') ?? null,
    hallName: first(t, 'hall_name') ?? null,
    waiterId: int(first(t, 'user_id', 'waiter_id')),
    waiterName: first(t, 'name', 'waiter_name', 'user_name') ?? null,
    spotId: int(first(t, 'spot_id')),
    tabletId: int(first(t, 'spot_tablet_id', 'tablet_id')),
    guests: int(first(t, 'guests_count', 'guests')),
    comment: first(t, 'transaction_comment', 'comment') ?? null,
    openedAt: parseDate(first(t, 'date_start', 'date_create')),
    closedAt: parseDate(first(t, 'date_close')),
    sum: money(first(t, 'sum', 'total_sum')),
    payedSum: money(first(t, 'payed_sum')),
    products: (Array.isArray(t.products) ? t.products : []).map(normalizeProductLine),
    raw: t,
  };
}

export function normalizeCatalogProduct(p) {
  const mods = {};
  for (const m of p.modifications ?? []) {
    mods[String(first(m, 'modificator_id', 'id'))] = first(m, 'modificator_name', 'name');
  }
  return {
    id: int(first(p, 'product_id', 'id')),
    name: first(p, 'product_name', 'name') ?? 'Без названия',
    category: first(p, 'category_name') ?? null,
    workshopId: int(first(p, 'workshop', 'workshop_id')),
    hidden: String(first(p, 'hidden') ?? '0') === '1',
    modifications: mods,
  };
}
