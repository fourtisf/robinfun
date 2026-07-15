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
const NATIVE_ID = 'ETH';             // aggregator asset id for the chain's gas token (ETH)
const NATIVE_SYMBOL = 'ETH';

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
    docs: `${apiBase}/docs`,
    openapi: `${apiBase}/openapi.json`,
    endpoints: {
      tokens: `${apiBase}/tokens?limit=100&offset=0&status=all|bonding|listed`,
      token: `${apiBase}/tokens/{contractAddress}`,
      trades: `${apiBase}/tokens/{contractAddress}/trades?limit=100`,
      ohlc: `${apiBase}/tokens/{contractAddress}/ohlc?resolution=1h&limit=200`,
      stats: `${apiBase}/stats`,
      aggregator: {
        latestBlock: `${apiBase}/dex/latest-block`,
        asset: `${apiBase}/dex/asset?id={tokenAddress}`,
        pair: `${apiBase}/dex/pair?id={pairAddress}`,
        events: `${apiBase}/dex/events?fromBlock=&toBlock=`,
      },
    },
    notes: 'Read-only. CORS open. Data refreshes continuously from chain. Field names are stable within v1. Webhooks (token.created / token.graduated) available to partners on request.',
  };
}

// Parse a resolution string (1m/5m/15m/1h/4h/1d) to seconds. Default 1h.
function resolutionToSec(s) {
  const m = String(s || '1h').trim().toLowerCase().match(/^(\d+)\s*(m|h|d)$/);
  if (!m) return 3600;
  const n = Number(m[1]); const unit = m[2];
  return unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n * 86400;
}

// ============================================================================
// Aggregator endpoints — GeckoTerminal / DexScreener "standard" shape.
// Best-effort: our lightweight indexer stores block/price/side per trade but not
// per-swap tx hashes, makers, or pool reserves, so events use a synthetic id and
// omit maker/reserves. Enough for a tracker to build price/volume; documented in
// docs/API.md. Endpoints mounted under /api/v1/dex/*.
// ============================================================================

// GET /api/v1/dex/latest-block
function dexLatestBlock(stats) {
  const b = stats.latestBlock();
  return { block: { blockNumber: b.blockNumber || 0, blockTimestamp: b.blockTimestamp || 0 } };
}

// GET /api/v1/dex/asset?id=<tokenAddress|ETH>
function dexAsset(store, stats, id) {
  const key = String(id || '').trim();
  if (key.toUpperCase() === NATIVE_ID) {
    return { asset: { id: NATIVE_ID, name: 'Ether', symbol: NATIVE_SYMBOL, decimals: 18, totalSupply: null, circulatingSupply: null, coinGeckoId: 'ethereum' } };
  }
  const rec = store.allTokens().find((r) => r.ca && r.ca.toLowerCase() === key.toLowerCase());
  if (!rec) return null;
  return {
    asset: {
      id: rec.ca,
      name: rec.name || rec.ticker || '',
      symbol: rec.ticker || '',
      decimals: 18,
      totalSupply: TOTAL_SUPPLY,
      circulatingSupply: TOTAL_SUPPLY,
      coinGeckoId: null,
      metadata: { logoURI: absLogo(rec.logo) },
    },
  };
}

// Find the token whose curve/pair/ca matches an id (pair ids are the curve while
// bonding, the Uniswap pair once listed). Returns { rec, s } or null.
function findByPairId(store, st, id) {
  const key = String(id || '').toLowerCase();
  for (const r of store.allTokens()) {
    if (!r.ca) continue;
    const s = st.perToken[r.ca.toLowerCase()] || null;
    if (r.ca.toLowerCase() === key) return { rec: r, s };
    if (s && ((s.pair && s.pair.toLowerCase() === key) || (s.curve && s.curve.toLowerCase() === key))) return { rec: r, s };
  }
  return null;
}

