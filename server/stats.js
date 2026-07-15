'use strict';
/*
 * Robinfun board-stats indexer.
 *
 * Computes the homepage aggregates — 24h volume, all-time volume, paid-to-creators
 * and every token's live market cap — ONCE, server-side, on a continuous loop, so
 * browsers fetch ready numbers (GET /api/stats) instead of each one reading the
 * chain on every page load (which took ~a minute over a batchMaxCount:1 RPC).
 *
 * It is INCREMENTAL: after a one-time backward backfill per token, every cycle only
 * scans the handful of new blocks since the last one ("dihitung dari last, jalan
 * terus"). State is checkpointed to a JSON file so a restart resumes, never
 * recomputes from scratch.
 */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC          = (process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com').trim();
const CHAIN_ID     = Number(process.env.CHAIN_ID || 4663);
const FACTORY      = (process.env.FACTORY_ADDR || '0xf0a093bc6ab5bb408ca1f084ec2161d879edaa57').trim();
const FEEROUTER    = (process.env.FEE_ROUTER || '0x10343c9f38ca2a4f543318e378f84c58a4bd10d1').trim();
const DEX_FACTORY  = (process.env.DEX_FACTORY || '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f').trim();
const WETH         = (process.env.WETH || '0x0bd7d308f8e1639fab988df18a8011f41eacad73').trim();
const SUPPLY       = 1e9;
const STATS_FILE   = process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json');
const CYCLE_MS     = Math.max(8000, Number(process.env.STATS_CYCLE_MS || 20000));
const MAX_TOKENS   = Math.max(1, Number(process.env.STATS_MAX_TOKENS || 120));
const BACKFILL_CAP = Math.max(50000, Number(process.env.STATS_BACKFILL_BLOCKS || 2000000));
const CONCURRENCY  = Math.max(1, Number(process.env.STATS_CONCURRENCY || 6));

const CURVE_ABI = [
  'function virtualEthReserve() view returns (uint256)',
  'function virtualTokenReserve() view returns (uint256)',
  'function graduated() view returns (bool)',
  'event Buy(address indexed trader, address indexed recipient, uint256 grossEth, uint256 curveFeeEth, uint256 levyEth, uint256 netEth, uint256 tokensOut, uint256 virtualEthReserve, uint256 virtualTokenReserve)',
  'event Sell(address indexed trader, uint256 tokensIn, uint256 grossEth, uint256 curveFeeEth, uint256 levyEth, uint256 netEth, uint256 virtualEthReserve, uint256 virtualTokenReserve)',
];
const FACTORY_ABI   = ['function curveOf(address) view returns (address)'];
const FEEROUTER_ABI = ['function creatorEarnedLifetime(address) view returns (uint256)'];
const DEXFACTORY_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = [
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112,uint112,uint32)',
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
];

let _p = null;
function prov() {
  if (!_p) {
    // Pin the network (chainId 4663) so the provider never does an eth_chainId
    // detection round-trip that can fail on a cold/slow RPC and stall startup.
    const net = new ethers.Network('Robinhood Chain', CHAIN_ID);
    _p = new ethers.JsonRpcProvider(RPC, net, { batchMaxCount: 1, staticNetwork: net });
  }
  return _p;
}

// In-memory index. perToken[caLower] = {
//   ca, curve, pair, tok0, lastBlock, volAllEth, recent:[[tsSec,eth]],
//   mcapUsd, priceUsd, earnedEth, graduated, logChunk }
const idx = { ethUsd: 0, ethUsdAt: 0, blockTime: 0, blockTimeAt: 0, head: 0, updatedAt: 0, perToken: {} };
let _getTokens = () => [];
let _onEvent = () => {};   // (eventName, data) — e.g. webhook dispatcher
function emitEvent(ev, data) { try { _onEvent(ev, data); } catch (_) {} }

function loadCheckpoint() {
  try {
    const j = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (j && j.perToken) { idx.perToken = j.perToken; idx.ethUsd = j.ethUsd || 0; idx.blockTime = j.blockTime || 0; }
  } catch (_) {}
}
let _saveTimer = null;
function saveCheckpoint() {
  if (_saveTimer) return;                       // debounce: at most one write per 5s
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      fs.writeFileSync(STATS_FILE, JSON.stringify({ ethUsd: idx.ethUsd, blockTime: idx.blockTime, updatedAt: idx.updatedAt, perToken: idx.perToken }));
    } catch (_) {}
  }, 5000);
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (_) {} } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

