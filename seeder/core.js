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
  // REACT-TO-BUY (market-maker / seed recovery): when a REAL buyer (not one of our
  // wallets) buys ≥ reactMinUsd of a token we hold, sell a CAPPED slice to recover
  // seed capital + take small profit. Capped (reactSellPct per hit, reactMaxCount
  // hits per token) so it never fully dumps / rugs a real holder. Off by default.
  reactOn: /^(1|true|yes|on)$/i.test(process.env.REACT_ON || ''),
  reactEverySec: Math.max(20, Number(process.env.REACT_EVERY_SEC || 45)),
  reactMinUsd: Math.max(1, Number(process.env.REACT_MIN_USD || 15)),
  reactSellPct: Math.min(100, Math.max(1, Number(process.env.REACT_SELL_PCT || 25))),
  reactMaxCount: Math.max(1, Number(process.env.REACT_MAX_COUNT || 3)),
  // ANTI-GRADUATION guard: bot tokens must NEVER graduate (graduation burns the
  // LP = ~23% loss). When a bot token's collected ETH reaches capCeilingEth (a
  // margin below the ~2.6 graduation cap), sell 100% of the bot's holdings to
  // pull the pool back down. ON by default — it protects your capital.
  capGuardOn: !/^(0|off|false|no)$/i.test(process.env.CAP_GUARD_ON || 'on'),
  capCeilingEth: Math.max(0.1, Number(process.env.CAP_CEILING_ETH || 2.0)),
  // Gas price mode: 'cheap' = pay the network base-fee (cheapest that still
  // confirms, no tip) · 'fixed' = pay exactly gasGwei (floored to base-fee) ·
  // 'auto' = let ethers decide. gasGwei is the manual value used by 'fixed'.
  gasMode: (() => { const m = String(process.env.GAS_MODE || 'cheap').toLowerCase(); return ['cheap', 'fixed', 'auto'].includes(m) ? m : 'cheap'; })(),
  gasGwei: Math.max(0, Number(process.env.GAS_GWEI || 0.01)),
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
  // Events — lets the bot detect who is buying (react to REAL, non-bot buyers).
  'event Buy(address indexed trader, address indexed recipient, uint256 grossEth, uint256 curveFeeEth, uint256 levyEth, uint256 netEth, uint256 tokensOut, uint256 virtualEthReserve, uint256 virtualTokenReserve)',
  'event Sell(address indexed trader, uint256 tokensIn, uint256 grossEth, uint256 curveFeeEth, uint256 levyEth, uint256 netEth, uint256 virtualEthReserve, uint256 virtualTokenReserve)',
];

