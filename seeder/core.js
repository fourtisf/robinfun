'use strict';
/*
 * Robinfun seeder — shared core (config, wallet gen, meme fetch, launch).
 * Used by both the CLI (index.js) and the Telegram bot (telegram.js).
 */
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// auto-load seeder/.env once (real process env still wins)
(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch (_) {}
})();

const CFG = {
  rpc: process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com',
  factory: (process.env.FACTORY_ADDR || '0xf0a093bc6ab5bb408ca1f084ec2161d879edaa57').trim(),
  funderKey: (process.env.FUNDER_KEY || process.env.PRIVATE_KEY || '').trim(),
  numWallets: Math.min(20, Math.max(1, Number(process.env.NUM_WALLETS || 5))),
  walletFile: process.env.WALLET_FILE || path.join(__dirname, 'wallets.json'),
  backend: (process.env.BACKEND || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
  intervalSec: Math.max(5, Number(process.env.INTERVAL_SECONDS || 60)),
  // Option A default: dev-buy kept well BELOW the graduation cap so tokens stay
  // BONDING (varied mcaps on the board, ETH recoverable ~98% by selling back on
  // the curve) instead of graduating into a thin pool and losing ~23% on a dump.
  devBuyEth: String(process.env.DEV_BUY_ETH || '0.03'),
  levyBps: Math.min(1000, Math.max(0, Number(process.env.CREATOR_LEVY_BPS || 100))),
  // Creator fee per side — set BUY and SELL separately (both default to CREATOR_LEVY_BPS).
  buyLevyBps: Math.min(1000, Math.max(0, Number(process.env.BUY_LEVY_BPS || process.env.CREATOR_LEVY_BPS || 100))),
  sellLevyBps: Math.min(1000, Math.max(0, Number(process.env.SELL_LEVY_BPS || process.env.CREATOR_LEVY_BPS || 100))),
  // After launching, the bot can trade its OWN token to seed volume / graduate it
  // (a buy ≥ the graduation cap deploys + burns LP). 0 = off.
  autoBuyEth: String(process.env.AUTO_BUY_ETH || '0'),
  autoSellPct: Math.min(100, Math.max(0, Number(process.env.AUTO_SELL_PCT || 0))),
  // Multi-wallet volume: after wallet A launches, up to PEER_BUYERS OTHER funded
  // wallets each buy PEER_BUY_ETH — real volume + multiple holders + a rising
  // chart. Then optionally SELL_PCT of holdings SELL_AFTER_SEC seconds later.
  peerBuyers: Math.min(20, Math.max(0, Number(process.env.PEER_BUYERS || 3))),   // Option A: volume on by default
  peerBuyEth: String(process.env.PEER_BUY_ETH || '0.02'),
  sellAfterSec: Math.max(0, Number(process.env.SELL_AFTER_SEC || 0)),
  sellPct: Math.min(100, Math.max(0, Number(process.env.SELL_PCT || 50))),
  // Continuous AUTO-SALE: a background loop that periodically sells a % of every
  // wallet's holdings across ALL already-created tokens (take profit / recover
  // ETH / create sell volume). autoSaleOn=off by default.
  autoSaleOn: /^(1|true|yes|on)$/i.test(process.env.AUTO_SALE_ON || ''),
  autoSaleEverySec: Math.max(30, Number(process.env.AUTO_SALE_EVERY_SEC || 600)),
  autoSalePct: Math.min(100, Math.max(1, Number(process.env.AUTO_SALE_PCT || 100))),
  // Random buy sizes: when a MAX is set, each buy is a random ETH amount in
  // [MIN, MAX] (organic-looking volume) instead of the fixed amount above.
  // Option A defaults: random dev-buy 0.02–0.08 ETH and peer-buy 0.01–0.04 ETH —
  // organic-looking, varied mcaps, and total per-token spend stays a small
  // fraction of a 2.6-ETH cap so nothing graduates by accident.
  devBuyMin: String(process.env.DEV_BUY_MIN || '0.02'),
  devBuyMax: String(process.env.DEV_BUY_MAX || '0.08'),
  peerBuyMin: String(process.env.PEER_BUY_MIN || '0.01'),
  peerBuyMax: String(process.env.PEER_BUY_MAX || '0.04'),
  // Vanity CA suffix (hex) — mine a salt so every token address ends in this,
  // like the website's "…feed". Empty = off (random address). Longer = slower.
  vanitySuffix: (process.env.VANITY_SUFFIX !== undefined ? process.env.VANITY_SUFFIX : 'feed').trim().toLowerCase().replace(/[^0-9a-f]/g, ''),
  budgetEth: String(process.env.BUDGET_CAP_ETH || '0.05'),
  fundPerWalletEth: process.env.FUND_PER_WALLET_ETH || '',
  maxTokens: Number(process.env.MAX_TOKENS || 0),
  memeApi: process.env.MEME_API || 'https://meme-api.com/gimme',
  dryRun: /^(1|true|yes)$/i.test(process.env.DRY_RUN || ''),
  appUrl: (process.env.APP_URL || 'https://robinfun.io').replace(/\/+$/, ''),
  // telegram control bot
  tgToken: (process.env.TELEGRAM_TOKEN || process.env.BOT_TOKEN || '').trim(),
  tgAdmins: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  stateFile: process.env.STATE_FILE || path.join(__dirname, 'bot-state.json'),
  // L1 bridge (Ethereum mainnet -> Robinhood Chain, canonical depositEth)
  l1Rpc: (process.env.L1_RPC || 'https://ethereum-rpc.publicnode.com').trim(),
  // The RH-Chain Delayed Inbox on Ethereum L1. REQUIRED to bridge. Leave EMPTY
  // until you verify it against the OFFICIAL docs (docs.robinhood.com/chain/
  // protocol-contracts/) — a wrong Inbox = ETH lost forever. NEVER hardcode an
  // unverified value here.
  l1InboxAddr: (process.env.L1_INBOX_ADDR || '').trim(),
  bridgeMinEth: String(process.env.BRIDGE_MIN_ETH || '0.003'),
  // DEX (Uniswap V2 on Robinhood Chain) — for buying/selling graduated tokens
  dexRouter: (process.env.DEX_ROUTER || '0x89e5db8b5aa49aa85ac63f691524311aeb649eba').trim(),
  weth: (process.env.WETH || '0x0bd7d308f8e1639fab988df18a8011f41eacad73').trim(),
  // FeeRouter — where creator levy fees accrue. The creator wallet claims them.
  feeRouter: (process.env.FEE_ROUTER || '0x10343c9f38ca2a4f543318e378f84c58a4bd10d1').trim(),
};

const FACTORY_ABI = [
  'function createToken((string name,string symbol,string metadataURI,uint16 buyLevyBps,uint16 sellLevyBps,bool decayAtGraduation,bool renounceRateControl,uint256 devBuyMinTokensOut,bytes32 vanitySalt,uint256 maxDeployFee)) payable returns (address token, address curve)',
  'function deployFee() view returns (uint256)',
  'function betaMode() view returns (bool)',
  'function owner() view returns (address)',
  'function tradeAllowed(address) view returns (bool)',
  'function setBetaAllowed(address[] who, bool allowed)',
  'function curveOf(address token) view returns (address)',
  'function tokenImplementation() view returns (address)',
  'function allTokensLength() view returns (uint256)',
  'function allTokens(uint256) view returns (address)',
  'event TokenCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint16 buyLevyBps, uint16 sellLevyBps, bool decayAtGraduation, bool renounceRateControl, uint256 deployFee, uint256 devBuyEth)',
];

const CURVE_ABI = [
  'function marketCapEth() view returns (uint256)',
  'function currentPrice() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function graduationProgress() view returns (uint256 collected, uint256 target)',
  'function buy(uint256 minTokensOut, uint256 deadline) payable returns (uint256)',
  'function sell(uint256 tokensIn, uint256 minEthOut, uint256 deadline) returns (uint256)',
];

const ROUTER_ABI = [
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const FEEROUTER_ABI = [
  'function creatorOwed(address token) view returns (uint256)',            // unclaimed, per token
  'function creatorEarnedLifetime(address token) view returns (uint256)',  // lifetime (claimed + unclaimed)
  'function protocolPending() view returns (uint256)',                     // protocol revenue flushable → treasury
  'function treasury() view returns (address)',                            // where protocol revenue + sweeps land
  'function claim(address token)',                                          // claim one token (caller must be creator)
  'function claimMany(address[] tokens)',                                   // claim many in one tx
];

const PRE = ['Doge','Pepe','Wojak','Chad','Turbo','Giga','Baby','Based','Mega','Shib','Floki','Cyber','Rocket','Degen','Sigma','Ninja','Cosmic','Quantum','Hyper','Moon','Ser','Wen','Bonk','Wif','Fren','Comfy','Alpha','Vibe','Astro','Retro'];
const POST = ['Inu','Cat','Frog','Moon','Rocket','Coin','Lord','King','Ape','Bull','Bonk','Elon','Mars','Pump','Fren','Wojak','Pepe','Doge','Meme','Chad','Whale','Hodl','Lambo','Wagmi','Pamp','Gains','Chan','Bro','Fud','Zilla'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function genName() {
  const name = (pick(PRE) + ' ' + pick(POST) + (Math.random() < 0.3 ? ' ' + Math.floor(Math.random() * 1000) : '')).slice(0, 64);
  let ticker = (pick(PRE) + pick(POST)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3 + Math.floor(Math.random() * 4));
  if (ticker.length < 3) ticker = ('MEME' + ticker).slice(0, 5);
  return { name, ticker };
}

async function fetchMeme() {
  for (let i = 0; i < 4; i++) {
    try {
      const j = await (await fetch(CFG.memeApi, { signal: AbortSignal.timeout(8000) })).json();
      if (!j || j.nsfw || j.spoiler) continue;
      const url = j.url || (Array.isArray(j.preview) && j.preview[j.preview.length - 1]);
      if (!url) continue;
      const img = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const ct = (img.headers.get('content-type') || '').toLowerCase();
      if (!/^image\/(png|jpe?g|gif|webp)/.test(ct)) continue;
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > 1_900_000 || buf.length < 200) continue;
      return { dataUrl: `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`, src: url, title: String(j.title || '') };
    } catch (_) {}
  }
  return null;
}

async function postMeta(rec) {
  try { const r = await fetch(CFG.backend + '/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec), signal: AbortSignal.timeout(20000) }); return r.ok; }
  catch (_) { return false; }
}

const fmt = (wei) => ethers.formatEther(wei);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function makeProvider() { return new ethers.JsonRpcProvider(CFG.rpc, undefined, { batchMaxCount: 1, staticNetwork: true }); }

// deployer wallets: generate once + persist (chmod 600), reuse forever
function loadOrCreateWallets(provider) {
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(CFG.walletFile, 'utf8')); } catch (_) {}
  if (!Array.isArray(saved)) saved = [];
  let changed = false;
  while (saved.length < CFG.numWallets) { const w = ethers.Wallet.createRandom(); saved.push({ address: w.address, privateKey: w.privateKey }); changed = true; }
  saved = saved.slice(0, CFG.numWallets);
  if (changed) { fs.writeFileSync(CFG.walletFile, JSON.stringify(saved, null, 2)); try { fs.chmodSync(CFG.walletFile, 0o600); } catch (_) {} }
  return saved.map((s) => new ethers.Wallet(s.privateKey, provider));
}

async function readDeployFee(factoryRead) { try { return await factoryRead.deployFee(); } catch (_) { return 0n; } }

// live ETH→USD (CoinGecko, Coinbase fallback), cached 60s
let _ethUsd = 0, _ethUsdAt = 0;
async function ethUsd() {
  const now = Date.now();
  if (_ethUsd && now - _ethUsdAt < 60000) return _ethUsd;
  const sources = [
    { url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', pick: (j) => j && j.ethereum && j.ethereum.usd },
    { url: 'https://api.coinbase.com/v2/prices/ETH-USD/spot', pick: (j) => j && j.data && parseFloat(j.data.amount) },
  ];
  for (const s of sources) {
    try { const j = await (await fetch(s.url, { signal: AbortSignal.timeout(6000) })).json(); const v = s.pick(j); if (v) { _ethUsd = Number(v); _ethUsdAt = now; return _ethUsd; } } catch (_) {}
  }
  return _ethUsd || 0;
}

// market cap (in ETH wei) + graduation state for a token's bonding curve
async function tokenStats(curveAddr, provider) {
  if (!curveAddr || !ethers.isAddress(curveAddr)) return { mcEth: 0n, graduated: false };
  try {
    const c = new ethers.Contract(curveAddr, CURVE_ABI, provider);
    const [mcEth, graduated] = await Promise.all([c.marketCapEth().catch(() => 0n), c.graduated().catch(() => false)]);
    return { mcEth, graduated };
  } catch (_) { return { mcEth: 0n, graduated: false }; }
}

// ---- L1 -> Robinhood Chain canonical bridge (Arbitrum Orbit depositEth) ----
// depositEth() escrows msg.value on L1 and credits the SAME address on the L2
// (EOAs only; a contract sender would be address-aliased). Same private key =
// same address on both chains, so a deployer wallet self-bridges its own ETH.
const INBOX_ABI = ['function depositEth() payable returns (uint256)'];

function makeL1Provider() {
  if (!CFG.l1Rpc) return null;
  try { return new ethers.JsonRpcProvider(CFG.l1Rpc, undefined, { batchMaxCount: 1 }); } catch (_) { return null; }
}

// Confirm the configured Inbox is actually a deployed contract (catches a
// totally-wrong/EOA address). Does NOT prove it's the REAL Inbox — that must be
// verified by the operator against the official docs. Fail closed.
async function verifyInbox(l1Provider, addr) {
  if (!addr || !ethers.isAddress(addr)) return { ok: false, reason: 'alamat kosong / tidak valid' };
  if (!l1Provider) return { ok: false, reason: 'L1 RPC tidak tersedia' };
  try {
    const code = await l1Provider.getCode(addr);
    if (!code || code === '0x') return { ok: false, reason: 'tidak ada kontrak di alamat ini (bukan Inbox)' };
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.shortMessage || e.message }; }
}

// Bridge a single wallet's L1 ETH to Robinhood Chain via Inbox.depositEth().
// Keeps a gas reserve on L1 and sets explicit, headroomed gas so a base-fee
// rise can't strand the tx. Returns one of:
//   {skip}                                  — nothing sent (too little ETH)
//   {ok, bridged, hash, receipt}            — sent + confirmed
//   {ok, pending, bridged, hash}            — sent, not confirmed within timeout
//   {ok, unconfirmed, bridged, hash, error} — sent, confirmation RPC errored
// Throws ONLY if the send itself fails (no tx broadcast).
async function bridgeOne(wallet, l1Provider, inboxAddr, minEthStr) {
  const signer = wallet.connect(l1Provider);
  const bal = await l1Provider.getBalance(signer.address);
  const inbox = new ethers.Contract(inboxAddr, INBOX_ABI, signer);
  let gasLimit = 130000n;
  try { const est = await inbox.depositEth.estimateGas({ value: 1n }); gasLimit = (est * 15n) / 10n; } catch (_) {}
  const fee = await l1Provider.getFeeData();
  const baseMax = fee.maxFeePerGas || fee.gasPrice || ethers.parseUnits('40', 'gwei');
  const maxFeePerGas = baseMax * 2n; // headroom so a routine base-fee rise doesn't wedge the tx
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas || ethers.parseUnits('2', 'gwei');
  const reserve = gasLimit * maxFeePerGas; // the tx can never cost more than this
  const minEth = ethers.parseEther(minEthStr);
  if (bal <= reserve) return { skip: true, reason: 'saldo L1 < cadangan gas', bal };
  const amount = bal - reserve;
  if (amount < minEth) return { skip: true, reason: 'di bawah minimum bridge', bal, amount };
  const tx = await inbox.depositEth({ value: amount, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
  try {
    const receipt = await tx.wait(1, 180000); // bounded wait so a stuck tx can't hang the bot
    return { ok: true, bridged: amount, hash: tx.hash, receipt };
  } catch (e) {
    if (e && e.code === 'TIMEOUT') return { ok: true, pending: true, bridged: amount, hash: tx.hash };
    return { ok: true, unconfirmed: true, bridged: amount, hash: tx.hash, error: e.shortMessage || e.message };
  }
}

async function checkBeta(factoryRead, wallets) {
  let beta = false, owner = ethers.ZeroAddress;
  try { [beta, owner] = await Promise.all([factoryRead.betaMode(), factoryRead.owner()]); } catch (_) {}
  let allowed = wallets.map(() => true), missing = [];
  if (beta) {
    allowed = await Promise.all(wallets.map((w) => factoryRead.tradeAllowed(w.address).catch(() => false)));
    missing = wallets.filter((_, i) => !allowed[i]);
  }
  return { beta, owner, allowed, missing };
}

// Grind a vanity salt so the CREATE2 token address ends in `suffix` (hex), the
// same way the website mines "…feed". Bound to `creator` on-chain (see the
// factory's `_tokenSalt`) so a mined salt can't be front-run. Returns the salt,
// or null on time-out (a launch must never hang).
let _tokenImpl = null;
async function getTokenImpl(provider) {
  if (_tokenImpl) return _tokenImpl;
  try { _tokenImpl = await new ethers.Contract(CFG.factory, FACTORY_ABI, provider).tokenImplementation(); } catch (_) { _tokenImpl = null; }
  return _tokenImpl;
}
async function mineVanity(provider, creator, suffix) {
  const impl = await getTokenImpl(provider);
  if (!impl || !suffix) return null;
  const initCode = '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' + impl.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3';
  const initHash = ethers.keccak256(initCode);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const want = String(suffix).toLowerCase();
  const HARD_CAP = 8_000_000, TIME_CAP = 25_000, t0 = Date.now();
  // Start grinding at a RANDOM offset. If we always started at 1 the same
  // creator would mine the SAME first "…feed" address every launch, so the
  // second CREATE2 clone would collide with the already-deployed one and the
  // factory reverts ("execution reverted: unknown custom error"). A random
  // base makes every launch land on a fresh vanity address.
  const base = 1n + BigInt(Math.floor(Math.random() * 1e15)) + (BigInt(Date.now()) << 20n);
  for (let i = 0; i < HARD_CAP; i++) {
    const n = base + BigInt(i);
    const vanitySalt = ethers.zeroPadValue(ethers.toBeHex(n), 32);
    const salt = ethers.keccak256(coder.encode(['address', 'bytes32'], [creator, vanitySalt]));
    const addr = ethers.getCreate2Address(CFG.factory, salt, initHash);
    if (addr.toLowerCase().endsWith(want)) return { vanitySalt, addr, tries: i };
    if ((i & 16383) === 0 && Date.now() - t0 > TIME_CAP) return null;   // bail so a launch never hangs
  }
  return null;
}

// Launch one token from `wallet`. Returns a plain result object (no console I/O)
// so callers can format for the terminal or Telegram.
async function launchWith(wallet, provider, deployFee, devBuy) {
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, wallet);
  const { name, ticker } = genName();
  const meme = await fetchMeme();
  const value = deployFee + devBuy;
  // Vanity CA (…feed) — mine a salt bound to this wallet, like the website.
  let vanitySalt = ethers.ZeroHash;
  if (CFG.vanitySuffix && !CFG.dryRun) { const mined = await mineVanity(provider, wallet.address, CFG.vanitySuffix); if (mined) vanitySalt = mined.vanitySalt; }
  const params = {
    name, symbol: ticker, metadataURI: '',
    buyLevyBps: CFG.buyLevyBps, sellLevyBps: CFG.sellLevyBps,
    decayAtGraduation: false, renounceRateControl: false,
    devBuyMinTokensOut: 0n, vanitySalt, maxDeployFee: deployFee,
  };
  if (CFG.dryRun) return { ok: true, dry: true, name, ticker, memeSrc: meme ? meme.src : null, creator: wallet.address };

  // Snapshot the wallet balance so we can report the ACTUAL dev-buy. The curve
  // caps a buy at the graduation cap and refunds the surplus to the creator, so
  // the intended `devBuy` (e.g. 0.03 ETH) can differ wildly from what really
  // entered the curve (e.g. 0.005 ETH). netOut = deployFee + gas + actualDevBuy.
  const balBefore = await provider.getBalance(wallet.address).catch(() => null);
  let receipt;
  try { const tx = await factory.createToken(params, { value }); receipt = await tx.wait(); }
  catch (e) { return { ok: false, name, ticker, creator: wallet.address, error: e.shortMessage || e.reason || e.message }; }

  let ca = '', curve = '';
  for (const lg of receipt.logs) { try { const p = factory.interface.parseLog(lg); if (p && p.name === 'TokenCreated') { ca = p.args.token; curve = p.args.curve; break; } } catch (_) {} }
  const gasCostWei = receipt.gasUsed * (receipt.gasPrice || 0n);

  // Actual dev-buy = what really left the wallet minus gas and the deploy fee
  // (the graduation-cap refund already came back). Falls back to the intended
  // amount if the balance read failed. Read AFTER the tx, BEFORE any auto-trade.
  let devBuyActualWei = devBuy;
  if (balBefore !== null) {
    try {
      const balAfter = await provider.getBalance(wallet.address);
      const a = (balBefore - balAfter) - gasCostWei - deployFee;
      if (a >= 0n && a <= devBuy) devBuyActualWei = a;   // sanity-clamp to [0, intended]
    } catch (_) {}
  }

  const posted = await postMeta({
    name, ticker, ca,
    description: (meme && meme.title ? meme.title : `${name} — a Robinfun fair launch`).slice(0, 280),
    buyFee: CFG.buyLevyBps / 100, sellFee: CFG.sellLevyBps / 100,
    creator: wallet.address, logo: meme ? meme.dataUrl : undefined,
  });

  // Optional self-trade phase: seed volume and/or graduate the token (a buy that
  // crosses the graduation cap deploys + burns the Uniswap LP). Failures here
  // never fail the launch — the token is already live.
  const trade = {};
  try {
    if (ca && Number(CFG.autoBuyEth) > 0) {
      await botBuy(wallet, provider, ca, CFG.autoBuyEth);   // ETH string; botBuy parses to wei
      trade.boughtEth = CFG.autoBuyEth;
    }
    if (ca && CFG.autoSellPct > 0) {
      await botSell(wallet, provider, ca, CFG.autoSellPct);
      trade.soldPct = CFG.autoSellPct;
    }
  } catch (e) { trade.error = e.shortMessage || e.message; }

  return { ok: true, name, ticker, ca, curve, gasCostWei, txHash: receipt.hash, posted, memeSrc: meme ? meme.src : null, creator: wallet.address, trade, devBuyIntendedWei: devBuy, devBuyActualWei };
}

// Reclaim leftover ETH from `wallets` to `dest`. Returns [{address, sent|skip|error}].
async function sweepAll(wallets, provider, dest) {
  const out = [];
  const gas = ethers.parseEther('0.0003');
  for (const w of wallets) {
    try {
      const bal = await provider.getBalance(w.address);
      if (bal <= gas) { out.push({ address: w.address, skip: true, bal }); continue; }
      const tx = await w.sendTransaction({ to: dest, value: bal - gas }); await tx.wait();
      out.push({ address: w.address, sent: bal - gas, tx: tx.hash });
    } catch (e) { out.push({ address: w.address, error: e.shortMessage || e.message }); }
  }
  return out;
}

// ---- bot trading: buy/sell a token, auto-routing curve (bonding) vs DEX (graduated) ----
async function resolveCurve(provider, ca) {
  try { const c = await new ethers.Contract(CFG.factory, FACTORY_ABI, provider).curveOf(ca); return (c && c !== ethers.ZeroAddress) ? c : ''; } catch (_) { return ''; }
}
async function isGraduated(provider, curveAddr) {
  try { return await new ethers.Contract(curveAddr, CURVE_ABI, provider).graduated(); } catch (_) { return false; }
}
async function waitBounded(tx) { // never hang the bot on a stuck tx
  try { return await tx.wait(1, 180000); } catch (e) { if (e && e.code === 'TIMEOUT') return null; throw e; }
}
async function ensureApprove(wallet, ca, spender, amount) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const cur = await erc.allowance(wallet.address, spender).catch(() => 0n);
  if (cur < amount) { const tx = await erc.approve(spender, ethers.MaxUint256); await tx.wait(); }
}

// Buy `ethAmount` ETH of token `ca` from `wallet`. Curve buy while bonding,
// Uniswap swap once graduated. Returns {ok, venue, hash, pending} | throws.
// IMPORTANT: `ethAmount` is a HUMAN ETH amount (string/number like "0.01"), NOT
// wei — this parses it. Never pass ethers.parseEther(...) here (that double-parses
// into an astronomically large value → "insufficient funds").
async function botBuy(wallet, provider, ca, ethAmount) {
  const value = ethers.parseEther(String(ethAmount));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const curveAddr = await resolveCurve(provider, ca);
  const grad = curveAddr ? await isGraduated(provider, curveAddr) : true;
  if (curveAddr && !grad) {
    const tx = await new ethers.Contract(curveAddr, CURVE_ABI, wallet).buy(0n, deadline, { value });
    return { ok: true, venue: 'curve', hash: tx.hash, pending: !(await waitBounded(tx)) };
  }
  const tx = await new ethers.Contract(CFG.dexRouter, ROUTER_ABI, wallet)
    .swapExactETHForTokensSupportingFeeOnTransferTokens(0n, [CFG.weth, ca], wallet.address, deadline, { value });
  return { ok: true, venue: 'dex', hash: tx.hash, pending: !(await waitBounded(tx)) };
}

// Sell `pct`% (1-100) of the wallet's balance of token `ca`. Auto-routes.
async function botSell(wallet, provider, ca, pct) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const bal = await erc.balanceOf(wallet.address);
  const p = Math.max(1, Math.min(100, Math.round(Number(pct) || 0)));
  const amount = (bal * BigInt(p)) / 100n;
  if (amount <= 0n) return { skip: true, reason: 'saldo token 0' };
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const curveAddr = await resolveCurve(provider, ca);
  const grad = curveAddr ? await isGraduated(provider, curveAddr) : true;
  if (curveAddr && !grad) {
    await ensureApprove(wallet, ca, curveAddr, amount);
    const tx = await new ethers.Contract(curveAddr, CURVE_ABI, wallet).sell(amount, 0n, deadline);
    return { ok: true, venue: 'curve', sold: amount, hash: tx.hash, pending: !(await waitBounded(tx)) };
  }
  await ensureApprove(wallet, ca, CFG.dexRouter, amount);
  const tx = await new ethers.Contract(CFG.dexRouter, ROUTER_ABI, wallet)
    .swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0n, [ca, CFG.weth], wallet.address, deadline);
  return { ok: true, venue: 'dex', sold: amount, hash: tx.hash, pending: !(await waitBounded(tx)) };
}

