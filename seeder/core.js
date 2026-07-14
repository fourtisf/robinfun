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
  factory: (process.env.FACTORY_ADDR || '0xfa5c740aec9d91cebdc9844e5ca6591f309a5dd2').trim(),
  funderKey: (process.env.FUNDER_KEY || process.env.PRIVATE_KEY || '').trim(),
  numWallets: Math.min(20, Math.max(1, Number(process.env.NUM_WALLETS || 5))),
  walletFile: process.env.WALLET_FILE || path.join(__dirname, 'wallets.json'),
  backend: (process.env.BACKEND || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
  intervalSec: Math.max(5, Number(process.env.INTERVAL_SECONDS || 60)),
  devBuyEth: String(process.env.DEV_BUY_ETH || '0.001'),
  levyBps: Math.min(1000, Math.max(0, Number(process.env.CREATOR_LEVY_BPS || 100))),
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
};

const FACTORY_ABI = [
  'function createToken((string name,string symbol,string metadataURI,uint16 buyLevyBps,uint16 sellLevyBps,bool decayAtGraduation,bool renounceRateControl,uint256 devBuyMinTokensOut,bytes32 vanitySalt,uint256 maxDeployFee)) payable returns (address token, address curve)',
  'function deployFee() view returns (uint256)',
  'function betaMode() view returns (bool)',
  'function owner() view returns (address)',
  'function tradeAllowed(address) view returns (bool)',
  'function setBetaAllowed(address[] who, bool allowed)',
  'event TokenCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint16 buyLevyBps, uint16 sellLevyBps, bool decayAtGraduation, bool renounceRateControl, uint256 deployFee, uint256 devBuyEth)',
];

const CURVE_ABI = [
  'function marketCapEth() view returns (uint256)',
  'function currentPrice() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function graduationProgress() view returns (uint256 collected, uint256 target)',
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

// Launch one token from `wallet`. Returns a plain result object (no console I/O)
// so callers can format for the terminal or Telegram.
async function launchWith(wallet, provider, deployFee, devBuy) {
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, wallet);
  const { name, ticker } = genName();
  const meme = await fetchMeme();
  const value = deployFee + devBuy;
  const params = {
    name, symbol: ticker, metadataURI: '',
    buyLevyBps: CFG.levyBps, sellLevyBps: CFG.levyBps,
    decayAtGraduation: false, renounceRateControl: false,
    devBuyMinTokensOut: 0n, vanitySalt: ethers.ZeroHash, maxDeployFee: deployFee,
  };
  if (CFG.dryRun) return { ok: true, dry: true, name, ticker, memeSrc: meme ? meme.src : null, creator: wallet.address };

  let receipt;
  try { const tx = await factory.createToken(params, { value }); receipt = await tx.wait(); }
  catch (e) { return { ok: false, name, ticker, creator: wallet.address, error: e.shortMessage || e.reason || e.message }; }

  let ca = '', curve = '';
  for (const lg of receipt.logs) { try { const p = factory.interface.parseLog(lg); if (p && p.name === 'TokenCreated') { ca = p.args.token; curve = p.args.curve; break; } } catch (_) {} }
  const gasCostWei = receipt.gasUsed * (receipt.gasPrice || 0n);

  const posted = await postMeta({
    name, ticker, ca,
    description: (meme && meme.title ? meme.title : `${name} — a Robinfun fair launch`).slice(0, 280),
    buyFee: CFG.levyBps / 100, sellFee: CFG.levyBps / 100,
    creator: wallet.address, logo: meme ? meme.dataUrl : undefined,
  });

  return { ok: true, name, ticker, ca, curve, gasCostWei, txHash: receipt.hash, posted, memeSrc: meme ? meme.src : null, creator: wallet.address };
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

module.exports = {
  ethers, CFG, FACTORY_ABI, CURVE_ABI, INBOX_ABI, makeProvider,
  genName, fetchMeme, postMeta, loadOrCreateWallets,
  launchWith, readDeployFee, checkBeta, sweepAll, fmt, sleep,
  ethUsd, tokenStats,
  makeL1Provider, verifyInbox, bridgeOne,
};
