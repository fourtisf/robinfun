'use strict';
/*
 * Robinfun Trade Bot — Telegram UI (long-polling, HTML formatting, inline
 * keyboards). Paste a token contract address to get a live card with one-tap
 * buy/sell; manage your custodial wallet, portfolio, snipes, limit/TP-SL orders
 * and referrals. All trading logic lives in core.js; watchers.js runs snipe +
 * order fills in the background.
 */
const { ethers } = require('ethers');
const core = require('./core');
const watchers = require('./watchers');

const API = `https://api.telegram.org/bot${core.CFG.tgToken}`;
const pending = new Map();      // chatId -> { action, ... } for multi-step text input
let ETHUSD = 0;

// ------------------------------------------------------------ telegram api
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  return r.json();
}
function send(chatId, text, kb) { return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }); }
function edit(chatId, mid, text, kb) { return tg('editMessageText', { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }); }
function answer(id, text) { return tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); }
function del(chatId, mid) { return tg('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {}); }
const rows = (...r) => ({ inline_keyboard: r });
const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });

// ------------------------------------------------------------ format helpers
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
const usd = (eth) => ETHUSD > 0 ? '$' + fmt(Number(eth) * ETHUSD) : '—';
const isCa = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
const txLink = (h) => h ? `<a href="${core.CFG.explorer}/tx/${h}">tx ↗</a>` : '';

// ------------------------------------------------------------ screens
function mainMenu() {
  return rows(
    [btn('💼 Wallet', 'wal'), btn('📊 Portfolio', 'pos')],
    [btn('🎯 Snipe', 'snipe'), btn('📋 Orders', 'orders')],
    [btn('🎁 Referrals', 'ref'), btn('❔ Help', 'help')],
  );
}
async function walletScreen(chatId) {
  const u = core.ensureUser(chatId);
  const bal = await core.ethBalance(u.address);
  const ethStr = fmtEth(bal);
  return {
    text:
      `💼 <b>Your Wallet</b>\n\n` +
      `<code>${u.address}</code>\n\n` +
      `Balance: <b>${ethStr} ETH</b> (${usd(ethStr)})\n\n` +
      `Deposit ETH to this address on <b>Robinhood Chain</b>, then paste any token contract address to trade.`,
    kb: rows(
      [btn('🔄 Refresh', 'wal'), btn('📥 Deposit', 'dep')],
      [btn('📤 Withdraw', 'wd'), btn('🔑 Export key', 'exp')],
      [btn('📩 Import wallet', 'imp'), btn('♻️ New wallet', 'neww')],
      [btn('« Menu', 'menu')],
    ),
  };
}
function fmtEth(wei) { try { return Number(ethers.formatEther(wei)).toFixed(5); } catch (_) { return '0'; } }

async function tokenCard(chatId, ca) {
  const snap = await core.tokenSnapshot(ca).catch(() => null);
  if (!snap) return { text: '❌ Not a Robinfun token (no bonding curve found for that address).', kb: rows([btn('« Menu', 'menu')]) };
  const meta = await core.tokenMeta(ca);
  const u = core.getUser(chatId);
  const balRaw = u ? await core.tokenBalance(ca, u.address) : 0n;
  const bal = Number(ethers.formatUnits(balRaw, 18));
  const pos = u && u.positions[ca.toLowerCase()];
  const valueEth = bal * snap.priceEth;
  let pnlLine = '';
  if (pos && (pos.ethIn > 0)) {
    const unreal = valueEth - (pos.ethIn - pos.ethOut);
    const sign = unreal >= 0 ? '+' : '';
    pnlLine = `\nYour bag: ${fmt(bal)} $${esc(meta.sym)} · ${usd(valueEth)} · PnL <b>${sign}${unreal.toFixed(4)} ETH</b>`;
  } else if (bal > 0) {
    pnlLine = `\nYour bag: ${fmt(bal)} $${esc(meta.sym)} · ${usd(valueEth)}`;
  }
  const phase = snap.graduated ? '◆ GRADUATED (Uniswap)' : `◈ LISTED · ${snap.progressPct.toFixed(0)}% to graduation`;
  const priceUsd = snap.priceEth * ETHUSD;
  const text =
    `<b>${esc(meta.name)}</b>  $${esc(meta.sym)}\n` +
    `<code>${ca}</code>\n` +
    `${phase}\n\n` +
    `Price: <b>${priceUsd > 0 ? '$' + priceUsd.toPrecision(3) : snap.priceEth.toExponential(2) + ' ETH'}</b>\n` +
    `Market cap: <b>${usd(snap.mcapEth)}</b>${pnlLine}\n\n` +
    `<a href="${core.CFG.site}/token/${ca}">Open on Robinfun ↗</a>`;
  const kb = rows(
    [btn('Buy 0.01', `b:${ca}:0.01`), btn('Buy 0.05', `b:${ca}:0.05`), btn('Buy 0.1', `b:${ca}:0.1`)],
    [btn('Buy X', `bx:${ca}`), btn('Sell 50%', `s:${ca}:50`), btn('Sell 100%', `s:${ca}:100`)],
    [btn('🎯 TP', `tp:${ca}`), btn('🛑 SL', `sl:${ca}`), btn('⏳ Limit buy', `lb:${ca}`)],
    [btn('🔄 Refresh', `tok:${ca}`), btn('« Menu', 'menu')],
  );
  return { text, kb };
}

