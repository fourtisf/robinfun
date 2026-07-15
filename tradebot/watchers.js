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
    for (const u of armed) {
      try {
        const bal = await core.ethBalance(u.address, SNIPE_CHAIN);
        const need = ethers.parseEther(String(u.snipe.ethAmount)) + ethers.parseEther(core.CFG.gasBufferEth);
        if (bal < need) continue;   // can't afford → skip silently (no spam)
      } catch (_) { continue; }
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
    }
  }
}

// ------------------------------------------------------------------ orders
let _oid = 1;
function addOrder(chatId, order) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  order.id = (_oid++) + Date.now().toString(36);
  order.createdAt = Date.now();
  if (!order.chain) order.chain = core.userChain(u);
  u.orders = u.orders || [];
  u.orders.push(order);
  core.saveStore();
  return order;
}
function cancelOrder(chatId, id) {
  const u = core.getUser(chatId); if (!u || !u.orders) return false;
  const before = u.orders.length;
  u.orders = u.orders.filter((o) => o.id !== id);
  if (u.orders.length !== before) core.saveStore();
  return u.orders.length < before;
}
async function ordersCycle() {
  const users = core.allUsers().filter((u) => u.orders && u.orders.length);
  if (!users.length) return;
  const priceCache = new Map();
  const priceOf = async (chain, ca) => {
    const k = chain + ':' + ca.toLowerCase();
    if (priceCache.has(k)) return priceCache.get(k);
    const snap = await core.tokenSnapshot(ca, chain).catch(() => null);
    const px = snap ? snap.priceEth : null;
    priceCache.set(k, px);
    return px;
  };
  for (const u of users) {
    for (const o of [...u.orders]) {          // snapshot: we mutate u.orders inside
      const chain = o.chain || SNIPE_CHAIN;
      let px;
      try { px = await priceOf(chain, o.ca); } catch (_) { continue; }
      if (px == null || !(px > 0)) continue;
      const hit =
        (o.type === 'tp'       && px >= o.targetPriceEth) ||
        (o.type === 'sl'       && px <= o.targetPriceEth) ||
        (o.type === 'limitbuy' && px <= o.targetPriceEth);
      if (!hit) continue;
      // ONE-SHOT: remove + persist SYNCHRONOUSLY before the trade, so a crash can
      // never replay this fill on restart.
      u.orders = u.orders.filter((x) => x.id !== o.id);
      core.saveStoreNow();
      try {
        if (o.type === 'limitbuy') {
          const r = await core.buy(u.chatId, o.ca, o.ethAmount, chain);
          _notify(u.chatId, `✅ <b>Limit buy filled</b> $${esc(r.sym)}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ${r.native}\n${txLink(chain, r.hash)}`);
        } else {
          const r = await core.sell(u.chatId, o.ca, o.sellPct || 100, chain);
          const label = o.type === 'tp' ? 'Take-profit' : 'Stop-loss';
          _notify(u.chatId, `✅ <b>${label} filled</b> $${esc(o.sym || '')}\nSold ${r.soldPct}% for ${r.proceedsEth} ${r.native}\n${txLink(chain, r.hash)}`);
        }
      } catch (err) {
        _notify(u.chatId, `⚠️ Order on $${esc(o.sym || '')} triggered but failed: ${esc(err.message || String(err))}\nIt was removed — re-create it if you still want it.`);
      }
    }
  }
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
