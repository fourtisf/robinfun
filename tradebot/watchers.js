'use strict';
/*
 * Background watchers for the Robinfun Trade Bot:
 *   • SNIPE  — new-launch auto-buy on ROBINHOOD CHAIN (Robinfun curve launches).
 *              Polls the factory for TokenCreated and buys for every armed+funded
 *              user. (Generic new-pair sniping on other chains is a future add-on.)
 *   • ORDERS — limit-buy / take-profit / stop-loss on any chain. Polls each order's
 *              live price and executes ONE-SHOT when the target is crossed.
 *
 * Fund-safety: a triggered order is REMOVED and persisted synchronously BEFORE the
 * trade is sent, so a crash/restart can never replay a fill (double-spend). Orders
 * are one-shot — a triggered order that fails is dropped with a DM, not retried
 * (retrying a possibly-half-executed trade is unsafe).
 */
const { ethers } = require('ethers');
const core = require('./core');
const goplus = require('./goplus');

let _notify = () => {};
function setNotifier(fn) { if (typeof fn === 'function') _notify = fn; }
const SNIPE_CHAIN = 'robinhood';

// Bounded-concurrency map: run `fn` over items, at most `limit` in flight. Keeps
// one slow trade/confirmation from stalling the whole shared cycle (a triggered
// order or snipe that waits up to 180s for a receipt no longer blocks everyone).
async function mapLimit(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (_) {} } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
}
const SNIPE_CONCURRENCY = Math.max(1, Number(process.env.SNIPE_CONCURRENCY || 4));

// ------------------------------------------------------------------ snipe
let _lastSnipeBlock = 0;
const SNIPE_MAX_SPAN = Math.max(200, Number(process.env.SNIPE_MAX_SPAN || 2000));
const _snipeFailAt = new Map();   // chatId -> last failure-DM ms (rate limit)
async function snipeCycle() {
  const prov = core.providerFor(SNIPE_CHAIN);
  let head;
  try { head = await prov.getBlockNumber(); } catch (_) { return; }
  if (!_lastSnipeBlock || head < _lastSnipeBlock) _lastSnipeBlock = head;   // pin cursor near head always
  const armed = core.allUsers().filter((u) => u.snipe && u.snipe.chains && u.snipe.chains.robinhood && Number(u.snipe.ethAmount) > 0);
  if (!armed.length) { _lastSnipeBlock = head; return; }
  const factory = new ethers.Contract(core.chainOf(SNIPE_CHAIN).factory, core.FACTORY_ABI, prov);
  const from = Math.max(_lastSnipeBlock + 1, head - SNIPE_MAX_SPAN);
  if (from > head) { _lastSnipeBlock = head; return; }
  let evs = [];
  try { evs = await factory.queryFilter(factory.filters.TokenCreated(), from, head); }
  catch (_) { return; }
  _lastSnipeBlock = head;
  for (const e of evs) {
    const ca = e.args && e.args.token;
    const sym = (e.args && e.args.symbol) || '?';
    if (!ca) continue;
    // Snipe every armed user CONCURRENTLY (bounded) with their ACTIVE wallet, so one
    // slow buy doesn't make faster snipers miss the launch.
    await mapLimit(armed, SNIPE_CONCURRENCY, async (u) => {
      const addr = core.activeAddress(u); if (!addr) return;
      try {
        const bal = await core.ethBalance(addr, SNIPE_CHAIN);
        const need = ethers.parseEther(String(u.snipe.ethAmount)) + ethers.parseEther(core.CFG.gasBufferEth);
        if (bal < need) return;   // can't afford → skip silently (no spam)
      } catch (_) { return; }
      try {
        const r = await core.buy(u.chatId, ca, u.snipe.ethAmount, SNIPE_CHAIN);
        _notify(u.chatId, `🎯 <b>Sniped $${esc(sym)}</b>\nBought ${fmt(r.gotTokens)} $${esc(r.sym)} for ${r.spentEth} ${r.native}\n<code>${ca}</code>\n${txLink(SNIPE_CHAIN, r.hash)}`);
      } catch (err) {
        const now = Date.now();
        if (now - (_snipeFailAt.get(u.chatId) || 0) > 300000) {   // ≤ 1 failure DM / 5 min / user
          _snipeFailAt.set(u.chatId, now);
          _notify(u.chatId, `⚠️ A snipe failed: ${esc(err.message || String(err))} (further failures muted for 5 min)`);
        }
      }
    });
  }
}

