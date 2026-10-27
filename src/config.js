import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so the app runs without extra dependencies.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = (name, def) => process.env[name] ?? def;
const num = (name, def) => Number(env(name, def));

export const config = {
  port: num('PORT', 3000),
  databaseUrl: env('DATABASE_URL', 'postgres://kds:kds@localhost:5432/kds'),
  appSecret: env('APP_SECRET', 'change-me-please'),
  adminPassword: env('ADMIN_PASSWORD', 'admin'),
  timezone: env('TZ_NAME', 'Europe/Moscow'),

  poster: {
    apiUrl: env('POSTER_API_URL', 'https://joinposter.com/api'),
    token: env('POSTER_TOKEN', ''),
    appSecret: env('POSTER_APP_SECRET', ''),
    // Reject webhooks with a bad signature. Off by default: a webhook only
    // triggers a re-fetch from the Poster API, so a forged one can't inject data.
    webhookStrict: env('POSTER_WEBHOOK_STRICT', 'false') === 'true',
    // Poster returns money in minor units (kopecks) for dash.* methods.
    moneyDivisor: num('POSTER_MONEY_DIVISOR', 100),
    spotId: env('POSTER_SPOT_ID', ''),
    timeoutMs: num('POSTER_TIMEOUT_MS', 10000),
  },

  sync: {
    pollOpenMs: num('POLL_OPEN_MS', 4000),
    pollFullMs: num('POLL_FULL_MS', 60000),
    catalogMs: num('CATALOG_SYNC_MS', 10 * 60000),
    // Units are only created for checks opened within this window, so a first
    // launch or a backfill never floods the screen with old orders.
    maxAgeHours: num('KDS_MAX_AGE_HOURS', 12),
  },

  kds: {
    undoWindowSec: num('UNDO_WINDOW_SEC', 300),
    sessionHours: num('KDS_SESSION_HOURS', 14),
  },
};
