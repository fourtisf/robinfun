'use strict';
/*
 * Robinfun Trade Bot — engine (chain + custody + trading + referrals).
 *
 * A custodial, Maestro-style Telegram trading bot for Robinhood Chain: every user
 * gets a bot-managed wallet, deposits ETH, and buys/sells any Robinfun token by
 * pasting its contract address. Buys/sells route to the bonding curve while the
 * token is on the curve, and to Uniswap V2 once it has graduated — identical to
 * the on-site trade path.
 *
 * SECURITY (custodial): each user's private key is encrypted at rest with
 * AES-256-GCM under WALLET_SECRET (never stored or logged in plaintext). Keys are
 * only ever decrypted transiently to sign a transaction the user asked for.
 * Withdrawals require the user to type the destination; nothing moves without an
 * explicit user action.
 */
const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- config
const CFG = {
  tgToken:   (process.env.TRADEBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  rpc:       (process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com').trim(),
  chainId:   Number(process.env.CHAIN_ID || 4663),
  factory:   (process.env.FACTORY_ADDR || '0xf0a093bc6ab5bb408ca1f084ec2161d879edaa57').trim(),
  dexRouter: (process.env.DEX_ROUTER  || '0x89e5db8b5aa49aa85ac63f691524311aeb649eba').trim(),
  weth:      (process.env.WETH        || '0x0bd7d308f8e1639fab988df18a8011f41eacad73').trim(),
  explorer:  (process.env.EXPLORER || 'https://explorer.mainnet.chain.robinhood.com').replace(/\/+$/, ''),
  site:      (process.env.SITE || 'https://robinfun.io').replace(/\/+$/, ''),
  // Gas: 'cheap' pays the base-fee floor (no tip), 'fixed' pays GAS_GWEI, 'auto'
  // lets ethers decide. Robinhood Chain is an L2 — cheap is fine.
  gasMode:   (process.env.GAS_MODE || 'cheap').trim(),
  gasGwei:   Number(process.env.GAS_GWEI || 0.01),
  // Revenue: a flat bot fee on the ETH value of each trade → FEE_WALLET. Referrers
  // earn REF_SHARE_BPS of that fee. Default 1% fee, 30% of it to the referrer.
  feeBps:      Math.min(500, Math.max(0, Number(process.env.BOT_FEE_BPS || 100))),
  refShareBps: Math.min(10000, Math.max(0, Number(process.env.REF_SHARE_BPS || 3000))),
  feeWallet:   (process.env.FEE_WALLET || '').trim(),
  // Encryption master key for custodial private keys (REQUIRED in production).
  walletSecret: (process.env.WALLET_SECRET || '').trim(),
  dataDir:   (process.env.DATA_DIR || path.join(__dirname, 'data')).trim(),
  admins:    (process.env.TRADEBOT_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Gas buffer kept back on a "buy MAX" so the sell/withdraw later never strands.
  gasBufferEth: String(process.env.GAS_BUFFER_ETH || '0.0004'),
};

const FACTORY_ABI = [
  'function curveOf(address token) view returns (address)',
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
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];

// ---------------------------------------------------------------- provider
let _p = null;
function provider() {
  if (!_p) {
    const net = new ethers.Network('Robinhood Chain', CFG.chainId);
    _p = new ethers.JsonRpcProvider(CFG.rpc, net, { batchMaxCount: 1, staticNetwork: net });
  }
  return _p;
}

// ---------------------------------------------------------------- crypto (custodial keys)
// AES-256-GCM. Key = scrypt(WALLET_SECRET). Blob = base64(iv | tag | ciphertext).
function _key() {
  if (!CFG.walletSecret || CFG.walletSecret.length < 16) {
    throw new Error('WALLET_SECRET missing/too short — refusing to manage custodial keys');
  }
  return crypto.scryptSync(CFG.walletSecret, 'robinfun-tradebot-v1', 32);
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decrypt(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', _key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- store (JSON, atomic)
const STORE_FILE = path.join(CFG.dataDir, 'tradebot.json');
let DB = { users: {}, refByCode: {} };
function loadStore() {
  try { DB = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); }
  catch (_) { DB = { users: {}, refByCode: {} }; }
  if (!DB.users) DB.users = {};
  if (!DB.refByCode) DB.refByCode = {};
}
let _saveTimer = null;
function saveStore() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      fs.mkdirSync(CFG.dataDir, { recursive: true });
      const tmp = STORE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(DB));
      fs.renameSync(tmp, STORE_FILE);   // atomic replace
    } catch (e) { console.error('saveStore', e.message); }
  }, 400);
}
function allUsers() { return Object.values(DB.users); }
function getUser(chatId) { return DB.users[String(chatId)] || null; }