// ------------------------------------------------------------------ multi-chain snipe (new DEX pairs)
const _dexSnipeCursor = {};   // chainKey -> last scanned block
const _dexFactory = {};       // chainKey -> DEX pair factory (cached)
const DEX_SNIPE_MAX_TOKENS = Math.max(1, Number(process.env.DEX_SNIPE_MAX_TOKENS || 15));   // cap tokens/chain/cycle
const PAIR_CREATED_ABI = ['event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'];
const ROUTER_FACTORY_ABI = ['function factory() view returns (address)'];

async function dexFactoryOf(chainKey) {
  if (_dexFactory[chainKey]) return _dexFactory[chainKey];
  try {
    const f = await new ethers.Contract(core.chainOf(chainKey).router, ROUTER_FACTORY_ABI, core.providerFor(chainKey)).factory();
    if (f && f !== ethers.ZeroAddress) { _dexFactory[chainKey] = f; return f; }
  } catch (_) {}
  return null;
}
// A getLogs/queryFilter error that means "the block range is too wide" (as opposed
// to a transient timeout). On these we skip the cursor FORWARD rather than retrying
// the same doomed range forever (which would livelock that chain's loop).
function _isRangeError(e) {
  const m = String((e && (e.message || e.info || e)) || '').toLowerCase();
  if (/too many requests|rate.?limit|\b429\b/.test(m)) return false;   // transient → retry the range, don't skip past it
  return /(too many results|more than \d+ results|query returned more than|block range|range is too|range too (large|wide|big)|response size|limited to|logs? .*range|\b10000\b|max.*results)/.test(m);
}

// Snipe brand-new DEX pairs on ETH/Base/BNB/Arbitrum for users who opted in per
// chain. Honeypots are skipped; each armed user's ACTIVE wallet buys the amount.
// Each chain scans INDEPENDENTLY and CONCURRENTLY so one slow/flaky RPC can't delay
// sniping on the others.
async function dexSnipeCycle() {
  const list = core.chains.enabledChains().filter((ch) => !ch.curve);   // Robinhood is handled by snipeCycle
  await Promise.all(list.map((ch) => _dexSnipeChain(ch).catch((e) => console.error('dexsnipe', ch.key, (e && e.message) || e))));
}
async function _dexSnipeChain(ch) {
  const armed = core.allUsers().filter((u) => u.snipe && u.snipe.chains && u.snipe.chains[ch.key] && Number(u.snipe.ethAmount) > 0);
  if (!armed.length) return;
  const prov = core.providerFor(ch.key);
  let head; try { head = await prov.getBlockNumber(); } catch (_) { return; }
  const cursor = _dexSnipeCursor[ch.key];
  if (!cursor || head < cursor) { _dexSnipeCursor[ch.key] = head; return; }   // pin near head first pass (no backfill flood)
  const factory = await dexFactoryOf(ch.key); if (!factory) { _dexSnipeCursor[ch.key] = head; return; }
  const from = Math.max(cursor + 1, head - SNIPE_MAX_SPAN);
  if (from > head) { _dexSnipeCursor[ch.key] = head; return; }
  let evs = [];
  try { const fc = new ethers.Contract(factory, PAIR_CREATED_ABI, prov); evs = await fc.queryFilter(fc.filters.PairCreated(), from, head); }
  catch (e) { if (_isRangeError(e)) _dexSnipeCursor[ch.key] = head; return; }   // range too wide → skip forward; else keep cursor, retry next cycle
  _dexSnipeCursor[ch.key] = head;
  const weth = ch.weth.toLowerCase();
  let processed = 0;
  for (const e of evs) {
    if (processed >= DEX_SNIPE_MAX_TOKENS) break;
    const a = e.args || {};
    const t0 = String(a.token0 || '').toLowerCase(), t1 = String(a.token1 || '').toLowerCase();
    let token = null;
    if (t0 === weth) token = a.token1; else if (t1 === weth) token = a.token0; else continue;   // only native-paired launches
    if (!token) continue;
    processed++;
    // Skip anything GoPlus flags as DANGER (honeypot, can't-sell, pausable, owner-rug,
    // blacklist, >10% tax). When GoPlus has no data yet (brand-new token) we proceed —
    // sniping fresh launches is the whole point; blind-buy risk is bounded by the amount.
    if (goplus.supported(ch.key)) { const s = await goplus.tokenSecurity(ch.key, token).catch(() => null); if (s && goplus.verdict(s).level === 'danger') continue; }
    await mapLimit(armed, SNIPE_CONCURRENCY, async (u) => {
      const addr = core.activeAddress(u); if (!addr) return;
      try {
        const bal = await core.ethBalance(addr, ch.key);
        const need = ethers.parseEther(String(u.snipe.ethAmount)) + ethers.parseEther(core.CFG.gasBufferEth);
        if (bal < need) return;
      } catch (_) { return; }
      try {
        const r = await core.buy(u.chatId, token, u.snipe.ethAmount, ch.key);
        _notify(u.chatId, `🎯 <b>Sniped $${esc(r.sym)}</b> on ${ch.emoji} ${esc(ch.name)}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n<code>${token}</code>\n${txLink(ch.key, r.hash)}`);
      } catch (err) {
        const now = Date.now(), key = u.chatId + ':' + ch.key;
        if (now - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now); _notify(u.chatId, `⚠️ A snipe on ${esc(ch.name)} failed: ${esc(err.message || String(err))} (muted 5 min)`); }
      }
    });
  }
}

