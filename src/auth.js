import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { query } from './db.js';

const scrypt = promisify(crypto.scrypt);

export const hmac = (v) => crypto.createHmac('sha256', config.appSecret).update(v).digest('hex');
// PINs are unique per venue, so the same "1111" can exist in two restaurants.
export const pinLookup = (accountId, pin) => hmac(`pin:${accountId}:${pin}`);
export const newToken = () => crypto.randomBytes(32).toString('base64url');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 32)).toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  const [salt, hash] = stored.split(':');
  return safeEqual((await scrypt(password, salt, 32)).toString('hex'), hash);
}

// --- signed cookies: venue admin and platform owner -------------------------
const COOKIE = { admin: 'kds_admin', platform: 'kds_platform' };
const TTL = 12 * 3600e3;

export const signSession = (kind, subject) => {
  const exp = Date.now() + TTL;
  return `${subject}.${exp}.${hmac(`${kind}.${subject}.${exp}`)}`;
};
function readSession(req, kind) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE[kind]}=([^;]+)`));
  const [subject, exp, sig] = (m ? decodeURIComponent(m[1]) : '').split('.');
  if (!subject || !(Number(exp) > Date.now()) || !safeEqual(sig, hmac(`${kind}.${subject}.${exp}`))) return null;
  return subject;
}
// Over HTTPS the cookie is SameSite=None so the admin panel also works when
// Poster shows it inside its own admin (an iframe). Browsers only accept None
// together with Secure, so plain-HTTP local installs keep Lax.
export const cookieAttrs = (publicUrl = config.publicUrl) =>
  (publicUrl.startsWith('https') ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax');

export function setSessionCookie(res, kind, value, maxAgeSec = TTL / 1000) {
  res.append('Set-Cookie', `${COOKIE[kind]}=${value}; HttpOnly; ${cookieAttrs()}; Path=/; Max-Age=${maxAgeSec}`);
}

export async function requireAdmin(req, res, next) {
  const id = Number(readSession(req, 'admin'));
  if (id) {
    const acc = (await query('SELECT id, name, poster_account, active FROM accounts WHERE id = $1', [id])).rows[0];
    if (acc?.active) { req.account = acc; return next(); }
  }
  res.status(401).json({ error: 'Требуется вход администратора' });
}

export function requirePlatform(req, res, next) {
  if (readSession(req, 'platform') === 'owner') return next();
  res.status(401).json({ error: 'Требуется вход владельца платформы' });
}
export const platformLogin = (password) =>
  (safeEqual(hmac(password ?? ''), hmac(config.platformPassword)) ? signSession('platform', 'owner') : null);

// --- KDS devices: a token issued from the admin panel; it also names the venue ----
export async function deviceByToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `UPDATE devices d SET last_seen_at = now() FROM accounts a
     WHERE d.token_hash = $1 AND d.active AND a.id = d.account_id AND a.active
     RETURNING d.id, d.name, d.account_id, d.station_id, d.kind`, [hmac(token)]);
  return rows[0] ?? null;
}

export async function requireDevice(req, res, next) {
  const device = await deviceByToken(req.get('x-device-token'));
  if (device) { req.device = device; return next(); }
  res.status(401).json({ error: 'Устройство не подключено', code: 'device' });
}

// --- PIN brute-force guard: 5 wrong PINs per device per minute -------------
const failures = new Map();
export function pinAttemptAllowed(deviceId) {
  const now = Date.now();
  const list = (failures.get(deviceId) ?? []).filter((t) => now - t < 60e3);
  failures.set(deviceId, list);
  return list.length < 5;
}
export const pinFailed = (deviceId) => failures.set(deviceId, [...(failures.get(deviceId) ?? []), Date.now()]);

// --- OAuth state: signed and short-lived, protects the Poster callback -------
// Carries a small payload (the chosen preset) through Poster's redirect.
export const oauthState = (payload = '') => {
  const exp = Date.now() + 10 * 60e3;
  return `${payload}.${exp}.${hmac(`oauth.${payload}.${exp}`)}`;
};
export const checkOauthState = (state) => {
  const [payload, exp, sig] = String(state ?? '').split('.');
  return Number(exp) > Date.now() && safeEqual(sig, hmac(`oauth.${payload}.${exp}`)) ? payload : null;
};

// --- one-time pairing codes for screens and Poster registers ---------------
export const newPairCode = () => String(crypto.randomInt(100000, 1000000));

const pairFailures = new Map();
export function pairAttemptAllowed(ip) {
  const now = Date.now();
  const list = (pairFailures.get(ip) ?? []).filter((t) => now - t < 10 * 60e3);
  pairFailures.set(ip, list);
  return list.length < 10;
}
export const pairFailed = (ip) => pairFailures.set(ip, [...(pairFailures.get(ip) ?? []), Date.now()]);
