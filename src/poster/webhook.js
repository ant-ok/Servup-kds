import crypto from 'node:crypto';
import { config } from '../config.js';

// Poster signs webhooks as md5("account;object;object_id;action;[data;]time;secret").
export function verifyWebhook(body) {
  if (!config.poster.appSecret || !body?.verify) return false;
  const parts = [body.account, body.object, body.object_id, body.action];
  if (body.data !== undefined && body.data !== null && body.data !== '') parts.push(body.data);
  parts.push(body.time, config.poster.appSecret);
  const expected = crypto.createHash('md5').update(parts.join(';')).digest('hex');
  return expected === String(body.verify).toLowerCase();
}

// Only checks matter to the KDS. Anything else (menu, employees) only
// warrants a catalog refresh.
export function classifyWebhook(body) {
  const object = String(body?.object ?? '');
  if (object === 'transaction' || object === 'incoming_order') return { kind: 'transaction', id: Number(body.object_id) };
  if (['product', 'dish', 'category', 'workshop', 'employee', 'user'].includes(object)) return { kind: 'catalog' };
  return { kind: 'ignore' };
}
