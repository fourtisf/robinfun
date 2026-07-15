'use strict';
/*
 * Background watchers for the Robinfun Trade Bot:
 *   • SNIPE   — new-launch auto-buy. Polls the factory for TokenCreated events and,
 *               for every user who armed a snipe, buys their configured amount.
 *   • ORDERS  — limit-buy / take-profit / stop-loss. Polls each order's live curve
 *               price and executes when the target is crossed.
 * Both are polling loops (no websockets) so they work over the same plain RPC the
 * rest of the stack uses. A notify(chatId, text) callback surfaces fills to users.
 */
const { ethers } = require('ethers');
const core = require('./core');

let _notify = () => {};
function setNotifier(fn) { if (typeof fn === 'function') _notify = fn; }

// ------------------------------------------------------------------ snipe
let _lastSnipeBlock = 0;
async function snipeCycle() {
  const armed = core.allUsers().filter((u) => u.snipe && u.snipe.on && Number(u.snipe.ethAmount) > 0);
  if (!armed.length) return;                          // nobody armed → skip the scan
  const prov = core.provider();
  const factory = new ethers.Contract(core.CFG.factory, core.FACTORY_ABI, prov);
  let head;
  try { head = await prov.getBlockNumber(); } catch (_) { return; }
  if (!_lastSnipeBlock) { _lastSnipeBlock = head; return; }   // baseline: only future launches
  if (head < _lastSnipeBlock) { _lastSnipeBlock = head; return; }
  let evs = [];
  try { evs = await factory.queryFilter(factory.filters.TokenCreated(), _lastSnipeBlock + 1, head); }
  catch (_) { return; }
  _lastSnipeBlock = head;
  for (const e of evs) {
    const ca = e.args && e.args.token;
    const sym = (e.args && e.args.symbol) || '?';
    if (!ca) continue;
    for (const u of armed) {
      // Skip wallets that can't afford the snipe — avoids spamming broke users
      // with failure DMs on every new launch.
      try {
        const bal = await core.ethBalance(u.address);
        const need = ethers.parseEther(String(u.snipe.ethAmount)) + ethers.parseEther(core.CFG.gasBufferEth);
        if (bal < need) continue;
      } catch (_) { continue; }
      try {
        const r = await core.buy(u.chatId, ca, u.snipe.ethAmount);
        _notify(u.chatId, `🎯 <b>Sniped $${esc(sym)}</b>\nBought ${fmt(r.gotTokens)} $${esc(r.sym)} for ${r.spentEth} ETH\n<code>${ca}</code>\n${txLink(r.hash)}`);
      } catch (err) {
        _notify(u.chatId, `⚠️ Snipe of $${esc(sym)} failed: ${esc(err.message || String(err))}`);
      }
    }
  }
}

// ------------------------------------------------------------------ orders
// order = { id, type:'tp'|'sl'|'limitbuy', ca, sym, targetPriceEth, ethAmount?, sellPct? }
let _oid = 1;
function addOrder(chatId, order) {
  const u = core.getUser(chatId); if (!u) throw new Error('no wallet');
  order.id = _oid++ + '' + Date.now().toString(36);
  order.createdAt = Date.now();
  u.orders = u.orders || [];
  u.orders.push(order);
  core.saveStore();
  return order;
}
function cancelOrder(chatId, id) {
  const u = core.getUser(chatId); if (!u || !u.orders) return false;
  const before = u.orders.length;
  u.orders = u.orders.filter((o) => o.id !== id);
  core.saveStore();
  return u.orders.length < before;
}
async function ordersCycle() {
  const users = core.allUsers().filter((u) => u.orders && u.orders.length);
  if (!users.length) return;
  // Snapshot price once per distinct CA this cycle (cheap dedupe).
  const priceCache = new Map();
  const priceOf = async (ca) => {
    const k = ca.toLowerCase();
    if (priceCache.has(k)) return priceCache.get(k);
    const snap = await core.tokenSnapshot(ca).catch(() => null);
    const px = snap ? snap.priceEth : null;
    priceCache.set(k, px);
    return px;
  };
  for (const u of users) {
    const keep = [];
    for (const o of u.orders) {
      let fired = false;
      try {
        const px = await priceOf(o.ca);
        if (px == null || !(px > 0)) { keep.push(o); continue; }
        const hit =
          (o.type === 'tp'       && px >= o.targetPriceEth) ||
          (o.type === 'sl'       && px <= o.targetPriceEth) ||
          (o.type === 'limitbuy' && px <= o.targetPriceEth);
        if (!hit) { keep.push(o); continue; }
        if (o.type === 'limitbuy') {
          const r = await core.buy(u.chatId, o.ca, o.ethAmount);
          _notify(u.chatId, `✅ <b>Limit buy filled</b> $${esc(r.sym)}\nBought ${fmt(r.gotTokens)} for ${r.spentEth} ETH\n${txLink(r.hash)}`);
        } else {
          const r = await core.sell(u.chatId, o.ca, o.sellPct || 100);
          const label = o.type === 'tp' ? 'Take-profit' : 'Stop-loss';
          _notify(u.chatId, `✅ <b>${label} filled</b> $${esc(o.sym || '')}\nSold ${r.soldPct}% for ${r.proceedsEth} ETH\n${txLink(r.hash)}`);
        }
        fired = true;
      } catch (err) {
        _notify(u.chatId, `⚠️ Order on $${esc(o.sym || '')} failed: ${esc(err.message || String(err))}`);
        keep.push(o);   // keep so the user can see/cancel; don't silently drop
        fired = true;
      }
      if (!fired) keep.push(o);
    }
    if (keep.length !== u.orders.length) { u.orders = keep; core.saveStore(); }
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
const txLink = (h) => h ? `<a href="${core.CFG.explorer}/tx/${h}">tx ↗</a>` : '';

module.exports = { setNotifier, start, addOrder, cancelOrder };