// ---------------------------------------------------------------- wallet (custodial)
function _refCode() {
  let c;
  do { c = crypto.randomBytes(4).toString('hex'); } while (DB.refByCode[c]);
  return c;
}
// Create the user's wallet on first touch. referredBy = a referral code (optional).
function ensureUser(chatId, referredBy) {
  const id = String(chatId);
  let u = DB.users[id];
  if (u) return u;
  const w = ethers.Wallet.createRandom();
  const code = _refCode();
  u = {
    chatId: id,
    address: w.address,
    enc: encrypt(w.privateKey),
    refCode: code,
    referredBy: (referredBy && DB.refByCode[referredBy] && DB.refByCode[referredBy] !== id) ? referredBy : null,
    createdAt: Date.now(),
    positions: {},        // caLower -> { ca, name, sym, ethIn, ethOut, tokens (last-known), realizedEth }
    orders: [],           // { id, type:'tp'|'sl'|'limitbuy', ca, ... }
    snipe: { on: false, ethAmount: '0.01' },
    refEarnedEth: 0,
    settings: { buyPreset: ['0.01', '0.05', '0.1', '0.5'], slippage: 0 },
  };
  DB.users[id] = u;
  DB.refByCode[code] = id;
  saveStore();
  return u;
}
// Transient signer — decrypt only to sign, never persist the plaintext key.
function signerFor(chatId) {
  const u = getUser(chatId);
  if (!u) throw new Error('no wallet');
  return new ethers.Wallet(decrypt(u.enc), provider());
}
// One-time key export (user explicitly asks). Returns the plaintext key.
function exportKey(chatId) {
  const u = getUser(chatId);
  if (!u) throw new Error('no wallet');
  return decrypt(u.enc);
}

// ---------------------------------------------------------------- chain reads
async function resolveCurve(ca) {
  try { const c = await new ethers.Contract(CFG.factory, FACTORY_ABI, provider()).curveOf(ca); return (c && c !== ethers.ZeroAddress) ? c : ''; }
  catch (_) { return ''; }
}
async function isGraduated(curveAddr) {
  try { return await new ethers.Contract(curveAddr, CURVE_ABI, provider()).graduated(); } catch (_) { return false; }
}
async function tokenMeta(ca) {
  const erc = new ethers.Contract(ca, ERC20_ABI, provider());
  let name = 'Token', sym = 'TOKEN';
  try { const [n, s] = await Promise.all([erc.name(), erc.symbol()]); if (n) name = n; if (s) sym = s; } catch (_) {}
  return { name, sym };
}
async function ethBalance(addr) { try { return await provider().getBalance(addr); } catch (_) { return 0n; } }
async function tokenBalance(ca, addr) { try { return await new ethers.Contract(ca, ERC20_ABI, provider()).balanceOf(addr); } catch (_) { return 0n; } }
async function ethUsd() {
  try { const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { signal: AbortSignal.timeout(6000) }); const j = await r.json(); const p = Number(j?.data?.amount); return p > 0 ? p : 0; }
  catch (_) { return 0; }
}
// Live token snapshot: price (ETH), mcap (ETH), graduated, graduation %.
async function tokenSnapshot(ca) {
  const curve = await resolveCurve(ca);
  if (!curve) return null;
  const c = new ethers.Contract(curve, CURVE_ABI, provider());
  const out = { ca, curve, priceEth: 0, mcapEth: 0, graduated: false, progressPct: 0 };
  try { out.graduated = await c.graduated(); } catch (_) {}
  try { out.priceEth = Number(ethers.formatEther(await c.currentPrice())); } catch (_) {}
  try { out.mcapEth = Number(ethers.formatEther(await c.marketCapEth())); } catch (_) {}
  try { const [col, tgt] = await c.graduationProgress(); out.progressPct = tgt > 0n ? Number(col) / Number(tgt) * 100 : 0; } catch (_) {}
  return out;
}

