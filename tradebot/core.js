'use strict';
/*
 * Robinfun Trade Bot — engine (multi-chain: chain + custody + trading + referrals).
 *
 * Custodial Telegram trading bot. One EVM key per user = the SAME address on every
 * supported chain (Robinhood Chain, Ethereum, Base, BNB Chain, Arbitrum — see
 * chains.js). On Robinhood Chain trades route to the Robinfun bonding curve while a
 * token is listed and to the DEX once graduated; on every other chain trades go
 * straight to that chain's Uniswap-V2-style DEX (any token, by contract address).
 *
 * SECURITY (custodial): private keys are AES-256-GCM encrypted at rest under
 * WALLET_SECRET and only decrypted transiently to sign a trade the user asked for.
 * Every trade sends a real minimum-out (never 0) so a sandwich bot can't drain it.
 */
const { ethers } = require('ethers');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const chains = require('./chains');
const { providerFor, chainOf, isEnabled, DEFAULT_CHAIN } = chains;

// Load tradebot/.env (KEY=VALUE lines) into process.env BEFORE config is read.
// Zero-dependency, no dotenv. A real environment variable ALWAYS wins over the
// file (we only fill values that are unset), so pm2 --update-env / systemd env
// still override. Keeps secrets (TRADEBOT_TOKEN, WALLET_SECRET) out of git.
(function loadDotEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) { /* never let env parsing crash the bot */ }
})();

// ---------------------------------------------------------------- config
const CFG = {
  tgToken:   (process.env.TRADEBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  site:      (process.env.SITE || 'https://robinfun.io').replace(/\/+$/, ''),
  gasMode:   (process.env.GAS_MODE || 'cheap').trim(),   // robinhood only; other chains use auto
  gasGwei:   Number(process.env.GAS_GWEI || 0.01),
  feeBps:      Math.min(500, Math.max(0, Number(process.env.BOT_FEE_BPS || 100))),
  refShareBps: Math.min(10000, Math.max(0, Number(process.env.REF_SHARE_BPS || 3000))),
  feeWallet:   (process.env.FEE_WALLET || '').trim(),
  feeWalletKey: (process.env.FEE_WALLET_KEY || '').trim(),   // OPTIONAL: enables referral auto-payout (hot key)
  walletSecret: (process.env.WALLET_SECRET || '').trim(),
  dataDir:   (process.env.DATA_DIR || path.join(__dirname, 'data')).trim(),
  admins:    (process.env.TRADEBOT_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
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
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
];

// ---------------------------------------------------------------- crypto (custodial keys)
function _key() {
  if (!CFG.walletSecret || CFG.walletSecret.length < 16) throw new Error('WALLET_SECRET missing/too short — refusing to manage custodial keys');
  return crypto.scryptSync(CFG.walletSecret, 'robinfun-tradebot-v1', 32);
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', _key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', _key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- store (JSON, atomic)
const STORE_FILE = path.join(CFG.dataDir, 'tradebot.json');
let DB = { users: {}, refByCode: {} };
function loadStore() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (_) { parsed = {}; }
  // Mutate the existing DB object in place (never reassign the binding) so the
  // exported reference (module.exports.DB) stays valid after a (re)load.
  DB.users = (parsed && parsed.users) || {};
  DB.refByCode = (parsed && parsed.refByCode) || {};
  wireShutdownFlush();
}
let _saveTimer = null;
function _writeNow() {
  try {
    fs.mkdirSync(CFG.dataDir, { recursive: true });
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB));
    fs.renameSync(tmp, STORE_FILE);   // atomic replace
  } catch (e) { console.error('store write', e.message); }
}
// Debounced save for high-frequency, non-critical mutations (positions, orders).
function saveStore() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; _writeNow(); }, 400);
}
// WRITE-THROUGH — for fund-critical mutations (a newly minted/imported private
// key, an order removal before a fill). A crash in the 400ms debounce window must
// never lose a wallet key or replay a filled order.
function saveStoreNow() { if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; } _writeNow(); }
// Flush any pending debounced write on shutdown/redeploy.
let _shutdownWired = false;
function wireShutdownFlush() {
  if (_shutdownWired) return; _shutdownWired = true;
  const flush = () => { try { saveStoreNow(); } catch (_) {} };
  process.on('beforeExit', flush);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
}

// ---- per-wallet serialization: two txs from one address must not race on the
// same nonce (one would be silently dropped). All sends for an address queue.
const _walletLocks = new Map();
function withWalletLock(address, fn) {
  const key = String(address).toLowerCase();
  const prev = _walletLocks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());          // run after the previous op settles
  _walletLocks.set(key, run.then(() => {}, () => {}));   // tail never rejects → chain continues
  return run;                                  // caller still sees the real result/throw
}
function allUsers() { return Object.values(DB.users); }
function getUser(chatId) { return DB.users[String(chatId)] || null; }
function userChain(u) { return (u && u.activeChain && chainOf(u.activeChain) && isEnabled(u.activeChain)) ? u.activeChain : DEFAULT_CHAIN; }

// ---------------------------------------------------------------- wallet (custodial, MULTI)
// A user holds up to WALLET_CAP wallets, one active at a time. Positions AND orders
// live ON each wallet (they belong to a specific address), so switching the active
// wallet never mixes one wallet's bags/orders with another's. Legacy single-wallet
// records are migrated transparently on first touch (see _migrateLegacy).
// Capped at 99 so a wallet index is always ≤2 digits — keeps every token-card
// callback (which encodes the index) under Telegram's 64-byte limit.
const WALLET_CAP = Math.max(1, Math.min(99, Number(process.env.MAX_WALLETS_PER_USER || 10)));
const DEFAULT_BUY_PRESETS = [0.01, 0.05, 0.1];   // the three quick-buy amounts on a token card
function _refCode() { let c; do { c = crypto.randomBytes(4).toString('hex'); } while (DB.refByCode[c]); return c; }
function _walletId() { return crypto.randomBytes(5).toString('hex'); }
function walletFromSecret(secret) {
  secret = String(secret || '').trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(secret)) return new ethers.Wallet(secret.startsWith('0x') ? secret : '0x' + secret);
  const words = secret.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length)) return ethers.Wallet.fromPhrase(words.join(' '));
  throw new Error('not a valid private key (64 hex chars) or seed phrase (12–24 words)');
}
function _newWallet(secret) {
  const w = secret ? walletFromSecret(secret) : ethers.Wallet.createRandom();
  return { id: _walletId(), address: w.address, enc: encrypt(w.privateKey), createdAt: Date.now(), positions: {}, orders: [], history: [] };
}
function walletList(u) { return (u && Array.isArray(u.wallets)) ? u.wallets : []; }
function walletById(u, id) { return walletList(u).find((w) => w.id === id) || null; }
function activeWallet(u) { const list = walletList(u); return list.find((w) => w.id === u.activeWalletId) || list[0] || null; }
function activeAddress(u) { const w = activeWallet(u); return w ? w.address : null; }
function _resolveWallet(u, walletId) { const w = walletId ? walletById(u, walletId) : activeWallet(u); if (!w) throw new Error('no wallet'); return w; }

