import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';

export const hmac = (v) => crypto.createHmac('sha256', config.appSecret).update(v).digest('hex');
export const pinLookup = (pin) => hmac(`pin:${pin}`);
export const newToken = () => crypto.randomBytes(32).toString('base64url');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// --- admin: signed cookie ---------------------------------------------------
const ADMIN_COOKIE = 'kds_admin';

export function adminLogin(password) {
  if (!safeEqual(hmac(password ?? ''), hmac(config.adminPassword))) return null;
  const exp = Date.now() + 12 * 3600e3;
  return `${exp}.${hmac(`admin.${exp}`)}`;
}

function readCookie(req, name) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export function setAdminCookie(res, value) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
}

export function requireAdmin(req, res, next) {
  const [exp, sig] = (readCookie(req, ADMIN_COOKIE) ?? '').split('.');
  if (exp && Number(exp) > Date.now() && safeEqual(sig, hmac(`admin.${exp}`))) return next();
  res.status(401).json({ error: 'Требуется вход администратора' });
}

// --- KDS devices: a token issued from the admin panel ----------------------
export async function requireDevice(req, res, next) {
  const token = req.get('x-device-token');
  if (token) {
    const { rows } = await query(
      'UPDATE devices SET last_seen_at = now() WHERE token_hash = $1 AND active RETURNING id, name', [hmac(token)]);
    if (rows[0]) {
      req.device = rows[0];
      return next();
    }
  }
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
