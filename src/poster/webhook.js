import crypto from 'node:crypto';
import { config } from '../config.js';

// Poster signs webhooks as md5("account;object;object_id;action;[data;]time;secret").
export function verifyWebhook(body) {
  if (!config.poster.appSecret || !body?.verify) return false;
  const parts = [body.account, body.object, body.object_id, body.action];
  // `data` is signed as the string Poster sent; if a JSON parser turned it into
  // an object, sign its JSON form.
  if (body.data !== undefined && body.data !== null && body.data !== '') {
    parts.push(typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
  }
  parts.push(body.time, config.poster.appSecret);
  const expected = crypto.createHash('md5').update(parts.join(';')).digest('hex');
  return expected === String(body.verify).toLowerCase();
}

// Only checks matter to the KDS. Anything else (menu, employees) only
// warrants a catalog refresh.
export function classifyWebhook(body) {
  const object = String(body?.object ?? '');
  // An online order (incoming_order) has its own id; once accepted it becomes
  // a check and arrives as a `transaction` webhook of its own.
  if (object === 'transaction') return { kind: 'transaction', id: Number(body.object_id) };
  if (['product', 'dish', 'category', 'workshop', 'employee', 'user', 'settings'].includes(object)) return { kind: 'catalog' };
  // The venue (re)installed or removed our application in Poster.
  if (object === 'application') return { kind: 'application', action: String(body.action ?? '') };
  return { kind: 'ignore' };
}

export function webhookData(body) {
  if (!body?.data) return {};
  if (typeof body.data === 'object') return body.data;
  try { return JSON.parse(body.data); } catch { return {}; }
}
