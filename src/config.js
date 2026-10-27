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
  // Password of the platform owner panel (/platform/) where venues are managed.
  platformPassword: env('PLATFORM_PASSWORD', 'platform'),
  // Public https address of this installation, used for Poster OAuth redirects.
  publicUrl: env('PUBLIC_URL', 'http://localhost:3000'),
  timezone: env('TZ_NAME', 'Europe/Moscow'),

  poster: {
    apiUrl: env('POSTER_API_URL', 'https://joinposter.com/api'),
    // Poster application (dev.joinposter.com): lets venues connect themselves via OAuth
    // and signs webhooks. One application serves every venue.
    appId: env('POSTER_APP_ID', ''),
    appSecret: env('POSTER_APP_SECRET', ''),
    oauthAuthorizeUrl: env('POSTER_OAUTH_AUTHORIZE_URL', 'https://joinposter.com/api/auth'),
    // {account} is replaced with the venue's Poster subdomain.
    oauthTokenUrl: env('POSTER_OAUTH_TOKEN_URL', 'https://{account}.joinposter.com/api/v2/auth/access_token'),
    // Optional single-venue bootstrap: creates the first account from these on start.
    bootstrapToken: env('POSTER_TOKEN', ''),
    bootstrapAccount: env('POSTER_ACCOUNT', ''),
    bootstrapAdminPassword: env('ADMIN_PASSWORD', ''),
    // Reject webhooks with a bad signature. Off by default: a webhook only
    // triggers a re-fetch from the Poster API, so a forged one can't inject data.
    webhookStrict: env('POSTER_WEBHOOK_STRICT', 'false') === 'true',
    // Poster returns money in minor units (kopecks) for dash.* methods.
    moneyDivisor: num('POSTER_MONEY_DIVISOR', 100),
    timeoutMs: num('POSTER_TIMEOUT_MS', 10000),
  },

  // One bot for the whole installation. Venues link their own chats;
  // the platform chat receives every alert of every venue.
  telegram: {
    botToken: env('TELEGRAM_BOT_TOKEN', ''),
    platformChatId: env('TELEGRAM_PLATFORM_CHAT_ID', ''),
    apiUrl: env('TELEGRAM_API_URL', 'https://api.telegram.org'),
  },

  alerts: {
    posterDownMin: num('ALERT_POSTER_DOWN_MIN', 3),
    screenOfflineMin: num('ALERT_SCREEN_OFFLINE_MIN', 5),
    stuckOrderMin: num('ALERT_STUCK_ORDER_MIN', 30),
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
