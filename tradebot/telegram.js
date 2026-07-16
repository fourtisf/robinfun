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
const goplus = require('./goplus');
const tokeninfo = require('./tokeninfo');

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
const taxStr = (t) => (t == null ? '?' : (Math.round(t * 10) / 10) + '%');
function fmtAge(ms) { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd'; }
function setPending(chatId, obj) { obj.ts = Date.now(); pending.set(chatId, obj); }
function activeChain(chatId) { return core.chainOf(core.userChain(core.ensureUser(chatId))); }

// ------------------------------------------------------------ screens
function mainMenu() {
  return rows(
    [btn('💼 Wallet', 'wal'), btn('📊 Portfolio', 'pos')],
    [btn('🌐 Chain', 'chain'), btn('🎯 Snipe', 'snipe'), btn('📋 Orders', 'orders')],
    [btn('🎁 Referrals', 'ref'), btn('⚙️ Settings', 'set'), btn('❔ Help', 'help')],
  );
}
async function walletScreen(chatId) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const list = core.walletList(u);
  const w = core.activeWallet(u);
  const idx = list.findIndex((x) => x.id === w.id) + 1;
  const bal = await core.ethBalance(w.address, ch.key);
  const ethStr = fmtEth(bal);
  return {
    text:
      `💼 <b>Your Wallet</b>  ·  ${ch.emoji} ${esc(ch.name)}\n\n` +
      `Active: <b>Wallet ${idx}</b> of ${list.length}\n` +
      `<code>${w.address}</code>\n\n` +
      `Balance: <b>${ethStr} ${ch.native}</b> (${usd(ethStr, ch.native)})\n\n` +
      `Same address works on every chain. Deposit ${ch.native} here on <b>${esc(ch.name)}</b>, then paste a token contract to trade.`,
    kb: rows(
      [btn('🔄 Refresh', 'wal'), btn('🌐 Switch chain', 'chain')],
      [btn('📥 Deposit', 'dep'), btn('📤 Withdraw', 'wd')],
      [btn('🔑 Export key', 'exp'), btn(`👛 Wallets (${list.length}/${core.WALLET_CAP})`, 'wallets')],
      [btn('« Menu', 'menu')],
    ),
  };
}
async function walletsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const list = core.walletList(u);
  const bals = await Promise.all(list.map((w) => core.ethBalance(w.address, ch.key).catch(() => 0n)));
  let body = '';
  const kbRows = [];
  list.forEach((w, i) => {
    const active = w.id === u.activeWalletId;
    const nOrders = (w.orders && w.orders.length) || 0;
    body += `${active ? '✅' : '▫️'} <b>Wallet ${i + 1}</b> · <code>${short(w.address)}</code> · ${fmtEth(bals[i])} ${ch.native}${nOrders ? ' · ' + nOrders + ' order' + (nOrders > 1 ? 's' : '') : ''}\n`;
    const row = [btn(`${active ? '✓ ' : ''}Wallet ${i + 1} · ${short(w.address)}`, active ? 'wal' : 'sw:' + w.id)];
    row.push(btn('🔑', 'expw:' + w.id));
    if (list.length > 1) row.push(btn('🗑', 'rmw:' + w.id));
    kbRows.push(row);
  });
  if (list.length < core.WALLET_CAP) kbRows.push([btn('➕ Generate', 'neww'), btn('📩 Import', 'imp')]);
  kbRows.push([btn('« Wallet', 'wal'), btn('« Menu', 'menu')]);
  return {
    text: `👛 <b>Your wallets</b> (${list.length}/${core.WALLET_CAP}) · ${ch.emoji} ${esc(ch.name)}\n\n${body}\nTap a wallet to make it active. Balances, positions &amp; orders are per-wallet.`,
    kb: { inline_keyboard: kbRows },
  };
}
function chainScreen(chatId) {
  const cur = core.userChain(core.ensureUser(chatId));
  const list = core.chains.enabledChains();
  const kb = list.map((c) => [btn(`${c.emoji} ${c.name}${c.key === cur ? '  ✓' : ''}`, 'setch:' + c.key)]);
  kb.push([btn('« Menu', 'menu')]);
  return { text: `🌐 <b>Select chain</b>\n\nYour wallet is the same address on all of them. Pick where to trade:`, kb: { inline_keyboard: kb } };
}
async function tokenCard(chatId, ca, chainKey, walletId) {
  const u = core.ensureUser(chatId);
  chainKey = (chainKey && core.chainOf(chainKey)) ? chainKey : core.userChain(u);
  const ch = core.chainOf(chainKey);
  const list = core.walletList(u);
  const w = (walletId && core.walletById(u, walletId)) || core.activeWallet(u);
  const wi = list.findIndex((x) => x.id === w.id) + 1;   // 1-based wallet index, encoded in every action
  // Rich scan: on-chain price/mcap + liquidity + Robinfun API (vol/socials) + GoPlus
  // (tax/honeypot/holders/LP) — all best-effort, never throws (tokeninfo swallows).
  const info = await tokeninfo.enrich(ca, chainKey).catch(() => null);
  if (!info) return { text: `❌ Couldn't price <code>${short(ca)}</code> on ${ch.emoji} ${esc(ch.name)} — no pool/curve found here. Switch chain if it trades elsewhere.`, kb: rows([btn('🌐 Switch chain', 'chain'), btn('« Menu', 'menu')]) };
  const meta = await core.tokenMeta(ca, chainKey);
  const balRaw = await core.tokenBalance(ca, w.address, chainKey);
  const bal = Number(ethers.formatUnits(balRaw, meta.decimals));
  const pos = (w.positions || {})[chainKey + ':' + ca.toLowerCase()];
  const nat = ch.native;
  const api = info.api, sec = info.security;
  const px = info.priceEth || 0;
  const priceUsd = px * nativeUsd(nat);
  const name = (api && api.name) || meta.name;
  const sym = (api && api.symbol) || meta.sym;

  const L = [];
  L.push(`<b>${esc(name)}</b>  $${esc(sym)}  ·  ${ch.emoji} ${esc(ch.name)}`);
  L.push(`<code>${ca}</code>`);
  L.push(info.dex ? '◆ DEX' : (info.graduated ? '◆ GRADUATED' : `◈ LISTED · ${(info.progressPct || 0).toFixed(0)}%`));
  if (sec) { const v = goplus.verdict(sec); if (v.level === 'danger') L.push(`🚨 <b>HIGH RISK</b>: ${esc(v.red.join(', '))}`); else if (v.level === 'warn') L.push(`⚠️ ${esc(v.warn.join(', '))}`); }
  L.push('');
  L.push(`💵 Price: <b>${priceUsd > 0 ? '$' + priceUsd.toPrecision(3) : px.toExponential(2) + ' ' + nat}</b>`);
  const mcapUsd = (api && api.marketCapUsd) || (info.mcapEth * nativeUsd(nat));
  L.push(`📊 Market cap: <b>${mcapUsd > 0 ? '$' + fmt(mcapUsd) : usd(info.mcapEth, nat)}</b>`);
  if (info.liquidityNative != null) L.push(`💧 Liquidity: <b>${info.liquidityNative.toFixed(3)} ${nat}</b> (${usd(info.liquidityNative, nat)})`);
  else if (info.raised != null) L.push(`💧 Raised: <b>${info.raised.toFixed(3)} / ${(info.target || 0).toFixed(2)} ${nat}</b> (bonding curve)`);
  if (api && api.volume) L.push(`📈 Vol 24h: <b>${api.volume.h24Usd != null ? '$' + fmt(api.volume.h24Usd) : '—'}</b>${api.volume.totalUsd != null ? ' · total $' + fmt(api.volume.totalUsd) : ''}`);
  const hLp = [];
  if (sec && sec.holders != null) hLp.push(`👥 ${sec.holders} holders`);
  if (sec && sec.lpLockedPct != null) hLp.push(`🔒 LP ${Math.round(sec.lpLockedPct)}% locked`);
  else if (ch.curve && info.graduated) hLp.push('🔒 LP burned');
  if (hLp.length) L.push(hLp.join('  ·  '));
  if (sec) L.push(`🛡 Tax B/S: <b>${taxStr(sec.buyTaxPct)}/${taxStr(sec.sellTaxPct)}</b> · Honeypot: <b>${sec.honeypot ? '🔴 YES' : 'no'}</b>${sec.openSource === false ? ' · ⚠️ closed-source' : ''}`);
  else if (ch.curve) L.push(`🛡 <b>Fair-launch</b> · 0% tax · fixed 1B supply · LP burned on graduation`);
  const created = api && api.createdAt;
  if (created) L.push(`⏱ Age: <b>${fmtAge(created)}</b>`);
  if (api && api.links) { const lk = []; if (api.links.website) lk.push(`<a href="${esc(api.links.website)}">Web</a>`); if (api.links.twitter) lk.push(`<a href="${esc(api.links.twitter)}">X</a>`); if (api.links.telegram) lk.push(`<a href="${esc(api.links.telegram)}">TG</a>`); if (lk.length) L.push('🔗 ' + lk.join(' · ')); }
  const valueEth = bal * px;
  if (pos && pos.ethIn > 0) { const unreal = valueEth - (pos.ethIn - pos.ethOut); L.push(''); L.push(`💼 Your bag: ${fmt(bal)} $${esc(sym)} · ${usd(valueEth, nat)} · PnL <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${nat}</b>`); }
  else if (bal > 0) { L.push(''); L.push(`💼 Your bag: ${fmt(bal)} $${esc(sym)} · ${usd(valueEth, nat)}`); }
  if (list.length > 1) L.push(`<i>Trading with Wallet ${wi}</i>`);
  const text = L.join('\n');
  // Encode the card's chain AND wallet index in every action, so a tap on a stale
  // card trades on the chain+wallet it was rendered for — never on whatever chain
  // or wallet merely happens to be active now.
  const bp = core.buyPresets(u);   // user's quick-buy amounts (Settings)
  const lastRow = [btn('🔄 Refresh', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')];
  if (goplus.supported(chainKey)) lastRow.unshift(btn('🛡 Safety', `sec:${chainKey}:${ca}`));   // GoPlus only on supported chains
  const kb = rows(
    [btn(`Buy ${bp[0]}`, `b:${chainKey}:${wi}:${ca}:${bp[0]}`), btn(`Buy ${bp[1]}`, `b:${chainKey}:${wi}:${ca}:${bp[1]}`), btn(`Buy ${bp[2]}`, `b:${chainKey}:${wi}:${ca}:${bp[2]}`), btn('Buy X', `bx:${chainKey}:${wi}:${ca}`)],
    [btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)],
    [btn('Sell X%', `sx:${chainKey}:${wi}:${ca}`), btn('🎯 TP', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 SL', `sl:${chainKey}:${wi}:${ca}`), btn('⏳ Limit', `lb:${chainKey}:${wi}:${ca}`)],
    lastRow,
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
    text: `🎯 <b>Snipe new launches</b> (Robinhood Chain)\n\nAuto-buys <b>every new Robinfun token</b> the moment it launches, using your <b>active wallet</b>.\n\nStatus: <b>${on ? '🟢 ON' : '⚪ OFF'}</b>\nAmount per snipe: <b>${esc(u.snipe.ethAmount)} ETH</b>\n\n⚠️ Buys indiscriminately — keep the amount small.`,
    kb: rows([btn(on ? '🔴 Turn OFF' : '🟢 Turn ON', on ? 'snoff' : 'snon')], [btn('✏️ Set amount', 'snamt')], [btn('« Menu', 'menu')]),
  };
}
function ordersScreen(chatId) {
  const u = core.ensureUser(chatId);
  const wl = core.walletList(u);
  const multi = wl.length > 1;
  const list = [];
  wl.forEach((w, i) => { for (const o of (w.orders || [])) list.push({ o, wi: i + 1 }); });
  if (!list.length) return { text: '📋 <b>Orders</b>\n\nNo active orders. Open a token card and set a TP / SL / Limit buy.', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  for (const { o, wi } of list) {
    const c = core.chainOf(o.chain || 'robinhood');
    const label = o.type === 'tp' ? 'TP' : o.type === 'sl' ? 'SL' : 'Limit buy';
    const tgtUsd = nativeUsd(c.native) > 0 ? ('$' + (o.targetPriceEth * nativeUsd(c.native)).toPrecision(3)) : (o.targetPriceEth.toExponential(2) + ' ' + c.native);
    const wtag = multi ? ` · <i>W${wi}</i>` : '';
    body += `${c.emoji} <b>${label}</b> $${esc(o.sym || '')} @ ${tgtUsd}${o.type === 'limitbuy' ? ' · ' + o.ethAmount + ' ' + c.native : ' · sell ' + (o.sellPct || 100) + '%'}${wtag}\n`;
    kbRows.push([btn(`✖ Cancel ${label} $${o.sym || ''}${multi ? ' (W' + wi + ')' : ''}`, `oc:${o.id}`)]);
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

function settingsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const s = u.settings;
  const slip = s.slippage > 0 ? s.slippage + '%' : 'default (5%)';
  const bp = core.buyPresets(u).join(' · ');
  return {
    text: `⚙️ <b>Settings</b>\n\n` +
      `Slippage: <b>${esc(String(slip))}</b>\n` +
      `Quick-buy buttons: <b>${esc(bp)}</b>\n` +
      `Auto-buy on paste: <b>${s.autoBuy ? '🟢 ON · ' + esc(s.autoBuyAmount) : '⚪ OFF'}</b>\n\n` +
      `<i>Auto-buy: paste a contract address and it buys instantly with your active wallet on the active chain — no card, no extra tap.</i>`,
    kb: rows(
      [btn('📉 Slippage', 'setslip'), btn('⚡ Buy presets', 'setbp')],
      [btn(s.autoBuy ? '🔴 Auto-buy OFF' : '🟢 Auto-buy ON', 'abtog'), btn('✏️ Auto-buy amount', 'abamt')],
      [btn('« Menu', 'menu')],
    ),
  };
}
async function safetyScreen(chatId, ca, chainKey) {
  const ch = core.chainOf(chainKey) || core.chainOf(core.userChain(core.ensureUser(chatId)));
  const back = rows([btn('« Menu', 'menu')]);
  if (!goplus.supported(chainKey)) {
    return { text: `🛡 <b>Token safety</b> — not available on ${ch.emoji} ${esc(ch.name)}.\n\nRobinfun-native tokens on Robinhood Chain are fair-launch by design: fixed supply, no tax, and LP is 100% burned at graduation.`, kb: back };
  }
  const s = await goplus.tokenSecurity(chainKey, ca).catch(() => null);
  if (!s) return { text: `🛡 <b>Token safety</b>\n\nCouldn't fetch security data right now (or the token isn't indexed yet). Trade carefully.`, kb: rows([btn('🔄 Retry', `sec:${chainKey}:${ca}`), btn('« Menu', 'menu')]) };
  const v = goplus.verdict(s);
  const banner = v.level === 'danger' ? '🚨 <b>HIGH RISK</b>' : v.level === 'warn' ? '⚠️ <b>CAUTION</b>' : '✅ <b>No major red flags</b>';
  const tax = (t) => (t == null ? '?' : (Math.round(t * 10) / 10) + '%');
  const yn = (bad) => (bad ? '🔴' : '🟢');
  let body =
    `${yn((s.buyTaxPct || 0) > 10)} Buy tax: <b>${tax(s.buyTaxPct)}</b>  ·  ${yn((s.sellTaxPct || 0) > 10)} Sell tax: <b>${tax(s.sellTaxPct)}</b>\n` +
    `${yn(s.honeypot)} Honeypot: <b>${s.honeypot ? 'YES' : 'no'}</b>  ·  ${yn(s.cannotSellAll)} Can sell all: <b>${s.cannotSellAll ? 'NO' : 'yes'}</b>\n` +
    `${yn(s.mintable)} Mintable: <b>${s.mintable ? 'yes' : 'no'}</b>  ·  ${yn(s.ownerChangeBalance)} Owner edits balances: <b>${s.ownerChangeBalance ? 'yes' : 'no'}</b>\n` +
    `${yn(s.openSource === false)} Open-source: <b>${s.openSource === false ? 'no' : 'yes'}</b>  ·  ${yn(s.proxy)} Proxy: <b>${s.proxy ? 'yes' : 'no'}</b>\n`;
  if (s.lpLockedPct != null) body += `${yn(s.lpLockedPct < 50)} LP locked/burned: <b>${Math.round(s.lpLockedPct)}%</b>\n`;
  if (s.holders != null) body += `Holders: <b>${s.holders}</b>\n`;
  if (v.red.length) body += `\n🔴 <b>${v.red.join(', ')}</b>`;
  else if (v.warn.length) body += `\n⚠️ ${v.warn.join(', ')}`;
  return {
    text: `🛡 <b>Token safety</b> · ${ch.emoji} ${esc(ch.name)}  ${s.symbol ? '· $' + esc(s.symbol) : ''}\n${banner}\n\n${body}\n\n<i>Source: GoPlus. Not financial advice — always DYOR.</i>`,
    kb: rows([btn('🔄 Recheck', `sec:${chainKey}:${ca}`), btn('« Menu', 'menu')]),
  };
}

// ------------------------------------------------------------ actions
// 1-based index of a wallet (default active) — used to re-encode the card action.
function walletIndex(chatId, walletId) {
  const u = core.getUser(chatId); if (!u) return 1;
  const id = walletId || (core.activeWallet(u) || {}).id;
  const i = core.walletList(u).findIndex((w) => w.id === id);
  return i >= 0 ? i + 1 : 1;
}
async function doBuy(chatId, ca, amt, chain, walletId) {
  try {
    await send(chatId, `⏳ Buying ${esc(amt)} of <code>${short(ca)}</code>…`);
    const r = await core.buy(chatId, ca, amt, chain, walletId);
    const wi = walletIndex(chatId, walletId);
    await send(chatId, `✅ <b>Bought</b> ${fmt(r.gotTokens)} $${esc(r.sym)}\nSpent ${r.spentEth} ${r.native} · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.chain, r.hash)}`, rows([btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]));
  } catch (e) { await send(chatId, `❌ Buy failed: ${esc(e.message || String(e))}`); }
}
async function doSell(chatId, ca, pct, chain, walletId) {
  try {
    await send(chatId, `⏳ Selling ${pct}% of <code>${short(ca)}</code>…`);
    const r = await core.sell(chatId, ca, pct, chain, walletId);
    const wi = walletIndex(chatId, walletId);
    await send(chatId, `✅ <b>Sold</b> ${r.soldPct}%\nGot ${r.proceedsEth} ${r.native} · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.chain, r.hash)}`, rows([btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]));
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
  if (text === '/settings') { const s = settingsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/withdraw') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 Send the <b>destination address</b> to withdraw to:'); }
  if (text === '/export') return askExport(chatId);
  if (text === '/admin') return adminScreen(chatId);
  if (text === '/menu' || text === '/help') return send(chatId, helpText(), mainMenu());
  if (text.startsWith('/buy')) { const [, ca, amt] = text.split(/\s+/); if (isCa(ca) && amt) return doBuy(chatId, ca, amt); return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;amount&gt;</code> — or paste a contract address.'); }
  if (text.startsWith('/sell')) { const [, ca, pct] = text.split(/\s+/); if (isCa(ca) && pct) return doSell(chatId, ca, Number(pct)); return send(chatId, 'Usage: <code>/sell &lt;contract&gt; &lt;pct&gt;</code>'); }

  if (isCa(text)) {
    const u = core.ensureUser(chatId);
    // Auto-buy on paste (Settings): buy instantly with the active wallet/chain.
    if (u.settings && u.settings.autoBuy) {
      const amt = u.settings.autoBuyAmount || '0.01';
      const chainKey = core.userChain(u);
      // Safety gate: auto-buy skips the manual 🛡 Safety screen, so on GoPlus
      // chains refuse an obvious honeypot / can't-sell token before spending funds.
      let safetyNote = '';
      if (goplus.supported(chainKey)) {
        const s = await goplus.tokenSecurity(chainKey, text).catch(() => null);
        if (s && (s.honeypot || s.cannotSellAll)) {
          return send(chatId, `🚨 <b>Auto-buy blocked</b> — <code>${short(text)}</code> looks like a <b>honeypot / can't-sell</b> token (GoPlus). Open the card and review 🛡 Safety before buying manually.`, rows([btn('🔎 Open card', `tok:${chainKey}:${walletIndex(chatId)}:${text}`), btn('« Menu', 'menu')]));
        }
        // Gate fails OPEN when GoPlus has no data (fresh/unindexed token — the
        // riskiest case). Tell the user the check didn't actually run.
        if (!s) safetyNote = '\n⚠️ <i>Safety data unavailable — buying blind on a fresh/unknown token.</i>';
      }
      await send(chatId, `⚡ <b>Auto-buy</b> ${esc(amt)} of <code>${short(text)}</code>… <i>(toggle in ⚙️ Settings)</i>${safetyNote}`);
      return doBuy(chatId, text, amt, chainKey);
    }
    const c = await tokenCard(chatId, text); return send(chatId, c.text, c.kb);
  }
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
  if (data === 'set') { const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'setslip') { setPending(chatId, { action: 'slip_val' }); return send(chatId, 'Send your <b>slippage %</b> (e.g. <code>5</code>). <code>0</code> = default (5%). Max 50.'); }
  if (data === 'setbp') { setPending(chatId, { action: 'bp_val' }); return send(chatId, 'Send <b>3 quick-buy amounts</b> separated by spaces, e.g. <code>0.01 0.05 0.1</code>:'); }
  if (data === 'abtog') { const u = core.ensureUser(chatId); try { core.setAutoBuy(chatId, !u.settings.autoBuy); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'abamt') { setPending(chatId, { action: 'ab_amt' }); return send(chatId, 'Send the <b>auto-buy amount</b> to spend per paste (e.g. <code>0.02</code>):'); }
  if (k === 'sec') { const parts = data.split(':'); const s = await safetyScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dep') { const u = core.ensureUser(chatId); const ch = core.chainOf(core.userChain(u)); return edit(chatId, mid, `📥 <b>Deposit ${ch.native}</b> on ${ch.emoji} ${esc(ch.name)}\n\n<code>${core.activeAddress(u)}</code>\n\nThis is your <b>active</b> wallet. Same address on every chain — then paste a token contract to buy.`, rows([btn('🔄 Refresh balance', 'wal'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')])); }
  if (data === 'wallets') { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'sw') { try { core.switchWallet(chatId, ca); } catch (_) {} const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'rmw') {
    const u = core.ensureUser(chatId); const w = core.walletById(u, ca);
    if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    const i = core.walletList(u).findIndex((x) => x.id === ca) + 1;
    return edit(chatId, mid, `🗑 <b>Remove Wallet ${i}?</b>\n<code>${w.address}</code>\n\nIt must be <b>empty of native</b> on every chain. I can't see ERC20 bags — <b>🔑 export the key first</b> if it holds tokens. Any <b>pending orders</b> on this wallet are cancelled. (The key is archived and stays recoverable, but export is the safe way.)`, rows([btn('✅ Remove', 'rmwok:' + ca), btn('✖ Cancel', 'wallets')]));
  }
  if (k === 'rmwok') { try { await core.removeWallet(chatId, ca); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'expw') { const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); } const i = core.walletList(u).findIndex((x) => x.id === ca) + 1; return send(chatId, `🔑 <b>Export Wallet ${i}</b>\n<code>${short(w.address)}</code>\n\nThis reveals full control of that wallet — anyone with the key can drain it. Never share it. Continue?`, rows([btn('Yes, show key', 'expwy:' + ca), btn('Cancel', 'wallets')])); }
  if (k === 'expwy') { try { const pk = core.exportKey(chatId, ca); await send(chatId, `🔑 <b>Private key</b> (delete this message after saving):\n\n<code>${pk}</code>`); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (data === 'wd') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 Send the <b>destination address</b>:'); }
  if (data === 'exp') return askExport(chatId);
  if (data === 'expy') { try { const pk = core.exportKey(chatId); await send(chatId, `🔑 <b>Private key</b> (delete this message after saving):\n\n<code>${pk}</code>`); } catch (e) { await send(chatId, '❌ ' + esc(e.message)); } return; }
  if (data === 'imp') { setPending(chatId, { action: 'import_key' }); return send(chatId, `📩 <b>Import a wallet</b>\n\nPaste your <b>private key</b> (64 hex) or <b>seed phrase</b> (12–24 words). It's <b>added</b> to your wallets (up to ${core.WALLET_CAP}) and made active.\n\n⚠️ I'll <b>delete your message immediately</b> after importing. Never share the secret with anyone else.`); }
  if (data === 'neww') { try { const nw = core.addWallet(chatId); await send(chatId, `✅ <b>New wallet created</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now your <b>active</b> wallet. Deposit to start trading.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (data === 'snon') { const u = core.ensureUser(chatId); u.snipe.on = true; core.saveStore(); const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snoff') { const u = core.ensureUser(chatId); u.snipe.on = false; core.saveStore(); const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snamt') { setPending(chatId, { action: 'snipe_amt' }); return send(chatId, 'Send the ETH amount to buy per snipe (e.g. <code>0.01</code>):'); }

  // Trade actions encode the CARD's chain: k:chain:ca[:arg]
  if (k === 'tok' || k === 'b' || k === 's' || k === 'bx' || k === 'sx' || k === 'tp' || k === 'sl' || k === 'lb') {
    const parts = data.split(':'); const ch = parts[1], wi = parts[2], tca = parts[3], a = parts[4];
    const wobj = core.walletList(core.ensureUser(chatId))[Number(wi) - 1];
    const wid = wobj ? wobj.id : undefined;   // stale/removed index → fall back to the active wallet
    if (k === 'tok') { const c = await tokenCard(chatId, tca, ch, wid); return edit(chatId, mid, c.text, c.kb); }
    if (k === 'b') return doBuy(chatId, tca, a, ch, wid);
    if (k === 's') return doSell(chatId, tca, Number(a), ch, wid);
    if (k === 'bx') { setPending(chatId, { action: 'buy_amt', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Send the amount to buy of <code>${short(tca)}</code>:`); }
    if (k === 'sx') { setPending(chatId, { action: 'sell_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Sell what % of your <code>${short(tca)}</code> bag? Send a number 1–100:`); }
    if (k === 'tp') { setPending(chatId, { action: 'tp_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Take-profit: send the target <b>USD price</b> to sell 100% at:`); }
    if (k === 'sl') { setPending(chatId, { action: 'sl_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Stop-loss: send the target <b>USD price</b> to sell 100% at:`); }
    if (k === 'lb') { setPending(chatId, { action: 'lb_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Limit buy: send <b>&lt;usd_price&gt; &lt;amount&gt;</b> (e.g. <code>0.002 0.05</code>) — buy when price drops to that:`); }
  }
  if (k === 'oc') { const ok = watchers.cancelOrder(chatId, ca); await answer(q.id, ok ? 'Cancelled' : 'Not found'); const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
}

async function resolvePending(chatId, p, text, m) {
  const t = text.trim();
  try {
    if (p.action === 'import_key') {
      if (m && m.message_id) await del(chatId, m.message_id);   // delete the secret FIRST
      try { const nw = core.addWallet(chatId, t); return send(chatId, `✅ <b>Wallet imported</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now active and your secret message was deleted. Trade as normal.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); }
      catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e)) + '\n\n(Your message was deleted for safety — try Import again.)'); }
    }
    if (p.action === 'buy_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); return doBuy(chatId, p.ca, t, p.chain, p.walletId); }
    if (p.action === 'sell_pct') { const pct = Number(t); if (!(pct > 0 && pct <= 100)) return send(chatId, 'Send a number 1–100.'); return doSell(chatId, p.ca, pct, p.chain, p.walletId); }
    if (p.action === 'slip_val') { const n = core.setSlippage(chatId, t); const s = settingsScreen(chatId); return send(chatId, `✅ Slippage set to <b>${n > 0 ? n + '%' : 'default (5%)'}</b>.`, s.kb); }
    if (p.action === 'bp_val') { const arr = core.setBuyPresets(chatId, t); return send(chatId, `✅ Quick-buy buttons: <b>${arr.join(' · ')}</b>.`, settingsScreen(chatId).kb); }
    if (p.action === 'ab_amt') { const r = core.setAutoBuy(chatId, undefined, t); return send(chatId, `✅ Auto-buy amount: <b>${esc(r.autoBuyAmount)}</b>.`, settingsScreen(chatId).kb); }
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
      watchers.addOrder(chatId, { type, ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), sellPct: 100 }, p.walletId);
      return send(chatId, `✅ ${type === 'tp' ? 'Take-profit' : 'Stop-loss'} set for $${esc(meta.sym)} at $${usdPrice} on ${ch.emoji} ${esc(ch.name)}.`, rows([btn('📋 Orders', 'orders')]));
    }
    if (p.action === 'lb_price') {
      const [pxStr, amtStr] = t.split(/\s+/); const usdPrice = Number(pxStr), amount = Number(amtStr);
      if (!(usdPrice > 0) || !(amount > 0)) return send(chatId, 'Format: <code>&lt;usd_price&gt; &lt;amount&gt;</code>');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      watchers.addOrder(chatId, { type: 'limitbuy', ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), ethAmount: String(amount) }, p.walletId);
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
    `• <b>/wallet</b> — up to ${core.WALLET_CAP} wallets: balance, deposit/withdraw, import/export, switch\n` +
    `• <b>/portfolio</b> — positions & PnL (active chain)\n` +
    `• <b>/snipe</b> — auto-buy every new Robinfun launch\n` +
    `• <b>/orders</b> — take-profit / stop-loss / limit buys\n` +
    `• <b>/referral</b> — earn ${(core.CFG.refShareBps / 100).toFixed(0)}% of the bot fee from invites\n` +
    `• <b>/settings</b> — slippage, quick-buy amounts, auto-buy on paste\n` +
    `• 🛡 <b>Safety</b> — on a token card (Ethereum/Base/BNB/Arbitrum): honeypot, tax, mint, LP checks\n` +
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
