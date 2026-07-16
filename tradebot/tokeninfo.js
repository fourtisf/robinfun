'use strict';
/*
 * Rich token "scan" — aggregates everything a Maestro-style card shows, from
 * several sources, all best-effort (a slow/missing source degrades gracefully):
 *
 *   • on-chain snapshot (core.tokenSnapshot): price, mcap, curve/graduation state
 *   • liquidity: DEX pool = WETH reserve × 2 (via router.factory→getPair→reserves);
 *                bonding curve = ETH raised so far / graduation target
 *   • Robinfun API (Robinhood-chain tokens): 24h/total volume, socials, created-at
 *   • GoPlus (Ethereum/Base/BNB/Arbitrum): tax, honeypot, holders, LP lock, mint…
 *
 * Everything is wrapped so this NEVER throws to the caller and never blocks a trade.
 */
const { ethers } = require('ethers');
const core = require('./core');
const goplus = require('./goplus');

const SITE = (process.env.SITE || 'https://robinfun.io').replace(/\/+$/, '');
const ROUTER_FACTORY_ABI = ['function factory() view returns (address)'];
const FACTORY_V2_ABI = ['function getPair(address,address) view returns (address)'];
const PAIR_ABI = ['function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)', 'function token0() view returns (address)'];
const CURVE_PROGRESS_ABI = ['function graduationProgress() view returns (uint256 collected, uint256 target)'];

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

// DEX pool liquidity in native units (WETH reserve × 2). null if no pool / error.
async function dexLiquidityNative(ca, chainKey) {
  const chain = core.chainOf(chainKey); if (!chain || !chain.router || !chain.weth) return null;
  const prov = core.providerFor(chainKey);
  try {
    const factory = await new ethers.Contract(chain.router, ROUTER_FACTORY_ABI, prov).factory();
    if (!factory || factory === ethers.ZeroAddress) return null;
    const pair = await new ethers.Contract(factory, FACTORY_V2_ABI, prov).getPair(ca, chain.weth);
    if (!pair || pair === ethers.ZeroAddress) return null;
    const pc = new ethers.Contract(pair, PAIR_ABI, prov);
    const [r0, r1] = await pc.getReserves();
    const t0 = String(await pc.token0()).toLowerCase();
    const wethReserve = t0 === chain.weth.toLowerCase() ? r0 : r1;
    return Number(ethers.formatEther(wethReserve)) * 2;
  } catch (_) { return null; }
}

// Bonding-curve progress: ETH raised so far and the graduation target.
async function curveRaised(curveAddr, chainKey) {
  try {
    const [col, tgt] = await new ethers.Contract(curveAddr, CURVE_PROGRESS_ABI, core.providerFor(chainKey)).graduationProgress();
    return { raised: Number(ethers.formatEther(col)), target: Number(ethers.formatEther(tgt)) };
  } catch (_) { return null; }
}

// Robinfun public API token record (Robinhood-chain launches only).
async function robinfunApi(ca) {
  try {
    const r = await fetch(`${SITE}/api/v1/tokens/${ca}`, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.address) ? j : null;
  } catch (_) { return null; }
}

// Aggregate a rich scan. Returns null only if the token can't be priced at all.
async function enrich(ca, chainKey) {
  const chain = core.chainOf(chainKey); if (!chain) return null;
  const snap = await core.tokenSnapshot(ca, chainKey).catch(() => null);
  if (!snap) return null;
  const info = { ...snap, chainKey, native: chain.native };
  const tasks = [];
  const onCurve = !!(chain.curve && snap.curve && !snap.graduated);
  if (onCurve) tasks.push(curveRaised(snap.curve, chainKey).then((v) => { if (v) { info.raised = v.raised; info.target = v.target; } }));
  else tasks.push(dexLiquidityNative(ca, chainKey).then((v) => { info.liquidityNative = v; }));
  if (chain.curve) tasks.push(robinfunApi(ca).then((a) => { info.api = a; }));
  if (goplus.supported(chainKey)) tasks.push(goplus.tokenSecurity(chainKey, ca).then((s) => { info.security = s; }).catch(() => {}));
  // Each task swallows its own errors, so Promise.all never rejects; the timeout
  // caps total latency and any unfinished task simply leaves its field undefined.
  await withTimeout(Promise.all(tasks), Math.max(3000, Number(process.env.SCAN_TIMEOUT_MS || 9000)));
  return info;
}

module.exports = { enrich, dexLiquidityNative, curveRaised, robinfunApi };