// Migrate a legacy single-wallet record { address, enc, positions, orders, oldWallets }
// into the multi-wallet shape. The current wallet becomes Wallet 1 (keeps its
// positions+orders); previously-archived oldWallets return as extra selectable
// wallets (empty bags — they were cleared when archived), capped at WALLET_CAP.
function _migrateLegacy(u) {
  if (Array.isArray(u.wallets) && u.wallets.length) return false;
  const wallets = [];
  if (u.address && u.enc) {
    wallets.push({ id: _walletId(), address: u.address, enc: u.enc, createdAt: u.createdAt || Date.now(),
      positions: (u.positions && typeof u.positions === 'object') ? u.positions : {},
      orders: Array.isArray(u.orders) ? u.orders : [] });
  }
  // Bring back archived wallets as selectable ones (up to the cap). Any that don't
  // fit are KEPT in a residual archive — never wholesale-deleted, so no encrypted
  // key is ever destroyed by the migration.
  const leftover = [];
  for (const ow of (Array.isArray(u.oldWallets) ? u.oldWallets : [])) {
    if (!ow || !ow.address || !ow.enc) continue;
    if (wallets.some((w) => w.address.toLowerCase() === ow.address.toLowerCase())) continue;
    if (wallets.length < WALLET_CAP) wallets.push({ id: _walletId(), address: ow.address, enc: ow.enc, createdAt: ow.at || Date.now(), positions: {}, orders: [] });
    else leftover.push(ow);
  }
  if (!wallets.length) return false;
  // Stamp every migrated order with its owning wallet's id, so a pre-upgrade
  // TP/SL/limit always executes on THE WALLET IT BELONGS TO — never on whatever
  // wallet happens to be active after the user adds/switches wallets.
  for (const w of wallets) for (const o of w.orders) if (o && !o.walletId) o.walletId = w.id;
  u.wallets = wallets;
  u.activeWalletId = wallets[0].id;
  delete u.address; delete u.enc; delete u.positions; delete u.orders;
  if (leftover.length) u.oldWallets = leftover; else delete u.oldWallets;
  return true;
}
function ensureUser(chatId, referredBy) {
  const id = String(chatId);
  let u = DB.users[id];
  if (u) {
    // Backfill any field a stored record predates, so screens never crash on a
    // partial/legacy user after a schema change.
    let ch = false, minted = false;
    if (!u.activeChain) { u.activeChain = DEFAULT_CHAIN; ch = true; }
    if (_migrateLegacy(u)) ch = true;
    if (!Array.isArray(u.wallets) || !u.wallets.length) { u.wallets = [_newWallet()]; ch = true; minted = true; }
    for (const w of u.wallets) {
      if (!w.id) { w.id = _walletId(); ch = true; }
      if (!w.positions || typeof w.positions !== 'object') { w.positions = {}; ch = true; }
      if (!Array.isArray(w.orders)) { w.orders = []; ch = true; }
      if (!Array.isArray(w.history)) { w.history = []; ch = true; }                        // per-wallet trade log
      for (const o of w.orders) if (o && !o.walletId) { o.walletId = w.id; ch = true; }   // every order knows its wallet
    }
    if (!u.activeWalletId || !walletById(u, u.activeWalletId)) { u.activeWalletId = u.wallets[0].id; ch = true; }
    if (!u.snipe || typeof u.snipe !== 'object') { u.snipe = { ethAmount: '0.01' }; ch = true; }
    if (!u.snipe.chains || typeof u.snipe.chains !== 'object') { u.snipe.chains = { robinhood: !!u.snipe.on }; delete u.snipe.on; ch = true; }   // migrate on→chains.robinhood
    if (typeof u.snipe.ethAmount !== 'string' || !(Number(u.snipe.ethAmount) > 0)) { u.snipe.ethAmount = '0.01'; ch = true; }
    if (!Array.isArray(u.alerts)) { u.alerts = []; ch = true; }                            // price alerts (notify-only)
    if (!u.copy || typeof u.copy !== 'object') { u.copy = { on: false, targets: [] }; ch = true; }   // copy-trading
    if (!Array.isArray(u.copy.targets)) { u.copy.targets = []; ch = true; }
    if (!u.settings || typeof u.settings !== 'object') { u.settings = {}; ch = true; }
    { const s = u.settings;
      if (typeof s.slippage !== 'number') { s.slippage = 0; ch = true; }                                   // 0 → 5% default
      if (!Array.isArray(s.buyPresets) || s.buyPresets.length !== 3 || !s.buyPresets.every((x) => x > 0)) { s.buyPresets = DEFAULT_BUY_PRESETS.slice(); ch = true; }
      if (typeof s.autoBuy !== 'boolean') { s.autoBuy = false; ch = true; }
      if (typeof s.autoBuyAmount !== 'string' || !(Number(s.autoBuyAmount) > 0)) { s.autoBuyAmount = '0.01'; ch = true; }
      if (typeof s.confirmBuy !== 'boolean') { s.confirmBuy = false; ch = true; }
      if (typeof s.expert !== 'boolean') { s.expert = false; ch = true; }
      if (!s.notify || typeof s.notify !== 'object') { s.notify = { snipe: true, copy: true, alerts: true }; ch = true; }
      if (!s.presetsByChain || typeof s.presetsByChain !== 'object') { s.presetsByChain = {}; ch = true; } }
    // Write THROUGH if we just minted a key in the backfill (durability), else debounce.
    if (minted) saveStoreNow(); else if (ch) saveStore();
    return u;
  }
  const w = _newWallet();
  const code = _refCode();
  u = {
    chatId: id, refCode: code,
    referredBy: (referredBy && DB.refByCode[referredBy] && DB.refByCode[referredBy] !== id) ? referredBy : null,
    createdAt: Date.now(),
    activeChain: DEFAULT_CHAIN,
    wallets: [w], activeWalletId: w.id,   // each wallet: { id, address, enc, positions, orders, history }
    snipe: { ethAmount: '0.01', chains: { robinhood: false } },
    alerts: [], copy: { on: false, targets: [] },
    refEarnedEth: 0,
    settings: { slippage: 0, buyPresets: DEFAULT_BUY_PRESETS.slice(), autoBuy: false, autoBuyAmount: '0.01', confirmBuy: false, expert: false, notify: { snipe: true, copy: true, alerts: true }, presetsByChain: {} },
  };
  DB.users[id] = u; DB.refByCode[code] = id;
  saveStoreNow();   // write-through: the encrypted key must be durable before we return the address
  return u;
}
function _signer(w, chainKey) { return new ethers.Wallet(decrypt(w.enc), providerFor(chainKey)); }
function signerFor(chatId, chainKey, walletId) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  return _signer(_resolveWallet(u, walletId), chainKey || userChain(u));
}
function exportKey(chatId, walletId) { const u = getUser(chatId); if (!u) throw new Error('no wallet'); return decrypt(_resolveWallet(u, walletId).enc); }

