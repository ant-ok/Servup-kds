import crypto from 'node:crypto';
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
export async function call(token, method, params = {}, { retries = 2 } = {}) {
  if (!token) throw new PosterError('Нет токена Poster', { method });
  const url = new URL(`${config.poster.apiUrl}/${method}`);
  url.searchParams.set('token', token);
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
      // `response: false` is Poster's "not found"; `err_code` is an error inside a 200.
      if (body.response === false) return null;
      if (body.response?.err_code) {
        throw new PosterError(`Poster err_code ${body.response.err_code}`, { method, code: body.response.err_code, retryable: false });
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

// One client per venue, bound to that venue's access token.
export function createPosterClient(token) {
  const api = (method, params) => call(token, method, params);
  return {
    // light: ids and statuses only, without the items (cheap enough to ask every few seconds).
    async getTransactions({ from, to, status = 0, light = false }) {
      return listOf(await api('dash.getTransactions',
        { dateFrom: ymd(from), dateTo: ymd(to), status, ...(light ? {} : { include_products: true, include_history: true }) }));
    },
    async getTransaction(id) {
      const r = await api('dash.getTransaction', { transaction_id: id, include_products: true, include_history: true });
      const t = Array.isArray(r) ? r[0] : r;
      if (t && !Array.isArray(t.products)) {
        t.products = listOf(await api('dash.getTransactionProducts', { transaction_id: id }));
      }
      return t ?? null;
    },
    getProducts: async () => listOf(await api('menu.getProducts')),
    getProduct: async (id) => api('menu.getProduct', { product_id: id }),
    getWorkshops: async () => listOf(await api('menu.getWorkshops')),
    getEmployees: async () => listOf(await api('access.getEmployees')),
    getSettings: async () => api('settings.getAllSettings'),
  };
}

// Poster Platform: an application opened from inside the Poster admin panel
// gets a `code`; verify = md5("application_id:application_secret:code").
export async function exchangeManageCode({ code }) {
  const { appId, appSecret } = config.poster;
  const body = new URLSearchParams({
    application_id: appId, application_secret: appSecret, code,
    verify: crypto.createHash('md5').update(`${appId}:${appSecret}:${code}`).digest('hex'),
  });
  const res = await fetch(config.poster.manageAuthUrl, { method: 'POST', body, signal: AbortSignal.timeout(config.poster.timeoutMs) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new PosterError(data.message || `Poster manage auth: HTTP ${res.status}`, { method: 'manage' });
  return data;
}

// OAuth: exchange the code Poster sends to our redirect URL for a venue token.
export async function exchangeOAuthCode({ account, code }) {
  const body = new URLSearchParams({
    application_id: config.poster.appId,
    application_secret: config.poster.appSecret,
    grant_type: 'authorization_code',
    redirect_uri: `${config.publicUrl}/auth/poster/callback`,
    code,
  });
  const url = config.poster.oauthTokenUrl.replace('{account}', encodeURIComponent(account));
  const res = await fetch(url, { method: 'POST', body, signal: AbortSignal.timeout(config.poster.timeoutMs) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new PosterError(data.error_message || data.error?.message || `Poster OAuth: HTTP ${res.status}`, { method: 'oauth' });
  }
  return data;
}
