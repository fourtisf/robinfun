'use strict';
/**
 * Robinfun metadata API (M3, off-chain).
 *
 * Persists token metadata (name, ticker, description, socials, creator, logo)
 * so launches survive reloads and are shared across all visitors — the board
 * is no longer just each browser's local simulation.
 *
 * Small on purpose: Express + a JSON-file store + base64 image save. No native
 * dependencies, so it installs cleanly on a plain VPS.
 *
 * NOTE (trust): until the contracts are on-chain, POST /api/tokens is trusted
 * (it cannot yet verify a deploy transaction — brief §7). When the factory is
 * live, gate creation on the on-chain TokenCreated event / a signature.
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');   // MongoDB (if MONGODB_URI) or JSON-file fallback
const stats = require('./stats');   // continuous on-chain board-stats indexer
const apiV1 = require('./api-v1');  // public partner API (read-only token data)
const webhooks = require('./webhooks'); // partner webhook subscriptions (token.created / graduated)

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const UPLOAD_BASE = process.env.UPLOAD_BASE || '/uploads';   // public URL prefix (nginx serves this)
const SITE_DIR = process.env.SITE_DIR || '';                 // optional: serve the static site (dev only)
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 100000);
const MAX_IMG_BYTES = 2 * 1024 * 1024;
const DEFAULT_SETTINGS = { gradLpEth: 2.6 };

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Token + settings persistence lives in ./store (MongoDB or JSON — see store.js).
// store.init() runs before app.listen() in the async bootstrap at the bottom.

// Constant-time admin check, shared by the settings + delete endpoints.
function adminOk(req) {
  const secret = process.env.ADMIN_SECRET || '';
  if (!secret) return false;
  const given = req.get('x-admin-secret') || '';
  return given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

// ---------------------------------------------------------------- helpers
// SVG is intentionally NOT allowed: an <svg> served same-origin can execute
// script if opened directly, which would be stored XSS. Raster only.
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function saveDataUrlImage(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl || '');
  if (!m) throw new Error('bad-image');
  const ext = MIME_EXT[m[1].toLowerCase()];
  if (!ext) throw new Error('bad-image-type');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length === 0 || buf.length > MAX_IMG_BYTES) throw new Error('bad-image-size');
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return UPLOAD_BASE + '/' + name;
}
const clip = (s, n) => String(s == null ? '' : s).replace(/\p{Cc}/gu, '').slice(0, n).trim();
function cleanUrl(u) {
  u = clip(u, 300);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const p = new URL(u); return (p.protocol === 'http:' || p.protocol === 'https:') ? p.href : ''; }
  catch { return ''; }
}

// ---------------------------------------------------------------- rate limit
const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'x';
  const now = Date.now(), WIN = 60000, MAX = 12;
  let rec = hits.get(ip);
  if (!rec || now - rec.t > WIN) rec = { t: now, n: 0 };
  rec.n++; hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();   // crude memory bound
  if (rec.n > MAX) return res.status(429).json({ error: 'slow down' });
  next();
}

// ---------------------------------------------------------------- app
const app = express();
app.set('trust proxy', 1);              // behind nginx → real client IP in req.ip
app.use(express.json({ limit: '6mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, tokens: store.countTokens(), backend: store.backend() }));

// CORS for the admin-console endpoints — the console lives on a different origin
// (robinfun.tech) and needs to GET/POST/DELETE here. Everything else stays
// same-origin. Only the exact ADMIN_ORIGIN is ever allowed.
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN || 'https://robinfun.tech';
function adminCors(req, res, next) {
  const origin = req.get('origin') || '';
  if (origin === ADMIN_ORIGIN) {
    res.set('Access-Control-Allow-Origin', ADMIN_ORIGIN);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'content-type, x-admin-secret');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
app.options('/api/settings', adminCors);
// Public: the frontend reads these on load.
app.get('/api/settings', adminCors, (req, res) => res.json(store.getSettings()));
// Admin: change a setting (same x-admin-secret as delete). e.g. { gradLpEth: 2.6 }
app.post('/api/settings', adminCors, async (req, res) => {
  if (!process.env.ADMIN_SECRET) return res.status(503).json({ error: 'settings locked (set ADMIN_SECRET)' });
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const settings = { ...store.getSettings() };
  if (b.gradLpEth !== undefined) {
    const g = Number(b.gradLpEth);
    if (!(g > 0 && g <= 1000)) return res.status(400).json({ error: 'gradLpEth must be 0-1000' });
    settings.gradLpEth = g;
  }
  try { await store.saveSettings(settings); res.json({ ok: true, settings }); }
  catch { res.status(500).json({ error: 'server error' }); }
});

app.options('/api/tokens/:id', adminCors);   // preflight for the admin-console DELETE
app.get('/api/tokens', adminCors, (req, res) => {
  res.json(store.allTokens().slice().reverse());   // newest first
});

// Public: pre-computed board aggregates (24h vol, all-time vol, paid-to-creators)
// + per-token mcap/volume, indexed server-side on a loop so the homepage is instant
// instead of every browser reading the chain. Short cache — refreshed each cycle.
app.options('/api/stats', adminCors);
app.get('/api/stats', adminCors, (req, res) => {
  res.set('Cache-Control', 'public, max-age=10');
  res.json(stats.getStats());
});

// ---------------- Public Partner API v1 (read-only, CORS open) ----------------
// Stable, documented token feed so partners can auto-list Robinfun tokens.
// Any origin may read it; there are no secrets and it exposes only public data.
function publicCors(req, res, next) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'content-type, x-api-key');
  res.set('Cache-Control', 'public, max-age=15');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
const apiBase = (req) => `${req.protocol}://${req.get('host')}/api/v1`;
app.get('/api/v1', publicCors, (req, res) => res.json(apiV1.index(apiBase(req))));
app.get('/api/v1/stats', publicCors, (req, res) => res.json(apiV1.platformStats(stats)));
app.get('/api/v1/tokens', publicCors, (req, res) => res.json(apiV1.listTokens(store, stats, apiBase(req), req.query)));
app.get('/api/v1/tokens/:ca', publicCors, (req, res) => {
  const t = apiV1.getToken(store, stats, apiBase(req), req.params.ca);
  if (!t) return res.status(404).json({ error: 'token not found' });
  res.json(t);
});
app.get('/api/v1/tokens/:ca/trades', publicCors, (req, res) => {
  const t = apiV1.tokenTrades(store, stats, req.params.ca, req.query.limit);
  if (!t) return res.status(404).json({ error: 'token not found' });
  res.json(t);
});
app.get('/api/v1/tokens/:ca/ohlc', publicCors, (req, res) => {
  const t = apiV1.tokenOHLC(store, stats, req.params.ca, apiV1.resolutionToSec(req.query.resolution), req.query.limit);
  if (!t) return res.status(404).json({ error: 'token not found' });
  res.json(t);
});

// ---- OpenAPI spec + interactive docs (Swagger UI) ----
app.get('/api/v1/openapi.json', publicCors, (req, res) => res.json(apiV1.openapi(apiBase(req))));
app.get('/api/v1/docs', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(apiV1.docsHtml(apiBase(req)));
});

// ---- Aggregator (GeckoTerminal / DexScreener) endpoints ----
app.get('/api/v1/dex/latest-block', publicCors, (req, res) => res.json(apiV1.dexLatestBlock(stats)));
app.get('/api/v1/dex/asset', publicCors, (req, res) => {
  const a = apiV1.dexAsset(store, stats, req.query.id);
  if (!a) return res.status(404).json({ error: 'asset not found' });
  res.json(a);
});
app.get('/api/v1/dex/pair', publicCors, (req, res) => {
  const p = apiV1.dexPair(store, stats, req.query.id);
  if (!p) return res.status(404).json({ error: 'pair not found' });
  res.json(p);
});
app.get('/api/v1/dex/events', publicCors, (req, res) => {
  res.json(apiV1.dexEvents(store, stats, req.query.fromBlock, req.query.toBlock, req.query.limit));
});

// ---- Webhook subscriptions (admin-gated: same x-admin-secret) ----
// Partners register a URL; Robinfun POSTs to it on token.created / token.graduated.
app.options('/api/v1/webhooks', adminCors);
app.options('/api/v1/webhooks/:id', adminCors);
app.get('/api/v1/webhooks', adminCors, (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ webhooks: webhooks.list(), events: webhooks.VALID_EVENTS });
});
app.post('/api/v1/webhooks', adminCors, (req, res) => {
  if (!process.env.ADMIN_SECRET) return res.status(503).json({ error: 'webhooks locked (set ADMIN_SECRET)' });
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  try { res.status(201).json(webhooks.register(b.url, b.events, b.secret)); }
  catch (e) { res.status(400).json({ error: String(e.message || 'bad request') }); }
});
app.delete('/api/v1/webhooks/:id', adminCors, (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: webhooks.remove(String(req.params.id)) });
});

app.get('/api/tokens/:id', (req, res) => {
  const t = store.findToken(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

app.post('/api/tokens', rateLimit, async (req, res) => {
  try {
    if (store.countTokens() >= MAX_TOKENS) return res.status(507).json({ error: 'full' });
    const b = req.body || {};
    const name = clip(b.name, 64);
    const ticker = clip(b.ticker, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!name || !ticker) return res.status(400).json({ error: 'name and ticker required' });

    let logo = null;
    if (b.logo) {
      try { logo = saveDataUrlImage(b.logo); }
      catch { return res.status(400).json({ error: 'invalid image (png/jpg/gif/webp, max 2MB)' }); }
    }

    const ca = /^0x[0-9a-fA-F]{40}$/.test(String(b.ca || '').trim()) ? String(b.ca).trim() : '';

    const rec = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      ticker,
      ca,
      description: clip(b.description, 280),
      website: cleanUrl(b.website),
      x: cleanUrl(b.x),
      tg: cleanUrl(b.tg),
      buyFee: Math.min(10, Math.max(0, Number(b.buyFee) || 0)),
      sellFee: Math.min(10, Math.max(0, Number(b.sellFee) || 0)),
      decay: !!b.decay,
      renounce: !!b.renounce,
      creator: clip(b.creator, 64),
      logo,
      createdAt: Date.now(),
    };
    await store.addToken(rec);
    // Notify partner webhooks (fire-and-forget) with the public token shape.
    try { webhooks.dispatch('token.created', apiV1.toPublic(rec, stats.getStats(), apiBase(req))); } catch (_) {}
    res.status(201).json(rec);
  } catch {
    res.status(500).json({ error: 'server error' });
  }
});

// Moderation: delete a token (e.g. a stale/duplicate testnet launch).
// Guarded by a shared admin secret so only the operator can call it. If
// ADMIN_SECRET is unset the endpoint stays disabled (503) — safe by default.
// Match by record id, by ticker (?by=ticker), or by contract address (?by=ca).
app.delete('/api/tokens/:id', adminCors, async (req, res) => {
  const secret = process.env.ADMIN_SECRET || '';
  if (!secret) return res.status(503).json({ error: 'deletion disabled (set ADMIN_SECRET)' });
  const given = req.get('x-admin-secret') || '';
  if (given.length !== secret.length ||
      !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const key = String(req.params.id).trim();
  const by = String(req.query.by || 'id').toLowerCase();
  const match = (t) =>
    by === 'ticker' ? String(t.ticker).toUpperCase() === key.toUpperCase() :
    by === 'ca'     ? String(t.ca || '').toLowerCase() === key.toLowerCase() :
                      t.id === key;
  try {
    const removed = await store.removeTokens(match);
    if (!removed.length) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, removed: removed.length, remaining: store.countTokens() });
  } catch {
    res.status(500).json({ error: 'server error' });
  }
});

// Dev convenience: serve the static site + uploads same-origin so the frontend
// can be tested end-to-end locally. In production nginx serves these instead.
if (SITE_DIR) {
  app.use(UPLOAD_BASE, express.static(UPLOAD_DIR, { setHeaders: (r) => r.setHeader('X-Content-Type-Options', 'nosniff') }));
  app.use(express.static(SITE_DIR));
}

// Bootstrap: connect the store (MongoDB or JSON) BEFORE accepting requests.
(async () => {
  await store.init({ dataDir: DATA_DIR, defaultSettings: DEFAULT_SETTINGS });
  app.listen(PORT, HOST, () => console.log(`robinfun-api listening on ${HOST}:${PORT} [store: ${store.backend()}]`));
  // Kick off the continuous board-stats indexer (reads the chain server-side so
  // GET /api/stats is instant for every browser). Disable with STATS_INDEXER=off.
  if (!/^(0|off|false|no)$/i.test(process.env.STATS_INDEXER || '')) {
    // Pass webhooks.dispatch so the indexer can push token.graduated to partners.
    try { stats.startIndexer(() => store.allTokens(), webhooks.dispatch); console.log('board-stats indexer started'); }
    catch (e) { console.error('stats indexer failed to start', e); }
  }
})().catch((e) => { console.error('fatal: store init failed', e); process.exit(1); });