// Add a wallet (generate when secret is undefined, else import a key/seed). Adds
// to the list (up to WALLET_CAP) and makes it active. Non-destructive — existing
// wallets are untouched, so nothing can be stranded.
function addWallet(chatId, secret) {
  const u = ensureUser(chatId);
  if (u.wallets.length >= WALLET_CAP) throw new Error(`wallet limit reached (${WALLET_CAP}). Remove one first.`);
  const nw = _newWallet(secret);
  if (u.wallets.some((w) => w.address.toLowerCase() === nw.address.toLowerCase())) throw new Error('that wallet is already in your list');
  u.wallets.push(nw);
  u.activeWalletId = nw.id;
  saveStoreNow();   // write-through: a fresh/imported key must be durable
  return { id: nw.id, address: nw.address, index: u.wallets.length };
}
function switchWallet(chatId, walletId) {
  const u = ensureUser(chatId);
  const w = walletById(u, walletId); if (!w) throw new Error('wallet not found');
  u.activeWalletId = w.id; saveStore();
  return w;
}
// Remove a wallet. GUARD: keep at least one; refuse (fail-closed) if it still holds
// native on any enabled chain, so removing can never strand funds. ERC20 bags can't
// be auto-detected, so tell the user to export the key first if unsure.
async function removeWallet(chatId, walletId) {
  const u = ensureUser(chatId);
  if (u.wallets.length <= 1) throw new Error('you must keep at least one wallet');
  const w = walletById(u, walletId); if (!w) throw new Error('wallet not found');
  const dust = ethers.parseEther('0.0002');
  for (const ch of chains.enabledChains()) {
    let bal;
    try { bal = await providerFor(ch.key).getBalance(w.address); }
    catch (_) { throw new Error(`couldn't verify this wallet's balance on ${ch.name} right now — try again in a moment.`); }
    if (bal > dust) throw new Error(`this wallet still holds ${Number(ethers.formatEther(bal)).toFixed(5)} ${ch.native} on ${ch.name} — withdraw it (or export the key) first.`);
  }
  // Re-validate AFTER the async balance loop (the event loop yielded, so a
  // concurrent removal could have changed the list). This block runs to completion
  // WITHOUT yielding, so the check-and-mutate is atomic — no race can empty wallets.
  if (!walletById(u, w.id)) return u.wallets.length;   // already removed by a concurrent call
  if (u.wallets.length <= 1) throw new Error('you must keep at least one wallet');
  // Archive the encrypted key before dropping the wallet, so a removed wallet's key
  // is NEVER irrecoverable (it may still hold ERC20 bags the native guard can't see).
  u.oldWallets = Array.isArray(u.oldWallets) ? u.oldWallets : [];
  u.oldWallets.push({ address: w.address, enc: w.enc, at: Date.now() });
  if (u.oldWallets.length > 20) u.oldWallets = u.oldWallets.slice(-20);
  u.wallets = u.wallets.filter((x) => x.id !== w.id);
  if (u.activeWalletId === w.id) u.activeWalletId = u.wallets[0].id;
  saveStoreNow();
  return u.wallets.length;
}
function listWallets(chatId) {
  const u = ensureUser(chatId);
  return u.wallets.map((w, i) => ({ id: w.id, index: i + 1, address: w.address, active: w.id === u.activeWalletId, orders: (w.orders || []).length }));
}
function setChain(chatId, key) {
  const u = ensureUser(chatId);
  if (!isEnabled(key)) throw new Error('chain not enabled');
  u.activeChain = key; saveStore();
  return chainOf(key);
}
// Per-chain snipe toggle (Robinhood = new Robinfun launches; other chains = new DEX pairs).
function setSnipeChain(chatId, key, on) {
  const u = ensureUser(chatId);
  if (!isEnabled(key)) throw new Error('chain not enabled');
  u.snipe.chains = u.snipe.chains || {};
  u.snipe.chains[key] = !!on;
  saveStore();
  return u.snipe.chains;
}
function setSnipeAmount(chatId, amt) {
  const u = ensureUser(chatId);
  const a = Number(amt); if (!(a > 0)) throw new Error('amount must be > 0');
  u.snipe.ethAmount = String(a); saveStore();
  return u.snipe.ethAmount;
}