// A random ETH amount in [min, max] as a 6-dp string (min==max → fixed). Returns
// null if the range is invalid.
function randEthStr(min, max) {
  const a = Number(min), b = Number(max);
  if (!(a >= 0) || !(b > 0) || b < a) return null;
  return (a + Math.random() * (b - a)).toFixed(6);
}
// Multi-wallet volume: each of `buyers` buys a RANDOM amount in [minEth, maxEth]
// of `ca` (pass min==max for a fixed size). Skips any wallet without enough ETH.
// Returns per-wallet results incl. the ETH spent (never throws).
async function seedVolume(provider, buyers, ca, minEth, maxEth) {
  const out = [];
  for (const w of buyers) {
    const ethStr = randEthStr(minEth, maxEth) || String(minEth || '0');
    try {
      const need = ethers.parseEther(ethStr) + ethers.parseEther('0.0002'); // buy + gas headroom
      const bal = await provider.getBalance(w.address).catch(() => 0n);
      if (bal < need || Number(ethStr) <= 0) { out.push({ address: w.address, skip: true }); continue; }
      await botBuy(w, provider, ca, ethStr);   // botBuy parses ETH→wei itself; pass the ETH string (NOT wei)
      out.push({ address: w.address, ok: true, eth: Number(ethStr) });
    } catch (e) { out.push({ address: w.address, ok: false, error: e.shortMessage || e.message }); }
  }
  return out;
}
// Each of `sellers` sells `pct`% of its `ca` balance (for scheduled dumps).
async function sellHoldings(provider, sellers, ca, pct) {
  const out = [];
  for (const w of sellers) {
    try { const r = await botSell(w, provider, ca, pct); out.push({ address: w.address, ok: !r.skip, skip: !!r.skip }); }
    catch (e) { out.push({ address: w.address, ok: false, error: e.shortMessage || e.message }); }
  }
  return out;
}
// Sell `pct`% of EVERY wallet's balance across ALL token CAs in `cas`. botSell
// reads the balance first and skips wallets holding nothing, so idle positions
// cost only a cheap balanceOf. Used by the continuous auto-sale loop and /dumpall.
// Returns [{ ca, address, ok|skip|error }].
async function sellAllHoldings(provider, wallets, cas, pct) {
  const out = [];
  for (const ca of cas) {
    if (!ca || !ethers.isAddress(ca)) continue;
    for (const w of wallets) {
      try { const r = await botSell(w, provider, ca, pct); out.push({ ca, address: w.address, ok: !r.skip, skip: !!r.skip }); }
      catch (e) { out.push({ ca, address: w.address, ok: false, error: e.shortMessage || e.message }); }
    }
  }
  return out;
}