async function refreshEthUsd() {
  if (Date.now() - idx.ethUsdAt < 300000 && idx.ethUsd > 0) return idx.ethUsd;   // 5-min cache
  const urls = [
    'https://api.coinbase.com/v2/prices/ETH-USD/spot',
    'https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD',
  ];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const px = Number(j?.data?.amount ?? j?.USD);
      if (px > 0) { idx.ethUsd = px; idx.ethUsdAt = Date.now(); return px; }
    } catch (_) {}
  }
  return idx.ethUsd;   // keep last known
}

// Estimate seconds-per-block so backfilled trades get an approximate timestamp
// (new trades are stamped with wall-clock time as they're seen, which is exact).
async function refreshBlockTime(head) {
  if (Date.now() - idx.blockTimeAt < 600000 && idx.blockTime > 0) return idx.blockTime;
  try {
    const back = Math.max(1, head - 50000);
    const [a, b] = await Promise.all([prov().getBlock(head), prov().getBlock(back)]);
    if (a && b && a.number > b.number) {
      const bt = (Number(a.timestamp) - Number(b.timestamp)) / (a.number - b.number);
      if (bt > 0 && bt < 60) { idx.blockTime = bt; idx.blockTimeAt = Date.now(); }
    }
  } catch (_) {}
  return idx.blockTime || 0.5;   // conservative default
}

// Probe the widest eth_getLogs window this RPC accepts (cached per token).
async function probeChunk(contract, filter, head) {
  for (const c of [90000, 45000, 18000, 7000, 2500, 800]) {
    try { await contract.queryFilter(filter, Math.max(0, head - c), head); return c; } catch (_) {}
  }
  return 0;
}

// Scan curve Buy+Sell across [lo,hi] (chunked). Returns { events:[{block,eth}], reserves|null }.
async function scanCurve(curve, lo, hi, chunk) {
  const events = [];
  let reserves = null;
  for (let from = lo; from <= hi; from += chunk + 1) {
    const to = Math.min(hi, from + chunk);
    let buys = [], sells = [];
    try { [buys, sells] = await Promise.all([
      curve.queryFilter(curve.filters.Buy(), from, to),
      curve.queryFilter(curve.filters.Sell(), from, to),
    ]); } catch (_) { continue; }
    // rE/rT = post-trade virtual reserves — carried through so the aggregator can
    // report curve LIQUIDITY to DexScreener/GeckoTerminal (they read reserves off
    // swap events; without this every curve token shows Liquidity $0 even after we
    // submit the feed). li = on-chain log index → stable swap ids (no dedup double-count).
    for (const e of buys)  { const a = e.args; const vE = Number(ethers.formatEther(a.virtualEthReserve)), vT = Number(ethers.formatUnits(a.virtualTokenReserve, 18)); events.push({ block: e.blockNumber, li: e.index, eth: Number(ethers.formatEther(a.grossEth)), priceEth: vT > 0 ? vE / vT : 0, buy: true, rE: vE, rT: vT }); }
    for (const e of sells) { const a = e.args; const vE = Number(ethers.formatEther(a.virtualEthReserve)), vT = Number(ethers.formatUnits(a.virtualTokenReserve, 18)); events.push({ block: e.blockNumber, li: e.index, eth: Number(ethers.formatEther(a.netEth)), priceEth: vT > 0 ? vE / vT : 0, buy: false, rE: vE, rT: vT }); }
  }
  return events;
}