// ---------------------------------------------------------------- copy-trading
const MAX_COPY_TARGETS = Math.max(1, Number(process.env.MAX_COPY_TARGETS || 5));
function addCopyTarget(chatId, address, chain, buyEth, maxEth) {
  const u = ensureUser(chatId);
  address = String(address || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('invalid wallet address');
  if (!isEnabled(chain)) throw new Error('chain not enabled');
  u.copy = u.copy || { on: false, targets: [] };
  u.copy.targets = u.copy.targets || [];
  if (u.copy.targets.length >= MAX_COPY_TARGETS) throw new Error(`copy limit (${MAX_COPY_TARGETS}) reached — remove one first`);
  if (u.copy.targets.some((t) => t.address.toLowerCase() === address.toLowerCase() && t.chain === chain)) throw new Error('already following that wallet on this chain');
  const be = Number(buyEth), me = Number(maxEth);
  if (!(be > 0)) throw new Error('per-buy amount must be > 0');
  if (!(me >= be)) throw new Error('total budget must be ≥ the per-buy amount');
  const t = { id: 'cp' + crypto.randomBytes(4).toString('hex'), address, chain, buyEth: String(be), maxEth: String(me), spentEth: 0, bought: {}, cursor: 0, createdAt: Date.now() };
  u.copy.targets.push(t);
  saveStore();
  return t;
}
function removeCopyTarget(chatId, id) {
  const u = getUser(chatId); if (!u || !u.copy || !Array.isArray(u.copy.targets)) return false;
  const before = u.copy.targets.length;
  u.copy.targets = u.copy.targets.filter((t) => t.id !== id);
  if (u.copy.targets.length !== before) { saveStore(); return true; }
  return false;
}
function setCopyOn(chatId, on) {
  const u = ensureUser(chatId);
  u.copy = u.copy || { on: false, targets: [] };
  u.copy.on = !!on; saveStore();
  return u.copy.on;
}

// ---------------------------------------------------------------- settings
// Getter that RE-ASSERTS the render constraint the setter enforces (short plain
// decimal, ≤100), so the token card can never build an invalid/oversized callback
// even if the store was hand-edited. Falls back to the defaults if anything's off.
function _presetsOk(a) {
  const okOne = (x) => x > 0 && x <= 100 && String(x).length <= 6 && !/e/i.test(String(x));
  return Array.isArray(a) && a.length === 3 && a.every(okOne);
}
// Quick-buy amounts. Per-chain override (settings.presetsByChain[chainKey]) wins,
// then the global settings.buyPresets, then the default. Chain amounts differ in
// value (0.01 ETH != 0.01 BNB) so a per-chain default is genuinely useful.
function buyPresets(u, chainKey) {
  const s = (u && u.settings) || {};
  if (chainKey && s.presetsByChain && _presetsOk(s.presetsByChain[chainKey])) return s.presetsByChain[chainKey];
  return _presetsOk(s.buyPresets) ? s.buyPresets : DEFAULT_BUY_PRESETS;
}
function setSlippage(chatId, pct) {
  const u = ensureUser(chatId);
  const n = Number(pct);
  if (!(n >= 0) || n > 50) throw new Error('slippage must be a number 0–50 (%)');
  u.settings.slippage = n; saveStore();
  return n;
}
// Set the 3 quick-buy amounts. If chainKey is given, they apply to THAT chain only
// (settings.presetsByChain[chainKey]); otherwise they set the global default.
function setBuyPresets(chatId, input, chainKey) {
  const u = ensureUser(chatId);
  const toks = String(input).trim().split(/[\s,]+/).filter(Boolean);
  if (toks.length !== 3) throw new Error('give exactly 3 positive amounts, e.g. "0.01 0.05 0.1"');
  const nums = [];
  for (const t of toks) {
    // Plain decimals only — exponential like "1e-7" would pass Number() but then
    // ethers.parseEther() rejects it at buy time, and it also encodes weirdly.
    if (!/^\d*\.?\d+$/.test(t)) throw new Error('amounts must be plain numbers, e.g. 0.01 0.05 0.1');
    const n = Number(t);
    // Embedded in a Telegram callback (≤64 bytes) beside a 42-char address, so keep
    // the printed form short + a plain decimal (no exponential from tiny values).
    if (!(n > 0) || n > 100 || String(n).length > 6 || /e/i.test(String(n))) throw new Error('keep each amount a short plain number ≤ 100 (e.g. 0.01 0.05 0.1)');
    nums.push(n);
  }
  if (chainKey && isEnabled(chainKey)) { u.settings.presetsByChain = u.settings.presetsByChain || {}; u.settings.presetsByChain[chainKey] = nums; }
  else u.settings.buyPresets = nums;
  saveStore();
  return nums;
}
function setAutoBuy(chatId, on, amount) {
  const u = ensureUser(chatId);
  if (on !== undefined && on !== null) u.settings.autoBuy = !!on;
  if (amount !== undefined && amount !== null) { const a = Number(amount); if (!(a > 0)) throw new Error('amount must be > 0'); u.settings.autoBuyAmount = String(a); }
  saveStore();
  return { autoBuy: u.settings.autoBuy, autoBuyAmount: u.settings.autoBuyAmount };
}
// Confirm-before-buy: when ON, a buy asks for a Yes/No confirmation first.
function setConfirmBuy(chatId, on) { const u = ensureUser(chatId); u.settings.confirmBuy = !!on; saveStore(); return u.settings.confirmBuy; }
// Expert/fast mode: skip the intermediate "⏳ Buying…" progress messages.
function setExpert(chatId, on) { const u = ensureUser(chatId); u.settings.expert = !!on; saveStore(); return u.settings.expert; }
// Per-type notification toggles (snipe / copy / alerts). Orders always notify.
const NOTIFY_TYPES = ['snipe', 'copy', 'alerts'];
function setNotify(chatId, type, on) {
  const u = ensureUser(chatId);
  if (!NOTIFY_TYPES.includes(type)) throw new Error('unknown notify type');
  u.settings.notify = u.settings.notify || {};
  u.settings.notify[type] = !!on; saveStore();
  return u.settings.notify;
}
function notifyOn(chatId, type) {
  const u = getUser(chatId); if (!u) return true;
  const n = u.settings && u.settings.notify;
  if (!n || typeof n !== 'object' || n[type] === undefined) return true;   // default ON
  return !!n[type];
}

// ---------------------------------------------------------------- chain reads
async function resolveCurve(ca, chainKey) {
  const chain = chainOf(chainKey); if (!chain || !chain.curve) return '';
  try { const c = await new ethers.Contract(chain.factory, FACTORY_ABI, providerFor(chainKey)).curveOf(ca); return (c && c !== ethers.ZeroAddress) ? c : ''; }
  catch (_) { return ''; }
}
async function isGraduated(curveAddr, chainKey) {
  try { return await new ethers.Contract(curveAddr, CURVE_ABI, providerFor(chainKey)).graduated(); } catch (_) { return false; }
}
async function tokenDecimals(ca, chainKey) {
  try { return Number(await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).decimals()); } catch (_) { return 18; }
}
async function tokenMeta(ca, chainKey) {
  const erc = new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey));
  let name = 'Token', sym = 'TOKEN', dec = 18;
  try { const [n, s] = await Promise.all([erc.name(), erc.symbol()]); if (n) name = n; if (s) sym = s; } catch (_) {}
  try { dec = Number(await erc.decimals()); } catch (_) {}
  return { name: String(name).slice(0, 40), sym: String(sym).slice(0, 20), decimals: dec };
}
async function ethBalance(addr, chainKey) { try { return await providerFor(chainKey).getBalance(addr); } catch (_) { return 0n; } }
async function tokenBalance(ca, addr, chainKey) { try { return await new ethers.Contract(ca, ERC20_ABI, providerFor(chainKey)).balanceOf(addr); } catch (_) { return 0n; } }
async function ethUsd(chainKey) {
  // Robinhood + ETH-native chains price in ETH; BSC prices in BNB.
  const sym = (chainOf(chainKey) || {}).native === 'BNB' ? 'BNB' : 'ETH';
  try { const r = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { signal: AbortSignal.timeout(6000) }); const j = await r.json(); const p = Number(j?.data?.amount); return p > 0 ? p : 0; }
  catch (_) { return 0; }
}
// Live token snapshot on a given chain: price (native), mcap (native), curve state.
async function tokenSnapshot(ca, chainKey) {
  const chain = chainOf(chainKey); if (!chain) return null;
  const prov = providerFor(chainKey);
  if (chain.curve) {
    const curve = await resolveCurve(ca, chainKey);
    if (curve) {
      const c = new ethers.Contract(curve, CURVE_ABI, prov);
      const out = { ca, curve, priceEth: 0, mcapEth: 0, graduated: false, progressPct: 0, decimals: 18, dex: false };
      try { out.graduated = await c.graduated(); } catch (_) {}
      try { out.priceEth = Number(ethers.formatEther(await c.currentPrice())); } catch (_) {}
      try { out.mcapEth = Number(ethers.formatEther(await c.marketCapEth())); } catch (_) {}
      try { const [col, tgt] = await c.graduationProgress(); out.progressPct = tgt > 0n ? Number(col) / Number(tgt) * 100 : 0; } catch (_) {}
      if (!out.graduated) return out;   // still on the curve → curve is the source of truth
      // graduated → price now lives on the DEX; fall through to read it there
    }
  }
  // DEX snapshot (any chain with a router): price via getAmountsOut, mcap via supply.
  const dec = await tokenDecimals(ca, chainKey);
  const router = new ethers.Contract(chain.router, ROUTER_ABI, prov);
  let priceEth = 0, mcapEth = 0;
  try {
    const one = 10n ** BigInt(dec);
    const amts = await router.getAmountsOut(one, [ca, chain.weth]);
    priceEth = Number(ethers.formatEther(amts[1]));
    const ts = await new ethers.Contract(ca, ERC20_ABI, prov).totalSupply();
    mcapEth = priceEth * Number(ethers.formatUnits(ts, dec));
  } catch (_) {}
  if (!(priceEth > 0)) return null;   // no pool here / can't price
  return { ca, curve: '', priceEth, mcapEth, graduated: true, progressPct: 100, decimals: dec, dex: true };
}

