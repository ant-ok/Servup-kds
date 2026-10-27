// Runs the real HTTP + WebSocket server in-process against fake Poster accounts.
import { db, resetDb, FakePoster } from './helpers.js';
import { EngineManager } from '../src/sync/engine.js';
import { createRuntime } from '../src/runtime.js';

export async function startServer({ exchangeCode, exchangeManage } = {}) {
  await resetDb();
  const fakes = new Map(); // poster token -> FakePoster
  const fakeFor = (token) => {
    if (!fakes.has(token)) fakes.set(token, new FakePoster());
    return fakes.get(token);
  };
  const engines = new EngineManager({ posterFor: fakeFor });
  const runtime = createRuntime({
    engines,
    appOptions: {
      exchangeCode: exchangeCode ?? (async ({ account }) => ({ access_token: `tok-${account}`, account, account_number: `n-${account}` })),
      exchangeManage: exchangeManage ?? (async ({ code }) => ({ access_token: `mtok-${code}`, account_number: `num-${code}` })),
    },
  });
  await new Promise((r) => runtime.server.listen(0, r));
  const base = `http://localhost:${runtime.server.address().port}`;

  // Tiny cookie-keeping HTTP client.
  const client = (defaults = {}) => {
    let cookie = '';
    const call = async (path, { method = 'GET', body, headers = {}, raw = false } = {}) => {
      const res = await fetch(base + path, {
        method, redirect: 'manual',
        headers: { 'content-type': 'application/json', cookie, ...defaults.headers, ...headers },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      });
      const set = res.headers.getSetCookie?.() ?? [];
      if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
      const text = await res.text();
      let data = text;
      if (!raw) { try { data = JSON.parse(text); } catch { /* html, csv */ } }
      return { status: res.status, data, headers: res.headers, location: res.headers.get('location') };
    };
    // Raw fetch with this client's cookies, for byte-level checks.
    call.fetch = (path) => fetch(base + path, { headers: { cookie, ...defaults.headers } });
    return call;
  };

  const platform = async () => {
    const p = client();
    await p('/api/platform/login', { method: 'POST', body: { password: 'platform' } });
    return p;
  };

  // A venue with a fake Poster, a logged-in admin and a bar screen.
  let seq = 0;
  const venue = async ({ preset = 'bar', name } = {}) => {
    seq++;
    const p = await platform();
    const token = `t${seq}-${Math.random().toString(36).slice(2, 6)}`;
    const acc = (await p('/api/platform/accounts', { method: 'POST',
      body: { name: name ?? `Заведение ${seq}`, poster_account: `v${seq}${token.slice(-4)}`, token, password: 'password-123', preset } })).data;
    const admin = client();
    await admin('/api/admin/login', { method: 'POST', body: { account: String(acc.id), password: 'password-123' } });
    const stations = (await admin('/api/admin/stations')).data;
    const fake = fakeFor(token);
    const engine = engines.get(acc.id);
    return { acc, admin, adminFetch: admin.fetch, fake, engine, stations, token };
  };

  const close = async () => {
    engines.stopAll();
    await runtime.close();
  };

  return { base, engines, runtime, client, platform, venue, fakes, close, db };
}

export const pollUntil = async (fn, { timeout = 3000, every = 50 } = {}) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('pollUntil: timed out');
    await new Promise((r) => setTimeout(r, every));
  }
};
