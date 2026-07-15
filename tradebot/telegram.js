'use strict';
/*
 * Robinfun Trade Bot — Telegram UI (long-polling, HTML, inline keyboards).
 * Multi-chain: pick a chain, paste a token contract, one-tap buy/sell. Manage a
 * custodial wallet (generate/import/export/withdraw), portfolio, snipes,
 * limit/TP-SL orders and referrals. Trading logic is in core.js; watchers.js runs
 * snipe + order fills. DMs only (custodial wallet must not be shared in a group).
 */
const { ethers } = require('ethers');
const core = require('./core');
const watchers = require('./watchers');

const API = `https://api.telegram.org/bot${core.CFG.tgToken}`;
const pending = new Map();      // chatId -> { action, ..., ts }
const PENDING_TTL = 5 * 60 * 1000;
const PRICES = { ETH: 0, BNB: 0 };
let BOT_USERNAME = '';

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

// ------------------------------------------------------------ helpers
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const short = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
const fmt = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(2) + 'K'; return n.toFixed(n < 1 ? 4 : 2); };
const isCa = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());
const nativeUsd = (native) => PRICES[native] || 0;
const usd = (amount, native) => nativeUsd(native) > 0 ? '$' + fmt(Number(amount) * nativeUsd(native)) : '—';
const txLink = (chainKey, h) => { const c = core.chainOf(chainKey); return (h && c) ? `<a href="${c.explorer}/tx/${h}">tx ↗</a>` : ''; };
const fmtEth = (wei) => { try { return Number(ethers.formatEther(wei)).toFixed(5); } catch (_) { return '0'; } };
function setPending(chatId, obj) { obj.ts = Date.now(); pending.set(chatId, obj); }
function activeChain(chatId) { return core.chainOf(core.userChain(core.ensureUser(chatId))); }