// ---------------------------------------------------------------- gas
async function gasOverrides() {
  if (CFG.gasMode === 'auto') return {};
  let floor = 0n;
  try { const blk = await provider().getBlock('latest'); if (blk && blk.baseFeePerGas) floor = blk.baseFeePerGas; } catch (_) {}
  if (floor === 0n) { try { const fd = await provider().getFeeData(); floor = fd.gasPrice || 0n; } catch (_) {} }
  if (CFG.gasMode === 'cheap') return { gasPrice: floor > 0n ? floor : ethers.parseUnits('0.01', 'gwei') };
  const want = ethers.parseUnits(String(CFG.gasGwei > 0 ? CFG.gasGwei : 0.01), 'gwei');
  return { gasPrice: (floor > 0n && floor > want) ? floor : want };
}
async function waitBounded(tx) { try { return await tx.wait(1, 180000); } catch (e) { if (e && e.code === 'TIMEOUT') return null; throw e; } }
async function ensureApprove(wallet, ca, spender, amount) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const cur = await erc.allowance(wallet.address, spender).catch(() => 0n);
  if (cur < amount) { const gas = await gasOverrides(); const tx = await erc.approve(spender, ethers.MaxUint256, gas); await tx.wait(); }
}

// ---------------------------------------------------------------- fee + referral
async function _chargeFee(wallet, feeWei) {
  if (feeWei <= 0n || !CFG.feeWallet || !/^0x[0-9a-fA-F]{40}$/.test(CFG.feeWallet)) return null;
  try { const gas = await gasOverrides(); const tx = await wallet.sendTransaction({ to: CFG.feeWallet, value: feeWei, ...gas }); waitBounded(tx); return tx.hash; }
  catch (e) { console.error('fee charge failed', e.message); return null; }
}
function _creditReferral(user, feeWei) {
  if (!user.referredBy || feeWei <= 0n) return;
  const refId = DB.refByCode[user.referredBy];
  const ref = refId && DB.users[refId];
  if (!ref) return;
  const share = (feeWei * BigInt(CFG.refShareBps)) / 10000n;
  ref.refEarnedEth = (ref.refEarnedEth || 0) + Number(ethers.formatEther(share));
  ref._refOwedWei = ((BigInt(ref._refOwedWei || '0')) + share).toString();   // accrued, admin-settled
  saveStore();
}

// ---------------------------------------------------------------- trade
// Buy `ethAmount` (human ETH string) of `ca` from the user's wallet. Fee is taken
// from the ETH value; the remainder buys. Routes curve→DEX automatically.
async function buy(chatId, ca, ethAmount) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const wallet = signerFor(chatId);
  const gross = ethers.parseEther(String(ethAmount));
  if (gross <= 0n) throw new Error('amount must be > 0');
  const bal = await ethBalance(wallet.address);
  const gasBuf = ethers.parseEther(CFG.gasBufferEth);
  if (bal < gross + gasBuf) throw new Error(`insufficient ETH — need ~${ethers.formatEther(gross + gasBuf)} incl. gas, have ${ethers.formatEther(bal)}`);
  const fee = (gross * BigInt(CFG.feeBps)) / 10000n;
  const spend = gross - fee;

  const curve = await resolveCurve(ca);
  const grad = curve ? await isGraduated(curve) : true;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const gas = await gasOverrides();
  const before = await tokenBalance(ca, wallet.address);

  let venue, hash;
  if (curve && !grad) {
    const tx = await new ethers.Contract(curve, CURVE_ABI, wallet).buy(0n, deadline, { value: spend, ...gas });
    venue = 'curve'; hash = tx.hash; await waitBounded(tx);
  } else {
    if (!curve) throw new Error('not a Robinfun token (no curve found)');
    const tx = await new ethers.Contract(CFG.dexRouter, ROUTER_ABI, wallet)
      .swapExactETHForTokensSupportingFeeOnTransferTokens(0n, [CFG.weth, ca], wallet.address, deadline, { value: spend, ...gas });
    venue = 'dex'; hash = tx.hash; await waitBounded(tx);
  }
  const after = await tokenBalance(ca, wallet.address);
  const got = after > before ? after - before : 0n;

  // Fee + referral (after a successful buy, so a failed buy never charges).
  const feeHash = await _chargeFee(wallet, fee);
  _creditReferral(u, fee);

  // Position accounting.
  const meta = await tokenMeta(ca);
  const key = ca.toLowerCase();
  const p = u.positions[key] || { ca, name: meta.name, sym: meta.sym, ethIn: 0, ethOut: 0, realizedEth: 0, tokens: '0' };
  p.name = meta.name; p.sym = meta.sym;
  p.ethIn += Number(ethers.formatEther(spend));
  p.tokens = after.toString();
  u.positions[key] = p;
  saveStore();

  return { venue, hash, feeHash, spentEth: Number(ethers.formatEther(spend)), feeEth: Number(ethers.formatEther(fee)), gotTokens: Number(ethers.formatUnits(got, 18)), sym: meta.sym };
}

