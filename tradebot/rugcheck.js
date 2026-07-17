'use strict';
/*
 * RugCheck — pre-trade safety for SOLANA SPL tokens (GoPlus doesn't cover Solana).
 * Mirrors goplus.js's interface (supported / tokenSecurity / verdict) so it's a
 * drop-in behind safety.js: mint & freeze authority, LP locked/burned, top-holder
 * concentration, "rugged" flag, plus RugCheck's own scored risk list.
 *
 * Free, no API key. Best-effort: returns null on a non-Solana chain, a bad mint, or
 * any network error, so callers degrade gracefully instead of blocking a trade.
 *
 * API: GET https://api.rugcheck.xyz/v1/tokens/{mint}/report
 */
const RUG_BASE = (process.env.RUGCHECK_BASE || 'https://api.rugcheck.xyz/v1').replace(/\/+$/, '');
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;   // base58, no 0/O/I/l

function supported(chainKey) { return chainKey === 'solana'; }
const numOr = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const has = (v) => v != null && v !== '' && v !== '11111111111111111111111111111111';   // system program = "revoked/none"

// Short-TTL cache + in-flight de-dup (the snipe/copy loops re-check the same fresh
// token every few seconds). A good result is cached briefly; a miss is cached shorter
// so an interactive re-scan retries quickly. Never throws.
const _cache = new Map();       // mint -> { at, val }
const _inflight = new Map();
const OK_TTL = Math.max(0, Number(process.env.RUGCHECK_TTL_MS || 60000));
const ERR_TTL = Math.max(0, Number(process.env.RUGCHECK_ERR_TTL_MS || 8000));
const CACHE_MAX = 5000;

async function tokenSecurity(chainKey, mint) {
  if (chainKey !== 'solana') return null;
  mint = String(mint || '').trim();
  if (!B58.test(mint)) return null;
  const now = Date.now();
  const hit = _cache.get(mint);
  if (hit && (now - hit.at) < (hit.val ? OK_TTL : ERR_TTL)) return hit.val;
  if (_inflight.has(mint)) return _inflight.get(mint);
  const pr = (async () => {
    const val = await _fetchReport(mint);   // never throws
    if (_cache.size >= CACHE_MAX) { const first = _cache.keys().next().value; _cache.delete(first); }
    _cache.set(mint, { at: Date.now(), val });
    return val;
  })().finally(() => _inflight.delete(mint));
  _inflight.set(mint, pr);
  return pr;
}

async function _fetchReport(mint) {
  let d;
  try {
    const r = await fetch(`${RUG_BASE}/tokens/${mint}/report`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    d = await r.json();
  } catch (_) { return null; }
  if (!d || typeof d !== 'object') return null;
  const tok = d.token || {};
  const mintAuth = has(d.mintAuthority) || has(tok.mintAuthority);
  const freezeAuth = has(d.freezeAuthority) || has(tok.freezeAuthority);
  // LP locked/burned %: max across markets (a token can have several pools).
  let lpLockedPct = null;
  for (const m of (Array.isArray(d.markets) ? d.markets : [])) {
    const p = numOr(m && m.lp && m.lp.lpLockedPct);
    if (p != null) lpLockedPct = Math.max(lpLockedPct == null ? 0 : lpLockedPct, p);
  }
  // Holder concentration: largest single holder + top-10 sum, excluding entries RugCheck
  // marks as the LP/pool itself (`insider` is a separate signal we surface too).
  const holders = Array.isArray(d.topHolders) ? d.topHolders : [];
  let topHolderPct = null, top10Pct = null, insiderPct = 0;
  if (holders.length) {
    const pcts = holders.map((h) => numOr(h && h.pct)).filter((x) => x != null);
    if (pcts.length) { topHolderPct = Math.max(...pcts); top10Pct = pcts.slice(0, 10).reduce((a, b) => a + b, 0); }
    for (const h of holders) { if (h && h.insider) insiderPct += (numOr(h.pct) || 0); }
  }
  const risks = (Array.isArray(d.risks) ? d.risks : []).map((r) => ({
    name: String((r && r.name) || '').slice(0, 60),
    level: (r && r.level) === 'danger' ? 'danger' : 'warn',
    description: String((r && r.description) || '').slice(0, 120),
    score: numOr(r && r.score),
  }));
  return {
    name: tok.name || d.tokenMeta && d.tokenMeta.name || null,
    symbol: tok.symbol || d.tokenMeta && d.tokenMeta.symbol || null,
    mintAuthorityEnabled: mintAuth,
    freezeAuthorityEnabled: freezeAuth,
    rugged: d.rugged === true,
    topHolderPct, top10Pct, insiderPct: insiderPct || null,
    lpLockedPct,
    totalHolders: numOr(d.totalHolders),
    liquidityUsd: numOr(d.totalMarketLiquidity),
    score: numOr(d.score),
    scoreNorm: numOr(d.score_normalised),
    risks,
    raw: d,
  };
}

// Turn the normalized fields into a verdict: 'danger' | 'warn' | 'ok' plus the specific
// flags that drove it (deduped, capped). Same shape goplus.verdict returns.
function verdict(s) {
  const red = [], warn = [];
  const addRed = (m) => { if (m && !red.includes(m)) red.push(m); };
  const addWarn = (m) => { if (m && !warn.includes(m)) warn.push(m); };
  if (s.rugged) addRed('flagged as rugged');
  if (s.freezeAuthorityEnabled) addRed('freeze authority active (can freeze your tokens)');
  if (s.topHolderPct != null && s.topHolderPct >= 50) addRed(`top holder owns ${s.topHolderPct.toFixed(0)}%`);
  for (const r of (s.risks || [])) { if (r.level === 'danger') addRed(r.name || 'high risk'); }
  if (s.mintAuthorityEnabled) addWarn('mint authority active (supply can grow)');
  if (s.lpLockedPct != null && s.lpLockedPct < 50) addWarn(`LP only ${s.lpLockedPct.toFixed(0)}% locked/burned`);
  if (s.topHolderPct != null && s.topHolderPct >= 20 && s.topHolderPct < 50) addWarn(`top holder ${s.topHolderPct.toFixed(0)}%`);
  if (s.top10Pct != null && s.top10Pct >= 70) addWarn(`top-10 hold ${s.top10Pct.toFixed(0)}%`);
  if (s.insiderPct != null && s.insiderPct >= 10) addWarn(`insiders ${s.insiderPct.toFixed(0)}%`);
  for (const r of (s.risks || [])) { if (r.level === 'warn') addWarn(r.name || 'risk'); }
  let level = 'ok';
  if (red.length) level = 'danger';
  else if (warn.length) level = 'warn';
  return { level, red: red.slice(0, 5), warn: warn.slice(0, 5) };
}

module.exports = { supported, tokenSecurity, verdict };
