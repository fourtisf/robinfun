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

// ---------------------------------------------------------------- config
const CFG = {
  tgToken:   (process.env.TRADEBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  site:      (process.env.SITE || 'https://robinfun.io').replace(/\/+$/, ''),
  gasMode:   (process.env.GAS_MODE || 'cheap').trim(),   // robinhood only; other chains use auto
  gasGwei:   Number(process.env.GAS_GWEI || 0.01),
  feeBps:      Math.min(500, Math.max(0, Number(process.env.BOT_FEE_BPS || 100))),
  refShareBps: Math.min(10000, Math.max(0, Number(process.env.REF_SHARE_BPS || 3000))),
  feeWallet:   (process.env.FEE_WALLET || '').trim(),
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
  try { DB = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (_) { DB = { users: {}, refByCode: {} }; }
  if (!DB.users) DB.users = {};
  if (!DB.refByCode) DB.refByCode = {};
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

// ---------------------------------------------------------------- wallet (custodial)
function _refCode() { let c; do { c = crypto.randomBytes(4).toString('hex'); } while (DB.refByCode[c]); return c; }
function ensureUser(chatId, referredBy) {
  const id = String(chatId);
  let u = DB.users[id];
  if (u) {
    // Backfill any field a stored record predates, so screens never crash on a
    // partial/legacy user after a schema change.
    let ch = false;
    if (!u.activeChain) { u.activeChain = DEFAULT_CHAIN; ch = true; }
    if (!u.positions || typeof u.positions !== 'object') { u.positions = {}; ch = true; }
    if (!Array.isArray(u.orders)) { u.orders = []; ch = true; }
    if (!u.snipe || typeof u.snipe !== 'object') { u.snipe = { on: false, ethAmount: '0.01' }; ch = true; }
    if (!u.settings || typeof u.settings !== 'object') { u.settings = { slippage: 0 }; ch = true; }
    if (ch) saveStore();
    return u;
  }
  const w = ethers.Wallet.createRandom();
  const code = _refCode();
  u = {
    chatId: id, address: w.address, enc: encrypt(w.privateKey), refCode: code,
    referredBy: (referredBy && DB.refByCode[referredBy] && DB.refByCode[referredBy] !== id) ? referredBy : null,
    createdAt: Date.now(),
    activeChain: DEFAULT_CHAIN,
    positions: {},        // "chain:caLower" -> { chain, ca, name, sym, dec, ethIn, ethOut, realizedEth, tokens }
    orders: [], snipe: { on: false, ethAmount: '0.01' },
    refEarnedEth: 0,
    settings: { slippage: 0 },
  };
  DB.users[id] = u; DB.refByCode[code] = id;
  saveStoreNow();   // write-through: the encrypted key must be durable before we return the address
  return u;
}
function signerFor(chatId, chainKey) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  return new ethers.Wallet(decrypt(u.enc), providerFor(chainKey || userChain(u)));
}
function exportKey(chatId) { const u = getUser(chatId); if (!u) throw new Error('no wallet'); return decrypt(u.enc); }
function walletFromSecret(secret) {
  secret = String(secret || '').trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(secret)) return new ethers.Wallet(secret.startsWith('0x') ? secret : '0x' + secret);
  const words = secret.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length)) return ethers.Wallet.fromPhrase(words.join(' '));
  throw new Error('not a valid private key (64 hex chars) or seed phrase (12–24 words)');
}
// Replace wallet (import a secret, or generate when secret is undefined). GUARD:
// refuse if the OUTGOING wallet holds native on ANY enabled chain, so switching
// can never strand funds — withdraw/export first.
async function replaceWallet(chatId, secret) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  const w = secret ? walletFromSecret(secret) : ethers.Wallet.createRandom();
  if (w.address.toLowerCase() === u.address.toLowerCase()) throw new Error('that is already your current wallet');
  const dust = ethers.parseEther('0.0002');
  // Best-effort guard: refuse if the old wallet still holds NATIVE on any chain.
  // Fail CLOSED on an RPC error (can't verify ⇒ don't switch) so a transient read
  // failure can't wave through a funded wallet.
  for (const ch of chains.enabledChains()) {
    let bal;
    try { bal = await providerFor(ch.key).getBalance(u.address); }
    catch (_) { throw new Error(`couldn't verify your balance on ${ch.name} right now — try again in a moment.`); }
    if (bal > dust) throw new Error(`your current wallet still holds ${Number(ethers.formatEther(bal)).toFixed(5)} ${ch.native} on ${ch.name} — withdraw it (or export the key) first so it isn't lost.`);
  }
  // The native guard can't see ERC20 token bags, so ARCHIVE the old encrypted key
  // before replacing it — nothing is ever unrecoverable (the key can still be
  // exported later). Then clear positions/orders (bound to the old wallet).
  u.oldWallets = u.oldWallets || [];
  u.oldWallets.push({ address: u.address, enc: u.enc, at: Date.now() });
  if (u.oldWallets.length > 20) u.oldWallets = u.oldWallets.slice(-20);
  u.address = w.address; u.enc = encrypt(w.privateKey); u.positions = {}; u.orders = [];
  saveStoreNow();
  return u.address;
}
function setChain(chatId, key) {
  const u = ensureUser(chatId);
  if (!isEnabled(key)) throw new Error('chain not enabled');
  u.activeChain = key; saveStore();
  return chainOf(key);
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
  saveStore();
}
function posKey(chainKey, ca) { return chainKey + ':' + ca.toLowerCase(); }

