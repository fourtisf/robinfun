#!/usr/bin/env node
'use strict';
/**
 * Diagnose why the indexer finds no trades.
 *
 * Picks tokens that provably traded (creator fees > 0), then asks the RPC for
 * their curve's logs with different block-window sizes, with and without the
 * Buy/Sell topic filter, and prints which event signatures actually appear.
 *
 *   NODE_PATH=/opt/famspad/server/node_modules node diag-volume.js [DATA_DIR]
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const DATA_DIR = process.argv[2] || process.env.DATA_DIR || '/var/lib/famspad';
const RPC = (process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com').trim();
const net = new ethers.Network('Robinhood Chain', Number(process.env.CHAIN_ID || 4663));
const p = new ethers.JsonRpcProvider(RPC, net, { batchMaxCount: 1, staticNetwork: net });

const IFACE = new ethers.Interface([
  'event Buy(address indexed trader, address indexed recipient, uint256 grossEth, uint256 curveFeeEth, uint256 levyEth, uint256 netEth, uint256 tokensOut, uint256 virtualEthReserve, uint256 virtualTokenReserve)',
  'event Sell(address indexed trader, uint256 tokensIn, uint256 grossEth, uint256 curveFeeEth, uint256 levyEth, uint256 netEth, uint256 virtualEthReserve, uint256 virtualTokenReserve)',
]);
const BUY = IFACE.getEvent('Buy').topicHash, SELL = IFACE.getEvent('Sell').topicHash;
const FR = new ethers.Contract(process.env.FEE_ROUTER || '0x10343c9f38ca2a4f543318e378f84c58a4bd10d1',
  ['function creatorEarnedLifetime(address) view returns (uint256)'], p);

async function logs(address, topics, from, to) {
  const t0 = Date.now();
  try {
    const r = await p.getLogs({ address, topics, fromBlock: from, toBlock: to });
    return { n: r.length, ms: Date.now() - t0, r };
  } catch (e) { return { err: String((e.error && e.error.message) || e.shortMessage || e.message).slice(0, 110), ms: Date.now() - t0 }; }
}

(async () => {
  const tokens = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tokens.json'), 'utf8')).tokens || [];
  let stats = {};
  try { stats = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stats.json'), 'utf8')).perToken || {}; } catch (_) {}
  const head = await p.getBlockNumber();
  console.log(`RPC ${RPC} · head ${head} · ${tokens.length} tokens`);

  // tokens that provably traded: creator fees > 0 (from the stats checkpoint, else ask the chain)
  const cands = [];
  for (const t of tokens) {
    const s = stats[String(t.ca || '').toLowerCase()] || {};
    const curve = s.curve || t.curve;
    if (!curve || !t.createdBlock) continue;
    let earned = s.earnedEth;
    if (!(earned > 0)) { try { earned = Number(ethers.formatEther(await FR.creatorEarnedLifetime(t.ca))); } catch (_) { earned = 0; } }
    if (earned > 0) cands.push({ t, curve, earned, s });
    if (cands.length >= 40) break;
  }
  cands.sort((a, b) => b.earned - a.earned);
  if (!cands.length) { console.log('No token with creator fees > 0 found — nothing traded on-chain?'); return; }

  for (const { t, curve, earned, s } of cands.slice(0, 3)) {
    const from = Number(t.createdBlock);
    console.log(`\n=== $${t.ticker} ${t.ca}\n    curve ${curve} · launched block ${from} · creator fees ${earned.toFixed(5)} ETH`);
    console.log(`    indexer state: lastBlock ${s.lastBlock} histLo ${s.histLo} histHi ${s.histHi} logChunk ${s.logChunk} volAllEth ${s.volAllEth}`);
    for (const w of [1000, 10000, 100000, 500000, 2000000]) {
      const to = Math.min(head, from + w - 1);
      const any = await logs(curve, [], from, to);
      const bs = await logs(curve, [[BUY, SELL]], from, to);
      console.log(`    window ${String(w).padStart(7)}: all logs ${any.err ? 'ERR ' + any.err : any.n} · Buy/Sell ${bs.err ? 'ERR ' + bs.err : bs.n}  (${any.ms}ms)`);
      if (to >= head) break;
    }
    // what does this curve actually emit? scan forward in 10k windows until something shows up
    const seen = {};
    for (let a = from, i = 0; a <= head && i < 60; a += 10000, i++) {
      const r = await logs(curve, [], a, Math.min(head, a + 9999));
      if (r.err) { console.log(`    10k scan @${a}: ERR ${r.err}`); break; }
      for (const l of r.r) seen[l.topics[0]] = (seen[l.topics[0]] || 0) + 1;
      if (Object.keys(seen).length && i > 3) break;
    }
    const label = (h) => (h === BUY ? 'Buy (matches indexer)' : h === SELL ? 'Sell (matches indexer)' : 'UNKNOWN to indexer');
    console.log('    event signatures seen near launch:', Object.keys(seen).length ? '' : 'none');
    for (const [h, n] of Object.entries(seen)) console.log(`      ${h}  ×${n}  ${label(h)}`);
  }
})().catch((e) => { console.error('diag failed:', e.message); process.exit(1); });