// ---------------------------------------------------------------- gas
async function gasOverrides(chainKey) {
  const prov = providerFor(chainKey);
  // Only Robinhood (cheap L2) uses the fixed/cheap floor; busy L1s/L2s use auto so
  // ethers sets a proper (base + tip) fee that actually confirms.
  const mode = chainKey === 'robinhood' ? CFG.gasMode : 'auto';
  if (mode === 'auto') return {};
  let floor = 0n;
  try { const blk = await prov.getBlock('latest'); if (blk && blk.baseFeePerGas) floor = blk.baseFeePerGas; } catch (_) {}
  if (floor === 0n) { try { const fd = await prov.getFeeData(); floor = fd.gasPrice || 0n; } catch (_) {} }
  if (mode === 'cheap') return { gasPrice: floor > 0n ? floor : ethers.parseUnits('0.01', 'gwei') };
  const want = ethers.parseUnits(String(CFG.gasGwei > 0 ? CFG.gasGwei : 0.01), 'gwei');
  return { gasPrice: (floor > 0n && floor > want) ? floor : want };
}
async function waitBounded(tx) { try { return await tx.wait(1, 180000); } catch (e) { if (e && e.code === 'TIMEOUT') return null; throw e; } }
async function ensureApprove(wallet, ca, spender, amount, chainKey) {
  const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
  const cur = await erc.allowance(wallet.address, spender).catch(() => 0n);
  if (cur < amount) { const gas = await gasOverrides(chainKey); const tx = await erc.approve(spender, ethers.MaxUint256, gas); await tx.wait(); }
}

