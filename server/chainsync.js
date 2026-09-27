'use strict';
/**
 * Chain sync — fills the board from the chain itself.
 *
 * Every token launched through the Famspad factories (current + legacy) emits
 * TokenCreated. This module scans those events and registers any token the
 * metadata store doesn't know yet, so a fresh server (or one whose metadata
 * POST was lost) still shows every real token on Robinhood Chain — the stats
 * indexer then fills in live price / mcap / volume for them.
 *
 * Chain-only records have no logo or socials (metadataURI is empty on-chain);
 * the site renders its monogram fallback. Webhooks are NOT fired for backfilled
 * tokens (they are not new launches).
 *
 * Env: CHAINSYNC=off to disable · FACTORY_ADDRS=0x..,0x.. · SYNC_FROM_BLOCK=n ·
 *      CHAINSYNC_MS (poll interval, default 60s)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ethers } = require('ethers');

const RPC = (process.env.RPC || process.env.CHAIN_RPC || 'https://rpc.mainnet.chain.robinhood.com').trim();
const CHAIN_ID = Number(process.env.CHAIN_ID || 4663);
const FACTORIES = (process.env.FACTORY_ADDRS ||
  '0xf0a093bc6ab5bb408ca1f084ec2161d879edaa57,0xfa5c740aec9d91cebdc9844e5ca6591f309a5dd2')   // mainnet v3, legacy
  .split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s));
const POLL_MS = Math.max(15000, Number(process.env.CHAINSYNC_MS || 60000));

const IFACE = new ethers.Interface([
  'event TokenCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint16 buyLevyBps, uint16 sellLevyBps, bool decayAtGraduation, bool renounceRateControl, uint256 deployFee, uint256 devBuyEth)',
]);
const TOPIC = IFACE.getEvent('TokenCreated').topicHash;

let _p = null;
function prov() {
  if (!_p) {
    const net = new ethers.Network('Robinhood Chain', CHAIN_ID);
    _p = new ethers.JsonRpcProvider(RPC, net, { batchMaxCount: 1, staticNetwork: net });
  }
  return _p;
}

let stateFile = '';
let state = { lastBlock: {}, chunk: 0 };
function loadState() {
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch (_) {}
  state.lastBlock = state.lastBlock || {};
}
function saveState() {
  try { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state)); fs.renameSync(stateFile + '.tmp', stateFile); } catch (_) {}
}

// First block where the factory has code (binary search) — avoids scanning
// the whole chain from genesis. Falls back to SYNC_FROM_BLOCK / 0 if the RPC
// can't serve historical eth_getCode.
async function deployBlock(addr, head) {
  if (process.env.SYNC_FROM_BLOCK) return Number(process.env.SYNC_FROM_BLOCK) || 0;
  try {
    if ((await prov().getCode(addr, head)) === '0x') return head;   // not deployed
    let lo = 0, hi = head;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await prov().getCode(addr, mid)) === '0x') lo = mid + 1; else hi = mid;
    }
    return lo;
  } catch (_) { return 0; }
}

// eth_getLogs with an adaptive window: start wide, halve on RPC range errors,
// remember the size that worked.
async function getLogsRange(addr, from, to) {
  const out = [];
  let chunk = state.chunk || 500000;
  let a = from;
  while (a <= to) {
    const b = Math.min(to, a + chunk - 1);
    try {
      const logs = await prov().getLogs({ address: addr, topics: [TOPIC], fromBlock: a, toBlock: b });
      out.push(...logs);
      a = b + 1;
      state.chunk = chunk;
    } catch (e) {
      if (chunk <= 500) throw e;
      chunk = Math.floor(chunk / 4);
    }
  }
  return out;
}

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);

async function syncFactory(store, addr, head) {
  const from = state.lastBlock[addr] != null ? state.lastBlock[addr] + 1 : await deployBlock(addr, head);
  if (from > head) return 0;
  const logs = await getLogsRange(addr, from, head);
  const known = new Set(store.allTokens().map((t) => String(t.ca || '').toLowerCase()).filter(Boolean));
  const tsCache = new Map();
  let added = 0;
  for (const log of logs) {
    let ev;
    try { ev = IFACE.parseLog(log); } catch (_) { continue; }
    const ca = String(ev.args.token).toLowerCase();
    if (known.has(ca)) continue;
    const ticker = clean(ev.args.symbol, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const name = clean(ev.args.name, 64);
    if (!name || !ticker) continue;
    let ts = tsCache.get(log.blockNumber);
    if (ts == null) {
      try { ts = Number((await prov().getBlock(log.blockNumber)).timestamp) * 1000; } catch (_) { ts = Date.now(); }
      tsCache.set(log.blockNumber, ts);
    }
    await store.addToken({
      id: crypto.randomBytes(8).toString('hex'),
      name, ticker,
      ca: ethers.getAddress(ca),
      curve: ethers.getAddress(String(ev.args.curve)),
      description: '',
      website: '', x: '', tg: '',
      buyFee: Number(ev.args.buyLevyBps) / 100,
      sellFee: Number(ev.args.sellLevyBps) / 100,
      decay: !!ev.args.decayAtGraduation,
      renounce: !!ev.args.renounceRateControl,
      creator: ethers.getAddress(String(ev.args.creator)),
      logo: null,
      createdAt: ts,
      source: 'chain',
    });
    known.add(ca);
    added++;
  }
  state.lastBlock[addr] = head;
  saveState();
  return added;
}

async function cycle(store) {
  const head = await prov().getBlockNumber();
  let total = 0;
  for (const fa of FACTORIES) {
    try { total += await syncFactory(store, fa, head); }
    catch (e) { console.error(`[chainsync] ${fa}: ${e && e.message}`); }
  }
  if (total) console.log(`[chainsync] added ${total} on-chain token(s) — board now ${store.countTokens()}`);
}

function start(store, dataDir) {
  if (/^(0|off|false|no)$/i.test(process.env.CHAINSYNC || '')) return false;
  stateFile = path.join(dataDir, 'chainsync.json');
  loadState();
  (async function loop() {
    for (;;) {
      try { await cycle(store); } catch (e) { console.error('[chainsync]', e && e.message); }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  })().catch(() => {});
  return true;
}

module.exports = { start, _internal: { IFACE, TOPIC, syncFactory, getLogsRange, deployBlock, state: () => state, setProvider: (p) => { _p = p; } } };
