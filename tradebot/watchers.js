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
  const armed = core.allUsers().filter((u) => u.snipe && u.snipe.on && Number(u.snipe.ethAmount) > 0);
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

// ------------------------------------------------------------------ orders
// Orders live ON a wallet (wallet.orders) and are tagged with walletId so a
// TP/SL/limit set on one wallet always executes on THAT wallet, even after the
// user switches their active wallet.
let _oid = 1;
const MAX_ORDERS_PER_USER = Math.max(1, Number(process.env.MAX_ORDERS_PER_USER || 25));
const ORDER_MAX_READS = Math.max(20, Number(process.env.ORDER_MAX_READS || 300));
const ORDER_CONCURRENCY = Math.max(1, Number(process.env.ORDER_CONCURRENCY || 4));
const ORDER_READ_TIMEOUT_MS = Math.max(1000, Number(process.env.ORDER_READ_TIMEOUT_MS || 3500));

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
  // Bounded, timeout-guarded, de-duplicated price reads — so a hostile/unpriceable
  // token can neither stall the loop nor drain the RPC endpoint.
  const priceCache = new Map();   // chain:ca -> Promise<priceEth|null> — cached BEFORE await so concurrent reads coalesce
  let reads = 0;
  const priceOf = (chain, ca) => {
    const k = chain + ':' + ca.toLowerCase();
    if (priceCache.has(k)) return priceCache.get(k);
    if (reads++ >= ORDER_MAX_READS) { const p = Promise.resolve(null); priceCache.set(k, p); return p; }   // read budget spent → defer
    const p = Promise.race([
      core.tokenSnapshot(ca, chain).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), ORDER_READ_TIMEOUT_MS)),   // hard per-read ceiling
    ]).then((snap) => (snap ? snap.priceEth : null));
    priceCache.set(k, p);   // store the PROMISE immediately → N concurrent callers = ONE RPC + ONE budget slot
    return p;
  };
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

// ------------------------------------------------------------------ loop runner
function start() {
  const snipeMs = Math.max(4000, Number(process.env.SNIPE_POLL_MS || 6000));
  const orderMs = Math.max(8000, Number(process.env.ORDER_POLL_MS || 15000));
  (async function snipeLoop() { for (;;) { try { await snipeCycle(); } catch (e) { console.error('snipe', e.message); } await sleep(snipeMs); } })();
  (async function orderLoop() { for (;;) { try { await ordersCycle(); } catch (e) { console.error('orders', e.message); } await sleep(orderMs); } })();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
const txLink = (chain, h) => { const c = core.chainOf(chain); return (h && c) ? `<a href="${c.explorer}/tx/${h}">tx ↗</a>` : ''; };

module.exports = { setNotifier, start, addOrder, cancelOrder };