// ---------------------------------------------------------------- fee + referral
function slipBps(u) { let s = Number(u && u.settings && u.settings.slippage); if (!(s > 0)) s = 5; if (s > 50) s = 50; return BigInt(Math.round(s * 100)); }
async function _chargeFee(wallet, feeWei, chainKey) {
  if (feeWei <= 0n || !CFG.feeWallet || !/^0x[0-9a-fA-F]{40}$/.test(CFG.feeWallet)) return null;
  try {
    const gas = await gasOverrides(chainKey);
    const tx = await wallet.sendTransaction({ to: CFG.feeWallet, value: feeWei, ...gas });
    const rc = await waitBounded(tx);
    if (!rc || rc.status === 0) return null;   // null = timed out (unconfirmed) → don't credit referral
    return tx.hash;
  } catch (e) { console.error('fee charge failed', e.message); return null; }
}
function _creditReferral(user, feeWei, chainKey) {
  if (!user.referredBy || feeWei <= 0n) return;
  const refId = DB.refByCode[user.referredBy];
  const ref = refId && DB.users[refId];
  if (!ref) return;
  const share = (feeWei * BigInt(CFG.refShareBps)) / 10000n;
  // Bucket per chain — a BNB fee share must NOT be summed with ETH shares (1 BNB
  // != 1 ETH). refOwed[chainKey] = wei string, settled per native.
  ref.refOwed = ref.refOwed || {};
  ref.refOwed[chainKey] = ((BigInt(ref.refOwed[chainKey] || '0')) + share).toString();
  saveStoreNow();   // write-through: the fee already moved on-chain; don't lose the credit in the debounce window
}
function posKey(chainKey, ca) { return chainKey + ':' + ca.toLowerCase(); }
// Append a trade to a wallet's history (newest last), bounded so the store can't grow forever.
function _pushHistory(wal, entry) {
  if (!Array.isArray(wal.history)) wal.history = [];
  entry.ts = Date.now();
  wal.history.push(entry);
  if (wal.history.length > 50) wal.history = wal.history.slice(-50);
}

// ---------------------------------------------------------------- trade
// Buy `ethAmount` (human native) of `ca` on the user's active chain (or chainKey).
async function buy(chatId, ca, ethAmount, chainKey, walletId) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const wal = _resolveWallet(u, walletId);
  return withWalletLock(wal.address, async () => {
    chainKey = chainKey || userChain(u);
    const chain = chainOf(chainKey);
    const wallet = _signer(wal, chainKey);
    const gross = ethers.parseEther(String(ethAmount));
    if (gross <= 0n) throw new Error('amount must be > 0');
    const bal = await ethBalance(wallet.address, chainKey);
    // L1 Ethereum gas dwarfs the L2 default — reserve more so a buy isn't left
    // unable to pay for its own swap.
    const gasBuf = ethers.parseEther(chainKey === 'ethereum' ? (process.env.ETH_GAS_BUFFER || '0.006') : CFG.gasBufferEth);
    if (bal < gross + gasBuf) throw new Error(`insufficient ${chain.native} — need ~${ethers.formatEther(gross + gasBuf)} incl. gas, have ${Number(ethers.formatEther(bal)).toFixed(5)}`);
    const fee = (gross * BigInt(CFG.feeBps)) / 10000n;
    const spend = gross - fee;

    const curve = await resolveCurve(ca, chainKey);
    const grad = curve ? await isGraduated(curve, chainKey) : true;
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const gas = await gasOverrides(chainKey);
    const slip = slipBps(u);
    const before = await tokenBalance(ca, wallet.address, chainKey);

    let venue, hash, trc;
    if (curve && !grad) {
      const cc = new ethers.Contract(curve, CURVE_ABI, wallet);
      let minTok;
      try { const exp = await cc.buy.staticCall(0n, deadline, { value: spend }); minTok = exp * (10000n - slip) / 10000n; }
      catch (e) { throw new Error('could not quote this buy (try again / lower amount): ' + (e.shortMessage || e.message || e)); }
      const tx = await cc.buy(minTok, deadline, { value: spend, ...gas });
      venue = 'curve'; hash = tx.hash; trc = await waitBounded(tx);
    } else {
      const router = new ethers.Contract(chain.router, ROUTER_ABI, wallet);
      let expTok = 0n;
      try { const amts = await router.getAmountsOut(spend, [chain.weth, ca]); expTok = amts[1]; }
      catch (e) { throw new Error('could not quote this buy on ' + chain.name + ' (no pool? try again): ' + (e.shortMessage || e.message || e)); }
      const dexSlip = slip + 1200n > 5000n ? 5000n : slip + 1200n;
      const minTok = expTok > 0n ? expTok * (10000n - dexSlip) / 10000n : 0n;
      if (minTok <= 0n) throw new Error('no liquidity / zero quote for this token on ' + chain.name);
      const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(minTok, [chain.weth, ca], wallet.address, deadline, { value: spend, ...gas });
      venue = 'dex'; hash = tx.hash; trc = await waitBounded(tx);
    }
    const after = await tokenBalance(ca, wallet.address, chainKey);
    const meta = await tokenMeta(ca, chainKey);
    const got = after > before ? after - before : 0n;
    // Confirmed = receipt status 1 (waitBounded returns it; a revert would have
    // thrown) OR a positive balance change. Only "pending" if BOTH the receipt
    // timed out (null) AND the balance read shows no gain — so a successful buy
    // whose balance read merely failed isn't falsely retried (double-buy).
    if (!trc && got <= 0n) {
      // Broadcast succeeded but we can't confirm the fill (receipt timed out AND the
      // balance read shows no gain). The tx MAY still land, so tag it: callers that
      // committed budget/dedup before the buy (copy-trade) must NOT roll it back.
      const e = new Error('trade sent but not confirmed / no tokens received yet — check your wallet before retrying. Tx: ' + hash);
      e.broadcast = true; throw e;
    }

    const feeHash = await _chargeFee(wallet, fee, chainKey);
    if (feeHash) _creditReferral(u, fee, chainKey);

    const key = posKey(chainKey, ca);
    const p = wal.positions[key] || { chain: chainKey, ca, name: meta.name, sym: meta.sym, dec: meta.decimals, ethIn: 0, ethOut: 0, realizedEth: 0, tokens: '0' };
    p.name = meta.name; p.sym = meta.sym; p.dec = meta.decimals;
    p.ethIn += Number(ethers.formatEther(spend));
    p.tokens = after.toString();
    delete p.closed;
    wal.positions[key] = p;
    _pushHistory(wal, { side: 'buy', chain: chainKey, ca, sym: meta.sym, ethAmount: Number(ethers.formatEther(spend)), tokens: Number(ethers.formatUnits(got, meta.decimals)), hash });
    saveStore();

    return { chain: chainKey, native: chain.native, venue, hash, feeHash, spentEth: Number(ethers.formatEther(spend)), feeEth: Number(ethers.formatEther(fee)), gotTokens: Number(ethers.formatUnits(got, meta.decimals)), sym: meta.sym };
  });
}