// GET /api/v1/dex/pair?id=<pairAddress|curveAddress|tokenAddress>
function dexPair(store, stats, id) {
  const st = stats.getStats();
  const hit = findByPairId(store, st, id);
  if (!hit) return null;
  const { rec, s } = hit;
  const pairId = (s && (s.pair || s.curve)) || rec.ca;
  return {
    pair: {
      id: pairId,
      dexKey: s && s.graduated ? 'uniswap-v2' : 'robinfun-curve',
      asset0Id: rec.ca,
      asset1Id: NATIVE_ID,
      createdAtBlockNumber: null,
      createdAtBlockTimestamp: rec.createdAt ? Math.floor(rec.createdAt / 1000) : null,
      createdAtTxnId: null,
      feeBps: Math.round((Number(rec.buyFee) || 0) * 100),
      metadata: { name: rec.name || rec.ticker || '', symbol: rec.ticker || '', logoURI: absLogo(rec.logo) },
    },
  };
}

// GET /api/v1/dex/events?fromBlock=&toBlock=  (swap events across all tokens)
function dexEvents(store, stats, fromBlock, toBlock, limit) {
  const st = stats.getStats();
  const rows = stats.eventsInRange(fromBlock, toBlock, limit);
  // token ca -> pair id, cached per call
  const pairOf = {};
  const events = rows.map((x, i) => {
    const ca = x.address;
    if (!(ca in pairOf)) { const s = st.perToken[ca]; pairOf[ca] = (s && (s.pair || s.curve)) || ca; }
    const buy = x.eventType === 'buy';
    return {
      block: { blockNumber: x.block, blockTimestamp: x.ts },
      eventType: 'swap',
      txnId: `${x.block}-${i}`,          // synthetic (no per-swap tx hash indexed)
      txnIndex: i,
      eventIndex: i,
      maker: null,
      pairId: pairOf[ca],
      // Buy = ETH in / token out; Sell = token in / ETH out. amount1 is the ETH side.
      amount1: buy ? -x.amountEth : x.amountEth,   // sign: + into pool, - out of pool
      amountNative: x.amountEth,
      priceNative: x.priceNative,
      priceUsd: x.priceUsd,
      volumeUsd: x.amountUsd,
      side: x.eventType,
      reserves: null,
    };
  });
  return { events };
}

// ============================================================================
// OpenAPI 3.0 spec + interactive docs page (Swagger UI).
// ============================================================================

