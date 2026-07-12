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

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
const UPLOAD_BASE = process.env.UPLOAD_BASE || '/uploads';   // public URL prefix (nginx serves this)
const SITE_DIR = process.env.SITE_DIR || '';                 // optional: serve the static site (dev only)
const DB_FILE = path.join(DATA_DIR, 'tokens.json');
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 100000);
const MAX_IMG_BYTES = 2 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- JSON store
function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { tokens: [] }; }
}
function save(db) {
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);   // atomic replace
}
const db = load();

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

app.get('/api/health', (req, res) => res.json({ ok: true, tokens: db.tokens.length }));

app.get('/api/tokens', (req, res) => {
  res.json(db.tokens.slice().reverse());   // newest first
});

app.get('/api/tokens/:id', (req, res) => {
  const t = db.tokens.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  res.json(t);
});

app.post('/api/tokens', rateLimit, (req, res) => {
  try {
    if (db.tokens.length >= MAX_TOKENS) return res.status(507).json({ error: 'full' });
    const b = req.body || {};
    const name = clip(b.name, 64);
    const ticker = clip(b.ticker, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!name || !ticker) return res.status(400).json({ error: 'name and ticker required' });

    let logo = null;
    if (b.logo) {
      try { logo = saveDataUrlImage(b.logo); }
      catch { return res.status(400).json({ error: 'invalid image (png/jpg/gif/webp, max 2MB)' }); }
    }

    const rec = {
      id: crypto.randomBytes(8).toString('hex'),
      name,
      ticker,
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
    db.tokens.push(rec);
    save(db);
    res.status(201).json(rec);
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

app.listen(PORT, HOST, () => console.log(`robinfun-api listening on ${HOST}:${PORT}`));
