import http from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { migrate, query, pool } from './db.js';
import { hmac } from './auth.js';
import { createApp } from './app.js';
import { SyncEngine } from './sync/engine.js';

if (process.env.NODE_ENV === 'production' && (config.appSecret === 'change-me-please' || config.adminPassword === 'admin')) {
  console.error('[kds] Задайте APP_SECRET и ADMIN_PASSWORD в .env перед запуском');
  process.exit(1);
}

await migrate();

const engine = new SyncEngine();
let io;

// Screens are told "something changed" and re-read the board themselves, so a
// missed push can never leave them showing a partial state.
let pending = null;
const notify = () => {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    io?.emit('board');
  }, 100);
};

const app = createApp({ engine, notify });
const server = http.createServer(app);
io = new Server(server, { pingInterval: 10000, pingTimeout: 8000 });

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.deviceToken;
  const { rows } = token ? await query('SELECT id FROM devices WHERE token_hash = $1 AND active', [hmac(token)]) : { rows: [] };
  return rows[0] ? next() : next(new Error('device'));
});
io.on('connection', (socket) => socket.emit('health', engine.getHealth()));

engine.on('changed', notify);
engine.on('health', (h) => io.emit('health', h));

// Housekeeping: idempotency keys and expired sessions.
setInterval(() => {
  query(`DELETE FROM applied_ops WHERE created_at < now() - interval '2 days'`).catch(() => {});
  query(`DELETE FROM kds_sessions WHERE expires_at < now()`).catch(() => {});
}, 3600e3);

server.listen(config.port, () => {
  console.log(`[kds] http://localhost:${config.port}  (экран: /kds/, админка: /admin/)`);
  if (!config.poster.token) console.warn('[kds] POSTER_TOKEN не задан — синхронизация с Poster не работает');
  engine.start();
});

const shutdown = async () => {
  engine.stop();
  io.close();
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
