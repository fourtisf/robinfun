'use strict';
/*
 * Robinfun Public API v1 — read-only token data for partners & integrations
 * (auto-listing, aggregators, wallets, trackers). Merges off-chain metadata
 * (name/symbol/logo/links) with the continuously-indexed on-chain market data
 * (price, market cap, volume, status) into one clean, stable JSON shape.
 *
 * See docs/API.md for the contract. Keep field names STABLE — partners depend
 * on them. Add new fields freely; never rename/remove without a v2.
 */
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const SITE = (process.env.APP_URL || 'https://robinfun.io').replace(/\/+$/, '');
const EXPLORER = (process.env.EXPLORER_URL || 'https://robinhoodchain.blockscout.com').replace(/\/+$/, '');
const TOTAL_SUPPLY = '1000000000';   // every Robinfun token: fixed 1B supply, 18 decimals

function absLogo(logo) {
  if (!logo) return null;
  return /^https?:\/\//i.test(logo) ? logo : SITE + (logo.startsWith('/') ? '' : '/') + logo;
}

// Shape one token for the public API by merging its stored record with the
// indexed market data (may be null if the indexer hasn't seen it yet).
function toPublic(rec, st, apiBase) {
  const ca = (rec.ca || '').trim();
  const s = (ca && st && st.perToken) ? st.perToken[ca.toLowerCase()] : null;
  return {
    chainId: CHAIN_ID,
    chain: 'robinhood',
    address: ca || null,
    name: rec.name || null,
    symbol: rec.ticker || null,
    decimals: 18,
    totalSupply: TOTAL_SUPPLY,
    logoURI: absLogo(rec.logo),
    description: rec.description || '',
    links: {
      website: rec.website || null,
      twitter: rec.x || null,
      telegram: rec.tg || null,
    },
    creator: rec.creator || null,
    status: s ? (s.graduated ? 'listed' : 'bonding') : 'bonding',   // bonding = on curve, listed = on Uniswap
    graduated: s ? !!s.graduated : false,
    priceUsd: s ? s.priceUsd : null,
    marketCapUsd: s ? s.mcapUsd : null,
    volume: {
      h24Usd: s ? s.vol24Usd : null,
      totalUsd: s ? s.volAllUsd : null,
    },
    fees: { buyPercent: Number(rec.buyFee) || 0, sellPercent: Number(rec.sellFee) || 0 },
    creatorFeesEarnedEth: s ? s.earnedEth : null,
    curveAddress: s ? (s.curve || null) : null,
    pairAddress: s ? (s.pair || null) : null,           // Uniswap V2 pair (once listed)
    createdAt: rec.createdAt || null,
    urls: {
      robinfun: ca ? `${SITE}/token/${ca}` : SITE,
      explorer: ca ? `${EXPLORER}/token/${ca}` : null,
      api: (ca && apiBase) ? `${apiBase}/tokens/${ca}` : null,
    },
  };
}

// GET /api/v1/tokens — paginated list. opts: { limit, offset, status }.
function listTokens(store, stats, apiBase, opts = {}) {
  const st = stats.getStats();
  const grad = (r) => !!(r.ca && st.perToken[r.ca.toLowerCase()] && st.perToken[r.ca.toLowerCase()].graduated);
  let recs = store.allTokens().slice().reverse();   // newest first
  if (opts.status === 'listed') recs = recs.filter(grad);
  else if (opts.status === 'bonding') recs = recs.filter((r) => !grad(r));
  const total = recs.length;
  const off = Math.max(0, Number(opts.offset) || 0);
  const lim = Math.min(500, Math.max(1, Number(opts.limit) || 100));
  const tokens = recs.slice(off, off + lim).map((r) => toPublic(r, st, apiBase));
  return { chainId: CHAIN_ID, updatedAt: st.updatedAt, ethUsd: st.ethUsd, count: tokens.length, total, offset: off, limit: lim, tokens };
}

// GET /api/v1/tokens/:ca — one token by contract address. Null if not found.
function getToken(store, stats, apiBase, ca) {
  const key = String(ca || '').toLowerCase();
  const rec = store.allTokens().find((r) => r.ca && r.ca.toLowerCase() === key);
  if (!rec) return null;
  return toPublic(rec, stats.getStats(), apiBase);
}

// GET /api/v1/tokens/:ca/trades — recent trades for a token. Null if not found.
function tokenTrades(store, stats, ca, limit) {
  const key = String(ca || '').toLowerCase();
  const rec = store.allTokens().find((r) => r.ca && r.ca.toLowerCase() === key);
  if (!rec) return null;
  return { chainId: CHAIN_ID, address: rec.ca, symbol: rec.ticker, trades: stats.getTrades(rec.ca, limit) };
}

// GET /api/v1/tokens/:ca/ohlc — OHLC candles for a token. Null if not found.
function tokenOHLC(store, stats, ca, resolutionSec, limit) {
  const key = String(ca || '').toLowerCase();
  const rec = store.allTokens().find((r) => r.ca && r.ca.toLowerCase() === key);
  if (!rec) return null;
  return { chainId: CHAIN_ID, address: rec.ca, symbol: rec.ticker, resolutionSec, quote: 'USD', candles: stats.getOHLC(rec.ca, resolutionSec, limit) };
}

// GET /api/v1/stats — platform-wide aggregates.
function platformStats(stats) {
  const st = stats.getStats();
  return {
    chainId: CHAIN_ID,
    chain: 'robinhood',
    updatedAt: st.updatedAt,
    ethUsd: st.ethUsd,
    tokensTracked: st.totals.tokens,
    volume24hUsd: st.totals.vol24Usd,
    volumeTotalUsd: st.totals.volAllUsd,
    paidToCreatorsUsd: st.totals.paidUsd,
  };
}

// GET /api/v1 — self-describing index so integrators can discover endpoints.
function index(apiBase) {
  return {
    name: 'Robinfun Public API',
    version: '1',
    chain: 'Robinhood Chain', chainId: CHAIN_ID,
    docs: `${SITE}/api-docs`,
    endpoints: {
      tokens: `${apiBase}/tokens?limit=100&offset=0&status=all|bonding|listed`,
      token: `${apiBase}/tokens/{contractAddress}`,
      trades: `${apiBase}/tokens/{contractAddress}/trades?limit=100`,
      ohlc: `${apiBase}/tokens/{contractAddress}/ohlc?resolution=1h&limit=200`,
      stats: `${apiBase}/stats`,
    },
    notes: 'Read-only. CORS open. Data refreshes continuously from chain. Field names are stable within v1.',
  };
}

// Parse a resolution string (1m/5m/15m/1h/4h/1d) to seconds. Default 1h.
function resolutionToSec(s) {
  const m = String(s || '1h').trim().toLowerCase().match(/^(\d+)\s*(m|h|d)$/);
  if (!m) return 3600;
  const n = Number(m[1]); const unit = m[2];
  return unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n * 86400;
}

module.exports = { toPublic, listTokens, getToken, tokenTrades, tokenOHLC, platformStats, index, resolutionToSec };