async function sell(chatId, ca, pct, chainKey, walletId) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const wal = _resolveWallet(u, walletId);
  return withWalletLock(wal.address, async () => {
    chainKey = chainKey || userChain(u);
    const chain = chainOf(chainKey);
    const wallet = _signer(wal, chainKey);
    const erc = new ethers.Contract(ca, ERC20_ABI, wallet);
    const bal = await erc.balanceOf(wallet.address);
    const p = Math.max(1, Math.min(100, Math.round(Number(pct) || 0)));
    const amount = (bal * BigInt(p)) / 100n;
    if (amount <= 0n) throw new Error('token balance is 0');

    const curve = await resolveCurve(ca, chainKey);
    const grad = curve ? await isGraduated(curve, chainKey) : true;
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const gas = await gasOverrides(chainKey);
    const slip = slipBps(u);
    const onCurve = !!(curve && !grad);
    const spender = onCurve ? curve : chain.router;
    await ensureApprove(wallet, ca, spender, amount, chainKey);   // before ethBefore snapshot
    const ethBefore = await ethBalance(wallet.address, chainKey);

    let venue, hash, trc;
    if (onCurve) {
      const cc = new ethers.Contract(curve, CURVE_ABI, wallet);
      let minEth;
      try { const exp = await cc.sell.staticCall(amount, 0n, deadline); minEth = exp * (10000n - slip) / 10000n; }
      catch (e) { throw new Error('could not quote this sell (try again): ' + (e.shortMessage || e.message || e)); }
      const tx = await cc.sell(amount, minEth, deadline, gas);
      venue = 'curve'; hash = tx.hash; trc = await waitBounded(tx);
    } else {
      const router = new ethers.Contract(chain.router, ROUTER_ABI, wallet);
      let expEth = 0n;
      try { const amts = await router.getAmountsOut(amount, [ca, chain.weth]); expEth = amts[1]; }
      catch (e) { throw new Error('could not quote this sell on ' + chain.name + ' (no pool? try again): ' + (e.shortMessage || e.message || e)); }
      const dexSlip = slip + 1200n > 5000n ? 5000n : slip + 1200n;
      const minEth = expEth > 0n ? expEth * (10000n - dexSlip) / 10000n : 0n;
      if (minEth <= 0n) throw new Error('no liquidity / zero quote for this sell on ' + chain.name);   // never send minOut=0 (sandwich drain)
      const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, minEth, [ca, chain.weth], wallet.address, deadline, gas);
      venue = 'dex'; hash = tx.hash; trc = await waitBounded(tx);
    }
    const tokAfter = await erc.balanceOf(wallet.address);
    // Confirmed = receipt status 1, OR tokens actually left the wallet. Only
    // "pending" if the receipt timed out AND the balance read shows no change.
    if (!trc && tokAfter >= bal) throw new Error('sell sent but not confirmed yet — check your wallet before retrying. Tx: ' + hash);
    const ethAfter = await ethBalance(wallet.address, chainKey);
    const proceeds = ethAfter > ethBefore ? ethAfter - ethBefore : 0n;
    const fee = (proceeds * BigInt(CFG.feeBps)) / 10000n;
    const feeHash = await _chargeFee(wallet, fee, chainKey);
    if (feeHash) _creditReferral(u, fee, chainKey);

    const key = posKey(chainKey, ca);
    const pos = wal.positions[key];
    if (pos) {
      pos.ethOut += Number(ethers.formatEther(proceeds - fee));
      pos.tokens = tokAfter.toString();
      pos.realizedEth = (pos.ethOut - pos.ethIn);
      if (pos.tokens === '0') pos.closed = true;
    }
    _pushHistory(wal, { side: 'sell', chain: chainKey, ca, sym: (pos && pos.sym) || '', ethAmount: Number(ethers.formatEther(proceeds)), pct: p, hash });
    saveStore();
    return { chain: chainKey, native: chain.native, venue, hash, feeHash, soldPct: p, proceedsEth: Number(ethers.formatEther(proceeds)), feeEth: Number(ethers.formatEther(fee)) };
  });
}