// GET /api/v1/openapi.json
function openapi(apiBase) {
  const base = apiBase || `${SITE}/api/v1`;
  const CA = { name: 'contractAddress', in: 'path', required: true, schema: { type: 'string' }, description: 'Token contract address (0x…)' };
  const ok = (ref) => ({ '200': { description: 'OK', content: { 'application/json': { schema: ref } } } });
  const okAnd404 = (ref) => ({ ...ok(ref), '404': { description: 'Token not found' } });
  return {
    openapi: '3.0.3',
    info: {
      title: 'Robinfun Public API',
      version: '1.0.0',
      description: 'Read-only market data for memecoins launched on Robinfun (Robinhood Chain, chainId 4663). Use it to auto-list tokens, power aggregators/trackers, or feed wallets and bots. No auth, CORS open, cached ~15s.',
      contact: { name: 'Robinfun', url: SITE },
    },
    servers: [{ url: base, description: 'Robinfun API v1' }],
    tags: [
      { name: 'Discovery' }, { name: 'Tokens' }, { name: 'Market' }, { name: 'Platform' }, { name: 'Aggregator' },
    ],
    paths: {
      '/': { get: { tags: ['Discovery'], summary: 'API index', operationId: 'getIndex', responses: ok({ type: 'object' }) } },
      '/stats': { get: { tags: ['Platform'], summary: 'Platform aggregates', operationId: 'getStats', responses: ok({ $ref: '#/components/schemas/PlatformStats' }) } },
      '/tokens': {
        get: {
          tags: ['Tokens'], summary: 'List tokens (newest first)', operationId: 'listTokens',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 500 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['all', 'bonding', 'listed'], default: 'all' }, description: 'bonding = on the curve · listed = on Uniswap' },
          ],
          responses: ok({ $ref: '#/components/schemas/TokenList' }),
        },
      },
      '/tokens/{contractAddress}': { get: { tags: ['Tokens'], summary: 'One token', operationId: 'getToken', parameters: [CA], responses: okAnd404({ $ref: '#/components/schemas/Token' }) } },
      '/tokens/{contractAddress}/trades': {
        get: {
          tags: ['Market'], summary: 'Recent trades (newest first)', operationId: 'getTrades',
          parameters: [CA, { name: 'limit', in: 'query', schema: { type: 'integer', default: 100, maximum: 1000 } }],
          responses: okAnd404({ $ref: '#/components/schemas/TradeList' }),
        },
      },
      '/tokens/{contractAddress}/ohlc': {
        get: {
          tags: ['Market'], summary: 'OHLC price candles', operationId: 'getOHLC',
          parameters: [CA,
            { name: 'resolution', in: 'query', schema: { type: 'string', enum: ['1m', '5m', '15m', '1h', '4h', '1d'], default: '1h' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 1000 } }],
          responses: okAnd404({ $ref: '#/components/schemas/CandleList' }),
        },
      },
      '/dex/latest-block': { get: { tags: ['Aggregator'], summary: 'Latest indexed block', operationId: 'dexLatestBlock', responses: ok({ type: 'object' }) } },
      '/dex/asset': { get: { tags: ['Aggregator'], summary: 'Asset (token) by id', operationId: 'dexAsset', parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' }, description: 'Token address, or "ETH" for the native asset' }], responses: okAnd404({ type: 'object' }) } },
      '/dex/pair': { get: { tags: ['Aggregator'], summary: 'Pair by id', operationId: 'dexPair', parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' }, description: 'Pair/curve/token address' }], responses: okAnd404({ type: 'object' }) } },
      '/dex/events': { get: { tags: ['Aggregator'], summary: 'Swap events in a block range', operationId: 'dexEvents', parameters: [{ name: 'fromBlock', in: 'query', schema: { type: 'integer' } }, { name: 'toBlock', in: 'query', schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 1000, maximum: 5000 } }], responses: ok({ type: 'object' }) } },
    },
    components: {
      schemas: {
        Token: {
          type: 'object',
          properties: {
            chainId: { type: 'integer', example: CHAIN_ID },
            chain: { type: 'string', example: 'robinhood' },
            address: { type: 'string', nullable: true },
            name: { type: 'string', nullable: true },
            symbol: { type: 'string', nullable: true },
            decimals: { type: 'integer', example: 18 },
            totalSupply: { type: 'string', example: TOTAL_SUPPLY },
            logoURI: { type: 'string', nullable: true },
            description: { type: 'string' },
            links: { type: 'object', properties: { website: { type: 'string', nullable: true }, twitter: { type: 'string', nullable: true }, telegram: { type: 'string', nullable: true } } },
            creator: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['bonding', 'listed'] },
            graduated: { type: 'boolean' },
            priceUsd: { type: 'number', nullable: true },
            marketCapUsd: { type: 'number', nullable: true },
            volume: { type: 'object', properties: { h24Usd: { type: 'number', nullable: true }, totalUsd: { type: 'number', nullable: true } } },
            fees: { type: 'object', properties: { buyPercent: { type: 'number' }, sellPercent: { type: 'number' } } },
            creatorFeesEarnedEth: { type: 'number', nullable: true },
            curveAddress: { type: 'string', nullable: true },
            pairAddress: { type: 'string', nullable: true },
            createdAt: { type: 'integer', nullable: true },
            urls: { type: 'object', properties: { robinfun: { type: 'string' }, explorer: { type: 'string', nullable: true }, api: { type: 'string', nullable: true } } },
          },
        },
        TokenList: {
          type: 'object',
          properties: {
            chainId: { type: 'integer' }, updatedAt: { type: 'integer' }, ethUsd: { type: 'number' },
            count: { type: 'integer' }, total: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' },
            tokens: { type: 'array', items: { $ref: '#/components/schemas/Token' } },
          },
        },
        Trade: {
          type: 'object',
          properties: {
            ts: { type: 'integer', description: 'ms epoch' }, side: { type: 'string', enum: ['buy', 'sell'] },
            priceUsd: { type: 'number' }, priceEth: { type: 'number' }, volumeUsd: { type: 'number' }, volumeEth: { type: 'number' },
          },
        },
        TradeList: { type: 'object', properties: { chainId: { type: 'integer' }, address: { type: 'string' }, symbol: { type: 'string' }, trades: { type: 'array', items: { $ref: '#/components/schemas/Trade' } } } },
        Candle: { type: 'object', properties: { time: { type: 'integer', description: 'unix seconds (bucket start)' }, open: { type: 'number' }, high: { type: 'number' }, low: { type: 'number' }, close: { type: 'number' }, volumeUsd: { type: 'number' } } },
        CandleList: { type: 'object', properties: { chainId: { type: 'integer' }, address: { type: 'string' }, symbol: { type: 'string' }, resolutionSec: { type: 'integer' }, quote: { type: 'string' }, candles: { type: 'array', items: { $ref: '#/components/schemas/Candle' } } } },
        PlatformStats: {
          type: 'object',
          properties: {
            chainId: { type: 'integer' }, chain: { type: 'string' }, updatedAt: { type: 'integer' }, ethUsd: { type: 'number' },
            tokensTracked: { type: 'integer' }, volume24hUsd: { type: 'number' }, volumeTotalUsd: { type: 'number' }, paidToCreatorsUsd: { type: 'number' },
          },
        },
      },
    },
  };
}