const ROUTER_ABI = [
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',   // quote a sell before sending
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
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
function makeProvider() {
  // Cap each RPC request (ethers defaults to 300s). Under the sequential 50-token ×
  // N-wallet sell load, an unbounded request on a degraded endpoint could wedge the
  // whole cycle (and, via the shared `trading` lock, the anti-graduation guard).
  const req = new ethers.FetchRequest(CFG.rpc);
  req.timeout = Math.max(5000, Number(process.env.RPC_TIMEOUT_MS || 20000));
  return new ethers.JsonRpcProvider(req, undefined, { batchMaxCount: 1, staticNetwork: true });
}

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
  try { const tx = await factory.createToken(params, { value }); receipt = await tx.wait(1, 180000); }   // bounded — a stuck launch tx must not hang the bot/lock
  catch (e) { return { ok: false, name, ticker, creator: wallet.address, error: (e && e.code === 'TIMEOUT') ? 'launch tx sent but not confirmed in 3 min — check the explorer / retry' : (e.shortMessage || e.reason || e.message) }; }

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
      const sr = await botSell(wallet, provider, ca, CFG.autoSellPct);   // returns {ok|skip|error} — doesn't throw
      if (sr.ok) trade.soldPct = CFG.autoSellPct;
      else if (sr.error) trade.error = sr.error;
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
      const tx = await w.sendTransaction({ to: dest, value: bal - gas }); await waitBounded(tx);   // bounded — never hang the bot on a stuck sweep tx
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
// Token name/symbol/decimals, cached forever (immutable). Never throws.
const _metaCache = new Map();
async function tokenMeta(provider, ca) {
  const k = String(ca).toLowerCase();
  if (_metaCache.has(k)) return _metaCache.get(k);
  const erc = new ethers.Contract(ca, ERC20_ABI, provider);
  let decOk = true;
  const [name, symbol, decimals] = await Promise.all([
    erc.name().catch(() => ''), erc.symbol().catch(() => ''),
    erc.decimals().then((d) => Number(d)).catch(() => { decOk = false; return 18; }),
  ]);
  const meta = { name: name || '', symbol: symbol || '', decimals: Number.isFinite(decimals) ? decimals : 18 };
  if ((name || symbol) && decOk) _metaCache.set(k, meta);   // don't permanently cache a fallback decimals (transient decimals() miss)
  return meta;
}
// Resolve how to trade a token (curve while bonding, DEX once graduated) with a light
// retry so a transient RPC blip doesn't MIS-route (which used to send a bonding sell
// to the DEX → revert). Returns { curve, graduated } or null when genuinely
// unreadable — the caller should retry later, NOT count it as a sale failure.
async function resolveRoute(provider, ca) {
  for (let i = 0; i < 2; i++) {
    try {
      const curve = await new ethers.Contract(CFG.factory, FACTORY_ABI, provider).curveOf(ca);
      if (!curve || curve === ethers.ZeroAddress) return { curve: '', graduated: true };   // not a Robinfun curve token → plain DEX
      const graduated = await new ethers.Contract(curve, CURVE_ABI, provider).graduated();
      return { curve, graduated: !!graduated };
    } catch (_) { await sleep(300); }
  }
  return null;
}
async function waitBounded(tx) { // never hang the bot on a stuck tx
  try { return await tx.wait(1, 180000); } catch (e) { if (e && e.code === 'TIMEOUT') return null; throw e; }
}
// True ONLY for a genuine on-chain revert (the contract said no). Everything else
// (timeout, network drop, rate-limit, decode error) is transient → worth retrying,
// NOT a "can't sell" skip. Used to classify sell failures correctly.
function _isRevert(e) { return !!(e && e.code === 'CALL_EXCEPTION'); }
// Gas-price overrides by mode:
//   'auto'  → {} (ethers decides — safest if txs ever get stuck)
//   'cheap' → pay the network BASE-FEE with no tip (cheapest that still confirms)
//   'fixed' → pay exactly gasGwei, floored UP to the base-fee so it never sits
// Reads the latest block's baseFeePerGas (the true floor); falls back to
// getFeeData / a tiny default if the chain doesn't report one.
async function gasOverrides(provider) {
  if (CFG.gasMode === 'auto') return {};
  let floor = 0n;
  try { const blk = await provider.getBlock('latest'); if (blk && blk.baseFeePerGas) floor = blk.baseFeePerGas; } catch (_) {}
  if (floor === 0n) { try { const fd = await provider.getFeeData(); floor = fd.gasPrice || 0n; } catch (_) {} }
  if (CFG.gasMode === 'cheap') {
    const gp = floor > 0n ? floor : ethers.parseUnits('0.01', 'gwei');
    return { gasPrice: gp };
  }
  // 'fixed': honour the chosen gwei but never below the floor (else it sits).
  const want = ethers.parseUnits(String(CFG.gasGwei > 0 ? CFG.gasGwei : 0.01), 'gwei');
  return { gasPrice: (floor > 0n && floor > want) ? floor : want };
}
// Returns TRUE only when the allowance is CONFIRMED sufficient on-chain. If it has to
// send an approve and that approve doesn't confirm in time, returns FALSE so the caller
// treats it as a transient retry (selling before the allowance lands would just revert).
async function ensureApprove(wallet, ca, spender, amount) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const cur = await erc.allowance(wallet.address, spender).catch(() => 0n);
  if (cur >= amount) return true;
  const gas = await gasOverrides(wallet.provider || null);
  const tx = await erc.approve(spender, ethers.MaxUint256, gas);
  return !!(await waitBounded(tx));   // bounded; false = broadcast but not yet confirmed
}

