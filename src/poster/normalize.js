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

// History of a check (dash.getTransaction with include_history): open, additem,
// changeitemcount, deleteitem, sendtokitchen, print, comment, settable, close...
// null when the payload has no history at all, [] when it is empty.
export function normalizeHistory(t) {
  if (!Array.isArray(t?.history)) return null;
  return t.history.map((h) => ({
    type: String(first(h, 'type_history', 'type') ?? ''),
    time: parseDate(first(h, 'time')),
    tabletId: int(first(h, 'spot_tablet_id')),
  }));
}

export function normalizeTransaction(t) {
  const history = normalizeHistory(t);
  return {
    id: int(first(t, 'transaction_id', 'id')),
    status: int(first(t, 'status')) ?? 1,
    tableName: first(t, 'table_name', 'table_num') ?? null,
    hallName: first(t, 'hall_name') ?? null,
    waiterId: int(first(t, 'user_id', 'waiter_id')),
    waiterName: first(t, 'name', 'waiter_name', 'user_name') ?? null,
    spotId: int(first(t, 'spot_id')),
    // The check itself has no register; its "open" history entry does.
    tabletId: int(first(t, 'spot_tablet_id', 'tablet_id')) ?? history?.find((h) => h.type === 'open')?.tabletId ?? null,
    guests: int(first(t, 'guests_count', 'guests')),
    comment: first(t, 'transaction_comment', 'comment') ?? null,
    openedAt: parseDate(first(t, 'date_start', 'date_create')),
    closedAt: parseDate(first(t, 'date_close')),
    sum: money(first(t, 'sum', 'total_sum')),
    payedSum: money(first(t, 'payed_sum')),
    products: (Array.isArray(t.products) ? t.products : []).map(normalizeProductLine),
    // How many times the waiter pressed "send to workshop"; null = unknown.
    sentCount: history ? history.filter((h) => h.type === 'sendtokitchen').length : null,
    raw: t,
  };
}

// Poster "cooking_time". The unit isn't documented in what we could read:
// small values are taken as minutes, larger ones as seconds.
export function cookingSeconds(v) {
  const n = Number(v);
  if (!(n > 0)) return null;
  return Math.round(n <= 60 ? n * 60 : n);
}

export function normalizeCatalogProduct(p) {
  const mods = {};
  // Product variants ("0.3 l / 0.5 l")...
  for (const m of p.modifications ?? []) {
    mods[String(first(m, 'modificator_id', 'id'))] = first(m, 'modificator_name', 'name');
  }
  // ...and dish modifiers ("+ cheese"), referenced from checks as [{ m, a }].
  for (const g of p.group_modifications ?? []) {
    for (const m of g.modifications ?? []) mods[`d${first(m, 'dish_modification_id', 'id')}`] = first(m, 'name');
  }
  return {
    id: int(first(p, 'product_id', 'id')),
    name: first(p, 'product_name', 'name') ?? 'Без названия',
    category: first(p, 'category_name') ?? null,
    workshopId: int(first(p, 'workshop', 'workshop_id')),
    hidden: String(first(p, 'hidden') ?? '0') === '1',
    modifications: mods,
    photo: first(p, 'photo_origin', 'photo') ?? null,
    cookingSeconds: cookingSeconds(first(p, 'cooking_time')),
    description: first(p, 'product_production_description') ?? null,
    // Some API versions already include the tech card in the menu list.
    recipe: Array.isArray(p.ingredients) ? normalizeRecipe(p) : null,
  };
}

const UNITS = { g: 'г', gr: 'г', kg: 'кг', ml: 'мл', l: 'л', p: 'шт', pcs: 'шт', pc: 'шт', шт: 'шт' };

// Tech card from menu.getProduct: [{ name, netto, unit }]. Weights in a
// Poster tech card are per one portion.
export function normalizeRecipe(p) {
  return (Array.isArray(p?.ingredients) ? p.ingredients : []).map((i) => {
    const unitRaw = String(first(i, 'structure_unit', 'ingredient_unit', 'unit') ?? '').toLowerCase();
    return {
      name: first(i, 'ingredient_name', 'name', 'product_name') ?? 'Ингредиент',
      netto: Number(first(i, 'structure_netto', 'netto', 'structure_brutto', 'brutto', 'amount') ?? 0),
      unit: UNITS[unitRaw] ?? unitRaw,
    };
  }).filter((i) => i.netto > 0);
}

// Display name of a check line's modifiers: a product variant id, or a dish's
// JSON list [{"m": id, "a": count}].
export function modifierName(product, modKey, fallback) {
  if (!modKey || modKey === '0') return fallback ?? null;
  const mods = product?.modifications ?? {};
  if (mods[modKey]) return mods[modKey];
  if (modKey.startsWith('[')) {
    try {
      const names = JSON.parse(modKey).map(({ m, a }) => {
        const name = mods[`d${m}`] ?? mods[String(m)];
        return name ? (Number(a) > 1 ? `${name} ×${a}` : name) : null;
      }).filter(Boolean);
      if (names.length) return names.join(', ');
    } catch { /* not JSON */ }
  }
  return fallback ?? null;
}
