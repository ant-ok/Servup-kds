import { config } from './config.js';
import { migrate, query, pool } from './db.js';
import { createAccount } from './accounts.js';
import { EngineManager } from './sync/engine.js';
import { createTelegram, startBotPolling, AlertMonitor } from './alerts.js';
import { createRuntime } from './runtime.js';

if (process.env.NODE_ENV === 'production' && (config.appSecret === 'change-me-please' || config.platformPassword === 'platform')) {
  console.error('[kds] Задайте APP_SECRET и PLATFORM_PASSWORD в .env перед запуском');
  process.exit(1);
}

// Last-resort guards. A stray rejected promise is logged; an uncaught
// exception leaves the process in an unknown state, so it exits and Docker
// restarts it (restart: always) within seconds.
process.on('unhandledRejection', (err) => console.error('[kds] unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  console.error('[kds] uncaught exception, restarting:', err);
  process.exit(1);
});

// After a power cut the database may come up later than the app: wait for it
// instead of crash-looping.
for (let attempt = 1; ; attempt++) {
  try {
    await query('SELECT 1');
    break;
  } catch (err) {
    if (attempt >= 60) throw err;
    console.log(`[kds] база данных недоступна (${err.message}), повтор через 2 с…`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await migrate();

// Single-venue setup straight from .env: the first start creates the account.
if (config.poster.bootstrapToken) {
  const { rows } = await query('SELECT id FROM accounts WHERE poster_token = $1 OR ($2 <> \'\' AND poster_account = $2)',
    [config.poster.bootstrapToken, config.poster.bootstrapAccount]);
  if (!rows.length) {
    const acc = await createAccount({
      name: config.poster.bootstrapAccount || 'Моё заведение', posterAccount: config.poster.bootstrapAccount || null,
      token: config.poster.bootstrapToken, password: config.poster.bootstrapAdminPassword || null,
      preset: config.poster.bootstrapPreset,
    });
    console.log(`[kds] создано заведение #${acc.id} из POSTER_TOKEN (вход в админку: «${config.poster.bootstrapAccount || acc.id}»)`);
  }
}

const engines = new EngineManager();

// Telegram alerts, when a bot token is configured.
const telegram = createTelegram();
if (telegram) {
  telegram.getMe().then((me) => { telegram.username = me.username; }).catch((err) => console.error('[telegram]', err.message));
  startBotPolling(telegram, { onError: (err) => console.error('[telegram]', err.message) });
  const monitor = new AlertMonitor({ engines, send: telegram.send });
  setInterval(() => monitor.check().catch((err) => console.error('[alerts]', err.message)), 60000);
}

const runtime = createRuntime({ engines, telegram });
runtime.server.listen(config.port, async () => {
  console.log(`[kds] ${config.publicUrl}  (экран: /kds/, админка: /admin/, платформа: /platform/)`);
  await engines.startAll();
});

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  engines.stopAll();
  await Promise.race([runtime.close(), new Promise((r) => setTimeout(r, 5000))]);
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