async function scanDex(pair, tok0, ca, lo, hi, chunk) {
  const events = [];
  const tokenIs0 = tok0 === ca.toLowerCase();
  for (let from = lo; from <= hi; from += chunk + 1) {
    const to = Math.min(hi, from + chunk);
    let sw = [];
    try { sw = await pair.queryFilter(pair.filters.Swap(), from, to); } catch (_) { continue; }
    for (const e of sw) {
      const a = e.args;
      const a0i = Number(ethers.formatUnits(a.amount0In, 18)), a1i = Number(ethers.formatUnits(a.amount1In, 18));
      const a0o = Number(ethers.formatUnits(a.amount0Out, 18)), a1o = Number(ethers.formatUnits(a.amount1Out, 18));
      const tokIn = tokenIs0 ? a0i : a1i, tokOut = tokenIs0 ? a0o : a1o;
      const ethIn = tokenIs0 ? a1i : a0i, ethOut = tokenIs0 ? a1o : a0o;
      const buy = tokOut > 0;                       // tokens leaving the pool = a buy
      const eth = buy ? ethIn : ethOut;
      const tok = buy ? tokOut : tokIn;
      events.push({ block: e.blockNumber, li: e.index, eth, priceEth: tok > 0 ? eth / tok : 0, buy });
    }
  }
  return events;
}

async function indexToken(rec, head, nowSec) {
  const ca = String(rec.ca || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca)) return;
  let s = idx.perToken[ca];
  if (!s) { s = idx.perToken[ca] = { ca, curve: '', pair: '', tok0: '', lastBlock: 0, volAllEth: 0, recent: [], mcapUsd: 0, priceUsd: 0, earnedEth: 0, graduated: false, logChunk: 0 }; }

  // Resolve the curve once.
  if (!s.curve) {
    try { const c = await new ethers.Contract(FACTORY, FACTORY_ABI, prov()).curveOf(ca); if (c && c !== ethers.ZeroAddress) s.curve = c; } catch (_) {}
  }
  if (!s.curve) return;
  const curve = new ethers.Contract(s.curve, CURVE_ABI, prov());

  // Live mcap + graduation (cheap; 3 reads).
  let hadReserves = false;
  try {
    const [vE, vT, grad] = await Promise.all([curve.virtualEthReserve(), curve.virtualTokenReserve(), curve.graduated()]);
    const vEth = Number(ethers.formatEther(vE)), vTok = Number(ethers.formatUnits(vT, 18));
    const priceEth = vTok > 0 ? vEth / vTok : 0;
    s.priceUsd = priceEth * idx.ethUsd;
    s.mcapUsd = priceEth * SUPPLY * idx.ethUsd;
    const wasGrad = s.graduated;
    s.graduated = !!grad;
    // Fire a one-time webhook event when a token graduates (curve → Uniswap).
    if (!wasGrad && s.graduated && !s._gradFired) { s._gradFired = true; emitEvent('token.graduated', { address: rec.ca || ca, symbol: rec.ticker, name: rec.name, marketCapUsd: s.mcapUsd }); }
    hadReserves = true;
  } catch (_) {}

  // Creator earnings (lifetime).
  try { const v = Number(ethers.formatEther(await new ethers.Contract(FEEROUTER, FEEROUTER_ABI, prov()).creatorEarnedLifetime(ca))); if (v >= 0) s.earnedEth = v; } catch (_) {}

  // DEX pair (once graduated).
  if (s.graduated && !s.pair) {
    try {
      const p = await new ethers.Contract(DEX_FACTORY, DEXFACTORY_ABI, prov()).getPair(ca, WETH);
      if (p && p !== ethers.ZeroAddress) { s.pair = p; s.tok0 = (await new ethers.Contract(p, PAIR_ABI, prov()).token0()).toLowerCase(); }
    } catch (_) {}
  }

  // For a GRADUATED token the curve reserves are frozen at the graduation point,
  // so the price above is stale — the real market cap now lives in the Uniswap
  // pool and MUST come from its reserves (else every graduated token shows the
  // same frozen graduation mcap even after its DEX price has moved/crashed).
  if (s.graduated && s.pair) {
    try {
      const [r, tokenIs0] = [await new ethers.Contract(s.pair, PAIR_ABI, prov()).getReserves(), s.tok0 === ca];
      const tokRes = Number(ethers.formatUnits(tokenIs0 ? r[0] : r[1], 18));
      const ethRes = Number(ethers.formatEther(tokenIs0 ? r[1] : r[0]));
      if (tokRes > 0) { const px = ethRes / tokRes; s.priceUsd = px * idx.ethUsd; s.mcapUsd = px * SUPPLY * idx.ethUsd; }
    } catch (_) {}
  }

  if (!s.logChunk) s.logChunk = await probeChunk(curve, curve.filters.Buy(), head);
  const chunk = s.logChunk || 2500;

  // Determine the scan range: backfill on first sight, else incremental from the
  // block AFTER the last one scanned. Never re-scan lastBlock (that would double
  // count any trade in it). If no new blocks, there's nothing to scan.
  const backfilling = !s.lastBlock;
  const lo = backfilling ? Math.max(0, head - BACKFILL_CAP) : s.lastBlock + 1;
  const hi = head;
  if (lo > hi) return;   // no new blocks since last cycle

  const fresh = [];
  const cur = await scanCurve(curve, lo, hi, chunk);
  fresh.push(...cur);
  if (s.pair) fresh.push(...await scanDex(new ethers.Contract(s.pair, PAIR_ABI, prov()), s.tok0, ca, lo, hi, chunk));

  // Stamp timestamps: incremental trades = now (accurate); backfill = estimated.
  const bt = idx.blockTime || 0.5;
  if (!s.trades) s.trades = [];
  for (const e of fresh) {
    const ts = backfilling ? Math.max(0, nowSec - (head - e.block) * bt) : nowSec;
    s.volAllEth += e.eth;
    s.recent.push([Math.round(ts), e.eth]);
    // Full trade row for the /trades + /ohlc + aggregator API: ts, block, log
    // index (li → stable swap ids), price (ETH), eth volume, side, and post-trade
    // reserves (rE/rT → curve liquidity for the DEX aggregator feed).
    s.trades.push({ t: Math.round(ts), blk: e.block, li: (e.li == null ? 0 : e.li), pe: e.priceEth || 0, e: e.eth, b: !!e.buy, rE: e.rE || 0, rT: e.rT || 0 });
  }
  // keep trades sorted by time and bounded (memory) — last ~1500 or ~14 days
  s.trades.sort((a, b) => a.t - b.t);
  const tradeCutoff = nowSec - 14 * 86400;
  if (s.trades.length > 1500 || (s.trades.length && s.trades[0].t < tradeCutoff)) {
    s.trades = s.trades.filter((x) => x.t >= tradeCutoff).slice(-1500);
  }
  s.lastBlock = hi;

  // Prune the 24h window (keep ~26h of margin) to bound memory.
  const cutoff = nowSec - 93600;
  if (s.recent.length > 4000 || (s.recent.length && s.recent[0][0] < cutoff)) {
    s.recent = s.recent.filter((r) => r[0] >= cutoff);
  }
}