// GET /api/v1/docs — interactive Swagger UI page, restyled to Robinfun's
// dark volt-lime brand (Space Grotesk / IBM Plex Mono). Loads Swagger UI from
// CDN; this is a real website page (not a sandboxed artifact), so that's fine.
function docsHtml(apiBase) {
  const specUrl = `${apiBase}/openapi.json`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Robinfun API — Docs</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='46' fill='%23C6F23C'/%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Instrument+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
<style>
  :root{
    --bg:#080B0A; --panel:#0F140F; --raise:#161C13; --rule:#1C231A; --rule2:#29321F;
    --ink:#F2F5EA; --dim:#9AA18F; --mute:#5F6653; --lime:#C6F23C; --lime2:#D8FB5C;
    --lime-dim:rgba(198,242,60,.12); --red:#FF5B4A;
    --fdisplay:"Space Grotesk",system-ui,sans-serif; --fbody:"Instrument Sans",system-ui,sans-serif; --fmono:"IBM Plex Mono",ui-monospace,monospace;
  }
  html,body{background:var(--bg);}
  body{margin:0;font-family:var(--fbody);}
  body::after{content:"";position:fixed;left:50%;top:-340px;transform:translateX(-50%);width:1100px;height:620px;pointer-events:none;z-index:0;background:radial-gradient(closest-side,rgba(198,242,60,.10),rgba(198,242,60,.03) 55%,transparent 75%);filter:blur(8px);}
  .swagger-ui .topbar{display:none;}
  /* ---- brand header ---- */
  .rf-head{position:relative;z-index:2;font-family:var(--fdisplay);color:var(--ink);max-width:1100px;margin:0 auto;padding:30px 24px 6px;}
  .rf-head .rf-brand{display:flex;align-items:center;gap:11px;font-size:23px;font-weight:700;letter-spacing:-.02em;}
  .rf-head .rf-dot{width:15px;height:15px;border-radius:99px;background:var(--lime);box-shadow:0 0 16px rgba(198,242,60,.6);}
  .rf-head .rf-sub{font-family:var(--fbody);color:var(--dim);font-size:14px;margin-top:7px;}
  .rf-head .rf-sub a{color:var(--lime);text-decoration:none;font-weight:600;}
  .rf-head .rf-sub a:hover{color:var(--lime2);}
  .rf-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}
  .rf-pills span{font-family:var(--fmono);font-size:11px;letter-spacing:.04em;color:var(--dim);background:var(--panel);border:1px solid var(--rule2);border-radius:99px;padding:5px 11px;}
  .rf-pills span b{color:var(--lime);font-weight:600;}
  /* ---- swagger base ---- */
  .swagger-ui{font-family:var(--fbody);position:relative;z-index:1;}
  .swagger-ui .wrapper{max-width:1100px;}
  .swagger-ui, .swagger-ui .info li, .swagger-ui .info p, .swagger-ui .info table,
  .swagger-ui .opblock-description-wrapper p, .swagger-ui .opblock-external-docs-wrapper p,
  .swagger-ui .opblock-title_normal p, .swagger-ui label, .swagger-ui .tab li,
  .swagger-ui .parameter__name, .swagger-ui .parameter__type, .swagger-ui table thead tr td,
  .swagger-ui table thead tr th, .swagger-ui .response-col_status, .swagger-ui .response-col_links,
  .swagger-ui .col_header, .swagger-ui .parameter__in, .swagger-ui .responses-inner h4,
  .swagger-ui .responses-inner h5, .swagger-ui .model-title{color:var(--ink);}
  .swagger-ui .info .title{color:var(--ink);font-family:var(--fdisplay);font-weight:700;}
  .swagger-ui .info .title small{background:var(--rule2);}
  .swagger-ui .info .title small.version-stamp{background:var(--lime);}
  .swagger-ui .info a, .swagger-ui a.nostyle, .swagger-ui .info a:visited{color:var(--lime);}
  .swagger-ui .info .base-url, .swagger-ui .info .description, .swagger-ui .info p{color:var(--dim);}
  /* server select */
  .swagger-ui .scheme-container{background:var(--panel);box-shadow:none;border:1px solid var(--rule);border-radius:14px;margin:0 auto 24px;max-width:1052px;}
  .swagger-ui .scheme-container .schemes-title, .swagger-ui select{color:var(--ink);}
  .swagger-ui select{background:var(--raise);border:1px solid var(--rule2);border-radius:8px;box-shadow:none;}
  /* tag groups */
  .swagger-ui .opblock-tag{color:var(--ink);font-family:var(--fdisplay);border-bottom:1px solid var(--rule);}
  .swagger-ui .opblock-tag:hover{background:rgba(198,242,60,.03);}
  .swagger-ui .opblock-tag small{color:var(--mute);}
  /* operation blocks */
  .swagger-ui .opblock{background:var(--panel);border:1px solid var(--rule);border-radius:12px;box-shadow:none;margin:0 0 12px;}
  .swagger-ui .opblock .opblock-summary{border-color:var(--rule);}
  .swagger-ui .opblock .opblock-summary-path, .swagger-ui .opblock .opblock-summary-path__deprecated,
  .swagger-ui .opblock .opblock-summary-description{color:var(--ink);font-family:var(--fmono);}
  .swagger-ui .opblock .opblock-summary-method{border-radius:7px;font-family:var(--fmono);text-shadow:none;}
  .swagger-ui .opblock.opblock-get{background:rgba(198,242,60,.04);border-color:var(--rule2);}
  .swagger-ui .opblock.opblock-get .opblock-summary-method{background:var(--lime);color:#0B0F04;}
  .swagger-ui .opblock.opblock-get .opblock-summary{border-color:rgba(198,242,60,.25);}
  .swagger-ui .opblock.opblock-post{background:rgba(198,242,60,.04);border-color:var(--rule2);}
  .swagger-ui .opblock.opblock-post .opblock-summary-method{background:var(--lime2);color:#0B0F04;}
  .swagger-ui .opblock.opblock-delete .opblock-summary-method{background:var(--red);color:#1a0400;}
  /* body / tables / params */
  .swagger-ui .opblock-body, .swagger-ui .opblock-section-header{background:var(--bg);box-shadow:none;}
  .swagger-ui .opblock-section-header{border-radius:8px;border:1px solid var(--rule);}
  .swagger-ui table.parameters, .swagger-ui .parameters-col_description{color:var(--ink);}
  .swagger-ui .parameters-col_description input[type=text]{background:var(--raise);border:1px solid var(--rule2);color:var(--ink);border-radius:8px;}
  .swagger-ui .parameter__name.required::after{color:var(--red);}
  .swagger-ui .btn{border:1px solid var(--rule2);color:var(--ink);border-radius:8px;box-shadow:none;background:var(--raise);}
  .swagger-ui .btn.execute{background:var(--lime);border-color:var(--lime);color:#0B0F04;font-family:var(--fdisplay);font-weight:600;}
  .swagger-ui .btn.execute:hover{background:var(--lime2);}
  .swagger-ui .btn.try-out__btn{background:transparent;color:var(--lime);border-color:var(--rule2);}
  .swagger-ui .btn.cancel{color:var(--red);border-color:var(--red);}
  /* responses / code */
  .swagger-ui .responses-inner{background:var(--bg);}
  .swagger-ui table.responses-table td{color:var(--ink);}
  .swagger-ui .response-col_description__inner div.renderedMarkdown p{color:var(--dim);}
  .swagger-ui .microlight, .swagger-ui .highlight-code, .swagger-ui .curl-command,
  .swagger-ui textarea, .swagger-ui .body-param__text{background:#05070500!important;}
  .swagger-ui .highlight-code, .swagger-ui .responses-inner pre, .swagger-ui .curl{background:#050706;border:1px solid var(--rule);border-radius:8px;}
  .swagger-ui .microlight code, .swagger-ui pre, .swagger-ui code{font-family:var(--fmono);color:#d7e6c4;}
  /* models */
  .swagger-ui section.models{border:1px solid var(--rule);background:var(--panel);border-radius:12px;}
  .swagger-ui section.models.is-open h4{border-color:var(--rule);color:var(--ink);}
  .swagger-ui .model-box{background:var(--raise);border-radius:8px;}
  .swagger-ui .model, .swagger-ui .model .property, .swagger-ui .prop-type{color:var(--dim);}
  .swagger-ui .prop-type{color:var(--lime);}
  .swagger-ui .model-toggle::after{filter:invert(1);}
  /* misc arrows, dividers */
  .swagger-ui .expand-operation svg, .swagger-ui .opblock-summary-control svg{fill:var(--dim);}
  .swagger-ui .opblock-tag-section h3, .swagger-ui hgroup.main a{color:var(--ink);}
  .swagger-ui .info__contact a{color:var(--lime);}
  .swagger-ui .parameter__enum, .swagger-ui .renderedMarkdown code{background:var(--lime-dim);color:var(--lime2);font-family:var(--fmono);border-radius:4px;}
  ::selection{background:rgba(198,242,60,.30);color:#0B0F04;}
</style>
</head>
<body>
<div class="rf-head">
  <div class="rf-brand"><span class="rf-dot"></span> Robinfun Public API</div>
  <div class="rf-sub">Read-only market data for tokens launched on Robinhood Chain — auto-list, aggregators, wallets &amp; bots. · <a href="${SITE}">robinfun.io</a> · <a href="${specUrl}">openapi.json</a></div>
  <div class="rf-pills"><span>Chain <b>Robinhood · 4663</b></span><span>Auth <b>none</b></span><span>CORS <b>open</b></span><span>Cache <b>~15s</b></span></div>
</div>
<div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
<script>
  window.addEventListener('load', function () {
    window.ui = SwaggerUIBundle({ url: ${JSON.stringify(specUrl)}, dom_id: '#swagger', deepLinking: true, docExpansion: 'list', defaultModelsExpandDepth: 0, tryItOutEnabled: true, syntaxHighlight: { theme: 'obsidian' } });
  });
</script>
</body>
</html>`;
}

module.exports = {
  toPublic, listTokens, getToken, tokenTrades, tokenOHLC, platformStats, index, resolutionToSec,
  dexLatestBlock, dexAsset, dexPair, dexEvents, openapi, docsHtml,
};