// Buy `ethAmount` ETH of token `ca` from `wallet`. Curve buy while bonding,
// Uniswap swap once graduated. Returns {ok, venue, hash, pending} | throws.
// IMPORTANT: `ethAmount` is a HUMAN ETH amount (string/number like "0.01"), NOT
// wei — this parses it. Never pass ethers.parseEther(...) here (that double-parses
// into an astronomically large value → "insufficient funds").
async function botBuy(wallet, provider, ca, ethAmount) {
  const value = ethers.parseEther(String(ethAmount));
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const gas = await gasOverrides(provider);
  const curveAddr = await resolveCurve(provider, ca);
  const grad = curveAddr ? await isGraduated(provider, curveAddr) : true;
  if (curveAddr && !grad) {
    const tx = await new ethers.Contract(curveAddr, CURVE_ABI, wallet).buy(0n, deadline, { value, ...gas });
    return { ok: true, venue: 'curve', hash: tx.hash, pending: !(await waitBounded(tx)) };
  }
  const tx = await new ethers.Contract(CFG.dexRouter, ROUTER_ABI, wallet)
    .swapExactETHForTokensSupportingFeeOnTransferTokens(0n, [CFG.weth, ca], wallet.address, deadline, { value, ...gas });
  return { ok: true, venue: 'dex', hash: tx.hash, pending: !(await waitBounded(tx)) };
}

