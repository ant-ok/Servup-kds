import { config } from '../config.js';

export class PosterError extends Error {
  constructor(message, { code, method, retryable } = {}) {
    super(message);
    this.code = code;
    this.method = method;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thin Poster API client: GET {apiUrl}/{method}?token=...  ->  { response } | { error }
export async function call(method, params = {}, { retries = 2 } = {}) {
  if (!config.poster.token) throw new PosterError('POSTER_TOKEN не задан', { method });
  const url = new URL(`${config.poster.apiUrl}/${method}`);
  url.searchParams.set('token', config.poster.token);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(config.poster.timeoutMs) });
      if (res.status >= 500 || res.status === 429) {
        throw new PosterError(`HTTP ${res.status}`, { method, retryable: true });
      }
      const body = await res.json();
      if (body.error) {
        const e = typeof body.error === 'object' ? body.error : { code: body.error, message: body.message };
        throw new PosterError(e.message || `Poster error ${e.code}`, { method, code: e.code, retryable: false });
      }
      return body.response;
    } catch (err) {
      const retryable = err.retryable ?? (err.name === 'TimeoutError' || err.name === 'TypeError');
      if (!retryable || attempt >= retries) {
        throw err instanceof PosterError ? err : new PosterError(err.message, { method, retryable });
      }
      await sleep(500 * 2 ** attempt);
    }
  }
}

const listOf = (r) => (Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : []);

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

export const poster = {
  async getTransactions({ from, to, status = 0 }) {
    const params = { dateFrom: ymd(from), dateTo: ymd(to), status, include_products: true };
    if (config.poster.spotId) params.spot_id = config.poster.spotId;
    return listOf(await call('dash.getTransactions', params));
  },
  async getTransaction(id) {
    const r = await call('dash.getTransaction', { transaction_id: id, include_products: true });
    const t = Array.isArray(r) ? r[0] : r;
    if (t && !Array.isArray(t.products)) {
      t.products = listOf(await call('dash.getTransactionProducts', { transaction_id: id }));
    }
    return t ?? null;
  },
  async getProducts() {
    return listOf(await call('menu.getProducts'));
  },
  async getWorkshops() {
    return listOf(await call('menu.getWorkshops'));
  },
  async getEmployees() {
    return listOf(await call('access.getEmployees'));
  },
};
