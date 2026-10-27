// HTTP + WebSocket server around the app. Used by server.js in production and
// by the browser tests, which run the real server in-process.
import http from 'node:http';
import { Server } from 'socket.io';
import { query } from './db.js';
import { deviceByToken } from './auth.js';
import { createApp } from './app.js';

export function createRuntime({ engines, telegram = null, appOptions = {} }) {
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

  const app = createApp({ engines, notify, telegram, ...appOptions });
  const server = http.createServer(app);
  // Slow or half-open clients must not pile up sockets.
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 65000;

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

  const onChanged = (e) => notify(e.accountId);
  const onHealth = (e) => io.to(`acc:${e.accountId}`).emit('health', e.health);
  engines.on('changed', onChanged);
  engines.on('health', onHealth);

  // Housekeeping: idempotency keys, expired sessions, old raw webhooks.
  const housekeeping = setInterval(() => {
    query(`DELETE FROM applied_ops WHERE created_at < now() - interval '2 days'`).catch(() => {});
    query(`DELETE FROM kds_sessions WHERE expires_at < now()`).catch(() => {});
    query(`DELETE FROM webhook_log WHERE received_at < now() - interval '14 days'`).catch(() => {});
  }, 3600e3);

  const close = async () => {
    clearInterval(housekeeping);
    for (const t of pending.values()) clearTimeout(t);
    engines.off('changed', onChanged);
    engines.off('health', onHealth);
    io.close();
    await new Promise((r) => server.close(() => r()));
  };

  return { app, server, io, notify, close };
}