// ------------------------------------------------------------------ orders
// Orders live ON a wallet (wallet.orders) and are tagged with walletId so a
// TP/SL/limit set on one wallet always executes on THAT wallet, even after the
// user switches their active wallet.
let _oid = 1;
const MAX_ORDERS_PER_USER = Math.max(1, Number(process.env.MAX_ORDERS_PER_USER || 25));
const ORDER_MAX_READS = Math.max(20, Number(process.env.ORDER_MAX_READS || 300));
const ORDER_CONCURRENCY = Math.max(1, Number(process.env.ORDER_CONCURRENCY || 4));
const ORDER_READ_TIMEOUT_MS = Math.max(1000, Number(process.env.ORDER_READ_TIMEOUT_MS || 3500));

// Shared bounded price reader: de-dups concurrent reads (caches the in-flight
// Promise), caps total distinct reads per cycle, and hard-times-out each read —
// so a hostile/unpriceable token can neither stall a cycle nor drain the RPC.
function priceReader() {
  const cache = new Map(); let reads = 0;
  return (chain, ca) => {
    const k = chain + ':' + String(ca).toLowerCase();
    if (cache.has(k)) return cache.get(k);
    if (reads++ >= ORDER_MAX_READS) { const p = Promise.resolve(null); cache.set(k, p); return p; }
    const p = Promise.race([
      core.tokenSnapshot(ca, chain).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), ORDER_READ_TIMEOUT_MS)),
    ]).then((snap) => (snap ? snap.priceEth : null));
    cache.set(k, p);
    return p;
  };
}