// Sell `pct`% (1-100) of the wallet's balance of token `ca`. Auto-routes and — the
// important part — SIMULATES the sell before sending, then falls back to the other
// venue, so a position that simply CAN'T be sold right now (no liquidity yet, curve
// rejects, dust) is reported as a quiet SKIP instead of burning gas and surfacing as
// a scary "error". `route` (from resolveRoute) can be passed to avoid re-resolving
// per wallet. Returns rich data for the report:
//   { ok, venue, hash, pending, tokensSold, expEthWei, proceedsWei, remaining }
//   | { skip, reason }              (nothing to sell / can't sell now — NORMAL)
//   | { error, retryable }          (approve/RPC/race — soft, don't alarm)
async function botSell(wallet, provider, ca, pct, route) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  let bal;
  try { bal = await retry(() => erc.balanceOf(wallet.address), 3); } catch (e) { return { error: e.shortMessage || e.message, retryable: true }; }   // retry: a flaky 0/throw must not falsely skip a real bag
  const p = Math.max(1, Math.min(100, Math.round(Number(pct) || 0)));
  const amount = (bal * BigInt(p)) / 100n;
  if (amount <= 0n) return { skip: true, reason: 'saldo token 0' };

  if (route === undefined) route = await resolveRoute(provider, ca);
  if (!route) return { error: 'route tak terbaca (RPC)', retryable: true };

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const gas = await gasOverrides(provider);
  const onCurve = !!(route.curve && !route.graduated);
  const candidates = onCurve ? ['curve', 'dex'] : ['dex'];   // bonding → curve first (dex fallback); graduated → dex only
  const ethBefore = await provider.getBalance(wallet.address).catch(() => null);

  let lastErr = null, sawRevert = false, sawTransient = false;
  for (const venue of candidates) {
    const spender = venue === 'curve' ? route.curve : CFG.dexRouter;
    let expOut = 0n;
    if (venue === 'dex') {
      // DEX quote (getAmountsOut) is a pure VIEW — no allowance needed. Quote FIRST
      // so a token with no pool is skipped cheaply, without wasting an approve tx.
      try { const a = await new ethers.Contract(CFG.dexRouter, ROUTER_ABI, provider).getAmountsOut(amount, [ca, CFG.weth]); expOut = a[a.length - 1]; }
      catch (e) { lastErr = e.shortMessage || e.reason || e.message; if (_isRevert(e)) sawRevert = true; else sawTransient = true; continue; }
      if (!(expOut > 0n)) { lastErr = 'quote 0 (tanpa likuiditas)'; sawRevert = true; continue; }
      let appr = false;
      try { appr = await ensureApprove(wallet, ca, spender, amount); }
      catch (e) { lastErr = 'approve gagal: ' + (e.shortMessage || e.message); sawTransient = true; continue; }
      if (!appr) { lastErr = 'approve belum konfirmasi'; sawTransient = true; continue; }
    } else {
      // curve.sell pulls tokens via transferFrom → allowance required even to
      // staticCall, so approve (and CONFIRM it) FIRST, then simulate.
      let appr = false;
      try { appr = await ensureApprove(wallet, ca, spender, amount); }
      catch (e) { lastErr = 'approve gagal: ' + (e.shortMessage || e.message); sawTransient = true; continue; }
      if (!appr) { lastErr = 'approve belum konfirmasi'; sawTransient = true; continue; }
      try { expOut = await new ethers.Contract(route.curve, CURVE_ABI, wallet).sell.staticCall(amount, 0n, deadline); }
      catch (e) { lastErr = e.shortMessage || e.reason || e.message; if (_isRevert(e)) sawRevert = true; else sawTransient = true; continue; }
      if (!(expOut > 0n)) { lastErr = 'quote 0'; sawRevert = true; continue; }
    }
    // 10% floor from a FRESH sim (was 0n = drainable). Sequential loop → sim≈send.
    const minOut = (expOut * 90n) / 100n;
    let tx;
    try {
      if (venue === 'curve') tx = await new ethers.Contract(route.curve, CURVE_ABI, wallet).sell(amount, minOut, deadline, gas);
      else tx = await new ethers.Contract(CFG.dexRouter, ROUTER_ABI, wallet).swapExactTokensForETHSupportingFeeOnTransferTokens(amount, minOut, [ca, CFG.weth], wallet.address, deadline, gas);
    } catch (e) { lastErr = e.shortMessage || e.reason || e.message; if (_isRevert(e)) sawRevert = true; else sawTransient = true; continue; }   // pre-broadcast fail → try the other venue
    // Wait for the receipt INSIDE try/catch: a mined-but-reverted sell (status 0,
    // exactly what the 10% floor can trigger) throws CALL_EXCEPTION — it must NOT
    // escape botSell (that would abort the whole batch). Tokens didn't move on a
    // revert, so it's safe to try the other venue / retry next cycle.
    let rc;
    try { rc = await waitBounded(tx); }
    catch (we) {
      if (_isRevert(we)) { lastErr = 'sell reverted on-chain'; sawRevert = true; continue; }   // reverted → tokens intact → next venue
      // Ambiguous (network dropped while waiting): the tx MAY have landed. Report as
      // pending and do NOT re-send (avoid double-selling the bag).
      let rem = bal; try { rem = await erc.balanceOf(wallet.address); } catch (_) {}
      return { ok: true, venue, hash: tx.hash, pending: true, tokensSold: amount, expEthWei: expOut, proceedsWei: 0n, remaining: rem };
    }
    const pending = !rc;
    let proceedsWei = 0n, remaining = 0n;
    try { const after = await provider.getBalance(wallet.address); if (ethBefore != null && after > ethBefore) proceedsWei = after - ethBefore; } catch (_) {}
    try { remaining = await erc.balanceOf(wallet.address); } catch (_) {}
    return { ok: true, venue, hash: tx.hash, pending, tokensSold: amount, expEthWei: expOut, proceedsWei, remaining };
  }
  // Nothing filled. A transient (RPC/approve/network) failure is a soft RETRY; a pure
  // on-chain revert / no-liquidity is a quiet SKIP. Never a scary error.
  if (sawTransient) return { error: lastErr, retryable: true };
  return { skip: true, reason: sawRevert ? 'tak bisa dijual sekarang (tanpa likuiditas / curve tolak)' : (lastErr || 'tak bisa dijual') };
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
// Each of `sellers` sells `pct`% of its `ca` balance (for scheduled dumps). Resolves
// the route + token metadata ONCE (not per wallet) and returns rich rows.
async function sellHoldings(provider, sellers, ca, pct) {
  const route = await resolveRoute(provider, ca);
  const meta = await tokenMeta(provider, ca).catch(() => ({ name: '', symbol: '', decimals: 18 }));
  const out = [];
  for (const w of sellers) {
    if (!route) { out.push({ ca, ...meta, address: w.address, error: 'route tak terbaca (RPC)', retryable: true }); continue; }
    let r; try { r = await botSell(w, provider, ca, pct, route); } catch (e) { r = { error: e.shortMessage || e.message, retryable: true }; }   // isolate: one wallet can never abort the batch
    out.push({ ca, ...meta, address: w.address, ...r });
  }
  return out;
}
// Sell `pct`% of EVERY wallet's balance across ALL token CAs in `cas`. botSell reads
// the balance first (cheap) and skips wallets holding nothing; the route + metadata
// are resolved ONCE per token (not per wallet) to cut RPC load. Used by the auto-sale
// loop and /dumpall. Returns rich rows: { ca, name, symbol, decimals, address,
// ok|skip|error, venue, hash, tokensSold, proceedsWei, remaining, ... }.
async function sellAllHoldings(provider, wallets, cas, pct) {
  const out = [];
  for (const ca of cas) {
    if (!ca || !ethers.isAddress(ca)) continue;
    const route = await resolveRoute(provider, ca);
    const meta = await tokenMeta(provider, ca).catch(() => ({ name: '', symbol: '', decimals: 18 }));
    if (!route) { out.push({ ca, ...meta, tokenSkip: true, error: 'route tak terbaca (RPC)', retryable: true }); continue; }
    for (const w of wallets) {
      let r; try { r = await botSell(w, provider, ca, pct, route); } catch (e) { r = { error: e.shortMessage || e.message, retryable: true }; }   // isolate: one wallet/token can never abort the batch
      out.push({ ca, ...meta, address: w.address, ...r });
    }
  }
  return out;
}