// ------------------------------------------------------------ screens
function mainMenu() {
  return rows(
    [btn('💼 Wallet', 'wal'), btn('📊 Portfolio', 'pos')],
    [btn('🌐 Chain', 'chain'), btn('🎯 Snipe', 'snipe'), btn('📋 Orders', 'orders')],
    [btn('🎁 Referrals', 'ref'), btn('❔ Help', 'help')],
  );
}
async function walletScreen(chatId) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const bal = await core.ethBalance(u.address, ch.key);
  const ethStr = fmtEth(bal);
  return {
    text:
      `💼 <b>Your Wallet</b>  ·  ${ch.emoji} ${esc(ch.name)}\n\n` +
      `<code>${u.address}</code>\n\n` +
      `Balance: <b>${ethStr} ${ch.native}</b> (${usd(ethStr, ch.native)})\n\n` +
      `Same address works on every chain. Deposit ${ch.native} here on <b>${esc(ch.name)}</b>, then paste a token contract to trade.`,
    kb: rows(
      [btn('🔄 Refresh', 'wal'), btn('🌐 Switch chain', 'chain')],
      [btn('📥 Deposit', 'dep'), btn('📤 Withdraw', 'wd')],
      [btn('🔑 Export key', 'exp'), btn('📩 Import', 'imp'), btn('♻️ New', 'neww')],
      [btn('« Menu', 'menu')],
    ),
  };
}
function chainScreen(chatId) {
  const cur = core.userChain(core.ensureUser(chatId));
  const list = core.chains.enabledChains();
  const kb = list.map((c) => [btn(`${c.emoji} ${c.name}${c.key === cur ? '  ✓' : ''}`, 'setch:' + c.key)]);
  kb.push([btn('« Menu', 'menu')]);
  return { text: `🌐 <b>Select chain</b>\n\nYour wallet is the same address on all of them. Pick where to trade:`, kb: { inline_keyboard: kb } };
}
async function tokenCard(chatId, ca, chainKey) {
  const u = core.ensureUser(chatId);
  chainKey = (chainKey && core.chainOf(chainKey)) ? chainKey : core.userChain(u);
  const ch = core.chainOf(chainKey);
  const snap = await core.tokenSnapshot(ca, chainKey).catch(() => null);
  if (!snap) return { text: `❌ Couldn't price <code>${short(ca)}</code> on ${ch.emoji} ${esc(ch.name)} — no pool/curve found here. Switch chain if it trades elsewhere.`, kb: rows([btn('🌐 Switch chain', 'chain'), btn('« Menu', 'menu')]) };
  const meta = await core.tokenMeta(ca, chainKey);
  const balRaw = await core.tokenBalance(ca, u.address, chainKey);
  const bal = Number(ethers.formatUnits(balRaw, meta.decimals));
  const pos = u.positions[chainKey + ':' + ca.toLowerCase()];
  const valueEth = bal * snap.priceEth;
  let bagLine = '';
  if (pos && pos.ethIn > 0) {
    const unreal = valueEth - (pos.ethIn - pos.ethOut);
    bagLine = `\nYour bag: ${fmt(bal)} $${esc(meta.sym)} · ${usd(valueEth, ch.native)} · PnL <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${ch.native}</b>`;
  } else if (bal > 0) bagLine = `\nYour bag: ${fmt(bal)} $${esc(meta.sym)} · ${usd(valueEth, ch.native)}`;
  const phase = snap.dex ? '◆ DEX' : (snap.graduated ? '◆ GRADUATED' : `◈ LISTED · ${snap.progressPct.toFixed(0)}%`);
  const priceUsd = snap.priceEth * nativeUsd(ch.native);
  const text =
    `<b>${esc(meta.name)}</b>  $${esc(meta.sym)}  ·  ${ch.emoji} ${esc(ch.name)}\n` +
    `<code>${ca}</code>\n${phase}\n\n` +
    `Price: <b>${priceUsd > 0 ? '$' + priceUsd.toPrecision(3) : snap.priceEth.toExponential(2) + ' ' + ch.native}</b>\n` +
    `Market cap: <b>${usd(snap.mcapEth, ch.native)}</b>${bagLine}`;
  // Encode the CARD's chain in every action so a tap on a stale card trades on the
  // chain it was rendered for, not whatever chain is active now.
  const kb = rows(
    [btn(`Buy 0.01`, `b:${chainKey}:${ca}:0.01`), btn('Buy 0.05', `b:${chainKey}:${ca}:0.05`), btn('Buy 0.1', `b:${chainKey}:${ca}:0.1`)],
    [btn('Buy X', `bx:${chainKey}:${ca}`), btn('Sell 50%', `s:${chainKey}:${ca}:50`), btn('Sell 100%', `s:${chainKey}:${ca}:100`)],
    [btn('🎯 TP', `tp:${chainKey}:${ca}`), btn('🛑 SL', `sl:${chainKey}:${ca}`), btn('⏳ Limit buy', `lb:${chainKey}:${ca}`)],
    [btn('🔄 Refresh', `tok:${chainKey}:${ca}`), btn('« Menu', 'menu')],
  );
  return { text, kb };
}
async function portfolioScreen(chatId) {
  const pf = await core.portfolio(chatId);
  const nat = pf.native || 'ETH';
  if (!pf.rows.length) return { text: `📊 <b>Portfolio</b> · ${pf.chain ? pf.chain.emoji + ' ' + esc(pf.chain.name) : ''}\n\nNo open positions on this chain. Paste a token contract to buy, or switch chain.`, kb: rows([btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
  let body = '', totalUnreal = 0;
  for (const r of pf.rows) {
    totalUnreal += r.unrealizedEth;
    body += `<b>$${esc(r.sym)}</b> ${fmt(r.tokens)} · ${usd(r.valueEth, nat)}\n   in ${r.ethIn.toFixed(4)} / out ${r.ethOut.toFixed(4)} ${nat} · PnL ${r.unrealizedEth >= 0 ? '+' : ''}${r.unrealizedEth.toFixed(4)}\n   <code>${r.ca}</code>\n`;
  }
  const text = `📊 <b>Portfolio</b> · ${pf.chain.emoji} ${esc(pf.chain.name)} · value ${usd(pf.totalValueEth, nat)}\n\n${body}\nUnrealized PnL: <b>${totalUnreal >= 0 ? '+' : ''}${totalUnreal.toFixed(4)} ${nat}</b>`;
  return { text, kb: rows([btn('🔄 Refresh', 'pos'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
}
function snipeScreen(chatId) {
  const u = core.ensureUser(chatId);
  const on = u.snipe.on;
  return {
    text: `🎯 <b>Snipe new launches</b> (Robinhood Chain)\n\nAuto-buys <b>every new Robinfun token</b> the moment it launches.\n\nStatus: <b>${on ? '🟢 ON' : '⚪ OFF'}</b>\nAmount per snipe: <b>${esc(u.snipe.ethAmount)} ETH</b>\n\n⚠️ Buys indiscriminately — keep the amount small.`,
    kb: rows([btn(on ? '🔴 Turn OFF' : '🟢 Turn ON', on ? 'snoff' : 'snon')], [btn('✏️ Set amount', 'snamt')], [btn('« Menu', 'menu')]),
  };
}
function ordersScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = u.orders || [];
  if (!list.length) return { text: '📋 <b>Orders</b>\n\nNo active orders. Open a token card and set a TP / SL / Limit buy.', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  for (const o of list) {
    const c = core.chainOf(o.chain || 'robinhood');
    const label = o.type === 'tp' ? 'TP' : o.type === 'sl' ? 'SL' : 'Limit buy';
    const tgtUsd = nativeUsd(c.native) > 0 ? ('$' + (o.targetPriceEth * nativeUsd(c.native)).toPrecision(3)) : (o.targetPriceEth.toExponential(2) + ' ' + c.native);
    body += `${c.emoji} <b>${label}</b> $${esc(o.sym || '')} @ ${tgtUsd}${o.type === 'limitbuy' ? ' · ' + o.ethAmount + ' ' + c.native : ' · sell ' + (o.sellPct || 100) + '%'}\n`;
    kbRows.push([btn(`✖ Cancel ${label} $${o.sym || ''}`, `oc:${o.id}`)]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `📋 <b>Active orders</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function referralScreen(chatId) {
  const u = core.ensureUser(chatId);
  const link = `https://t.me/${BOT_USERNAME}?start=${u.refCode}`;
  const owed = u.refOwed || {};
  const earned = Object.keys(owed).length
    ? Object.entries(owed).map(([ck, wei]) => { const c = core.chainOf(ck) || { native: 'ETH' }; return `${Number(ethers.formatEther(BigInt(wei || '0'))).toFixed(5)} ${c.native}`; }).join(' · ')
    : '0';
  return {
    text: `🎁 <b>Referrals</b>\n\nShare your link — you earn <b>${(core.CFG.refShareBps / 100).toFixed(0)}%</b> of the bot fee on every trade your referrals make.\n\n<code>${link}</code>\n\nEarned so far: <b>${earned}</b>`,
    kb: rows([btn('« Menu', 'menu')]),
  };
}

// ------------------------------------------------------------ actions
async function doBuy(chatId, ca, amt, chain) {
  try {
    await send(chatId, `⏳ Buying ${esc(amt)} of <code>${short(ca)}</code>…`);
    const r = await core.buy(chatId, ca, amt, chain);
    await send(chatId, `✅ <b>Bought</b> ${fmt(r.gotTokens)} $${esc(r.sym)}\nSpent ${r.spentEth} ${r.native} · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.chain, r.hash)}`, rows([btn('🔄 Card', `tok:${r.chain}:${ca}`), btn('📊 Portfolio', 'pos')]));
  } catch (e) { await send(chatId, `❌ Buy failed: ${esc(e.message || String(e))}`); }
}
async function doSell(chatId, ca, pct, chain) {
  try {
    await send(chatId, `⏳ Selling ${pct}% of <code>${short(ca)}</code>…`);
    const r = await core.sell(chatId, ca, pct, chain);
    await send(chatId, `✅ <b>Sold</b> ${r.soldPct}%\nGot ${r.proceedsEth} ${r.native} · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.chain, r.hash)}`, rows([btn('🔄 Card', `tok:${r.chain}:${ca}`), btn('📊 Portfolio', 'pos')]));
  } catch (e) { await send(chatId, `❌ Sell failed: ${esc(e.message || String(e))}`); }
}

// ------------------------------------------------------------ router
async function handleUpdate(up) {
  try {
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

  let p = pending.get(chatId);
  if (p && Date.now() - (p.ts || 0) > PENDING_TTL) { pending.delete(chatId); p = null; }   // expire stale prompts
  if (p && !text.startsWith('/')) { pending.delete(chatId); return await resolvePending(chatId, p, text, m); }
  if (text.startsWith('/')) pending.delete(chatId);   // a command aborts any pending flow
  if (text === '/cancel') return send(chatId, 'Cancelled.', mainMenu());

  if (text.startsWith('/start')) {
    const ref = text.split(/\s+/)[1] || null;
    const isNew = !core.getUser(chatId);
    core.ensureUser(chatId, ref);
    await send(chatId, `👋 <b>Welcome to the Robinfun Trade Bot</b>\n\nTrade tokens across chains from Telegram — paste a contract address to start.` + (isNew ? `\n\nA fresh wallet was created for you 👇` : ''), mainMenu());
    const w = await walletScreen(chatId); return send(chatId, w.text, w.kb);
  }
  if (text === '/wallet') { const w = await walletScreen(chatId); return send(chatId, w.text, w.kb); }
  if (text === '/chain') { const s = chainScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/portfolio' || text === '/positions') { const s = await portfolioScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/snipe') { const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/orders') { const s = ordersScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/referral' || text === '/refer') { const s = referralScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/withdraw') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 Send the <b>destination address</b> to withdraw to:'); }
  if (text === '/export') return askExport(chatId);
  if (text === '/admin') return adminScreen(chatId);
  if (text === '/menu' || text === '/help') return send(chatId, helpText(), mainMenu());
  if (text.startsWith('/buy')) { const [, ca, amt] = text.split(/\s+/); if (isCa(ca) && amt) return doBuy(chatId, ca, amt); return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;amount&gt;</code> — or paste a contract address.'); }
  if (text.startsWith('/sell')) { const [, ca, pct] = text.split(/\s+/); if (isCa(ca) && pct) return doSell(chatId, ca, Number(pct)); return send(chatId, 'Usage: <code>/sell &lt;contract&gt; &lt;pct&gt;</code>'); }

  if (isCa(text)) { core.ensureUser(chatId); const c = await tokenCard(chatId, text); return send(chatId, c.text, c.kb); }
  return send(chatId, 'Paste a <b>token contract address</b> to trade, or tap a button.', mainMenu());
}

async function onCallback(q) {
  const chatId = q.message.chat.id;
  const mid = q.message.message_id;
  const data = q.data || '';
  const [k, ca, arg] = data.split(':');
  if (k !== 'oc') await answer(q.id);

  if (data === 'wdcancel') { pending.delete(chatId); return send(chatId, 'Withdrawal cancelled.', mainMenu()); }
  if (data === 'wdok') {
    const pp = pending.get(chatId); pending.delete(chatId);
    if (!pp || pp.action !== 'wd_confirm' || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'Confirmation expired. Start again with /withdraw.');
    try { await send(chatId, '⏳ Sending…'); const r = await core.withdraw(chatId, pp.to, pp.amt, pp.chain); return send(chatId, `✅ Sent <b>${r.sentEth} ${r.native}</b>\n${txLink(pp.chain, r.hash)}`); }
    catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
  }
  if (data === 'menu') return edit(chatId, mid, '🏠 <b>Robinfun Trade Bot</b>\n\nPaste a contract address to trade, or pick:', mainMenu());
  if (data === 'help') return edit(chatId, mid, helpText(), mainMenu());
  if (data === 'wal') { const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'chain') { const s = chainScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'setch') { try { core.setChain(chatId, ca); } catch (_) {} const w = await walletScreen(chatId); return edit(chatId, mid, w.text, w.kb); }
  if (data === 'pos') { const s = await portfolioScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snipe') { const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'orders') { const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ref') { const s = referralScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dep') { const u = core.ensureUser(chatId); const ch = core.chainOf(core.userChain(u)); return edit(chatId, mid, `📥 <b>Deposit ${ch.native}</b> on ${ch.emoji} ${esc(ch.name)}\n\n<code>${u.address}</code>\n\nSame address on every chain — then paste a token contract to buy.`, rows([btn('🔄 Refresh balance', 'wal'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')])); }
  if (data === 'wd') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 Send the <b>destination address</b>:'); }
  if (data === 'exp') return askExport(chatId);
  if (data === 'expy') { try { const pk = core.exportKey(chatId); await send(chatId, `🔑 <b>Private key</b> (delete this message after saving):\n\n<code>${pk}</code>`); } catch (e) { await send(chatId, '❌ ' + esc(e.message)); } return; }
  if (data === 'imp') { setPending(chatId, { action: 'import_key' }); return send(chatId, `📩 <b>Import a wallet</b>\n\nPaste your <b>private key</b> (64 hex) or <b>seed phrase</b> (12–24 words).\n\n⚠️ I'll <b>delete your message immediately</b> after importing. Never share the secret with anyone else.`); }
  if (data === 'neww') return send(chatId, `♻️ <b>Generate a new wallet</b>\n\nReplaces your current bot wallet. It must be <b>empty on every chain</b> first (withdraw/export), or the switch is blocked so nothing is lost.\n\nProceed?`, rows([btn('✅ Generate new', 'newok'), btn('✖ Cancel', 'wal')]));
  if (data === 'newok') { try { const addr = await core.replaceWallet(chatId); await send(chatId, `✅ New wallet:\n<code>${addr}</code>\n\nDeposit to start trading.`, rows([btn('💼 Wallet', 'wal')])); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (data === 'snon') { const u = core.ensureUser(chatId); u.snipe.on = true; core.saveStore(); const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snoff') { const u = core.ensureUser(chatId); u.snipe.on = false; core.saveStore(); const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snamt') { setPending(chatId, { action: 'snipe_amt' }); return send(chatId, 'Send the ETH amount to buy per snipe (e.g. <code>0.01</code>):'); }

  // Trade actions encode the CARD's chain: k:chain:ca[:arg]
  if (k === 'tok' || k === 'b' || k === 's' || k === 'bx' || k === 'tp' || k === 'sl' || k === 'lb') {
    const parts = data.split(':'); const ch = parts[1], tca = parts[2], a = parts[3];
    if (k === 'tok') { const c = await tokenCard(chatId, tca, ch); return edit(chatId, mid, c.text, c.kb); }
    if (k === 'b') return doBuy(chatId, tca, a, ch);
    if (k === 's') return doSell(chatId, tca, Number(a), ch);
    if (k === 'bx') { setPending(chatId, { action: 'buy_amt', ca: tca, chain: ch }); return send(chatId, `Send the amount to buy of <code>${short(tca)}</code>:`); }
    if (k === 'tp') { setPending(chatId, { action: 'tp_price', ca: tca, chain: ch }); return send(chatId, `Take-profit: send the target <b>USD price</b> to sell 100% at:`); }
    if (k === 'sl') { setPending(chatId, { action: 'sl_price', ca: tca, chain: ch }); return send(chatId, `Stop-loss: send the target <b>USD price</b> to sell 100% at:`); }
    if (k === 'lb') { setPending(chatId, { action: 'lb_price', ca: tca, chain: ch }); return send(chatId, `Limit buy: send <b>&lt;usd_price&gt; &lt;amount&gt;</b> (e.g. <code>0.002 0.05</code>) — buy when price drops to that:`); }
  }
  if (k === 'oc') { const ok = watchers.cancelOrder(chatId, ca); await answer(q.id, ok ? 'Cancelled' : 'Not found'); const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
}

async function resolvePending(chatId, p, text, m) {
  const t = text.trim();
  try {
    if (p.action === 'import_key') {
      if (m && m.message_id) await del(chatId, m.message_id);   // delete the secret FIRST
      try { const addr = await core.replaceWallet(chatId, t); return send(chatId, `✅ <b>Wallet imported</b>\n<code>${addr}</code>\n\nYour secret message was deleted. Trade as normal.`, rows([btn('💼 Wallet', 'wal')])); }
      catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e)) + '\n\n(Your message was deleted for safety — try Import again.)'); }
    }
    if (p.action === 'buy_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); return doBuy(chatId, p.ca, t, p.chain); }
    if (p.action === 'snipe_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); const u = core.ensureUser(chatId); u.snipe.ethAmount = String(Number(t)); core.saveStore(); const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
    if (p.action === 'wd_addr') { if (!isCa(t)) return send(chatId, '❌ Not a valid address. Try /withdraw again.'); setPending(chatId, { action: 'wd_amt', to: t }); return send(chatId, `Amount to send to <code>${short(t)}</code> — a number, or <code>max</code>:`); }
    if (p.action === 'wd_amt') {
      if (!(String(t).toLowerCase() === 'max' || Number(t) > 0)) return send(chatId, 'Send a positive amount, or <code>max</code>.');
      const ch = activeChain(chatId);
      setPending(chatId, { action: 'wd_confirm', to: p.to, amt: t, chain: ch.key });
      return send(chatId, `⚠️ <b>Confirm withdrawal</b> · ${ch.emoji} ${esc(ch.name)}\n\nSend <b>${esc(t)} ${ch.native}</b> to:\n<code>${esc(p.to)}</code>\n\nThis is <b>irreversible</b>. Double-check the address.`, rows([btn('✅ Yes, send', 'wdok'), btn('✖ Cancel', 'wdcancel')]));
    }
    if (p.action === 'wd_confirm') { setPending(chatId, p); return send(chatId, 'Please tap ✅ Yes or ✖ Cancel above, or /cancel.'); }
    if (p.action === 'tp_price' || p.action === 'sl_price') {
      const usdPrice = Number(t); if (!(usdPrice > 0)) return send(chatId, 'Send a positive USD price.');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      const type = p.action === 'tp_price' ? 'tp' : 'sl';
      watchers.addOrder(chatId, { type, ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), sellPct: 100 });
      return send(chatId, `✅ ${type === 'tp' ? 'Take-profit' : 'Stop-loss'} set for $${esc(meta.sym)} at $${usdPrice} on ${ch.emoji} ${esc(ch.name)}.`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'lb_price') {
      const [pxStr, amtStr] = t.split(/\s+/); const usdPrice = Number(pxStr), amount = Number(amtStr);
      if (!(usdPrice > 0) || !(amount > 0)) return send(chatId, 'Format: <code>&lt;usd_price&gt; &lt;amount&gt;</code>');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      watchers.addOrder(chatId, { type: 'limitbuy', ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), ethAmount: String(amount) });
      return send(chatId, `✅ Limit buy set: ${amount} ${ch.native} of $${esc(meta.sym)} when price ≤ $${usdPrice}.`, rows([btn('📋 Orders', 'orders')]));
    }
  } catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e))); }
}

function askExport(chatId) {
  return send(chatId, `🔑 <b>Export private key</b>\n\nThis reveals full control of your bot wallet. Anyone with it can drain the wallet. Never share it.\n\nAre you sure?`, rows([btn('Yes, show my key', 'expy'), btn('Cancel', 'menu')]));
}
function adminScreen(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  const users = core.allUsers();
  const byChain = {};
  for (const u of users) { const o = u.refOwed || {}; for (const [ck, wei] of Object.entries(o)) { try { byChain[ck] = (BigInt(byChain[ck] || '0') + BigInt(wei || '0')).toString(); } catch (_) {} } }
  const owedLines = Object.entries(byChain).map(([ck, wei]) => { const c = core.chainOf(ck) || { native: 'ETH', name: ck }; return `  ${c.name}: <b>${Number(ethers.formatEther(BigInt(wei))).toFixed(5)} ${c.native}</b>`; }).join('\n') || '  none';
  return send(chatId, `🛠 <b>Admin</b>\n\nUsers: <b>${users.length}</b>\nReferral owed (unsettled), per chain:\n${owedLines}\n\nSettle manually from FEE_WALLET on each chain (refOwed[chain] in the store).`);
}
function helpText() {
  return (
    `🤖 <b>Robinfun Trade Bot — help</b>\n\n` +
    `• Paste a <b>contract address</b> → live card with one-tap buy/sell\n` +
    `• <b>/chain</b> — switch chain (Robinhood, Ethereum, Base, BNB, Arbitrum)\n` +
    `• <b>/wallet</b> — address, balance, deposit/withdraw, import/export, new\n` +
    `• <b>/portfolio</b> — positions & PnL (active chain)\n` +
    `• <b>/snipe</b> — auto-buy every new Robinfun launch\n` +
    `• <b>/orders</b> — take-profit / stop-loss / limit buys\n` +
    `• <b>/referral</b> — earn ${(core.CFG.refShareBps / 100).toFixed(0)}% of the bot fee from invites\n` +
    `• <b>/buy &lt;ca&gt; &lt;amt&gt;</b>, <b>/sell &lt;ca&gt; &lt;pct&gt;</b>, <b>/cancel</b>\n\n` +
    `Bot fee: <b>${(core.CFG.feeBps / 100).toFixed(2)}%</b> per trade. Only deposit what you can afford to lose.`
  );
}

// ------------------------------------------------------------ startup + poll
async function refreshPrices() {
  for (const sym of ['ETH', 'BNB']) {
    try { const r = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { signal: AbortSignal.timeout(6000) }); const j = await r.json(); const p = Number(j?.data?.amount); if (p > 0) PRICES[sym] = p; } catch (_) {}
  }
}
async function getMe() { try { const r = await tg('getMe', {}); if (r && r.ok) BOT_USERNAME = r.result.username; } catch (_) {} }

async function start() {
  if (!core.CFG.tgToken) { console.error('TRADEBOT_TOKEN missing.'); process.exit(1); }
  if (!core.CFG.walletSecret) { console.error('WALLET_SECRET missing — refusing to run custodial without key encryption.'); process.exit(1); }
  core.loadStore();
  await getMe();
  await refreshPrices();
  setInterval(refreshPrices, 120000);
  watchers.setNotifier((chatId, text) => send(chatId, text).catch(() => {}));
  watchers.start();
  console.log(`Robinfun Trade Bot up as @${BOT_USERNAME || '?'} — chains: ${core.chains.ENABLED.join(', ')}`);

  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (r && r.ok && r.result.length) for (const up of r.result) { offset = up.update_id + 1; handleUpdate(up); }
    } catch (e) { await new Promise((s) => setTimeout(s, 2000)); }
  }
}

module.exports = { start };
if (require.main === module) start();
