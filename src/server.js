import http from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { migrate, query, pool } from './db.js';
import { deviceByToken } from './auth.js';
import { createApp } from './app.js';
import { createAccount } from './accounts.js';
import { EngineManager } from './sync/engine.js';

if (process.env.NODE_ENV === 'production' && (config.appSecret === 'change-me-please' || config.platformPassword === 'platform')) {
  console.error('[kds] Задайте APP_SECRET и PLATFORM_PASSWORD в .env перед запуском');
  process.exit(1);
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
    });
    console.log(`[kds] создано заведение #${acc.id} из POSTER_TOKEN (вход в админку: «${config.poster.bootstrapAccount || acc.id}»)`);
  }
}

const engines = new EngineManager();
let io;

// Screens are told "something changed" and re-read their board, so a missed
// push can never leave them showing a partial state. Batched per venue.
const pending = new Map();
const notify = (accountId) => {
  if (pending.has(accountId)) return;
  pending.set(accountId, setTimeout(() => {
    pending.delete(accountId);
    io?.to(`acc:${accountId}`).emit('board');
  }, 100));
};

const app = createApp({ engines, notify });
const server = http.createServer(app);
io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

io.use(async (socket, next) => {
  const device = await deviceByToken(socket.handshake.auth?.deviceToken).catch(() => null);
  if (!device) return next(new Error('device'));
  socket.data.device = device;
  next();
});
io.on('connection', (socket) => {
  const accountId = socket.data.device.account_id;
  socket.join(`acc:${accountId}`);
  socket.emit('health', engines.health(accountId));
});

engines.on('changed', (e) => notify(e.accountId));
engines.on('health', (e) => io.to(`acc:${e.accountId}`).emit('health', e.health));

// Housekeeping: idempotency keys and expired sessions.
setInterval(() => {
  query(`DELETE FROM applied_ops WHERE created_at < now() - interval '2 days'`).catch(() => {});
  query(`DELETE FROM kds_sessions WHERE expires_at < now()`).catch(() => {});
}, 3600e3);

server.listen(config.port, async () => {
  console.log(`[kds] ${config.publicUrl}  (экран: /kds/, админка: /admin/, платформа: /platform/)`);
  await engines.startAll();
});

const shutdown = async () => {
  engines.stopAll();
  io.close();
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
