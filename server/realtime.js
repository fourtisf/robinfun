'use strict';
/*
 * Robinfun real-time feed — pushes live market events to partners the instant
 * they happen, so integrations don't have to poll. This is the answer to the
 * common partner question "is there a WebSocket for real-time trades?".
 *
 * Two transports carry the SAME JSON messages — pick whichever your stack likes:
 *
 *   • SSE  GET  https://robinfun.io/api/v1/stream   (Server-Sent Events)
 *          Zero-dependency, works from any browser (EventSource) or Node fetch,
 *          and survives nginx without special config (we set X-Accel-Buffering:no
 *          and heartbeat < the proxy read timeout).
 *
 *   • WS   wss://robinfun.io/api/v1/ws              (WebSocket)
 *          Needs the optional `ws` package + an nginx upgrade block. If `ws`
 *          isn't installed the server still boots — SSE just carries everything.
 *
 * Message envelope (identical on both transports):
 *   { type, ts, data }
 *     type = 'hello' | 'ping' | 'trade' | 'token.created' | 'token.graduated'
 *     ts   = ms epoch
 *
 * Optional query filters (both transports):
 *   ?token=0x…                 only 'trade' messages for that contract
 *   ?types=trade,token.created only these message types (comma-separated)
 *
 * Read-only, no auth, CORS open — same trust model as the rest of /api/v1.
 *
 * Because it's public and unauthenticated, it defends itself: a global client
 * cap AND a per-IP cap bound connection count, and any client that stops draining
 * (slow-loris / abandoned socket) is dropped once its server-side buffer exceeds
 * MAX_BUFFER — no unbounded memory growth.
 */

const url = require('url');

// Optional WebSocket support. Require lazily + defensively so a box without the
// `ws` package (or before `npm install`) still boots with SSE working.
let WebSocketServer = null;
try { WebSocketServer = require('ws').WebSocketServer; } catch (_) { WebSocketServer = null; }

const MAX_CLIENTS = Math.max(50, Number(process.env.RT_MAX_CLIENTS || 2000));   // combined SSE+WS ceiling
const MAX_PER_IP = Math.max(2, Number(process.env.RT_MAX_PER_IP || 25));        // per-source-IP ceiling
const MAX_BUFFER = Math.max(64 * 1024, Number(process.env.RT_MAX_BUFFER_BYTES || 1024 * 1024)); // drop a client buffering past this
const HEARTBEAT_MS = Math.max(5000, Number(process.env.RT_HEARTBEAT_MS || 25000));
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const ALL_TYPES = ['trade', 'token.created', 'token.graduated'];

// Live client registries.
const sseClients = new Set();       // { res, token, types, ip }
let wss = null;                     // WebSocketServer (or null when `ws` absent)
const ipCounts = new Map();         // ip -> live connection count (SSE + WS combined)

function wsCount() {
  if (!wss || !wss.clients) return 0;
  try { return wss.clients.size; } catch (_) { return 0; }
}
function totalCount() { return sseClients.size + wsCount(); }
function clientCount() { return { sse: sseClients.size, ws: wsCount(), total: totalCount() }; }

// Best client IP: X-Forwarded-For's first hop (nginx sets it), else the socket.
function clientIp(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (xff) { const first = String(xff).split(',')[0].trim(); if (first) return first; }
  if (req && req.ip) return req.ip;
  if (req && req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}
function ipInc(ip) { ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1); }
function ipDec(ip) {
  const n = (ipCounts.get(ip) || 0) - 1;
  if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
}
function ipAtLimit(ip) { return (ipCounts.get(ip) || 0) >= MAX_PER_IP; }

// Parse ?token= and ?types= into a normalized filter used by both transports.
function parseFilter(query) {
  const q = query || {};
  const rawTok = String(q.token || q.address || '').trim().toLowerCase();
  const token = /^0x[0-9a-f]{40}$/.test(rawTok) ? rawTok : null;
  let types = null;
  if (q.types) {
    const wanted = String(q.types).toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    const ok = wanted.filter((t) => ALL_TYPES.includes(t));
    if (ok.length) types = new Set(ok);
  }
  return { token, types };
}

// Does a message pass a client's filter?
function passes(filter, type, data) {
  if (filter.types && !filter.types.has(type)) return false;
  if (filter.token && type === 'trade') {
    const addr = String((data && data.address) || '').toLowerCase();
    if (addr !== filter.token) return false;
  }
  return true;
}

function envelope(type, data) {
  return JSON.stringify({ type, ts: Date.now(), data: data || null });
}

// ------------------------------------------------------------------ SSE
// Express handler for GET /api/v1/stream.
function sse(req, res) {
  if (totalCount() >= MAX_CLIENTS) { res.status(503).json({ error: 'stream at capacity, retry shortly' }); return; }
  const ip = clientIp(req);
  if (ipAtLimit(ip)) { res.status(429).json({ error: 'too many connections from your address' }); return; }
  const filter = parseFilter(req.query);
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',              // tell nginx: do NOT buffer this response
      'Access-Control-Allow-Origin': '*',
    });
  } catch (_) { return; }
  if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch (_) {} }

  const client = { res, ip, ...filter };
  sseClients.add(client);
  ipInc(ip);

  // Advise the client to reconnect after 5s if the stream drops, then greet it.
  try { res.write('retry: 5000\n\n'); } catch (_) {}
  writeSseFrame(client, 'data: ' + envelope('hello', helloData(filter)) + '\n\n');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    if (sseClients.delete(client)) ipDec(ip);
    try { req.removeListener('close', cleanup); } catch (_) {}
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
  res.on('close', cleanup);
  client._cleanup = cleanup;
}