async function cycle() {
  try {
    const [head, usd] = await Promise.all([prov().getBlockNumber(), refreshEthUsd()]);
    idx.head = head;
    await refreshBlockTime(head);
    const nowSec = Math.floor(Date.now() / 1000);

    const tokens = (_getTokens() || []).filter((t) => t && t.ca).slice(0, MAX_TOKENS);
    await mapLimit(tokens, CONCURRENCY, (rec) => indexToken(rec, head, nowSec));

    idx.updatedAt = Date.now();
    saveCheckpoint();
  } catch (_) {}
}

function startIndexer(getTokens, onEvent) {
  if (typeof getTokens === 'function') _getTokens = getTokens;
  if (typeof onEvent === 'function') _onEvent = onEvent;
  loadCheckpoint();
  (async function loop() {
    for (;;) {
      await cycle();
      await new Promise((r) => setTimeout(r, CYCLE_MS));
    }
  })().catch(() => {});
}

// Build the public snapshot the API serves.
function getStats() {
  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - 86400;
  const perToken = {};
  let vol24 = 0, volAll = 0, paid = 0;
  for (const ca of Object.keys(idx.perToken)) {
    const s = idx.perToken[ca];
    const v24Eth = (s.recent || []).reduce((a, r) => a + (r[0] >= cutoff ? r[1] : 0), 0);
    const v24Usd = v24Eth * idx.ethUsd;
    const vAllUsd = (s.volAllEth || 0) * idx.ethUsd;
    const earnedUsd = (s.earnedEth || 0) * idx.ethUsd;
    perToken[ca] = {
      mcapUsd: s.mcapUsd || 0, priceUsd: s.priceUsd || 0,
      vol24Usd: v24Usd, volAllUsd: vAllUsd, earnedUsd,
      earnedEth: s.earnedEth || 0, graduated: !!s.graduated,
      curve: s.curve || null, pair: s.pair || null,   // exposed for the public API
    };
    vol24 += v24Usd; volAll += vAllUsd; paid += earnedUsd;
  }
  return {
    updatedAt: idx.updatedAt, ethUsd: idx.ethUsd, head: idx.head,
    totals: { vol24Usd: vol24, volAllUsd: volAll, paidUsd: paid, tokens: Object.keys(perToken).length },
    perToken,
  };
}