async function portfolioScreen(chatId) {
  const pf = await core.portfolio(chatId);
  if (!pf.rows.length) return { text: '📊 <b>Portfolio</b>\n\nNo open positions yet. Paste a token contract address to buy.', kb: rows([btn('« Menu', 'menu')]) };
  let body = '';
  let totalUnreal = 0;
  for (const r of pf.rows) {
    const sign = r.unrealizedEth >= 0 ? '+' : '';
    totalUnreal += r.unrealizedEth;
    body += `<b>$${esc(r.sym)}</b> ${fmt(r.tokens)} · ${usd(r.valueEth)}\n   in ${r.ethIn.toFixed(4)} / out ${r.ethOut.toFixed(4)} ETH · PnL ${sign}${r.unrealizedEth.toFixed(4)}\n   <code>${r.ca}</code>\n`;
  }
  const sign = totalUnreal >= 0 ? '+' : '';
  const text = `📊 <b>Portfolio</b>  ·  value ${usd(pf.totalValueEth)}\n\n${body}\nUnrealized PnL: <b>${sign}${totalUnreal.toFixed(4)} ETH</b>`;
  return { text, kb: rows([btn('🔄 Refresh', 'pos'), btn('« Menu', 'menu')]) };
}

function snipeScreen(chatId) {
  const u = core.ensureUser(chatId);
  const on = u.snipe.on;
  return {
    text:
      `🎯 <b>Snipe new launches</b>\n\n` +
      `When ON, the bot auto-buys <b>every new token</b> launched on Robinfun the moment it's created.\n\n` +
      `Status: <b>${on ? '🟢 ON' : '⚪ OFF'}</b>\nAmount per snipe: <b>${esc(u.snipe.ethAmount)} ETH</b>\n\n` +
      `⚠️ Snipes buy indiscriminately — keep the amount small.`,
    kb: rows(
      [btn(on ? '🔴 Turn OFF' : '🟢 Turn ON', on ? 'snoff' : 'snon')],
      [btn('✏️ Set amount', 'snamt')],
      [btn('« Menu', 'menu')],
    ),
  };
}
function ordersScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = u.orders || [];
  if (!list.length) return { text: '📋 <b>Orders</b>\n\nNo active orders. Open a token card and set a Take-profit, Stop-loss, or Limit buy.', kb: rows([btn('« Menu', 'menu')]) };
  let body = '';
  const kbRows = [];
  for (const o of list) {
    const label = o.type === 'tp' ? 'TP' : o.type === 'sl' ? 'SL' : 'Limit buy';
    const tgtUsd = ETHUSD > 0 ? ('$' + (o.targetPriceEth * ETHUSD).toPrecision(3)) : (o.targetPriceEth.toExponential(2) + ' ETH');
    body += `<b>${label}</b> $${esc(o.sym || '')} @ ${tgtUsd}${o.type === 'limitbuy' ? ' · ' + o.ethAmount + ' ETH' : ' · sell ' + (o.sellPct || 100) + '%'}\n`;
    kbRows.push([btn(`✖ Cancel ${label} $${o.sym || ''}`, `oc:${o.id}`)]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `📋 <b>Active orders</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function referralScreen(chatId, botUsername) {
  const u = core.ensureUser(chatId);
  const link = `https://t.me/${botUsername}?start=${u.refCode}`;
  return {
    text:
      `🎁 <b>Referrals</b>\n\n` +
      `Share your link — you earn <b>${(core.CFG.refShareBps / 100).toFixed(0)}%</b> of the bot fee on every trade your referrals make.\n\n` +
      `Your link:\n<code>${link}</code>\n\n` +
      `Earned so far: <b>${(u.refEarnedEth || 0).toFixed(5)} ETH</b>`,
    kb: rows([btn('« Menu', 'menu')]),
  };
}

// ------------------------------------------------------------ actions
async function doBuy(chatId, ca, amt, mid) {
  try {
    await send(chatId, `⏳ Buying ${amt} ETH of <code>${short(ca)}</code>…`);
    const r = await core.buy(chatId, ca, amt);
    await send(chatId, `✅ <b>Bought</b> ${fmt(r.gotTokens)} $${esc(r.sym)}\nSpent ${r.spentEth} ETH · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.hash)}`, rows([btn('🔄 Card', `tok:${ca}`), btn('📊 Portfolio', 'pos')]));
  } catch (e) { await send(chatId, `❌ Buy failed: ${esc(e.message || String(e))}`); }
}
async function doSell(chatId, ca, pct) {
  try {
    await send(chatId, `⏳ Selling ${pct}% of <code>${short(ca)}</code>…`);
    const r = await core.sell(chatId, ca, pct);
    await send(chatId, `✅ <b>Sold</b> ${r.soldPct}%\nGot ${r.proceedsEth} ETH · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.hash)}`, rows([btn('🔄 Card', `tok:${ca}`), btn('📊 Portfolio', 'pos')]));
  } catch (e) { await send(chatId, `❌ Sell failed: ${esc(e.message || String(e))}`); }
}

// ------------------------------------------------------------ router
let BOT_USERNAME = '';
async function handleUpdate(up) {
  try {
    // Custodial bot: DMs ONLY. In a group, chat.id is shared, so everyone would
    // control one wallet and could resolve each other's pending actions. Refuse.
    const chat = (up.message && up.message.chat) || (up.callback_query && up.callback_query.message && up.callback_query.message.chat);
    if (chat && chat.type !== 'private') {
      if (up.callback_query) await answer(up.callback_query.id, 'DM me privately — group use is disabled.');
      else if (up.message) await send(chat.id, 'This is a custodial trading bot — please DM me privately. Group use is disabled for security.');
      return;
    }
    if (up.message) return await onMessage(up.message);
    if (up.callback_query) return await onCallback(up.callback_query);
  } catch (e) { console.error('handleUpdate', e.message); }
}

async function onMessage(m) {
  const chatId = m.chat.id;
  const text = (m.text || '').trim();
  if (!text) return;

  // Multi-step text input (withdraw address/amount, custom amounts, order prices).
  const p = pending.get(chatId);
  if (p && !text.startsWith('/')) { pending.delete(chatId); return await resolvePending(chatId, p, text, m); }
  if (text.startsWith('/')) pending.delete(chatId);   // any command aborts a pending flow
  if (text === '/cancel') return send(chatId, 'Cancelled.', mainMenu());

  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const ref = parts[1] || null;
    const isNew = !core.getUser(chatId);
    core.ensureUser(chatId, ref);
    const w = await walletScreen(chatId);
    await send(chatId,
      `👋 <b>Welcome to the Robinfun Trade Bot</b>\n\n` +
      `Trade any token on Robinhood Chain straight from Telegram — paste a contract address to start.\n` +
      (isNew ? `\nA fresh wallet was created for you 👇` : '') , mainMenu());
    return await send(chatId, w.text, w.kb);
  }
  if (text === '/wallet') { const w = await walletScreen(chatId); return send(chatId, w.text, w.kb); }
  if (text === '/portfolio' || text === '/positions') { const s = await portfolioScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/snipe') { const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/orders') { const s = ordersScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/referral' || text === '/refer') { const s = referralScreen(chatId, BOT_USERNAME); return send(chatId, s.text, s.kb); }
  if (text === '/withdraw') { pending.set(chatId, { action: 'wd_addr' }); return send(chatId, '📤 Send me the <b>destination address</b> to withdraw ETH to:'); }
  if (text === '/export') return askExport(chatId);
  if (text === '/menu' || text === '/help') return send(chatId, helpText(), mainMenu());
  if (text.startsWith('/buy')) { const [, ca, amt] = text.split(/\s+/); if (isCa(ca) && amt) return doBuy(chatId, ca, amt); return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;eth&gt;</code> — or just paste a contract address.'); }
  if (text.startsWith('/sell')) { const [, ca, pct] = text.split(/\s+/); if (isCa(ca) && pct) return doSell(chatId, ca, Number(pct)); return send(chatId, 'Usage: <code>/sell &lt;contract&gt; &lt;pct&gt;</code>'); }

  // Bare contract address → token card.
  if (isCa(text)) { core.ensureUser(chatId); const c = await tokenCard(chatId, text); return send(chatId, c.text, c.kb); }

  return send(chatId, 'Paste a <b>token contract address</b> to trade, or tap a button.', mainMenu());
}

async function onCallback(q) {
  const chatId = q.message.chat.id;
  const mid = q.message.message_id;
  const data = q.data || '';
  const [k, ca, arg] = data.split(':');
  if (k !== 'oc') await answer(q.id);   // 'oc' answers itself with a toast below

  if (data === 'wdcancel') { pending.delete(chatId); return send(chatId, 'Withdrawal cancelled.', mainMenu()); }
  if (data === 'wdok') {
    const pp = pending.get(chatId); pending.delete(chatId);
    if (!pp || pp.action !== 'wd_confirm') return send(chatId, 'Nothing to confirm (expired). Start again with /withdraw.');
    try { await send(chatId, '⏳ Sending…'); const r = await core.withdraw(chatId, pp.to, pp.amt); return send(chatId, `✅ Sent <b>${r.sentEth} ETH</b>\n${txLink(r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (data === 'menu') return edit(chatId, mid, '🏠 <b>Robinfun Trade Bot</b>\n\nPaste a contract address to trade, or pick:', mainMenu());
  if (data === 'help') return edit(chatId, mid, helpText(), mainMenu());
  if (data === 'wal') { const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'pos') { const s = await portfolioScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snipe') { const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'orders') { const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ref') { const s = referralScreen(chatId, BOT_USERNAME); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dep') { const u = core.ensureUser(chatId); return edit(chatId, mid, `📥 <b>Deposit ETH</b>\n\nSend ETH on <b>Robinhood Chain</b> to:\n\n<code>${u.address}</code>\n\nIt lands in your bot wallet — then paste any token contract to buy.`, rows([btn('🔄 Refresh balance', 'wal'), btn('« Menu', 'menu')])); }
  if (data === 'wd') { pending.set(chatId, { action: 'wd_addr' }); return send(chatId, '📤 Send me the <b>destination address</b>:'); }
  if (data === 'exp') return askExport(chatId);
  if (data === 'imp') { pending.set(chatId, { action: 'import_key' }); return send(chatId, `📩 <b>Import a wallet</b>\n\nPaste your <b>private key</b> (64 hex) or <b>seed phrase</b> (12–24 words).\n\n⚠️ I will <b>delete your message immediately</b> after importing so the secret isn't left in the chat. Never share it with anyone else.`); }
  if (data === 'neww') return send(chatId, `♻️ <b>Generate a new wallet</b>\n\nThis replaces your current bot wallet with a fresh one. Your current wallet must be <b>empty</b> first (withdraw/export it), or the switch is blocked so funds aren't lost.\n\nProceed?`, rows([btn('✅ Generate new', 'newok'), btn('✖ Cancel', 'wal')]));
  if (data === 'newok') { try { const addr = await core.replaceWallet(chatId); await send(chatId, `✅ New wallet created:\n<code>${addr}</code>\n\nDeposit ETH to start trading.`, rows([btn('💼 Wallet', 'wal')])); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (data === 'expy') { try { const pk = core.exportKey(chatId); await send(chatId, `🔑 <b>Private key</b> (keep it secret — delete this message after saving):\n\n<code>${pk}</code>`); } catch (e) { await send(chatId, '❌ ' + esc(e.message)); } return; }
  if (data === 'snon') { const u = core.ensureUser(chatId); u.snipe.on = true; core.saveStore(); const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snoff') { const u = core.ensureUser(chatId); u.snipe.on = false; core.saveStore(); const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snamt') { pending.set(chatId, { action: 'snipe_amt' }); return send(chatId, 'Send the ETH amount to buy per snipe (e.g. <code>0.01</code>):'); }

  if (k === 'tok') { const c = await tokenCard(chatId, ca); return edit(chatId, mid, c.text, c.kb); }
  if (k === 'b') return doBuy(chatId, ca, arg);
  if (k === 's') return doSell(chatId, ca, Number(arg));
  if (k === 'bx') { pending.set(chatId, { action: 'buy_amt', ca }); return send(chatId, `Send the ETH amount to buy of <code>${short(ca)}</code>:`); }
  if (k === 'tp') { pending.set(chatId, { action: 'tp_price', ca }); return send(chatId, `Take-profit: send the target <b>price in USD</b> to sell 100% at (current shown on the card):`); }
  if (k === 'sl') { pending.set(chatId, { action: 'sl_price', ca }); return send(chatId, `Stop-loss: send the target <b>price in USD</b> to sell 100% at:`); }
  if (k === 'lb') { pending.set(chatId, { action: 'lb_price', ca }); return send(chatId, `Limit buy: send <b>&lt;usd_price&gt; &lt;eth_amount&gt;</b> (e.g. <code>0.002 0.05</code>) — buy when price drops to that:`); }
  if (k === 'oc') { const ok = watchers.cancelOrder(chatId, ca); await answer(q.id, ok ? 'Cancelled' : 'Not found'); const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
}

async function resolvePending(chatId, p, text, m) {
  const t = text.trim();
  try {
    if (p.action === 'import_key') {
      // Delete the message holding the secret FIRST — before importing or erroring —
      // so the key never lingers in the chat regardless of outcome.
      if (m && m.message_id) await del(chatId, m.message_id);
      try { const addr = await core.replaceWallet(chatId, t); return send(chatId, `✅ <b>Wallet imported</b>\n<code>${addr}</code>\n\nYour secret message was deleted. Deposit/trade as normal.`, rows([btn('💼 Wallet', 'wal')])); }
      catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e)) + '\n\n(Your message was deleted for safety — try Import again.)'); }
    }
    if (p.action === 'buy_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); return doBuy(chatId, p.ca, t); }
    if (p.action === 'snipe_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); const u = core.ensureUser(chatId); u.snipe.ethAmount = String(Number(t)); core.saveStore(); const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
    if (p.action === 'wd_addr') { if (!isCa(t)) return send(chatId, '❌ That is not a valid address. Try /withdraw again.'); pending.set(chatId, { action: 'wd_amt', to: t }); return send(chatId, `Amount of ETH to send to <code>${short(t)}</code> — a number, or <code>max</code>:`); }
    if (p.action === 'wd_amt') {
      if (!(String(t).toLowerCase() === 'max' || Number(t) > 0)) return send(chatId, 'Send a positive amount, or <code>max</code>.');
      pending.set(chatId, { action: 'wd_confirm', to: p.to, amt: t });
      return send(chatId, `⚠️ <b>Confirm withdrawal</b>\n\nSend <b>${esc(t)} ETH</b> to:\n<code>${esc(p.to)}</code>\n\nThis is <b>irreversible</b>. Double-check the address.`, rows([btn('✅ Yes, send', 'wdok'), btn('✖ Cancel', 'wdcancel')]));
    }
    if (p.action === 'tp_price' || p.action === 'sl_price') {
      const usdPrice = Number(t);
      if (!(usdPrice > 0)) return send(chatId, 'Send a positive USD price.');
      if (!(ETHUSD > 0)) return send(chatId, 'Price feed unavailable right now — try again shortly.');
      const meta = await core.tokenMeta(p.ca);
      const targetPriceEth = usdPrice / ETHUSD;
      const type = p.action === 'tp_price' ? 'tp' : 'sl';
      watchers.addOrder(chatId, { type, ca: p.ca, sym: meta.sym, targetPriceEth, sellPct: 100 });
      return send(chatId, `✅ ${type === 'tp' ? 'Take-profit' : 'Stop-loss'} set for $${esc(meta.sym)} at $${usdPrice}. I'll sell 100% when hit.`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'lb_price') {
      const [pxStr, ethStr] = t.split(/\s+/);
      const usdPrice = Number(pxStr), ethAmount = Number(ethStr);
      if (!(usdPrice > 0) || !(ethAmount > 0)) return send(chatId, 'Format: <code>&lt;usd_price&gt; &lt;eth_amount&gt;</code>');
      if (!(ETHUSD > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca);
      watchers.addOrder(chatId, { type: 'limitbuy', ca: p.ca, sym: meta.sym, targetPriceEth: usdPrice / ETHUSD, ethAmount: String(ethAmount) });
      return send(chatId, `✅ Limit buy set: ${ethAmount} ETH of $${esc(meta.sym)} when price ≤ $${usdPrice}.`, rows([btn('📋 Orders', 'orders')]));
    }
  } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
}

function askExport(chatId) {
  return send(chatId,
    `🔑 <b>Export private key</b>\n\nThis reveals full control of your bot wallet. Never share it. Anyone with this key can drain the wallet.\n\nAre you sure?`,
    rows([btn('Yes, show my key', 'expy'), btn('Cancel', 'menu')]));
}
function helpText() {
  return (
    `🤖 <b>Robinfun Trade Bot — help</b>\n\n` +
    `• Paste a <b>contract address</b> → live card with one-tap buy/sell\n` +
    `• <b>/wallet</b> — your address, balance, deposit/withdraw, export key\n` +
    `• <b>/portfolio</b> — positions & PnL\n` +
    `• <b>/snipe</b> — auto-buy every new launch\n` +
    `• <b>/orders</b> — take-profit / stop-loss / limit buys\n` +
    `• <b>/referral</b> — earn ${(core.CFG.refShareBps / 100).toFixed(0)}% of the bot fee from people you invite\n` +
    `• <b>/buy &lt;ca&gt; &lt;eth&gt;</b>, <b>/sell &lt;ca&gt; &lt;pct&gt;</b> — quick trade\n\n` +
    `Bot fee: <b>${(core.CFG.feeBps / 100).toFixed(2)}%</b> per trade. Non-negotiable rule of crypto: only deposit what you can afford to lose.`
  );
}

// ------------------------------------------------------------ startup + poll loop
async function refreshEthUsd() { const p = await core.ethUsd(); if (p > 0) ETHUSD = p; }
async function getMe() { try { const r = await tg('getMe', {}); if (r && r.ok) BOT_USERNAME = r.result.username; } catch (_) {} }

async function start() {
  if (!core.CFG.tgToken) { console.error('TRADEBOT_TOKEN missing — set it in the environment.'); process.exit(1); }
  if (!core.CFG.walletSecret) { console.error('WALLET_SECRET missing — refusing to run a custodial bot without key encryption.'); process.exit(1); }
  core.loadStore();
  await getMe();
  await refreshEthUsd();
  setInterval(refreshEthUsd, 120000);
  // Wire watcher fills → user DMs, then start the background loops.
  watchers.setNotifier((chatId, text) => send(chatId, text).catch(() => {}));
  watchers.start();
  console.log(`Robinfun Trade Bot up as @${BOT_USERNAME || '?'} — custodial, chain ${core.CFG.chainId}`);

  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (r && r.ok && r.result.length) {
        for (const up of r.result) { offset = up.update_id + 1; handleUpdate(up); }
      }
    } catch (e) { await new Promise((s) => setTimeout(s, 2000)); }
  }
}

module.exports = { start };
if (require.main === module) start();
