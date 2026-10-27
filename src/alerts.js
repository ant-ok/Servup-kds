// Alerts to Telegram: the problem reaches the owner (and the platform) before
// a guest complains. Each condition alerts once when it starts and once when
// it clears; nothing repeats while it lasts.
import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';

export function createTelegram({ token = config.telegram.botToken, apiUrl = config.telegram.apiUrl } = {}) {
  if (!token) return null;
  const call = async (method, body, timeoutMs = 15000) => {
    const res = await fetch(`${apiUrl}/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.description || `Telegram HTTP ${res.status}`);
    return data.result;
  };
  return {
    send: (chatId, text) => call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }),
    getMe: () => call('getMe', {}),
    getUpdates: (offset) => call('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35000),
  };
}

// --- linking a venue chat ---------------------------------------------------
export async function createLinkCode(accountId) {
  const code = String(crypto.randomInt(100000, 1000000));
  await query(`UPDATE accounts SET telegram_link_code = $2, telegram_link_exp = now() + interval '15 minutes' WHERE id = $1`,
    [accountId, code]);
  return code;
}

// Handles one incoming bot message: "/start 123456" or "123456" links, "/stop" unlinks.
export async function handleBotMessage(msg, send) {
  const chatId = String(msg.chat?.id ?? '');
  const text = String(msg.text ?? '').trim();
  if (!chatId || !text) return;
  if (/^\/stop/.test(text)) {
    const { rows } = await query('UPDATE accounts SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 RETURNING name', [chatId]);
    await send(chatId, rows.length ? `Уведомления отключены: ${rows.map((r) => r.name).join(', ')}` : 'Этот чат не подключён.');
    return;
  }
  const code = text.match(/(\d{6})/)?.[1];
  if (!code) {
    await send(chatId, 'Чтобы подключить уведомления, отправьте код из админки KDS (Настройки → Telegram).');
    return;
  }
  const { rows } = await query(
    `UPDATE accounts SET telegram_chat_id = $2, telegram_link_code = NULL, telegram_link_exp = NULL
     WHERE telegram_link_code = $1 AND telegram_link_exp > now() RETURNING name`, [code, chatId]);
  await send(chatId, rows.length
    ? `✅ Подключено: ${rows[0].name}. Сюда придут сообщения о сбоях связи с Poster, выключенных экранах и зависших заказах.`
    : 'Код не подошёл или устарел. Получите новый в админке.');
}

export function startBotPolling(tg, { onError = console.error } = {}) {
  let offset = 0;
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        for (const u of await tg.getUpdates(offset)) {
          offset = u.update_id + 1;
          if (u.message) await handleBotMessage(u.message, tg.send).catch(onError);
        }
      } catch (err) {
        onError(err);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  })();
  return () => { stopped = true; };
}

// --- the monitor ---------------------------------------------------------------
// A venue is "working" if it had orders in the last 30 minutes: a screen that's
// off at 4 a.m. after closing is not an incident.
export class AlertMonitor {
  constructor({ engines, send, platformChatId = config.telegram.platformChatId, limits = config.alerts }) {
    this.engines = engines;
    this.send = send;
    this.platformChatId = platformChatId;
    this.limits = limits;
    this.active = new Map(); // key -> true while firing
  }

  async notify(acc, text) {
    const targets = [acc.telegram_chat_id, this.platformChatId && `${this.platformChatId}`].filter(Boolean);
    for (const chat of new Set(targets)) {
      const prefix = chat === acc.telegram_chat_id ? '' : `[${acc.name}] `;
      await this.send(chat, prefix + text).catch((err) => console.error('[alerts] send failed:', err.message));
    }
  }

  async transition(acc, key, firing, onText, offText) {
    const was = this.active.get(key) ?? false;
    if (firing === was) return;
    this.active.set(key, firing);
    await this.notify(acc, firing ? onText : offText);
  }

  async check(now = new Date()) {
    const accounts = (await query(
      `SELECT a.id, a.name, a.telegram_chat_id, a.poster_token IS NOT NULL AS connected,
         EXISTS (SELECT 1 FROM units u WHERE u.account_id = a.id AND u.created_at > $1::timestamptz - interval '30 minutes') AS working
       FROM accounts a WHERE a.active`, [now])).rows;
    for (const acc of accounts) {
      if (!acc.telegram_chat_id && !this.platformChatId) continue;

      // 1. Poster unreachable.
      const engine = this.engines.get(acc.id);
      const warmingUp = engine?.startedAt && now - engine.startedAt < this.limits.posterDownMin * 60e3;
      if (acc.connected && !warmingUp) {
        const h = this.engines.health(acc.id);
        const okAt = h.lastPollOkAt ? new Date(h.lastPollOkAt) : null;
        const down = !okAt || now - okAt > this.limits.posterDownMin * 60e3;
        await this.transition(acc, `poster:${acc.id}`, down,
          `⚠️ Нет связи с Poster больше ${this.limits.posterDownMin} мин. Новые заказы не приходят на экраны.${h.lastError ? `\nОшибка: ${h.lastError}` : ''}`,
          '✅ Связь с Poster восстановлена.');
      }

      // 2. Screens that went silent while the venue is working.
      const screens = (await query(
        `SELECT d.id, d.name, d.last_seen_at FROM devices d
         WHERE d.account_id = $1 AND d.active AND d.last_seen_at > $2::timestamptz - interval '12 hours'`, [acc.id, now])).rows;
      for (const d of screens) {
        const off = acc.working && now - new Date(d.last_seen_at) > this.limits.screenOfflineMin * 60e3;
        await this.transition(acc, `screen:${d.id}`, off,
          `📵 Экран «${d.name}» не на связи больше ${this.limits.screenOfflineMin} мин. Проверьте планшет: питание, Wi-Fi.`,
          `✅ Экран «${d.name}» снова на связи.`);
      }

      // 3. Orders waiting too long.
      const stuck = (await query(
        `SELECT count(*)::int AS n, min(t.table_name) AS table_name FROM units u JOIN transactions t ON t.id = u.transaction_id
         WHERE u.account_id = $1 AND u.status IN ('new','taken')
           AND u.created_at BETWEEN $2::timestamptz - interval '12 hours' AND $2::timestamptz - make_interval(mins => $3)`,
        [acc.id, now, this.limits.stuckOrderMin])).rows[0];
      await this.transition(acc, `stuck:${acc.id}`, stuck.n > 0,
        `⏰ Не готово дольше ${this.limits.stuckOrderMin} мин: ${stuck.n} порц.${stuck.table_name ? ` (например, стол ${stuck.table_name})` : ''}.`,
        '✅ Зависших заказов больше нет.');
    }
  }
}