// Sell `pct`% (1-100) of the user's balance of `ca`. Fee taken from ETH proceeds.
async function sell(chatId, ca, pct) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const wallet = signerFor(chatId);
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const bal = await erc.balanceOf(wallet.address);
  const p = Math.max(1, Math.min(100, Math.round(Number(pct) || 0)));
  const amount = (bal * BigInt(p)) / 100n;
  if (amount <= 0n) throw new Error('token balance is 0');

  const curve = await resolveCurve(ca);
  const grad = curve ? await isGraduated(curve) : true;
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const gas = await gasOverrides();
  const ethBefore = await ethBalance(wallet.address);

  let venue, hash;
  if (curve && !grad) {
    await ensureApprove(wallet, ca, curve, amount);
    const tx = await new ethers.Contract(curve, CURVE_ABI, wallet).sell(amount, 0n, deadline, gas);
    venue = 'curve'; hash = tx.hash; await waitBounded(tx);
  } else {
    if (!curve) throw new Error('not a Robinfun token (no curve found)');
    await ensureApprove(wallet, ca, CFG.dexRouter, amount);
    const tx = await new ethers.Contract(CFG.dexRouter, ROUTER_ABI, wallet)
      .swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0n, [ca, CFG.weth], wallet.address, deadline, gas);
    venue = 'dex'; hash = tx.hash; await waitBounded(tx);
  }
  const ethAfter = await ethBalance(wallet.address);
  const proceeds = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;   // net of gas, approximate
  const fee = (proceeds * BigInt(CFG.feeBps)) / 10000n;
  const feeHash = await _chargeFee(wallet, fee);
  _creditReferral(u, fee);

  const key = ca.toLowerCase();
  const pos = u.positions[key];
  if (pos) {
    pos.ethOut += Number(ethers.formatEther(proceeds - fee));
    pos.tokens = (await erc.balanceOf(wallet.address)).toString();
    pos.realizedEth = (pos.ethOut - pos.ethIn);
    if (pos.tokens === '0') pos.closed = true;
    saveStore();
  }
  return { venue, hash, feeHash, soldPct: p, proceedsEth: Number(ethers.formatEther(proceeds)), feeEth: Number(ethers.formatEther(fee)) };
}

// Send ETH out of the user's wallet to `to`. amount = human ETH, or 'max'.
async function withdraw(chatId, to, amount) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to || '').trim())) throw new Error('invalid destination address');
  const wallet = signerFor(chatId);
  const bal = await ethBalance(wallet.address);
  const gas = await gasOverrides();
  const gp = gas.gasPrice || ethers.parseUnits('0.01', 'gwei');
  const gasCost = gp * 21000n * 2n;   // headroom
  let value;
  if (String(amount).toLowerCase() === 'max') { value = bal - gasCost; }
  else { value = ethers.parseEther(String(amount)); }
  if (value <= 0n) throw new Error('nothing to withdraw (after gas)');
  if (value + gasCost > bal) throw new Error('amount exceeds balance after gas');
  const tx = await wallet.sendTransaction({ to: to.trim(), value, ...gas });
  await waitBounded(tx);
  return { hash: tx.hash, sentEth: Number(ethers.formatEther(value)) };
}

// Portfolio: live value + unrealized/realized PnL for every open position.
async function portfolio(chatId) {
  const u = getUser(chatId); if (!u) return { rows: [], totalValueEth: 0, address: null };
  const rows = [];
  let totalValueEth = 0;
  for (const key of Object.keys(u.positions)) {
    const p = u.positions[key];
    const balRaw = await tokenBalance(p.ca, u.address);
    const bal = Number(ethers.formatUnits(balRaw, 18));
    if (bal <= 1e-9 && !(p.ethIn > 0)) continue;
    const snap = await tokenSnapshot(p.ca).catch(() => null);
    const priceEth = snap ? snap.priceEth : 0;
    const valueEth = bal * priceEth;
    totalValueEth += valueEth;
    const unrealizedEth = valueEth - (p.ethIn - p.ethOut);
    rows.push({ ca: p.ca, name: p.name, sym: p.sym, tokens: bal, valueEth, ethIn: p.ethIn, ethOut: p.ethOut, unrealizedEth, realizedEth: p.realizedEth || 0, graduated: snap ? snap.graduated : false });
  }
  rows.sort((a, b) => b.valueEth - a.valueEth);
  return { rows, totalValueEth, address: u.address };
}

module.exports = {
  CFG, provider, FACTORY_ABI, CURVE_ABI, ERC20_ABI,
  loadStore, saveStore, allUsers, getUser, ensureUser, signerFor, exportKey,
  resolveCurve, isGraduated, tokenMeta, tokenSnapshot, ethBalance, tokenBalance, ethUsd, gasOverrides,
  buy, sell, withdraw, portfolio, DB,
};