// ---------------------------------------------------------------- trade
// Buy `ethAmount` (human native) of `ca` on the user's active chain (or chainKey).
async function buy(chatId, ca, ethAmount, chainKey) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  return withWalletLock(u.address, async () => {
    chainKey = chainKey || userChain(u);
    const chain = chainOf(chainKey);
    const wallet = signerFor(chatId, chainKey);
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
    if (!trc && got <= 0n) throw new Error('trade sent but not confirmed / no tokens received yet — check your wallet before retrying. Tx: ' + hash);

    const feeHash = await _chargeFee(wallet, fee, chainKey);
    if (feeHash) _creditReferral(u, fee, chainKey);

    const key = posKey(chainKey, ca);
    const p = u.positions[key] || { chain: chainKey, ca, name: meta.name, sym: meta.sym, dec: meta.decimals, ethIn: 0, ethOut: 0, realizedEth: 0, tokens: '0' };
    p.name = meta.name; p.sym = meta.sym; p.dec = meta.decimals;
    p.ethIn += Number(ethers.formatEther(spend));
    p.tokens = after.toString();
    delete p.closed;
    u.positions[key] = p; saveStore();

    return { chain: chainKey, native: chain.native, venue, hash, feeHash, spentEth: Number(ethers.formatEther(spend)), feeEth: Number(ethers.formatEther(fee)), gotTokens: Number(ethers.formatUnits(got, meta.decimals)), sym: meta.sym };
  });
}

async function sell(chatId, ca, pct, chainKey) {
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  return withWalletLock(u.address, async () => {
    chainKey = chainKey || userChain(u);
    const chain = chainOf(chainKey);
    const wallet = signerFor(chatId, chainKey);
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
    const pos = u.positions[key];
    if (pos) {
      pos.ethOut += Number(ethers.formatEther(proceeds - fee));
      pos.tokens = tokAfter.toString();
      pos.realizedEth = (pos.ethOut - pos.ethIn);
      if (pos.tokens === '0') pos.closed = true;
      saveStore();
    }
    return { chain: chainKey, native: chain.native, venue, hash, feeHash, soldPct: p, proceedsEth: Number(ethers.formatEther(proceeds)), feeEth: Number(ethers.formatEther(fee)) };
  });
}

async function withdraw(chatId, to, amount, chainKey) {
  to = String(to || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('invalid destination address');
  if (/^0x0{40}$/i.test(to)) throw new Error('refusing to send to the zero address');
  const u = getUser(chatId); if (!u) throw new Error('no wallet');
  return withWalletLock(u.address, async () => {
    chainKey = chainKey || userChain(u);
    const wallet = signerFor(chatId, chainKey);
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

// Portfolio for the user's ACTIVE chain: live value + PnL per position.
async function portfolio(chatId) {
  const u = getUser(chatId); if (!u) return { rows: [], totalValueEth: 0, address: null, chain: null };
  const chainKey = userChain(u);
  const chain = chainOf(chainKey);
  const rows = [];
  let totalValueEth = 0;
  for (const key of Object.keys(u.positions)) {
    const p = u.positions[key];
    if (p.chain !== chainKey) continue;   // show only the active chain
    const balRaw = await tokenBalance(p.ca, u.address, chainKey);
    const bal = Number(ethers.formatUnits(balRaw, p.dec || 18));
    if (bal <= 1e-9 && !(p.ethIn > 0)) continue;
    const snap = await tokenSnapshot(p.ca, chainKey).catch(() => null);
    const priceEth = snap ? snap.priceEth : 0;
    const valueEth = bal * priceEth;
    totalValueEth += valueEth;
    rows.push({ ca: p.ca, name: p.name, sym: p.sym, tokens: bal, valueEth, ethIn: p.ethIn, ethOut: p.ethOut, unrealizedEth: valueEth - (p.ethIn - p.ethOut), realizedEth: p.realizedEth || 0 });
  }
  rows.sort((a, b) => b.valueEth - a.valueEth);
  return { rows, totalValueEth, address: u.address, chain, native: chain.native };
}

module.exports = {
  CFG, chains, chainOf, userChain, providerFor, FACTORY_ABI, CURVE_ABI, ERC20_ABI,
  loadStore, saveStore, saveStoreNow, allUsers, getUser, ensureUser, signerFor, exportKey, walletFromSecret, replaceWallet, setChain,
  resolveCurve, isGraduated, tokenMeta, tokenDecimals, tokenSnapshot, ethBalance, tokenBalance, ethUsd, gasOverrides,
  buy, sell, withdraw, portfolio, DB,
};