// REACT-TO-BUY (market-maker / seed recovery). For each BONDING token we hold,
// scan new Buy events; if REAL (non-bot) buyers bought ≥ reactMinUsd since the
// last check, sell reactSellPct% from the wallet with the biggest bag — capped
// at reactMaxCount hits/token so it recovers seed capital + small profit WITHOUT
// fully dumping (a real holder never gets rugged; we always leave liquidity).
// `st` is a persisted map { [ca]: { last: block, hits: n } } (mutated in place).
// Returns { actions:[{ca,wallet,pct,realUsd,hits,hash}|{ca,error}], scanned }.
async function reactToBuys(provider, wallets, st) {
  st = st || {};
  const mine = new Set(wallets.map((w) => w.address.toLowerCase()));
  const owned = await ownedTokens(provider, wallets);
  if (!owned.length) return { actions: [], scanned: 0 };
  let head = 0;
  try { head = await provider.getBlockNumber(); } catch (_) { return { actions: [], scanned: 0 }; }
  const usd = await ethUsd();
  const minEth = usd > 0 ? CFG.reactMinUsd / usd : 0.01;
  const actions = [];
  for (const { ca } of owned) {
    // First time we see a token, baseline at the current head so we only react to
    // buys that arrive AFTER react-mode was enabled (never backfill into old buys).
    const rec = st[ca] || { last: head, hits: 0 };
    st[ca] = rec;
    if (rec.hits >= CFG.reactMaxCount) continue;            // budget spent: keep the rest, never full-dump
    const curve = await resolveCurve(provider, ca);
    if (!curve) continue;
    if (await isGraduated(provider, curve)) continue;       // only react while bonding
    const from = Math.min(rec.last + 1, head);
    if (from > head) continue;
    let logs = [];
    try { const c = new ethers.Contract(curve, CURVE_ABI, provider); logs = await c.queryFilter(c.filters.Buy(), from, head); }
    catch (_) { rec.last = head; continue; }
    rec.last = head;
    let realEth = 0n;
    for (const ev of logs) {
      const a = ev.args || {};
      const trader = String(a.trader || '').toLowerCase();
      const recip = String(a.recipient || '').toLowerCase();
      if (mine.has(trader) || mine.has(recip)) continue;    // our own buy: ignore
      realEth += a.grossEth || 0n;
    }
    const realUsd = Number(ethers.formatEther(realEth)) * usd;
    if (Number(ethers.formatEther(realEth)) < minEth) continue;
    // sell reactSellPct% from the wallet holding the most of this token
    let best = null, bestBal = 0n;
    for (const w of wallets) {
      const b = await new ethers.Contract(ca, ERC20_ABI, provider).balanceOf(w.address).catch(() => 0n);
      if (b > bestBal) { bestBal = b; best = w; }
    }
    if (!best || bestBal <= 0n) continue;
    try {
      const r = await botSell(best, provider, ca, CFG.reactSellPct);
      // Only a REAL sale burns a react "hit" — a skip/soft-error must not exhaust the
      // capped budget (else the bot stops reacting to genuine buyers after a few RPC blips).
      if (r.ok) { rec.hits += 1; actions.push({ ca, wallet: best.address, pct: CFG.reactSellPct, realUsd, hits: rec.hits, hash: r.hash }); }
      else if (r.error && !r.retryable) actions.push({ ca, error: r.error });
    } catch (e) { actions.push({ ca, error: e.shortMessage || e.message }); }
  }
  return { actions, scanned: owned.length };
}