function addOrder(chatId, order, walletId) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u); if (!w) throw new Error('no wallet');
  // DoS guard: cap total active orders per USER (across all wallets). Without this
  // a single free account could enqueue thousands of never-triggering orders on
  // junk tokens and force the shared ordersCycle to do unbounded serial RPC reads.
  const total = core.walletList(u).reduce((n, x) => n + ((x.orders && x.orders.length) || 0), 0);
  if (total >= MAX_ORDERS_PER_USER) throw new Error(`order limit reached (${MAX_ORDERS_PER_USER}). Cancel some first.`);
  order.id = (_oid++) + Date.now().toString(36);
  order.createdAt = Date.now();
  if (!order.chain) order.chain = core.userChain(u);
  order.walletId = w.id;
  w.orders = w.orders || [];
  w.orders.push(order);
  core.saveStore();
  return order;
}
function cancelOrder(chatId, id) {
  const u = core.getUser(chatId); if (!u) return false;
  let removed = false;
  for (const w of core.walletList(u)) {
    if (!Array.isArray(w.orders)) continue;
    const before = w.orders.length;
    w.orders = w.orders.filter((o) => o.id !== id);
    if (w.orders.length !== before) removed = true;
  }
  if (removed) core.saveStore();
  return removed;
}
async function ordersCycle() {
  // Flatten every wallet's orders into work items.
  const items = [];
  for (const u of core.allUsers()) {
    for (const w of core.walletList(u)) {
      for (const o of (w.orders || [])) items.push({ u, w, o });
    }
  }
  if (!items.length) return;
  const priceOf = priceReader();   // bounded, de-duped, timeout-guarded reads
  // Process concurrently (bounded) so one slow trade/user can't starve the rest.
  await mapLimit(items, ORDER_CONCURRENCY, async ({ u, w, o }) => {
    if (!Array.isArray(w.orders) || !w.orders.some((x) => x.id === o.id)) return;   // already filled/cancelled
    const chain = o.chain || SNIPE_CHAIN;
    let px;
    try { px = await priceOf(chain, o.ca); } catch (_) { return; }
    if (px == null || !(px > 0)) return;
    const hit =
      (o.type === 'tp'       && px >= o.targetPriceEth) ||
      (o.type === 'sl'       && px <= o.targetPriceEth) ||
      (o.type === 'limitbuy' && px <= o.targetPriceEth);
    if (!hit) return;
    // ONE-SHOT: remove + persist SYNCHRONOUSLY before the trade, so a crash can
    // never replay this fill on restart.
    w.orders = w.orders.filter((x) => x.id !== o.id);
    core.saveStoreNow();
    try {
      // Execute on the wallet the order LIVES ON (`w` is authoritative — the order
      // was pulled from w.orders), never on whatever wallet is merely active now.
      if (o.type === 'limitbuy') {
        const r = await core.buy(u.chatId, o.ca, o.ethAmount, chain, w.id);
        _notify(u.chatId, `✅ <b>Limit buy filled</b> $${esc(r.sym)}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n${txLink(chain, r.hash)}`);
      } else {
        const r = await core.sell(u.chatId, o.ca, o.sellPct || 100, chain, w.id);
        const label = o.type === 'tp' ? 'Take-profit' : 'Stop-loss';
        _notify(u.chatId, `✅ <b>${label} filled</b> $${esc(o.sym || '')}\nSold ${r.soldPct}% for ${r.proceedsEth} ${r.native}\n${txLink(chain, r.hash)}`);
      }
    } catch (err) {
      _notify(u.chatId, `⚠️ Order on $${esc(o.sym || '')} triggered but failed: ${esc(err.message || String(err))}\nIt was removed — re-create it if you still want it.`);
    }
  });
}