// Recent trades for one token (newest first). [{ ts, priceUsd, priceEth, volumeUsd, volumeEth, side }].
function getTrades(ca, limit = 100) {
  const s = idx.perToken[String(ca || '').toLowerCase()];
  if (!s || !s.trades) return [];
  const lim = Math.min(1000, Math.max(1, Number(limit) || 100));
  return s.trades.slice(-lim).reverse().map((x) => ({
    ts: x.t * 1000,
    priceUsd: (x.pe || 0) * idx.ethUsd,
    priceEth: x.pe || 0,
    volumeUsd: (x.e || 0) * idx.ethUsd,
    volumeEth: x.e || 0,
    side: x.b ? 'buy' : 'sell',
  }));
}

// OHLC candles for one token, built from indexed trades. resolutionSec is the
// bucket size (e.g. 3600 = 1h). Returns [{ time, open, high, low, close, volumeUsd }]
// with `time` a unix-seconds bucket start; prices are USD.
function getOHLC(ca, resolutionSec = 3600, limit = 200) {
  const s = idx.perToken[String(ca || '').toLowerCase()];
  if (!s || !s.trades || !s.trades.length) return [];
  const res = Math.max(60, Number(resolutionSec) || 3600);
  const buckets = new Map();
  for (const x of s.trades) {
    const px = (x.pe || 0) * idx.ethUsd;
    if (!(px > 0)) continue;
    const b = Math.floor(x.t / res) * res;
    let c = buckets.get(b);
    if (!c) { c = { time: b, open: px, high: px, low: px, close: px, volumeUsd: 0 }; buckets.set(b, c); }
    c.high = Math.max(c.high, px); c.low = Math.min(c.low, px); c.close = px;
    c.volumeUsd += (x.e || 0) * idx.ethUsd;
  }
  const lim = Math.min(1000, Math.max(1, Number(limit) || 200));
  return [...buckets.values()].sort((a, b) => a.time - b.time).slice(-lim);
}

// ---- aggregator (GeckoTerminal/DexScreener-style) accessors ----
function latestBlock() {
  return { blockNumber: idx.head, blockTimestamp: Math.floor((idx.updatedAt || Date.now()) / 1000) };
}
function tokenState(ca) { return idx.perToken[String(ca || '').toLowerCase()] || null; }
// Swap events across ALL tokens in a block range (for aggregator /events polling).
function eventsInRange(fromBlock, toBlock, limit = 1000) {
  const from = Math.max(0, Number(fromBlock) || 0);
  const to = Number(toBlock) || idx.head;
  const out = [];
  for (const ca of Object.keys(idx.perToken)) {
    const s = idx.perToken[ca];
    if (!s.trades) continue;
    for (const x of s.trades) {
      if (x.blk >= from && x.blk <= to) {
        out.push({
          address: ca, block: x.blk, ts: x.t, logIndex: (x.li == null ? 0 : x.li),
          priceNative: x.pe || 0, priceUsd: (x.pe || 0) * idx.ethUsd,
          amountEth: x.e || 0, amountUsd: (x.e || 0) * idx.ethUsd,
          eventType: x.b ? 'buy' : 'sell',
          reserveEth: x.rE || 0, reserveTok: x.rT || 0,
        });
      }
    }
  }
  out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return out.slice(0, Math.min(5000, Math.max(1, Number(limit) || 1000)));
}

module.exports = { startIndexer, getStats, getTrades, getOHLC, latestBlock, tokenState, eventsInRange };
