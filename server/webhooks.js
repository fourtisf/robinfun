'use strict';
/*
 * Webhook subscriptions — partners register a URL and Robinfun POSTs to it when
 * something happens (a token is created, a token graduates). Fire-and-forget with
 * an optional HMAC-SHA256 signature (`x-robinfun-signature: sha256=…`) so the
 * receiver can verify the payload. Subscriptions persist to a JSON file.
 *
 * Managed via the admin API (POST/GET/DELETE /api/v1/webhooks) — see docs/API.md.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE = process.env.WEBHOOKS_FILE || path.join(__dirname, 'data', 'webhooks.json');
const VALID_EVENTS = ['token.created', 'token.graduated'];
let subs = [];

function load() { try { subs = JSON.parse(fs.readFileSync(FILE, 'utf8')).webhooks || []; } catch (_) { subs = []; } }
function save() {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify({ webhooks: subs }, null, 2)); fs.chmodSync(FILE, 0o600); } catch (_) {}
}

// Public view — never leaks the shared secret.
function list() { return subs.map((s) => ({ id: s.id, url: s.url, events: s.events, createdAt: s.createdAt })); }

function register(url, events, secret) {
  if (!/^https?:\/\/.+/i.test(String(url || ''))) throw new Error('valid https url required');
  let ev = Array.isArray(events) ? events.filter((e) => VALID_EVENTS.includes(e)) : [];
  if (!ev.length) ev = [...VALID_EVENTS];
  const s = { id: crypto.randomBytes(8).toString('hex'), url: String(url), events: ev, secret: secret ? String(secret) : '', createdAt: Date.now() };
  subs.push(s); save();
  return { id: s.id, url: s.url, events: s.events };
}
function remove(id) { const n = subs.length; subs = subs.filter((s) => s.id !== id); save(); return subs.length < n; }

// Dispatch an event to every subscriber that wants it. Never throws / blocks.
function dispatch(event, data) {
  if (!subs.length) return;
  const body = JSON.stringify({ event, data, ts: Date.now() });
  for (const s of subs) {
    if (!s.events.includes(event)) continue;
    const headers = { 'content-type': 'application/json', 'x-robinfun-event': event };
    if (s.secret) headers['x-robinfun-signature'] = 'sha256=' + crypto.createHmac('sha256', s.secret).update(body).digest('hex');
    try { fetch(s.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) }).catch(() => {}); } catch (_) {}
  }
}

load();
module.exports = { list, register, remove, dispatch, VALID_EVENTS };