// ---- creator fee (levy) earnings: read + claim ----
// Read pending + lifetime creator earnings for a list of token CAs.
// Returns [{ ca, owed (ETH number), lifetime (ETH number) }]. Never throws.
async function creatorEarnings(provider, cas) {
  const fr = new ethers.Contract(CFG.feeRouter, FEEROUTER_ABI, provider);
  const out = [];
  for (const ca of cas) {
    if (!ca || !ethers.isAddress(ca)) continue;
    try {
      const [owed, life] = await Promise.all([fr.creatorOwed(ca), fr.creatorEarnedLifetime(ca)]);
      out.push({ ca, owed: Number(ethers.formatEther(owed)), lifetime: Number(ethers.formatEther(life)) });
    } catch (_) { out.push({ ca, owed: 0, lifetime: 0, error: true }); }
  }
  return out;
}

// Auto-detect total ETH DEPOSITED into the wallets, read from chain history via
// the Blockscout (Etherscan-compatible) explorer API. Sums only EXTERNAL incoming
// transfers: normal txs where `to` is our wallet and `from` is NOT one of our own
// wallets. Sell/swap proceeds and graduation refunds arrive as INTERNAL txs (not
// in txlist), and wallet↔wallet moves are excluded — so this is real funding only.
// Returns ETH (float). Falls back to 0 if the explorer is unreachable.
async function detectDeposits(wallets) {
  const api = (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com/api').replace(/\/+$/, '');
  const mine = new Set(wallets.map((w) => w.address.toLowerCase()));
  let total = 0n;
  for (const w of wallets) {
    const lc = w.address.toLowerCase();
    try {
      const url = `${api}?module=account&action=txlist&address=${w.address}&sort=asc`;
      const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (!j || !Array.isArray(j.result)) continue;
      for (const tx of j.result) {
        if (String(tx.isError) === '1') continue;                 // reverted
        if ((tx.to || '').toLowerCase() !== lc) continue;         // incoming only
        if (mine.has((tx.from || '').toLowerCase())) continue;    // skip wallet↔wallet moves
        try { total += BigInt(tx.value || '0'); } catch (_) {}
      }
    } catch (_) {}
  }
  return Number(ethers.formatEther(total));
}

// Full cash-flow of the wallets from chain history (Blockscout), per wallet + total.
// Classifies every transfer so the P&L needs no manual deposit figure:
//   depositIn — money funded IN: external transfers AND bridge credits (a self
//               deposit lands as from==to==wallet, so we count self-txs — that was
//               the bug that made bridged ETH invisible). Inter-wallet moves excluded.
//   spent     — buys + deploy: OUT txs that call a contract (input data present) + gas
//   sweepOut  — plain OUT transfers (e.g. /sweep to the treasury) — still your money
//   tradeIn   — sell proceeds + graduation refunds (internal tx IN, from a contract)
// Returns everything in ETH. Never throws.
async function walletCashflow(wallets) {
  const api = (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com/api').replace(/\/+$/, '');
  const mine = new Set(wallets.map((w) => w.address.toLowerCase()));
  const big = (x) => { try { return BigInt(x || '0'); } catch (_) { return 0n; } };
  const per = {};
  let depositIn = 0n, spent = 0n, sweepOut = 0n, tradeIn = 0n;
  for (const w of wallets) {
    const lc = w.address.toLowerCase();
    const p = per[lc] = { depositIn: 0n, spent: 0n, sweepOut: 0n, tradeIn: 0n };
    try {   // normal txs
      const j = await (await fetch(`${api}?module=account&action=txlist&address=${w.address}&sort=asc`, { signal: AbortSignal.timeout(12000) })).json();
      if (Array.isArray(j.result)) for (const tx of j.result) {
        if (String(tx.isError) === '1') continue;
        const v = big(tx.value), gas = big(tx.gasUsed) * big(tx.gasPrice);
        const to = (tx.to || '').toLowerCase(), from = (tx.from || '').toLowerCase();
        const isCall = !!(tx.input && tx.input.length > 2 && tx.input !== '0x');
        if (from === lc && to === lc) { p.depositIn += v; depositIn += v; continue; }        // bridge/self credit IN
        if (to === lc && !mine.has(from)) { p.depositIn += v; depositIn += v; }               // external funding IN
        if (from === lc) {
          if (isCall) { p.spent += v + gas; spent += v + gas; }                               // buy / deploy (contract call)
          else { p.sweepOut += v; sweepOut += v; p.spent += gas; spent += gas; }              // plain transfer out (sweep)
        }
      }
    } catch (_) {}
    try {   // internal txs: sell proceeds + graduation refunds coming back IN
      const j = await (await fetch(`${api}?module=account&action=txlistinternal&address=${w.address}&sort=asc`, { signal: AbortSignal.timeout(12000) })).json();
      if (Array.isArray(j.result)) for (const tx of j.result) {
        if (String(tx.isError) === '1') continue;
        const v = big(tx.value); const to = (tx.to || '').toLowerCase(), from = (tx.from || '').toLowerCase();
        if (to === lc && !mine.has(from)) { p.tradeIn += v; tradeIn += v; }
      }
    } catch (_) {}
  }
  const f = (x) => Number(ethers.formatEther(x));
  const perOut = {};
  for (const [k, v] of Object.entries(per)) perOut[k] = { depositIn: f(v.depositIn), spent: f(v.spent), sweepOut: f(v.sweepOut), tradeIn: f(v.tradeIn) };
  return { depositIn: f(depositIn), spent: f(spent), sweepOut: f(sweepOut), tradeIn: f(tradeIn), per: perOut };
}

// Protocol revenue currently flushable to the treasury (owner's wallet). ETH.
async function protocolPending(provider) {
  try { return Number(ethers.formatEther(await new ethers.Contract(CFG.feeRouter, FEEROUTER_ABI, provider).protocolPending())); }
  catch (_) { return 0; }
}
// Per-token trading P&L for the bot's tokens, from the CURVE Buy/Sell events
// (grossEth paid on buys, netEth received on sells), attributed to our wallets.
// Bounded to the most recent `maxTokens` (event scans are heavy). Returns
// [{ ca, creator, buy, sell, pnl, perW:{addr:{buy,sell}} }], best-effort.
async function tokenPnl(provider, wallets, maxTokens = 40) {
  const owned = await ownedTokens(provider, wallets);
  if (!owned.length) return [];
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);
  const head = await provider.getBlockNumber();
  const mineSet = new Set(wallets.map((w) => w.address.toLowerCase()));
  // Probe the widest getLogs window this RPC accepts (once, on the newest curve).
  let chunk = 0;
  try {
    const c0 = await factory.curveOf(owned[owned.length - 1].ca);
    if (c0 && c0 !== ethers.ZeroAddress) {
      const cc = new ethers.Contract(c0, CURVE_ABI, provider);
      for (const w of [90000, 45000, 18000, 7000, 2500, 800]) { try { await cc.queryFilter(cc.filters.Buy(), Math.max(0, head - w), head); chunk = w; break; } catch (_) {} }
    }
  } catch (_) {}
  if (!chunk) chunk = 2500;
  const items = owned.slice(-maxTokens);
  const rows = await mapLimit(items, 5, async (t) => {
    let curve = ''; try { curve = await factory.curveOf(t.ca); } catch (_) {}
    if (!curve || curve === ethers.ZeroAddress) return { ca: t.ca, creator: t.creator, buy: 0, sell: 0, pnl: 0, perW: {} };
    const c = new ethers.Contract(curve, CURVE_ABI, provider);
    const perW = {};
    const add = (addr, key, eth) => { const a = String(addr || '').toLowerCase(); if (!mineSet.has(a)) return; if (!perW[a]) perW[a] = { buy: 0, sell: 0 }; perW[a][key] += eth; };
    const FLOOR = Math.max(0, head - Math.min(2000000, chunk * 40));
    let seen = false, empty = 0;
    for (let hi = head; hi > FLOOR; hi -= chunk) {
      const lo = Math.max(FLOOR, hi - chunk);
      let buys = [], sells = [];
      try { [buys, sells] = await Promise.all([c.queryFilter(c.filters.Buy(), lo, hi), c.queryFilter(c.filters.Sell(), lo, hi)]); }
      catch (_) { if (lo === FLOOR) break; continue; }
      if (buys.length || sells.length) { seen = true; empty = 0; } else if (seen && ++empty >= 3) break;
      for (const e of buys) add(e.args.recipient, 'buy', Number(ethers.formatEther(e.args.grossEth)));
      for (const e of sells) add(e.args.trader, 'sell', Number(ethers.formatEther(e.args.netEth)));
      if (lo === FLOOR) break;
    }
    let buy = 0, sell = 0;
    for (const a of Object.keys(perW)) { buy += perW[a].buy; sell += perW[a].sell; }
    return { ca: t.ca, creator: t.creator, buy, sell, pnl: sell - buy, perW };
  });
  return rows.filter(Boolean);
}

// The treasury address (from the FeeRouter) and its live balance — read DIRECTLY
// from chain (verifiable on robinhoodscan), never reconstructed from tx history.
async function treasuryInfo(provider) {
  try {
    const addr = await new ethers.Contract(CFG.feeRouter, FEEROUTER_ABI, provider).treasury();
    if (!addr || addr === ethers.ZeroAddress) return { addr: '', balance: 0 };
    const bal = await provider.getBalance(addr);
    return { addr, balance: Number(ethers.formatEther(bal)) };
  } catch (_) { return { addr: '', balance: 0 }; }
}
// Token balance an address holds (float), 0 on error.
async function tokenBalance(provider, ca, addr) {
  try { return Number(ethers.formatUnits(await new ethers.Contract(ca, ERC20_ABI, provider).balanceOf(addr), 18)); }
  catch (_) { return 0; }
}

// Run async `fn` over `items` with at most `limit` in flight (RPC is batchMaxCount:1).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (_) { out[k] = null; } } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

// Enumerate EVERY token on the factory (via allTokens, not the bot's capped
// memory), keep those whose on-chain creator() is one of OUR wallets, and read
// each one's creatorOwed. This is chain-truth, so it finds fees on OLD tokens the
// bot's /last list dropped. Returns [{ ca, creator, owedWei }] (owed can be 0).
async function ownedTokens(provider, wallets) {
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);
  const fr = new ethers.Contract(CFG.feeRouter, FEEROUTER_ABI, provider);
  const mine = new Set(wallets.map((w) => w.address.toLowerCase()));
  let len = 0; try { len = Number(await factory.allTokensLength()); } catch (_) { return []; }
  const idxs = Array.from({ length: len }, (_, i) => i);
  const cas = (await mapLimit(idxs, 8, (i) => factory.allTokens(i))).filter(Boolean);
  const rows = await mapLimit(cas, 8, async (ca) => {
    try {
      const [creator, owed] = await Promise.all([
        new ethers.Contract(ca, ['function creator() view returns (address)'], provider).creator(),
        fr.creatorOwed(ca),
      ]);
      if (!mine.has(String(creator).toLowerCase())) return null;
      return { ca, creator, owedWei: owed };
    } catch (_) { return null; }
  });
  return rows.filter(Boolean);
}