async function withdraw(chatId, to, amount, chainKey, walletId) {
  to = String(to || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('invalid destination address');
  if (/^0x0{40}$/i.test(to)) throw new Error('refusing to send to the zero address');
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const wal = _resolveWallet(u, walletId);
  return withWalletLock(wal.address, async () => {
    chainKey = chainKey || userChain(u);
    const wallet = _signer(wal, chainKey);
    const bal = await ethBalance(wallet.address, chainKey);
    const gas = await gasOverrides(chainKey);
    let gp = gas.gasPrice;
    if (!gp) { try { const fd = await providerFor(chainKey).getFeeData(); gp = fd.gasPrice || fd.maxFeePerGas; } catch (_) {} }
    if (!gp || gp <= 0n) gp = ethers.parseUnits('0.1', 'gwei');
    const gasCost = gp * 21000n * 3n;
    let value;
    if (String(amount).toLowerCase() === 'max') value = bal - gasCost;
    else value = ethers.parseEther(String(amount));
    if (value <= 0n) throw new Error('nothing to withdraw (after gas)');
    if (value + gasCost > bal) throw new Error('amount exceeds balance after gas');
    const tx = await wallet.sendTransaction({ to, value, gasPrice: gp });
    await waitBounded(tx);
    return { hash: tx.hash, sentEth: Number(ethers.formatEther(value)), native: (chainOf(chainKey) || {}).native || 'ETH' };
  });
}

// ---------------------------------------------------------------- referral auto-payout (opt-in)
// Enabled only if FEE_WALLET_KEY is set AND it derives FEE_WALLET (so a wrong key
// can never move funds). This is a HOT key — off unless the operator opts in.
function feePayoutEnabled() {
  if (!CFG.feeWalletKey) return false;
  try { return !!CFG.feeWallet && new ethers.Wallet(CFG.feeWalletKey).address.toLowerCase() === CFG.feeWallet.toLowerCase(); }
  catch (_) { return false; }
}
// Pay `wei` native from the fee wallet to `to`. Nonce-serialized. We build + sign
// the tx LOCALLY, then broadcast as a distinct step, so failure classification is
// exact: anything before broadcast (nonce/estimate/sign) throws plainly → the caller
// may safely restore the debt; a failure DURING broadcast is tagged `e.ambiguous`
// (the node may have accepted the tx) → the caller must NOT re-pay. A timeout while
// waiting for the receipt returns { confirmed:false } (already broadcast → no re-pay).
async function payFromFeeWallet(chainKey, to, wei) {
  if (!feePayoutEnabled()) throw new Error('fee payout disabled');
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error('bad destination');
  wei = BigInt(wei);
  if (wei <= 0n) throw new Error('nothing to pay');
  const prov = providerFor(chainKey);
  const signer = new ethers.Wallet(CFG.feeWalletKey, prov);
  return withWalletLock(signer.address, async () => {
    const bal = await ethBalance(signer.address, chainKey);
    const gas = await gasOverrides(chainKey);
    let gp = gas.gasPrice;
    if (!gp) { try { const fd = await prov.getFeeData(); gp = fd.gasPrice || fd.maxFeePerGas; } catch (_) {} }
    if (!gp || gp <= 0n) gp = ethers.parseUnits('0.1', 'gwei');
    let gasLimit = 21000n;   // plain value transfer; bump if the chain estimates higher (e.g. Arbitrum L1 component)
    try { const est = await prov.estimateGas({ from: signer.address, to, value: wei }); if (est > gasLimit) gasLimit = est + est / 5n; } catch (_) {}
    if (wei + gp * gasLimit * 2n > bal) throw new Error('fee wallet balance too low for payout + gas');
    // Everything up to broadcast is PRE-broadcast: a throw here means nothing was sent.
    const nonce = await prov.getTransactionCount(signer.address, 'pending');
    const signed = await signer.signTransaction({ to, value: wei, gasPrice: gp, gasLimit, nonce, chainId: chainOf(chainKey).chainId, type: 0 });
    // Broadcast — from here on the node MAY have accepted the tx even if the RPC
    // errors, so a throw is AMBIGUOUS and the caller must NOT restore the debt.
    let tx;
    try { tx = await prov.broadcastTransaction(signed); }
    catch (e) { e.ambiguous = true; throw e; }
    let rc = null;
    try { rc = await waitBounded(tx); } catch (_) { rc = null; }   // already broadcast → never treat a wait failure as "not sent"
    if (rc && rc.status === 0) { const e = new Error('payout reverted'); e.reverted = true; throw e; }   // reverted value-transfer returns the ETH → safe to restore
    return { hash: tx.hash, confirmed: !!rc };
  });
}

// Portfolio for the ACTIVE (or specified) wallet on its active chain: value + PnL.
async function portfolio(chatId, walletId) {
  const u = getUser(chatId); if (!u) return { rows: [], totalValueEth: 0, address: null, chain: null };
  const wal = walletId ? walletById(u, walletId) : activeWallet(u);
  if (!wal) return { rows: [], totalValueEth: 0, address: null, chain: null };
  const chainKey = userChain(u);
  const chain = chainOf(chainKey);
  const rows = [];
  let totalValueEth = 0;
  for (const key of Object.keys(wal.positions || {})) {
    const p = wal.positions[key];
    if (p.chain !== chainKey) continue;   // show only the active chain
    const balRaw = await tokenBalance(p.ca, wal.address, chainKey);
    const bal = Number(ethers.formatUnits(balRaw, p.dec || 18));
    if (bal <= 1e-9 && !(p.ethIn > 0)) continue;
    const snap = await tokenSnapshot(p.ca, chainKey).catch(() => null);
    const priceEth = snap ? snap.priceEth : 0;
    const valueEth = bal * priceEth;
    totalValueEth += valueEth;
    rows.push({ ca: p.ca, name: p.name, sym: p.sym, tokens: bal, valueEth, ethIn: p.ethIn, ethOut: p.ethOut, unrealizedEth: valueEth - (p.ethIn - p.ethOut), realizedEth: p.realizedEth || 0 });
  }
  rows.sort((a, b) => b.valueEth - a.valueEth);
  return { rows, totalValueEth, address: wal.address, chain, native: chain.native };
}

// Trade history (newest first) + realized PnL for a wallet.
function getHistory(chatId, walletId) {
  const u = getUser(chatId); if (!u) return [];
  const wal = walletId ? walletById(u, walletId) : activeWallet(u);
  return (wal && Array.isArray(wal.history)) ? wal.history.slice().reverse() : [];
}
function realizedEth(wal, chainKey) {
  let r = 0;
  for (const k of Object.keys((wal && wal.positions) || {})) {
    const p = wal.positions[k];
    if (!p || typeof p.realizedEth !== 'number') continue;
    if (chainKey && p.chain !== chainKey) continue;   // don't sum ETH + BNB realized together
    r += p.realizedEth;
  }
  return r;
}

module.exports = {
  CFG, chains, chainOf, userChain, providerFor, FACTORY_ABI, CURVE_ABI, ERC20_ABI,
  getHistory, realizedEth,
  loadStore, saveStore, saveStoreNow, allUsers, getUser, ensureUser, signerFor, exportKey, walletFromSecret, setChain,
  walletList, walletById, activeWallet, activeAddress, addWallet, switchWallet, removeWallet, listWallets, WALLET_CAP,
  buyPresets, setSlippage, setBuyPresets, setAutoBuy, DEFAULT_BUY_PRESETS, setSnipeChain, setSnipeAmount,
  setConfirmBuy, setExpert, setNotify, notifyOn, NOTIFY_TYPES,
  addCopyTarget, removeCopyTarget, setCopyOn, MAX_COPY_TARGETS,
  feePayoutEnabled, payFromFeeWallet,
  resolveCurve, isGraduated, tokenMeta, tokenDecimals, tokenSnapshot, ethBalance, tokenBalance, ethUsd, gasOverrides,
  buy, sell, withdraw, portfolio, DB,
};