// ANTI-GRADUATION guard. Bot tokens must NEVER graduate (graduation burns the LP
// = ~23% loss). For every bot-held BONDING token, read how much ETH the curve has
// collected toward the ~2.6 graduation cap; if it reaches ceilingEth, sell 100%
// of the bot's holdings across all wallets to pull the pool back down. Only ever
// touches tokens the bot created/holds (ownedTokens filters by creator). After a
// full sell the bot holds nothing, so it won't fire again unless the pool climbs
// back. Returns [{ ca, collected, target, sold }] for tokens it acted on.
async function capGuard(provider, wallets, ceilingEth) {
  const owned = await ownedTokens(provider, wallets);
  const out = [];
  for (const { ca } of owned) {
    const curve = await resolveCurve(provider, ca);
    if (!curve) continue;
    const c = new ethers.Contract(curve, CURVE_ABI, provider);
    try { if (await c.graduated()) continue; } catch (_) { continue; }   // already graduated: too late, skip
    let collected = 0, target = 0;
    try { const p = await c.graduationProgress(); collected = Number(ethers.formatEther(p.collected ?? p[0])); target = Number(ethers.formatEther(p.target ?? p[1])); }
    catch (_) { continue; }
    if (collected >= ceilingEth) {
      const res = await sellHoldings(provider, wallets, ca, 100);   // dump the bot's whole bag
      const sold = res.filter((r) => r.ok).length;
      if (sold > 0) out.push({ ca, collected, target, sold });
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

// Every ERC-20 token the wallets CURRENTLY HOLD (balance > 0), read from the
// explorer's tokenlist API. Unlike ownedTokens (which filters by creator), this
// catches tokens a wallet holds but did NOT create — e.g. bought via react-to-buy,
// or another of our wallets' launches — so /dumpall can actually sell them.
// Returns [{ ca, holders:[address…] }]. Best-effort; falls back to [] if the
// explorer is down (callers union this with ownedTokens so nothing is lost).
async function heldTokens(provider, wallets) {
  // Tolerate a legacy (wallets)-only call: skip on-chain verification, use explorer.
  if (Array.isArray(provider) && !wallets) { wallets = provider; provider = null; }
  const api = (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com/api').replace(/\/+$/, '');
  const byCa = new Map();
  await mapLimit(wallets, 5, async (w) => {
    try {
      const j = await retry(async () => (await (await fetch(`${api}?module=account&action=tokenlist&address=${w.address}`, { signal: AbortSignal.timeout(12000) })).json()), 3);
      if (!Array.isArray(j.result)) return;
      for (const t of j.result) {
        const ca = t.contractAddress || t.contractaddress;
        let bal = 0n; try { bal = BigInt(t.balance || '0'); } catch (_) {}
        if (!ca || !ethers.isAddress(ca) || bal <= 0n) continue;
        const k = ca.toLowerCase();
        if (!byCa.has(k)) byCa.set(k, { ca, symbol: t.symbol || '', name: t.name || '', decimals: Number(t.decimals || 18), holders: [], totalRaw: 0n });
        const e = byCa.get(k);
        e.holders.push({ address: w.address, balanceRaw: bal });
      }
    } catch (_) {}
  });
  // VERIFY on-chain (retry): the explorer index LAGS — it can still list a token
  // that was already sold (balance now 0), and a flaky read must not drop a real
  // one. Trust the live balance; if the read genuinely fails, keep the explorer's.
  const rows = [...byCa.values()];
  if (provider) {
    await mapLimit(rows, 6, async (t) => {
      const erc = new ethers.Contract(t.ca, ERC20_ABI, provider);
      const verified = []; let total = 0n;
      for (const h of t.holders) {
        let live; try { live = await retry(() => erc.balanceOf(h.address), 3); } catch (_) { live = h.balanceRaw; }   // read failed → trust explorer
        if (live > 0n) { verified.push({ address: h.address, balanceRaw: live }); total += live; }
      }
      t.holders = verified; t.totalRaw = total;
    });
    return rows.filter((t) => t.totalRaw > 0n);   // drop phantom (already-sold) tokens
  }
  for (const t of rows) t.totalRaw = t.holders.reduce((s, h) => s + h.balanceRaw, 0n);
  return rows;
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
// Retry a flaky read a few times — the Robinhood RPC drops/ times out reads under
// load, and without a retry a scan silently loses tokens (50 of 171). Throws the
// last error only after all attempts fail.
async function retry(fn, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (e) { last = e; } }
  throw last;
}

// Enumerate EVERY token on the factory (via allTokens, not the bot's capped
// memory), keep those whose on-chain creator() is one of OUR wallets, and read
// each one's creatorOwed. This is chain-truth, so it finds fees on OLD tokens the
// bot's /last list dropped. Returns [{ ca, creator, owedWei }] (owed can be 0).
async function ownedTokens(provider, wallets) {
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);
  const fr = new ethers.Contract(CFG.feeRouter, FEEROUTER_ABI, provider);
  const mine = new Set(wallets.map((w) => w.address.toLowerCase()));
  let len = 0; try { len = Number(await retry(() => factory.allTokensLength())); } catch (_) { const r = []; Object.defineProperty(r, 'scanFailed', { value: -1, enumerable: false }); Object.defineProperty(r, 'scanTotal', { value: 0, enumerable: false }); return r; }
  const idxs = Array.from({ length: len }, (_, i) => i);
  let failed = 0;   // reads that still failed after retries → tokens we could NOT check
  const cas = (await mapLimit(idxs, 8, async (i) => { try { return await retry(() => factory.allTokens(i)); } catch (_) { failed++; return null; } })).filter(Boolean);
  const rows = await mapLimit(cas, 8, async (ca) => {
    try {
      const [creator, owed] = await Promise.all([
        retry(() => new ethers.Contract(ca, ['function creator() view returns (address)'], provider).creator()),
        retry(() => fr.creatorOwed(ca)),
      ]);
      if (!mine.has(String(creator).toLowerCase())) return null;
      return { ca, creator, owedWei: owed };
    } catch (_) { failed++; return null; }
  });
  const result = rows.filter(Boolean);
  // Non-enumerable so callers that treat this as a plain array (.map/.filter/.reduce)
  // are unaffected, but /dumpall & co. can warn when a scan was incomplete.
  Object.defineProperty(result, 'scanTotal', { value: len, enumerable: false });
  Object.defineProperty(result, 'scanFailed', { value: failed, enumerable: false });
  return result;
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
  resolveCurve, isGraduated, resolveRoute, tokenMeta, botBuy, botSell, seedVolume, sellHoldings, sellAllHoldings, randEthStr,
  creatorEarnings, claimCreator, protocolPending, treasuryInfo, tokenBalance, detectDeposits, walletCashflow,
  mapLimit, ownedTokens, heldTokens, creatorOwedTotal, tokenPnl, reactToBuys, gasOverrides, capGuard,
};