// Total creator fee OWED across all of our tokens (ETH), chain-truth.
async function creatorOwedTotal(provider, wallets) {
  const rows = await ownedTokens(provider, wallets);
  return Number(ethers.formatEther(rows.reduce((s, r) => s + (r.owedWei || 0n), 0n)));
}

// Claim creator levy fees across ALL of our tokens (not just the bot's recent
// memory). Groups tokens per creator wallet and claims in chunks (claimMany caps
// gas). ETH lands in each creator wallet — /sweep afterwards to the treasury.
// Returns [{ address, tokens:[ca…], claimedEth, tx } | { address, tokens, error }].
async function claimCreator(wallets, provider) {
  const rows = (await ownedTokens(provider, wallets)).filter((r) => r.owedWei > 0n);
  const byAddr = new Map(wallets.map((w) => [w.address.toLowerCase(), w]));
  const groups = new Map();   // creatorLower -> [{ca:checksum, owed:bigint}]
  for (const r of rows) {
    const key = String(r.creator).toLowerCase();
    if (!byAddr.has(key)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ca: ethers.getAddress(r.ca), owed: r.owedWei });
  }
  const out = [];
  for (const [key, items] of groups) {
    const w = byAddr.get(key);
    const frw = new ethers.Contract(CFG.feeRouter, FEEROUTER_ABI, w);
    // chunk to ~25 tokens per tx so claimMany never blows the block gas limit
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      const tokens = chunk.map((x) => x.ca);
      const total = chunk.reduce((s, x) => s + x.owed, 0n);
      try {
        const tx = tokens.length === 1 ? await frw.claim(tokens[0]) : await frw.claimMany(tokens);
        await waitBounded(tx);
        out.push({ address: w.address, tokens, claimedEth: Number(ethers.formatEther(total)), tx: tx.hash });
      } catch (e) { out.push({ address: w.address, tokens, error: e.shortMessage || e.reason || e.message }); }
    }
  }
  return out;
}

module.exports = {
  ethers, CFG, FACTORY_ABI, CURVE_ABI, ROUTER_ABI, ERC20_ABI, FEEROUTER_ABI, INBOX_ABI, makeProvider,
  genName, fetchMeme, postMeta, loadOrCreateWallets,
  launchWith, readDeployFee, checkBeta, sweepAll, fmt, sleep,
  ethUsd, tokenStats,
  makeL1Provider, verifyInbox, bridgeOne,
  resolveCurve, isGraduated, botBuy, botSell, seedVolume, sellHoldings, sellAllHoldings, randEthStr,
  creatorEarnings, claimCreator, protocolPending, treasuryInfo, tokenBalance, detectDeposits, walletCashflow,
  mapLimit, ownedTokens, creatorOwedTotal, tokenPnl,
};