// Write a pre-serialized SSE frame, honoring backpressure: if the socket's write
// buffer grows past MAX_BUFFER (client isn't draining), drop it — a public feed
// must never buffer for a dead/slow consumer without bound.
function writeSseFrame(client, frame) {
  const res = client.res;
  try {
    res.write(frame);
    if (res.writableLength > MAX_BUFFER) dropSse(client);
  } catch (_) { dropSse(client); }
}
function dropSse(client) {
  if (client._cleanup) { try { client._cleanup(); } catch (_) {} }
  else if (sseClients.delete(client)) ipDec(client.ip);
  try { client.res.end(); } catch (_) {}
  try { client.res.destroy(); } catch (_) {}
}

// SSE heartbeat: a comment line keeps the connection alive through proxies
// WITHOUT surfacing as an onmessage event on the client.
function beatSse() {
  for (const c of sseClients) {
    try {
      c.res.write(': ping\n\n');
      if (c.res.writableLength > MAX_BUFFER) dropSse(c);
    } catch (_) { dropSse(c); }
  }
}

// ------------------------------------------------------------------ WebSocket
// Attach the WS server to the shared HTTP server. Handles only /api/v1/ws
// upgrades; every other upgrade path is closed immediately (no dangling sockets).
function attach(server) {
  if (!server) return;
  if (!WebSocketServer) {
    console.warn('[realtime] `ws` not installed — WebSocket /api/v1/ws disabled; SSE /api/v1/stream still live');
    startHeartbeat();
    return;
  }
  wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 16 });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = url.parse(req.url).pathname || ''; } catch (_) { pathname = ''; }
    // Exact match only — a bare `return` would leak the raw socket, and a prefix
    // match (/api/v1/ws/<anything>) would bypass the client cap. Close anything else.
    if (pathname !== '/api/v1/ws') { try { socket.destroy(); } catch (_) {} return; }
    const ip = clientIp(req);
    if (totalCount() >= MAX_CLIENTS || ipAtLimit(ip)) {
      try { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); } catch (_) {}
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => { ws._ip = ip; wss.emit('connection', ws, req); });
  });

  wss.on('connection', (ws, req) => {
    let query = {};
    try { query = url.parse(req.url, true).query || {}; } catch (_) { query = {}; }
    const ip = ws._ip || clientIp(req);
    ws._ip = ip;
    ipInc(ip);
    ws._rf = parseFilter(query);
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    ws.on('error', () => { try { ws.terminate(); } catch (_) {} });
    ws.on('close', () => ipDec(ip));
    // Ignore inbound messages — this is a one-way (server → client) feed.
    ws.on('message', () => {});
    try { if (ws.readyState === 1) ws.send(envelope('hello', helloData(ws._rf))); } catch (_) {}
  });

  startHeartbeat();
}

// WS heartbeat: ping every interval; terminate sockets that missed the last pong
// or that are buffering past MAX_BUFFER (a stalled/slow consumer).
function beatWs() {
  if (!wss || !wss.clients) return;
  for (const ws of wss.clients) {
    if (ws._alive === false || ws.bufferedAmount > MAX_BUFFER) { try { ws.terminate(); } catch (_) {} continue; }
    ws._alive = false;
    try { ws.ping(); } catch (_) {}
  }
}

// ------------------------------------------------------------------ broadcast
// Fan a market event out to every connected client that wants it. The payload is
// serialized ONCE and reused for every client (no per-client JSON.stringify).
function broadcast(type, data) {
  if (!sseClients.size && !wsCount()) return;
  const json = envelope(type, data);
  // SSE
  if (sseClients.size) {
    const frame = 'data: ' + json + '\n\n';
    for (const c of [...sseClients]) {      // snapshot: dropSse() mutates the Set
      if (passes(c, type, data)) writeSseFrame(c, frame);
    }
  }
  // WS
  if (wss && wss.clients && wss.clients.size) {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      if (ws.bufferedAmount > MAX_BUFFER) { try { ws.terminate(); } catch (_) {} continue; }
      if (!passes(ws._rf || {}, type, data)) continue;
      try { ws.send(json); } catch (_) {}
    }
  }
}

// Subscribe to the indexer's event bus so on-chain trades + graduations flow
// straight to connected clients. (token.created is broadcast from the API when
// a launch is registered — see server/index.js.)
function subscribe(stats) {
  if (!stats || !stats.bus || typeof stats.bus.on !== 'function') return;
  stats.bus.on('trade', (d) => broadcast('trade', d));
  stats.bus.on('token.graduated', (d) => broadcast('token.graduated', d));
}

// ------------------------------------------------------------------ internals
let _hb = null;
function startHeartbeat() {
  if (_hb) return;
  _hb = setInterval(() => { beatSse(); beatWs(); }, HEARTBEAT_MS);
  if (_hb.unref) _hb.unref();
}

function helloData(filter) {
  return {
    message: 'Robinfun real-time feed',
    chainId: CHAIN_ID,
    types: ALL_TYPES,
    filter: { token: (filter && filter.token) || null, types: (filter && filter.types) ? [...filter.types] : null },
    heartbeatMs: HEARTBEAT_MS,
  };
}

module.exports = { sse, attach, subscribe, broadcast, clientCount, wsEnabled: () => !!WebSocketServer };