// ------------------------------------------------------------------ price alerts (notify-only)
let _aid = 1;
const MAX_ALERTS_PER_USER = Math.max(1, Number(process.env.MAX_ALERTS_PER_USER || 25));
function addAlert(chatId, alert) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  u.alerts = u.alerts || [];
  if (u.alerts.length >= MAX_ALERTS_PER_USER) throw new Error(`alert limit reached (${MAX_ALERTS_PER_USER}). Cancel some first.`);
  alert.id = 'al' + (_aid++) + Date.now().toString(36);
  alert.createdAt = Date.now();
  if (!alert.chain) alert.chain = core.userChain(u);
  u.alerts.push(alert);
  core.saveStore();
  return alert;
}
function cancelAlert(chatId, id) {
  const u = core.getUser(chatId); if (!u || !Array.isArray(u.alerts)) return false;
  const before = u.alerts.length;
  u.alerts = u.alerts.filter((a) => a.id !== id);
  if (u.alerts.length !== before) { core.saveStore(); return true; }
  return false;
}
async function alertsCycle() {
  const items = [];
  for (const u of core.allUsers()) for (const a of (u.alerts || [])) items.push({ u, a });
  if (!items.length) return;
  const priceOf = priceReader();
  await mapLimit(items, ORDER_CONCURRENCY, async ({ u, a }) => {
    if (!Array.isArray(u.alerts) || !u.alerts.some((x) => x.id === a.id)) return;   // cancelled since
    const chain = a.chain || SNIPE_CHAIN;
    let px; try { px = await priceOf(chain, a.ca); } catch (_) { return; }
    if (px == null || !(px > 0)) return;
    const hit = (a.dir === 'above' && px >= a.targetPriceEth) || (a.dir === 'below' && px <= a.targetPriceEth);
    if (!hit) return;
    // ONE-SHOT: remove + persist BEFORE notifying, so a crash can't double-fire.
    u.alerts = u.alerts.filter((x) => x.id !== a.id);
    core.saveStoreNow();
    const c = core.chainOf(chain) || { native: 'ETH', name: chain, emoji: '' };
    const wi = ((u.wallets || []).findIndex((w) => w.id === u.activeWalletId) + 1) || 1;   // active wallet (1-based), not a hardcoded #1
    const kb = { inline_keyboard: [[{ text: '📈 Trade', callback_data: `tok:${chain}:${wi}:${a.ca}` }]] };
    _notify(u.chatId, `🔔 <b>Price alert</b> — $${esc(a.sym || '')} is now <b>${a.dir === 'above' ? 'above' : 'below'}</b> your target${a.targetUsd ? ' of $' + a.targetUsd : ''} on ${c.emoji ? c.emoji + ' ' : ''}${esc(c.name || chain)}.`, kb);
  });
}

