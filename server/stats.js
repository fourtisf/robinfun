'use strict';
/*
 * Famspad board-stats indexer.
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
const EventEmitter = require('events');
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
const MAX_TOKENS   = Math.max(1, Number(process.env.STATS_MAX_TOKENS || 1000));
const BACKFILL_CAP = Math.max(50000, Number(process.env.STATS_BACKFILL_BLOCKS || 2000000));   // only when a token's start block can't be found
// History is scanned newest → oldest, this many shared getLogs windows per
// cycle, so a months-long backfill never stalls the live (incremental) scan.
const HIST_CHUNKS  = Math.max(1, Number(process.env.STATS_HIST_CHUNKS || 12));
const CHECKPOINT_V = 2;   // bump to force a full re-index (v1 only looked back BACKFILL_CAP blocks)
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
const idx = { ethUsd: 0, ethUsdAt: 0, blockTime: 0, blockTimeAt: 0, head: 0, updatedAt: 0, logChunk: 0, perToken: {} };
let _getTokens = () => [];
let _onEvent = () => {};   // (eventName, data) — e.g. webhook dispatcher
// Real-time event bus: the realtime feed (SSE/WS) subscribes here so on-chain
// trades + graduations reach connected partners the instant they're indexed.
// Kept separate from _onEvent (webhooks) so each can fail independently.
const bus = new EventEmitter();
bus.setMaxListeners(0);
function emitEvent(ev, data) {
  try { _onEvent(ev, data); } catch (_) {}
  try { bus.emit(ev, data); } catch (_) {}
}
// Bus-only emit (does NOT hit the webhook dispatcher). Used for 'trade', which
// the real-time feed wants but webhooks do not — routing it through emitEvent
// would make webhooks.dispatch JSON.stringify + discard every trade needlessly.
function emitBus(ev, data) { try { bus.emit(ev, data); } catch (_) {} }
// Tokens whose live feed is "warm": we push real-time 'trade' events only AFTER
// a token has completed one indexed cycle in THIS process. This Set is memory-only
// (never checkpointed), so on restart it starts empty — the first post-restart
// cycle, which catches up the entire downtime gap, is treated as catch-up and is
// NOT flooded to subscribers. Steady-state cycles (small ranges) emit normally.
const _liveReady = new Set();

function loadCheckpoint() {
  try {
    const j = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (j) { idx.ethUsd = j.ethUsd || 0; idx.blockTime = j.blockTime || 0; idx.logChunk = j.v === CHECKPOINT_V ? (j.logChunk || 0) : 0; }
    // Older checkpoints only covered the last BACKFILL_CAP blocks of history —
    // drop them so every token is re-indexed from its launch block.
    if (j && j.perToken && j.v === CHECKPOINT_V) idx.perToken = j.perToken;
  } catch (_) {}
}
let _saveTimer = null;
function saveCheckpoint() {
  if (_saveTimer) return;                       // debounce: at most one write per 5s
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
      fs.writeFileSync(STATS_FILE, JSON.stringify({ v: CHECKPOINT_V, logChunk: idx.logChunk || 0, ethUsd: idx.ethUsd, blockTime: idx.blockTime, updatedAt: idx.updatedAt, perToken: idx.perToken }));
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

// ---- batched log scanning -------------------------------------------------
// One eth_getLogs covers MANY curves (address list) — the whole board's
// history is a few dozen requests instead of per-token × per-window storms
// that trip the public RPC's rate limit.
const CURVE_IFACE = new ethers.Interface(CURVE_ABI);
const PAIR_IFACE = new ethers.Interface(PAIR_ABI);
const T_BUY = CURVE_IFACE.getEvent('Buy').topicHash;
const T_SELL = CURVE_IFACE.getEvent('Sell').topicHash;
const T_SWAP = PAIR_IFACE.getEvent('Swap').topicHash;
const ADDR_BATCH = 100;
const errText = (e) => String((e && e.error && e.error.message) || (e && e.shortMessage) || (e && e.message) || '').toLowerCase();
const isRateErr = (e) => /rate|429|too many requests|capacity|throttl|timeout|econnreset|socket/.test(errText(e));
const isRangeErr = (e) => !isRateErr(e) && /range|limit|exceed|too many|too large|response size|10000|query returned more/.test(errText(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// getLogs with backoff on rate limits; range errors are rethrown for the caller to split.
async function getLogsRetry(address, topics, fromBlock, toBlock) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { return await prov().getLogs({ address, topics, fromBlock, toBlock }); }
    catch (e) { last = e; if (isRangeErr(e)) throw e; await sleep(400 * 2 ** attempt); }
  }
  throw last;
}

// All Buy/Sell (curves) and Swap (pairs) logs for these addresses in [from,to].
// Narrows the window on range errors (and remembers the size that worked).
async function batchLogs(curves, pairs, from, to) {
  const out = [];
  const jobs = [];
  for (let i = 0; i < curves.length; i += ADDR_BATCH) jobs.push([curves.slice(i, i + ADDR_BATCH), [[T_BUY, T_SELL]]]);
  for (let i = 0; i < pairs.length; i += ADDR_BATCH) jobs.push([pairs.slice(i, i + ADDR_BATCH), [[T_SWAP]]]);
  for (const [addrs, topics] of jobs) {
    try { out.push(...await getLogsRetry(addrs, topics, from, to)); }
    catch (e) {
      if (!isRangeErr(e) || to - from < 1000) throw e;
      idx.logChunk = Math.max(1000, Math.floor((to - from + 1) / 2));
      const mid = Math.floor((from + to) / 2);
      out.push(...await batchLogs(topics[0][0] === T_SWAP ? [] : addrs, topics[0][0] === T_SWAP ? addrs : [], from, mid));
      out.push(...await batchLogs(topics[0][0] === T_SWAP ? [] : addrs, topics[0][0] === T_SWAP ? addrs : [], mid + 1, to));
    }
  }
  return out;
}

// Decode a curve Buy/Sell or pair Swap log into the indexer's trade shape.
function decodeTrade(log, s) {
  if (log.topics[0] === T_SWAP) {
    const a = PAIR_IFACE.parseLog(log).args;
    const tokenIs0 = s.tok0 === s.ca;
    const a0i = Number(ethers.formatUnits(a.amount0In, 18)), a1i = Number(ethers.formatUnits(a.amount1In, 18));
    const a0o = Number(ethers.formatUnits(a.amount0Out, 18)), a1o = Number(ethers.formatUnits(a.amount1Out, 18));
    const tokIn = tokenIs0 ? a0i : a1i, tokOut = tokenIs0 ? a0o : a1o;
    const ethIn = tokenIs0 ? a1i : a0i, ethOut = tokenIs0 ? a1o : a0o;
    const buy = tokOut > 0;                       // tokens leaving the pool = a buy
    const eth = buy ? ethIn : ethOut, tok = buy ? tokOut : tokIn;
    return { block: log.blockNumber, li: log.index, eth, priceEth: tok > 0 ? eth / tok : 0, buy };
  }
  const ev = CURVE_IFACE.parseLog(log);
  const a = ev.args;
  const vE = Number(ethers.formatEther(a.virtualEthReserve)), vT = Number(ethers.formatUnits(a.virtualTokenReserve, 18));
  // rE/rT = post-trade virtual reserves (curve liquidity for aggregator feeds);
  // li = on-chain log index → stable swap ids.
  const buy = ev.name === 'Buy';
  return { block: log.blockNumber, li: log.index, eth: Number(ethers.formatEther(buy ? a.grossEth : a.netEth)), priceEth: vT > 0 ? vE / vT : 0, buy, rE: vE, rT: vT };
}

// Book trades onto a token: volume, 24h window, trade list, live feed.
function recordTrades(rec, s, events, backfilling, head, nowSec, live) {
  const bt = idx.blockTime || 0.5;
  if (!s.trades) s.trades = [];
  events.sort((x, y) => x.block - y.block || x.li - y.li);
  for (const e of events) {
    // incremental trades = now (accurate); history = estimated from block time
    const ts = backfilling ? Math.max(0, nowSec - (head - e.block) * bt) : nowSec;
    s.volAllEth += e.eth;
    s.recent.push([Math.round(ts), e.eth]);
    s.trades.push({ t: Math.round(ts), blk: e.block, li: (e.li == null ? 0 : e.li), pe: e.priceEth || 0, e: e.eth, b: !!e.buy, rE: e.rE || 0, rT: e.rT || 0 });
    // Live feed: only steady-state trades of a token that was already warm when
    // this cycle began — never history, never the post-restart catch-up.
    if (!backfilling && live) {
      const pe = e.priceEth || 0;
      const usd = idx.ethUsd > 0;   // null (not 0) when the ETH/USD rate isn't known yet
      emitBus('trade', {
        chainId: CHAIN_ID, address: rec.ca || s.ca, symbol: rec.ticker || null, name: rec.name || null,
        side: e.buy ? 'buy' : 'sell', priceEth: pe, priceUsd: usd ? pe * idx.ethUsd : null,
        volumeEth: e.eth || 0, volumeUsd: usd ? (e.eth || 0) * idx.ethUsd : null,
        block: e.block, txnId: `${e.block}-${(e.li == null ? 0 : e.li)}`, ts: Math.round(ts) * 1000,
      });
    }
  }
}

function addrMap(entries) {
  const m = new Map();
  for (const en of entries) {
    m.set(en.s.curve.toLowerCase(), en);
    if (en.s.pair) m.set(en.s.pair.toLowerCase(), en);
  }
  return m;
}

// Forward pass: every token's blocks after its lastBlock, in shared windows.
async function forwardPass(entries, head, nowSec, liveBefore) {
  let from = Infinity;
  for (const en of entries) if (en.s.lastBlock < head) from = Math.min(from, en.s.lastBlock + 1);
  if (!Number.isFinite(from)) return;
  const chunk = idx.logChunk || 2000000;
  for (let a = from; a <= head; a += chunk) {
    const b = Math.min(head, a + chunk - 1);
    const part = entries.filter((en) => en.s.lastBlock < b);
    if (!part.length) continue;
    const logs = await batchLogs(part.map((en) => en.s.curve), part.filter((en) => en.s.pair).map((en) => en.s.pair), a, b);
    const byAddr = addrMap(part), got = new Map();
    for (const log of logs) {
      const en = byAddr.get(String(log.address).toLowerCase());
      if (!en || log.blockNumber <= en.s.lastBlock) continue;   // already counted
      try { (got.get(en) || got.set(en, []).get(en)).push(decodeTrade(log, en.s)); } catch (_) {}
    }
    for (const en of part) {
      recordTrades(en.rec, en.s, got.get(en) || [], false, head, nowSec, liveBefore.has(en.s.ca));
      en.s.lastBlock = b;
    }
    saveCheckpoint();
  }
}

// History pass: from each token's launch block up to where indexing began,
// newest → oldest, HIST_CHUNKS shared windows per cycle.
async function historyPass(entries, head, nowSec) {
  for (let n = 0; n < HIST_CHUNKS; n++) {
    const open = entries.filter((en) => en.s.histHi != null && en.s.histHi >= en.s.histLo);
    if (!open.length) return;
    const top = Math.max(...open.map((en) => en.s.histHi));
    const lo = Math.max(0, top - (idx.logChunk || 2000000) + 1);
    const part = open.filter((en) => en.s.histHi >= lo);
    const floor = Math.max(lo, Math.min(...part.map((en) => en.s.histLo)));
    const logs = await batchLogs(part.map((en) => en.s.curve), part.filter((en) => en.s.pair).map((en) => en.s.pair), floor, top);
    const byAddr = addrMap(part), got = new Map();
    for (const log of logs) {
      const en = byAddr.get(String(log.address).toLowerCase());
      if (!en || log.blockNumber < en.s.histLo || log.blockNumber > en.s.histHi) continue;   // outside its unscanned range
      try { (got.get(en) || got.set(en, []).get(en)).push(decodeTrade(log, en.s)); } catch (_) {}
    }
    for (const en of part) {
      recordTrades(en.rec, en.s, got.get(en) || [], true, head, nowSec, false);
      en.s.histHi = Math.max(en.s.histLo - 1, lo - 1);   // [lo, old histHi] is done
    }
    saveCheckpoint();
  }
}

// Bound per-token memory: trades (~14 days / 1500) and the 24h window.
function pruneToken(s, nowSec) {
  if (s.trades) {
    s.trades.sort((a, b) => a.t - b.t);
    const tradeCutoff = nowSec - 14 * 86400;
    if (s.trades.length > 1500 || (s.trades.length && s.trades[0].t < tradeCutoff)) s.trades = s.trades.filter((x) => x.t >= tradeCutoff).slice(-1500);
  }
  const cutoff = nowSec - 93600;   // keep ~26h of margin
  if (s.recent && s.recent.length) s.recent = s.recent.filter((r) => r[0] >= cutoff);
}

// First block worth scanning for a token: its launch block (recorded by
// chainsync from TokenCreated), else the curve's deploy block found by binary
// search on eth_getCode. Returns null when neither is available yet — e.g. a
// non-archive RPC can't answer historical getCode — so the caller can wait for
// chainsync instead of settling for a short window.
async function startBlockFor(rec, s, head) {
  const known = Number(rec.createdBlock);
  if (Number.isFinite(known) && known > 0 && known <= head) return known;
  try {
    let lo = 0, hi = head;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await prov().getCode(s.curve, mid)) === '0x') lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && lo <= head) return lo;
  } catch (_) {}
  return null;
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
  // Legacy-factory tokens aren't known to the current factory's curveOf — use
  // the curve recorded from their TokenCreated event (see chainsync.js).
  if (!s.curve && /^0x[0-9a-fA-F]{40}$/.test(String(rec.curve || ''))) s.curve = rec.curve;
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
    if (!wasGrad && s.graduated && !s._gradFired) { s._gradFired = true; emitEvent('token.graduated', { chainId: CHAIN_ID, address: rec.ca || ca, symbol: rec.ticker, name: rec.name, status: 'listed', graduated: true, priceUsd: s.priceUsd || null, marketCapUsd: s.mcapUsd || null }); }
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

  // Scan ranges (the scanning itself happens in forwardPass / historyPass):
  //   forward — blocks after lastBlock (live trades, stamped "now")
  //   history — [histLo, histHi]: launch block up to where indexing began
  // Neither ever re-scans a block, so nothing is double counted.
  if (!s.lastBlock) {
    let start = await startBlockFor(rec, s, head);
    if (start == null) {
      // Give chainsync a few cycles to record the launch block before falling
      // back to the last BACKFILL_CAP blocks (the extension below still widens
      // the history later if the launch block turns up).
      s.startTries = (s.startTries || 0) + 1;
      if (s.startTries < 6) return;
      start = Math.max(0, head - BACKFILL_CAP);
    }
    s.histLo = start;
    s.histHi = head;
    s.lastBlock = head;
  }
  // Launch block learned after indexing began (or indexing started from the
  // fallback window): extend the history pass back to it.
  const born = Number(rec.createdBlock);
  if (Number.isFinite(born) && born > 0 && s.histLo != null && born < s.histLo) {
    if (s.histHi < s.histLo) s.histHi = s.histLo - 1;   // history was finished — resume below it
    s.histLo = born;
  }
}

async function cycle() {
  try {
    const [head, usd] = await Promise.all([prov().getBlockNumber(), refreshEthUsd()]);
    idx.head = head;
    await refreshBlockTime(head);
    const nowSec = Math.floor(Date.now() / 1000);

    // newest first: the store is append-only, so the most recent launches are at the end
    const tokens = (_getTokens() || []).filter((t) => t && t.ca).slice(-MAX_TOKENS);
    await mapLimit(tokens, CONCURRENCY, (rec) => indexToken(rec, head, nowSec));   // prices, earnings, ranges

    const entries = [];
    for (const rec of tokens) {
      const s = idx.perToken[String(rec.ca).toLowerCase()];
      if (s && s.curve && s.lastBlock) entries.push({ rec, s });
    }
    // Tokens warm before this cycle may emit live trades; the rest are catching up.
    const liveBefore = new Set(_liveReady);
    try { await forwardPass(entries, head, nowSec, liveBefore); } catch (e) { console.error('[stats] forward scan:', errText(e).slice(0, 160)); }
    try { await historyPass(entries, head, nowSec); } catch (e) { console.error('[stats] history scan:', errText(e).slice(0, 160)); }
    for (const en of entries) { _liveReady.add(en.s.ca); pruneToken(en.s, nowSec); }

    idx.updatedAt = Date.now();
    saveCheckpoint();
  } catch (e) { console.error('[stats] cycle:', errText(e).slice(0, 160)); }
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

module.exports = { startIndexer, getStats, getTrades, getOHLC, latestBlock, tokenState, eventsInRange, bus };