// ------------------------------------------------------------------ copy-trading (copy-BUY only)
// Mirror a followed wallet's BUYS: watch ERC20 Transfer logs TO the target, and
// only mirror when the token came FROM its own WETH pair (i.e. a real swap-buy,
// not an airdrop/transfer). Honeypots skipped. Total spend per target is HARD-
// capped at maxEth, so worst-case loss is bounded even if it mirrors a bad token.
// Sells are the user's job (TP/SL/manual) — we never auto-sell someone else's exit.
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const GET_PAIR_ABI = ['function getPair(address,address) view returns (address)'];
const COPY_MAX_MIRRORS_PER_CYCLE = Math.max(1, Number(process.env.COPY_MAX_MIRRORS || 5));
const _copyPair = new Map();   // 'chain:token' -> { pair: string|null, at: ms }, BOUNDED
const COPY_PAIR_MAX = 5000;
const COPY_PAIR_NULL_TTL = 600000;   // a V2 pair address is permanent once it exists; re-check "no pair yet" every 10 min
async function pairOf(chainKey, token) {
  const k = chainKey + ':' + String(token).toLowerCase();
  const hit = _copyPair.get(k);
  if (hit && (hit.pair || (Date.now() - hit.at) < COPY_PAIR_NULL_TTL)) return hit.pair;
  const factory = await dexFactoryOf(chainKey);
  if (!factory) return null;   // transient factory miss → don't cache (retry next time)
  let pair = null;
  try {
    const p = await new ethers.Contract(factory, GET_PAIR_ABI, core.providerFor(chainKey)).getPair(token, core.chainOf(chainKey).weth);
    pair = (p && p !== ethers.ZeroAddress) ? p.toLowerCase() : null;
  } catch (_) { return null; }   // transient RPC error → don't cache a false "no pair"
  if (_copyPair.size >= COPY_PAIR_MAX) { const first = _copyPair.keys().next().value; _copyPair.delete(first); }   // bound memory (drop oldest)
  _copyPair.set(k, { pair, at: Date.now() });
  return pair;
}
async function copyCycle() {
  const users = core.allUsers().filter((u) => u.copy && u.copy.on && Array.isArray(u.copy.targets) && u.copy.targets.length);
  if (!users.length) return;
  for (const u of users) {
    for (const t of u.copy.targets) {
      const ch = core.chainOf(t.chain); if (!ch) continue;
      const prov = core.providerFor(t.chain);
      let head; try { head = await prov.getBlockNumber(); } catch (_) { continue; }
      if (!t.cursor || head < t.cursor) { t.cursor = head; core.saveStore(); continue; }   // pin near head first pass
      const from = Math.max(t.cursor + 1, head - SNIPE_MAX_SPAN);
      if (from > head) { t.cursor = head; continue; }
      let logs = [];
      try { logs = await prov.getLogs({ fromBlock: from, toBlock: head, topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(t.address.toLowerCase(), 32)] }); }
      catch (e) { if (_isRangeError(e)) { t.cursor = head; core.saveStore(); }  continue; }   // range too wide → skip forward (don't livelock); else keep cursor, retry
      t.cursor = head;
      let mirrors = 0;
      for (const log of logs) {
        if (mirrors >= COPY_MAX_MIRRORS_PER_CYCLE) break;
        const token = String(log.address || '').toLowerCase();
        const fromAddr = (log.topics && log.topics[1]) ? ('0x' + log.topics[1].slice(26)).toLowerCase() : '';
        if (!token || !fromAddr) continue;
        if (t.bought && t.bought[token]) continue;                         // already mirrored this token
        if (token === ch.weth.toLowerCase()) continue;                     // ignore WETH itself
        if (Number(t.spentEth) + Number(t.buyEth) > Number(t.maxEth) + 1e-12) continue;   // budget cap
        const pair = await pairOf(t.chain, token);
        if (!pair || pair !== fromAddr) continue;                          // not a swap-buy → skip (airdrop/transfer)
        // Skip anything GoPlus flags as DANGER (honeypot/pausable/owner-rug/high-tax…);
        // when GoPlus has no data we still mirror — worst-case loss stays bounded by maxEth.
        if (goplus.supported(t.chain)) { const s = await goplus.tokenSecurity(t.chain, token).catch(() => null); if (s && goplus.verdict(s).level === 'danger') continue; }
        // Commit budget + dedup BEFORE spending (crash-safe: no double-mirror, budget can't be exceeded on restart).
        t.bought = t.bought || {};
        const boughtKeys = Object.keys(t.bought);
        if (boughtKeys.length >= 2000) delete t.bought[boughtKeys[0]];   // hard cap the dedup map (drop oldest)
        t.bought[token] = true;
        t.spentEth = Number(t.spentEth) + Number(t.buyEth);
        core.saveStoreNow();
        mirrors++;
        try {
          const r = await core.buy(u.chatId, token, t.buyEth, t.chain);
          _notify(u.chatId, `👥 <b>Copy-buy</b> $${esc(r.sym)} on ${ch.emoji} ${esc(ch.name)}\nFollowed <code>${short(t.address)}</code> · ${r.spentEth} ${r.native}\n<code>${token}</code>\n${txLink(t.chain, r.hash)}`);
        } catch (err) {
          // Only give the budget/dedup back when the buy CLEARLY didn't spend. If the tx
          // was broadcast but couldn't be confirmed (err.broadcast), it may still land —
          // keep the commit so we never double-spend the budget on the next cycle.
          if (!err || !err.broadcast) {
            t.spentEth = Math.max(0, Number(t.spentEth) - Number(t.buyEth));   // buy didn't spend → give the budget back
            delete t.bought[token];                                            // and forget it (nothing bought → no dedup leak)
            core.saveStoreNow();
          }
          const now = Date.now(), key = u.chatId + ':copy:' + token;
          if (now - (_snipeFailAt.get(key) || 0) > 300000) { _snipeFailAt.set(key, now); _notify(u.chatId, `⚠️ Copy-buy of ${short(token)} failed: ${esc(err.message || String(err))} (muted 5 min)`); }
        }
      }
    }
    core.saveStore();
  }
}

// ------------------------------------------------------------------ referral auto-payout (opt-in)
const REF_PAYOUT_MIN = Math.max(0, Number(process.env.REF_PAYOUT_MIN_ETH || 0.005));   // min owed before paying (dust/gas guard)
async function payoutCycle() {
  if (!core.feePayoutEnabled()) return;
  const minWei = ethers.parseEther(String(REF_PAYOUT_MIN));
  for (const u of core.allUsers()) {
    const owed = u.refOwed; if (!owed || typeof owed !== 'object') continue;
    const dest = core.activeAddress(u); if (!dest) continue;
    for (const ck of Object.keys(owed)) {
      const ch = core.chainOf(ck); if (!ch) continue;
      let wei; try { wei = BigInt(owed[ck] || '0'); } catch (_) { continue; }
      if (wei < minWei) continue;
      // Deduct BEFORE paying so a crash can never overpay.
      owed[ck] = '0';
      core.saveStoreNow();
      try {
        const r = await core.payFromFeeWallet(ck, dest, wei);
        _notify(u.chatId, `💸 <b>Referral payout</b> — ${Number(ethers.formatEther(wei)).toFixed(5)} ${ch.native} sent to your wallet${r.confirmed ? '' : ' (confirming)'}.\n${txLink(ck, r.hash)}`);
      } catch (err) {
        if (err && err.ambiguous) {
          // The tx MAY have been accepted on-chain (broadcast errored after the node saw
          // it). Re-paying could double-send real funds, so we do NOT restore — the debt
          // stays cleared and we log it for manual review. Under-paying a small referral
          // credit is far safer than double-paying from a hot wallet.
          console.error('payout AMBIGUOUS (left cleared, verify manually)', ck, dest, wei.toString(), (err && err.message) || err);
        } else {
          // Nothing moved (pre-broadcast failure or clean revert) → give the debt back.
          // ADDITIVELY: a concurrent referral credit may have landed since we zeroed it.
          try { owed[ck] = (BigInt(owed[ck] || '0') + wei).toString(); } catch (_) { owed[ck] = wei.toString(); }
          core.saveStoreNow();
          console.error('payout', ck, (err && (err.message || err)) || 'unknown');
        }
      }
    }
  }
}

// ------------------------------------------------------------------ loop runner
function start() {
  const snipeMs = Math.max(4000, Number(process.env.SNIPE_POLL_MS || 6000));
  const orderMs = Math.max(8000, Number(process.env.ORDER_POLL_MS || 15000));
  const alertMs = Math.max(8000, Number(process.env.ALERT_POLL_MS || 20000));
  const dexSnipeMs = Math.max(5000, Number(process.env.DEX_SNIPE_POLL_MS || 8000));
  (async function snipeLoop() { for (;;) { try { await snipeCycle(); } catch (e) { console.error('snipe', e.message); } await sleep(snipeMs); } })();
  (async function dexSnipeLoop() { for (;;) { try { await dexSnipeCycle(); } catch (e) { console.error('dexsnipe', e.message); } await sleep(dexSnipeMs); } })();
  (async function orderLoop() { for (;;) { try { await ordersCycle(); } catch (e) { console.error('orders', e.message); } await sleep(orderMs); } })();
  (async function alertLoop() { for (;;) { try { await alertsCycle(); } catch (e) { console.error('alerts', e.message); } await sleep(alertMs); } })();
  const copyMs = Math.max(6000, Number(process.env.COPY_POLL_MS || 10000));
  (async function copyLoop() { for (;;) { try { await copyCycle(); } catch (e) { console.error('copy', e.message); } await sleep(copyMs); } })();
  if (core.feePayoutEnabled()) {
    const payoutMs = Math.max(60000, Number(process.env.REF_PAYOUT_POLL_MS || 300000));   // 5 min default
    console.log('referral auto-payout ENABLED (fee wallet key present)');
    (async function payoutLoop() { for (;;) { try { await payoutCycle(); } catch (e) { console.error('payout', e.message); } await sleep(payoutMs); } })();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
const txLink = (chain, h) => { const c = core.chainOf(chain); return (h && c) ? `<a href="${c.explorer}/tx/${h}">tx ↗</a>` : ''; };

module.exports = { setNotifier, start, addOrder, cancelOrder, addAlert, cancelAlert };
