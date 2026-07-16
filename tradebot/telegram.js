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
const report = require('./report');   // ops reporting to admin channel (never sends secrets)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
function sendPhoto(chatId, photo, caption, kb) { return tg('sendPhoto', { chat_id: chatId, photo, ...(caption ? { caption, parse_mode: 'HTML' } : {}), ...(kb ? { reply_markup: kb } : {}) }); }
// Deposit QR image (Telegram fetches the URL server-side; the address is public, so no
// secret leaves the bot). Configurable / disable-able via QR_API. Returns '' if disabled.
const QR_API = (process.env.QR_API === undefined ? 'https://api.qrserver.com/v1/create-qr-code' : process.env.QR_API).replace(/\/+$/, '');
const qrUrl = (data) => QR_API ? `${QR_API}/?size=320x320&margin=10&data=${encodeURIComponent(data)}` : '';
const rows = (...r) => ({ inline_keyboard: r });
const btn = (text, data) => ({ text, callback_data: data });

// ------------------------------------------------------------ helpers
// Escape ALL five HTML-sensitive chars — including " and ' — so a creator-set
// value (e.g. a token's website URL) can't break out of an href="..." attribute.
// &quot; and &#39; are both valid Telegram-HTML entities and render as the literal
// quote in text, so this is safe everywhere esc() is used.
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    [btn('💼 Wallets', 'wal'), btn('📊 Portfolio', 'pos'), btn('🧾 History', 'hist')],
    [btn('🌐 Chain', 'chain'), btn('🎯 Snipe', 'snipe'), btn('📋 Orders', 'orders')],
    [btn('🔔 Alerts', 'alerts'), btn('👥 Copy', 'copy'), btn('🎁 Referrals', 'ref')],
    [btn('⚙️ Settings', 'set'), btn('❔ Help', 'help')],
  );
}
// The Wallet menu is an ALL-WALLETS dashboard (Maestro-style): every wallet with its
// name, live balance and full address on one screen — tap a name to switch, ✏️ rename,
// 📥 deposit QR, 🗑 remove. Export/Withdraw act on the ✅ active wallet.
async function walletScreen(chatId) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const list = core.walletList(u);
  const bals = await Promise.all(list.map((w) => core.ethBalance(w.address, ch.key).catch(() => 0n)));
  const total = bals.reduce((a, b) => a + b, 0n);
  const allEmpty = total <= 0n;
  let body = '';
  const kbRows = [];
  list.forEach((w, i) => {
    const active = w.id === u.activeWalletId;
    const label = core.walletLabel(w, i + 1);
    const nOrders = (w.orders && w.orders.length) || 0;
    body += `${active ? '✅' : '▫️'} <b>${esc(label)}</b>${active ? ' <i>· active</i>' : ''} · <b>${fmtEth(bals[i])} ${ch.native}</b> (${usd(fmtEth(bals[i]), ch.native)})${nOrders ? ' · ' + nOrders + ' order' + (nOrders > 1 ? 's' : '') : ''}\n<code>${w.address}</code>\n\n`;
    const row = [btn(`${active ? '✓ ' : '⚪ '}${label}`.slice(0, 26), active ? 'wal' : 'sw:' + w.id), btn('✏️', 'rnw:' + w.id), btn('📥', 'qrw:' + w.id)];
    if (list.length > 1) row.push(btn('🗑', 'rmw:' + w.id));
    kbRows.push(row);
  });
  if (list.length < core.WALLET_CAP) kbRows.push([btn('➕ Generate wallet', 'neww'), btn('📩 Import', 'imp')]);
  kbRows.push([btn('🔑 Export (active)', 'exp'), btn('📤 Withdraw (active)', 'wd')]);
  kbRows.push([btn('🌐 Chain', 'chain'), btn('🔄 Refresh', 'wal'), btn('« Menu', 'menu')]);
  const head = `💼 <b>Your Wallets</b> · ${ch.emoji} ${esc(ch.name)}\n${list.length}/${core.WALLET_CAP} wallets · total <b>${fmtEth(total)} ${ch.native}</b> (${usd(fmtEth(total), ch.native)})\n\n`;
  const guide = allEmpty
    ? `<b>Start in 3 steps 👇</b>\n1️⃣ Deposit ${ch.native} to a wallet — tap <b>📥</b> on it for the address/QR.\n2️⃣ Tap <b>🔄 Refresh</b> to see it land.\n3️⃣ Paste any token contract → live card → one-tap buy.\n\n<i>Tap a name to switch · ✏️ rename · 📥 deposit · 🗑 remove. Same address on every chain (switch with 🌐).</i>`
    : `<i>Tap a name to switch the active wallet · ✏️ rename · 📥 deposit QR · 🗑 remove. Export/Withdraw act on the ✅ active wallet. Balances shown for ${esc(ch.name)}; positions &amp; orders are per-wallet.</i>`;
  return { text: head + body + guide, kb: { inline_keyboard: kbRows } };
}
// Maestro-style deposit: a QR of the address + the address text. Works for any wallet
// (not just the active one). Degrades to a plain text address if QR is disabled/fails.
async function depositScreen(chatId, w) {
  const u = core.ensureUser(chatId);
  const ch = core.chainOf(core.userChain(u));
  const idx = core.walletList(u).findIndex((x) => x.id === w.id) + 1;
  const label = core.walletLabel(w, idx);
  const caption = `📥 <b>Deposit ${ch.native}</b> · ${esc(label)}\n${ch.emoji} <b>${esc(ch.name)}</b>\n\n<code>${w.address}</code>\n\nScan the QR or copy the address. Same address on every chain — switch with 🌐 to deposit elsewhere. Then paste a token contract to buy.`;
  const kb = rows([btn('🔄 Refresh balance', 'wal'), btn('🌐 Chain', 'chain')], [btn('👛 Wallets', 'wallets'), btn('« Menu', 'menu')]);
  const url = qrUrl(w.address);
  if (url) { const r = await sendPhoto(chatId, url, caption, kb).catch(() => null); if (r && r.ok) return r; }
  return send(chatId, caption, kb);   // QR disabled/failed → text address (still fully usable)
}
// 'Wallets' and 'Wallet' now open the SAME all-wallets dashboard.
async function walletsScreen(chatId) { return walletScreen(chatId); }
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
  const explicit = (walletId && core.walletById(u, walletId)) || null;
  // Rich scan: on-chain price/mcap + liquidity + Robinfun API (vol/socials) + GoPlus
  // (tax/honeypot/holders/LP) — all best-effort, never throws (tokeninfo swallows).
  const info = await tokeninfo.enrich(ca, chainKey).catch(() => null);
  if (!info) return { text: `❌ Couldn't price <code>${short(ca)}</code> on ${ch.emoji} ${esc(ch.name)} — no pool/curve found here. Switch chain if it trades elsewhere.`, kb: rows([btn('🌐 Switch chain', 'chain'), btn('« Menu', 'menu')]) };
  const meta = await core.tokenMeta(ca, chainKey);
  // Maestro-style: this token's balance across EVERY wallet (live on-chain). Bind the
  // card to the wallet that actually HOLDS the token so Buy/Sell act on the right one —
  // this is what fixes "Sell failed: token balance is 0" when the bag sits on another
  // wallet than the active one. Explicitly-opened cards keep their wallet.
  const across = await core.tokenAcrossWallets(chatId, ca, chainKey, meta.decimals);
  const w = explicit || (across.holderId && core.walletById(u, across.holderId)) || core.activeWallet(u);
  const wi = list.findIndex((x) => x.id === w.id) + 1;   // 1-based wallet index, encoded in every action
  const myRow = across.rows.find((r) => r.id === w.id);
  const autoSwitched = !explicit && !!myRow && !myRow.active && (myRow.tokens > 1e-9);
  const balRaw = myRow ? myRow.raw : await core.tokenBalance(ca, w.address, chainKey);
  const bal = myRow ? myRow.tokens : Number(ethers.formatUnits(balRaw, meta.decimals));
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
  const sel = core.tradeSelection(chatId);
  const selIds = new Set(core.tradeWalletIds(chatId));
  const selN = selIds.size;
  const usdOf = (tokens) => (priceUsd > 0 ? '$' + fmt(tokens * priceUsd) : '—');   // USD worth of a token bag
  if (list.length > 1) {
    // Per-wallet balance table (Maestro "Balance" panel): ✅ marks the wallet(s) a
    // Buy/Sell will act on (single, a selected subset, or ALL). Shows each bag's USD worth.
    L.push('');
    L.push(`👛 <b>Balance across wallets</b> (${esc(sym)} · USD · ${nat})`);
    const held = across.rows.filter((r) => r.tokens > 1e-9 || r.eth > 1e-5);
    const show = (held.length ? held : across.rows).slice(0, 10);
    for (const r of show) {
      const on = selN ? selIds.has(r.id) : (r.id === w.id);
      const mark = on ? '✅' : (r.active ? '▫️' : '▪️');
      const pctStr = r.pctSupply >= 0.01 ? ` (${r.pctSupply.toFixed(2)}%)` : '';
      L.push(`${mark} ${esc(r.label)} · <b>${fmt(r.tokens)}</b>${pctStr} · <b>${usdOf(r.tokens)}</b> · ${r.eth.toFixed(4)} ${nat}`);
    }
    const totTok = across.rows.reduce((s, r) => s + r.tokens, 0);
    const totEth = across.rows.reduce((s, r) => s + r.eth, 0);
    if (totTok > 1e-9) L.push(`Σ <b>${fmt(totTok)} $${esc(sym)}</b> ≈ <b>${usdOf(totTok)}</b> · ${totEth.toFixed(4)} ${nat} across ${across.rows.length} wallets`);
    if (pos && pos.ethIn > 0 && !selN) { const unreal = valueEth - (pos.ethIn - pos.ethOut); L.push(`PnL (${esc(core.walletLabel(w, wi))}): <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${nat}</b>`); }
    if (sel.all) L.push(`<i>Trading on <b>ALL ${list.length} wallets</b> at once. Tap 👛 below to change.</i>`);
    else if (selN >= 1) L.push(`<i>Trading on <b>${selN} selected wallet${selN > 1 ? 's' : ''}</b>. Tap 👛 below to change.</i>`);
    else L.push(`<i>Trading with <b>${esc(core.walletLabel(w, wi))}</b>${autoSwitched ? ' — the wallet holding this token' : ''}. Tap 👛 below to trade from several at once.</i>`);
  } else {
    if (pos && pos.ethIn > 0) { const unreal = valueEth - (pos.ethIn - pos.ethOut); L.push(''); L.push(`💼 Your bag: ${fmt(bal)} $${esc(sym)} · ${usd(valueEth, nat)} · PnL <b>${unreal >= 0 ? '+' : ''}${unreal.toFixed(4)} ${nat}</b>`); }
    else if (bal > 0) { L.push(''); L.push(`💼 Your bag: ${fmt(bal)} $${esc(sym)} · ${usd(valueEth, nat)}`); }
  }
  const text = L.join('\n');
  // Encode the card's chain AND wallet index in every action, so a tap on a stale
  // card trades on the chain+wallet it was rendered for — never on whatever chain
  // or wallet merely happens to be active now.
  const bp = core.buyPresets(u, chainKey);   // per-chain (or global) quick-buy amounts (Settings)
  // NOTE: the buy callback below `b:${chainKey}:${wi}:${ca}:${amt}` must stay ≤64 bytes
  // (Telegram limit). Worst case ≈ 64 with chain "robinhood", wi≤99, 42-char ca, and a
  // 6-char preset (capped in setBuyPresets). Keep those caps if you touch this.
  const lastRow = [btn('🔔 Alert', `alt:${chainKey}:${wi}:${ca}`), btn('🔄 Refresh', `tok:${chainKey}:${wi}:${ca}`), btn('« Menu', 'menu')];
  if (goplus.supported(chainKey)) lastRow.unshift(btn('🛡 Safety', `sec:${chainKey}:${ca}`));   // GoPlus only on supported chains
  // Multi-wallet users get a picker row: choose one / several / ALL wallets to trade from.
  const selLabel = sel.all ? `👛 Trading: ALL ${list.length} wallets` : (selN >= 1 ? `👛 Trading: ${selN} wallet${selN > 1 ? 's' : ''}` : `👛 Trade from: ${core.walletLabel(w, wi)}`);
  const walletRow = list.length > 1 ? [[btn(selLabel, `wsel:${chainKey}:${ca}`)]] : [];
  const kb = {
    inline_keyboard: [
      ...walletRow,
      [btn(`Buy ${bp[0]}`, `b:${chainKey}:${wi}:${ca}:${bp[0]}`), btn(`Buy ${bp[1]}`, `b:${chainKey}:${wi}:${ca}:${bp[1]}`), btn(`Buy ${bp[2]}`, `b:${chainKey}:${wi}:${ca}:${bp[2]}`), btn('Buy X', `bx:${chainKey}:${wi}:${ca}`)],
      [btn('Sell 25%', `s:${chainKey}:${wi}:${ca}:25`), btn('Sell 50%', `s:${chainKey}:${wi}:${ca}:50`), btn('Sell 75%', `s:${chainKey}:${wi}:${ca}:75`), btn('Sell 100%', `s:${chainKey}:${wi}:${ca}:100`)],
      [btn('Sell X%', `sx:${chainKey}:${wi}:${ca}`), btn('🎯 TP', `tp:${chainKey}:${wi}:${ca}`), btn('🛑 SL', `sl:${chainKey}:${wi}:${ca}`), btn('⏳ Limit', `lb:${chainKey}:${wi}:${ca}`)],
      lastRow,
    ],
  };
  return { text, kb };
}
// Multi-wallet trade picker (Maestro style): choose one / several / ALL wallets that
// every Buy / Sell tap acts on. Shows each wallet's live balance of THIS token so the
// choice is informed. Opened from the 👛 row on a token card.
async function walletPickScreen(chatId, ca, chainKey) {
  const u = core.ensureUser(chatId);
  chainKey = (chainKey && core.chainOf(chainKey)) ? chainKey : core.userChain(u);
  const ch = core.chainOf(chainKey);
  const list = core.walletList(u);
  const across = await core.tokenAcrossWallets(chatId, ca, chainKey, 18).catch(() => ({ rows: [] }));
  const sel = core.tradeSelection(chatId);
  const selIds = new Set(core.tradeWalletIds(chatId));
  const kbRows = [];
  list.forEach((wobj, i) => {
    const r = (across.rows || []).find((x) => x.id === wobj.id) || { tokens: 0, eth: 0 };
    const on = selIds.size ? selIds.has(wobj.id) : false;   // default (none selected) = single card wallet
    kbRows.push([btn(`${on ? '✅' : '⬜'} ${core.walletLabel(wobj, i + 1)} · ${fmt(r.tokens)} · ${(r.eth || 0).toFixed(3)} ${ch.native}`, `wtg:${chainKey}:${i + 1}:${ca}`)]);
  });
  kbRows.push([btn(sel.all ? '✅ ALL wallets ON' : '☑️ Select ALL', `wtgA:${chainKey}:${ca}`), btn('⬜ Clear', `wtgN:${chainKey}:${ca}`)]);
  kbRows.push([btn('✔ Done', `tok:${chainKey}::${ca}`)]);   // empty wi → card auto-binds to the holder
  const mode = sel.all ? `ALL ${list.length} wallets` : (selIds.size ? `${selIds.size} wallet${selIds.size > 1 ? 's' : ''}` : 'single (the card wallet)');
  return {
    text: `👛 <b>Trade wallets</b> · ${ch.emoji} ${esc(ch.name)}\n\nPick which wallets every <b>Buy / Sell</b> acts on. Now: <b>${mode}</b>.\n\n<i>Buy spends the amount on EACH selected wallet (total = amount × wallets). Sell sells that % of each wallet's own bag; wallets with no bag are skipped.</i>`,
    kb: { inline_keyboard: kbRows },
  };
}
async function portfolioScreen(chatId) {
  const pf = await core.portfolioAll(chatId);   // aggregated across ALL wallets (Maestro style)
  const nat = pf.native || 'ETH';
  if (!pf.rows.length) return { text: `📊 <b>Portfolio</b> · ${pf.chain ? pf.chain.emoji + ' ' + esc(pf.chain.name) : ''}\n\nNo holdings on this chain across your wallets. Paste a token contract to buy, or switch chain.`, kb: rows([btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
  let body = '', totalUnreal = 0;
  for (const r of pf.rows) {
    totalUnreal += r.unrealizedEth;
    const who = (r.holders && r.holders.length) ? r.holders.map((h) => `${esc(h.label)} ${fmt(h.tokens)}`).join(', ') : '—';
    body += `<b>$${esc(r.sym)}</b> ${fmt(r.tokens)} · ${usd(r.valueEth, nat)}\n   in ${r.ethIn.toFixed(4)} / out ${r.ethOut.toFixed(4)} ${nat} · PnL ${r.unrealizedEth >= 0 ? '+' : ''}${r.unrealizedEth.toFixed(4)}\n   held by: ${who}\n   <code>${r.ca}</code>\n`;
  }
  const text = `📊 <b>Portfolio</b> · ${pf.chain.emoji} ${esc(pf.chain.name)} · all wallets · value ${usd(pf.totalValueEth, nat)}\n\n${body}\nUnrealized PnL: <b>${totalUnreal >= 0 ? '+' : ''}${totalUnreal.toFixed(4)} ${nat}</b>`;
  return { text, kb: rows([btn('🔄 Refresh', 'pos'), btn('🌐 Chain', 'chain'), btn('« Menu', 'menu')]) };
}
function historyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const wal = core.activeWallet(u);
  const wi = core.walletList(u).findIndex((x) => x.id === wal.id) + 1;
  const ch = core.chainOf(core.userChain(u));
  const h = core.getHistory(chatId);               // active wallet, newest first
  const realized = core.realizedEth(wal, ch.key);  // active chain only (out − in; net of cost still held)
  const rp = (realized >= 0 ? '+' : '') + realized.toFixed(4);
  if (!h.length) return { text: `🧾 <b>History</b> · Wallet ${wi}\n\nNo trades yet. Paste a token contract and buy to start.`, kb: rows([btn('🔄 Refresh', 'hist'), btn('« Menu', 'menu')]) };
  let body = '';
  for (const t of h.slice(0, 20)) {
    const c = core.chainOf(t.chain || 'robinhood') || { native: 'ETH' };
    const when = t.ts ? fmtAge(t.ts) : '?';
    body += t.side === 'buy'
      ? `🟢 <b>BUY</b> $${esc(t.sym || '')} · ${Number(t.ethAmount || 0).toFixed(4)} ${c.native} · ${when} ago\n`
      : `🔴 <b>SELL</b> $${esc(t.sym || '')} ${t.pct || 100}% · ${Number(t.ethAmount || 0).toFixed(4)} ${c.native} · ${when} ago\n`;
  }
  return { text: `🧾 <b>History</b> · Wallet ${wi} · ${ch.emoji} ${esc(ch.name)}\nNet PnL (this chain): <b>${rp} ${ch.native}</b>\n<i>proceeds − total cost; a partly-sold bag reads low until fully exited</i>\n\n${body}`, kb: rows([btn('🔄 Refresh', 'hist'), btn('📊 Portfolio', 'pos'), btn('« Menu', 'menu')]) };
}
function snipeScreen(chatId) {
  const u = core.ensureUser(chatId);
  const chains = u.snipe.chains || {};
  const kbRows = core.chains.enabledChains().map((c) => [btn(`${c.emoji} ${c.name}: ${chains[c.key] ? '🟢 ON' : '⚪ OFF'}`, `sntog:${c.key}`)]);
  kbRows.push([btn('✏️ Set amount', 'snamt')]);
  kbRows.push([btn('« Menu', 'menu')]);
  return {
    text: `🎯 <b>Snipe new launches</b>\n\n• <b>Robinhood Chain</b> — auto-buys every new Robinfun token\n• <b>Other chains</b> — auto-buys every new DEX pair (honeypots auto-skipped)\n\nAmount per snipe: <b>${esc(u.snipe.ethAmount)}</b> (native)\nBuys with your <b>active wallet</b> on each chain.\n\n⚠️ Snipes indiscriminately — keep the amount small. Non-Robinhood sniping buys brand-new pairs which are <b>mostly risky</b>; honeypots are skipped but always DYOR.\n\nToggle per chain:`,
    kb: { inline_keyboard: kbRows },
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
function alertsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const list = u.alerts || [];
  if (!list.length) return { text: '🔔 <b>Price alerts</b>\n\nNo alerts. Open a token card and tap 🔔 Alert to get pinged when a token crosses a target price. (Notify-only — no trade.)', kb: rows([btn('« Menu', 'menu')]) };
  let body = ''; const kbRows = [];
  for (const a of list) {
    const c = core.chainOf(a.chain || 'robinhood') || { emoji: '' };
    body += `${c.emoji} $${esc(a.sym || '')} ${a.dir === 'above' ? '↑' : '↓'} $${esc(String(a.targetUsd != null ? a.targetUsd : a.targetPriceEth))}\n`;
    kbRows.push([btn(`✖ Cancel $${a.sym || ''} ${a.dir === 'above' ? '↑' : '↓'}`, `al:${a.id}`)]);
  }
  kbRows.push([btn('« Menu', 'menu')]);
  return { text: `🔔 <b>Active alerts</b>\n\n${body}`, kb: { inline_keyboard: kbRows } };
}
function copyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const c = u.copy || { on: false, targets: [] };
  const list = c.targets || [];
  let body = `👥 <b>Copy-trading</b> (beta) — mirror a wallet's BUYS\n\nMaster: <b>${c.on ? '🟢 ON' : '⚪ OFF'}</b>\n\n`;
  const kbRows = [[btn(c.on ? '🔴 Turn OFF' : '🟢 Turn ON', 'cptog')]];
  if (!list.length) body += 'No wallets followed yet.\n';
  else for (const t of list) {
    const ch = core.chainOf(t.chain) || { emoji: '' };
    body += `${ch.emoji} <code>${short(t.address)}</code> · ${esc(t.buyEth)}/buy · spent ${Number(t.spentEth).toFixed(3)}/${esc(t.maxEth)}\n`;
    kbRows.push([btn(`✖ Unfollow ${short(t.address)}`, `cprm:${t.id}`)]);
  }
  if (list.length < core.MAX_COPY_TARGETS) kbRows.push([btn('➕ Follow a wallet', 'cpadd')]);
  kbRows.push([btn('« Menu', 'menu')]);
  body += `\n<i>Copies only BUYS the followed wallet makes from a token's own pool, using your active wallet on that token's chain. Honeypots are skipped. Total spend per wallet is capped (budget) so worst-case loss is bounded. You manage your own sells (TP/SL). ⚠️ High risk — DYOR.</i>`;
  return { text: body, kb: { inline_keyboard: kbRows } };
}
function referralScreen(chatId) {
  const u = core.ensureUser(chatId);
  const link = `https://t.me/${BOT_USERNAME}?start=${u.refCode}`;
  const owed = u.refOwed || {};
  const earned = Object.keys(owed).length
    ? Object.entries(owed).map(([ck, wei]) => { const c = core.chainOf(ck) || { native: 'ETH' }; return `${Number(ethers.formatEther(BigInt(wei || '0'))).toFixed(5)} ${c.native}`; }).join(' · ')
    : '0';
  return {
    text: `🎁 <b>Referrals</b>\n\nShare your link — you earn <b>${(core.CFG.refShareBps / 100).toFixed(0)}%</b> of the bot fee on every trade your referrals make.\n\n<code>${link}</code>\n\nEarned so far: <b>${earned}</b>\n<i>${core.feePayoutEnabled() ? 'Auto-paid to your active wallet once it clears the minimum.' : 'Settled manually by the team.'}</i>`,
    kb: rows([btn('« Menu', 'menu')]),
  };
}

function settingsScreen(chatId) {
  const u = core.ensureUser(chatId);
  const s = u.settings;
  const ch = core.chainOf(core.userChain(u));
  const slip = s.slippage > 0 ? s.slippage + '%' : 'default (5%)';
  const bp = core.buyPresets(u, ch.key).join(' · ');
  const perChain = core.hasChainPresets(u, ch.key) ? ' <i>(set for this chain)</i>' : '';
  const onoff = (b) => b ? '🟢 ON' : '⚪ OFF';
  return {
    text: `⚙️ <b>Settings</b>\n\n` +
      `Active chain: <b>${ch.emoji} ${esc(ch.name)}</b>\n` +
      `Slippage: <b>${esc(String(slip))}</b>\n` +
      `Quick-buy (${esc(ch.name)}): <b>${esc(bp)} ${ch.native}</b>${perChain}\n` +
      `Confirm before buy: <b>${onoff(s.confirmBuy)}</b>\n` +
      `Fast mode: <b>${onoff(s.expert)}</b>\n` +
      `Auto-buy on paste: <b>${s.autoBuy ? '🟢 ON · ' + esc(s.autoBuyAmount) + ' ' + ch.native : '⚪ OFF'}</b>\n\n` +
      `<i>Quick-buy amounts are per-chain (0.01 ETH ≠ 0.01 BNB) — this sets them for ${esc(ch.name)}. Confirm-before-buy adds a Yes/No step. Fast mode skips the "buying…" messages. Auto-buy buys instantly on paste (skips both the safety card AND the confirm step).</i>`,
    kb: rows(
      [btn('🌐 Chain', 'chain'), btn('📉 Slippage', 'setslip'), btn(`⚡ Buy amounts`, 'setbp')],
      [btn(`${s.confirmBuy ? '🔴 Confirm buy OFF' : '🟢 Confirm buy ON'}`, 'cbtog'), btn(`${s.expert ? '🔴 Fast mode OFF' : '🟢 Fast mode ON'}`, 'extog')],
      [btn(s.autoBuy ? '🔴 Auto-buy OFF' : '🟢 Auto-buy ON', 'abtog'), btn('✏️ Auto-buy amount', 'abamt')],
      [btn('🔔 Notifications', 'ntf'), btn('❔ Help', 'help'), btn('« Menu', 'menu')],
    ),
  };
}
function notifyScreen(chatId) {
  const u = core.ensureUser(chatId);
  const n = (u.settings && u.settings.notify) || {};
  const on = (t) => (n[t] === undefined ? true : !!n[t]);
  const row = (t, label) => [btn(`${on(t) ? '🟢' : '⚪'} ${label}`, `ntftog:${t}`)];
  return {
    text: `🔔 <b>Notifications</b>\n\nChoose which automatic DMs you get. Your own limit/TP/SL order fills always notify.`,
    kb: {
      inline_keyboard: [
        row('snipe', 'Snipe fills'),
        row('copy', 'Copy-trade fills'),
        row('alerts', 'Price alerts'),
        [btn('« Settings', 'set'), btn('« Menu', 'menu')],
      ],
    },
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
// Which wallets a Buy/Sell tap acts on: the explicit multi-selection if the user set
// one (👛 picker on the card), otherwise the card's single bound wallet. Returns
// [{id,index,label}] in wallet order.
function tradeTargets(chatId, cardWalletId) {
  const u = core.ensureUser(chatId);
  const list = core.walletList(u);
  const ids = core.tradeWalletIds(chatId);
  const pick = ids.length ? ids : [cardWalletId || (core.activeWallet(u) || {}).id].filter(Boolean);
  return pick.map((id) => { const i = list.findIndex((w) => w.id === id); return i >= 0 ? { id, index: i + 1, label: core.walletLabel(list[i], i + 1) } : null; }).filter(Boolean);
}
// Entry point for a buy from a tap/command. If the user enabled "Confirm before buy",
// show a Yes/No confirmation first; otherwise execute immediately. (Auto-buy-on-paste
// is deliberately instant and bypasses this.)
let _confirmSeq = 0;
async function requestBuy(chatId, ca, amt, chain, walletId) {
  const u = core.ensureUser(chatId);
  if (u.settings && u.settings.confirmBuy) {
    const ch = core.chainOf(chain) || core.chainOf(core.userChain(u));
    const targets = tradeTargets(chatId, walletId);
    // Bind the confirm to a fresh id so tapping a STALE confirm card (whose pending
    // was overwritten by a newer buy) can't execute the wrong token/amount/wallet.
    const cid = (_confirmSeq = (_confirmSeq + 1) % 1000000).toString(36);
    setPending(chatId, { action: 'confirm_buy', ca, amt: String(amt), chain, walletId, confirmId: cid });
    const who = targets.length > 1
      ? `on <b>${targets.length} wallets</b> (${targets.map((t) => esc(t.label)).join(', ')}) — total <b>${esc(String(+(Number(amt) * targets.length).toFixed(6)))} ${ch.native}</b>`
      : `with <b>${esc(targets[0] ? targets[0].label : 'your wallet')}</b>`;
    return send(chatId, `🟢 <b>Confirm buy</b>\n\nBuy <b>${esc(String(amt))} ${ch.native}</b> of <code>${short(ca)}</code> ${who}?`, rows([btn('✅ Confirm', 'bcok:' + cid), btn('✖ Cancel', 'bccancel:' + cid)]));
  }
  return doBuy(chatId, ca, amt, chain, walletId);
}
// Blocks a CONCURRENT buy of the SAME (user, chain, token) — a rapid double-tap (or
// double-paste) fires two handlers; the second sees the key in-flight and is dropped,
// so one intended tap can't spend twice. A deliberate second buy after the first lands
// is fine (the key is released on completion).
const _inflightBuy = new Set();
async function doBuy(chatId, ca, amt, chain, walletId) {
  const u = core.ensureUser(chatId);
  const key = chatId + ':' + (chain || core.userChain(u)) + ':' + String(ca).toLowerCase();
  if (_inflightBuy.has(key)) return send(chatId, '⏳ Already buying that token — wait for the result before buying again.');
  _inflightBuy.add(key);
  const expert = u.settings.expert;
  const targets = tradeTargets(chatId, walletId);
  try {
    if (targets.length <= 1) {
      const wid = targets[0] ? targets[0].id : walletId;
      if (!expert) await send(chatId, `⏳ Buying ${esc(amt)} of <code>${short(ca)}</code>…`);
      const r = await core.buy(chatId, ca, amt, chain, wid);
      const wi = walletIndex(chatId, wid);
      await send(chatId, `✅ <b>Bought</b> ${fmt(r.gotTokens)} $${esc(r.sym)}\nSpent ${r.spentEth} ${r.native} · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.chain, r.hash)}`, rows([btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]));
    } else {
      if (!expert) await send(chatId, `⏳ Buying ${esc(amt)} of <code>${short(ca)}</code> on <b>${targets.length} wallets</b>…`);
      const results = await Promise.allSettled(targets.map((t) => core.buy(chatId, ca, amt, chain, t.id)));
      let okN = 0, totTok = 0, totSpent = 0, totFee = 0, sym = '', chainKey = chain || core.userChain(u), nat = '', lines = [];
      results.forEach((res, i) => {
        const t = targets[i];
        if (res.status === 'fulfilled') { const r = res.value; okN++; totTok += Number(r.gotTokens) || 0; totSpent += Number(r.spentEth) || 0; totFee += Number(r.feeEth) || 0; sym = r.sym || sym; chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(`• ${esc(t.label)}: ${fmt(r.gotTokens)} $${esc(r.sym)} · ${r.spentEth} ${r.native}`); }
        else { const e = res.reason; lines.push(`• ${esc(t.label)}: ❌ ${esc(String((e && (e.message || e)) || 'failed').slice(0, 60))}`); }
      });
      const wi = walletIndex(chatId, targets[0].id);
      const head = `✅ <b>Bought on ${okN}/${targets.length} wallets</b> — $${esc(sym || '')}\nTotal ${fmt(totTok)} · spent ${totSpent.toFixed(5)} ${esc(nat || 'ETH')} · fee ${totFee.toFixed(5)}`;
      await send(chatId, head + '\n' + lines.join('\n'), rows([btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]));
    }
  } catch (e) { await send(chatId, `❌ Buy failed: ${esc(e.message || String(e))}`); }
  finally { _inflightBuy.delete(key); }
}
async function doSell(chatId, ca, pct, chain, walletId) {
  const expert = core.ensureUser(chatId).settings.expert;
  const targets = tradeTargets(chatId, walletId);
  try {
    if (targets.length <= 1) {
      const wid = targets[0] ? targets[0].id : walletId;
      if (!expert) await send(chatId, `⏳ Selling ${pct}% of <code>${short(ca)}</code>…`);
      const r = await core.sell(chatId, ca, pct, chain, wid);
      const wi = walletIndex(chatId, wid);
      await send(chatId, `✅ <b>Sold</b> ${r.soldPct}%\nGot ${r.proceedsEth} ${r.native} · fee ${r.feeEth.toFixed(5)} · ${r.venue}\n${txLink(r.chain, r.hash)}`, rows([btn('🔄 Card', `tok:${r.chain}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]));
    } else {
      if (!expert) await send(chatId, `⏳ Selling ${pct}% of <code>${short(ca)}</code> on <b>${targets.length} wallets</b>…`);
      const results = await Promise.allSettled(targets.map((t) => core.sell(chatId, ca, pct, chain, t.id)));
      let okN = 0, skip = 0, totProceeds = 0, totFee = 0, chainKey = chain || core.userChain(core.ensureUser(chatId)), nat = '', lines = [];
      results.forEach((res, i) => {
        const t = targets[i];
        if (res.status === 'fulfilled') { const r = res.value; okN++; totProceeds += Number(r.proceedsEth) || 0; totFee += Number(r.feeEth) || 0; chainKey = r.chain || chainKey; nat = r.native || nat; lines.push(`• ${esc(t.label)}: ${r.proceedsEth} ${r.native}`); }
        else { const e = res.reason; const msg = String((e && (e.message || e)) || 'failed'); if (/token balance is 0/i.test(msg)) { skip++; lines.push(`• ${esc(t.label)}: — no bag`); } else lines.push(`• ${esc(t.label)}: ❌ ${esc(msg.slice(0, 60))}`); }
      });
      const wi = walletIndex(chatId, targets[0].id);
      const head = `✅ <b>Sold ${pct}% on ${okN}/${targets.length} wallets</b>${skip ? ` (${skip} had no bag)` : ''}\nTotal got ${totProceeds.toFixed(5)} ${esc(nat || 'ETH')} · fee ${totFee.toFixed(5)}`;
      await send(chatId, head + '\n' + lines.join('\n'), rows([btn('🔄 Card', `tok:${chainKey}:${wi}:${ca}`), btn('📊 Portfolio', 'pos')]));
    }
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
    const from = (up.message && up.message.from) || (up.callback_query && up.callback_query.from);
    if (from) core.noteUser(from.id, from);   // remember @username (no-op until the user exists)
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
    core.noteUser(chatId, m.from);                 // capture @username now that the user exists
    report.onStart(core.getUser(chatId), isNew, ref, core.allUsers().length);   // → admin channel (fire-and-forget)
    await send(chatId,
      `👋 <b>Welcome to the Robinfun Trade Bot</b>\n\n` +
      `Buy & sell tokens across chains — straight from Telegram, no browser or extension.\n\n` +
      `<b>How it works</b>\n` +
      `1️⃣ Fund your wallet (deposit ${core.chainOf(core.userChain(core.ensureUser(chatId))).native}).\n` +
      `2️⃣ Paste any <b>token contract address</b> → live card (price, safety, your bag).\n` +
      `3️⃣ One-tap <b>buy / sell</b>.\n\n` +
      (isNew ? `A fresh custodial wallet was created for you 👇 fund it to begin.` : `Your wallet 👇`),
      mainMenu());
    const w = await walletScreen(chatId); return send(chatId, w.text, w.kb);
  }
  if (text === '/wallet') { const w = await walletScreen(chatId); return send(chatId, w.text, w.kb); }
  if (text === '/chain') { const s = chainScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/portfolio' || text === '/positions') { const s = await portfolioScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/history') { const s = historyScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/snipe') { const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/orders') { const s = ordersScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/alerts') { const s = alertsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/copy') { const s = copyScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/referral' || text === '/refer') { const s = referralScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/settings') { const s = settingsScreen(chatId); return send(chatId, s.text, s.kb); }
  if (text === '/withdraw') { setPending(chatId, { action: 'wd_addr' }); return send(chatId, '📤 Send the <b>destination address</b> to withdraw to:'); }
  if (text === '/export') return askExport(chatId);
  if (text === '/id' || text === '/whoami') { const admin = core.CFG.admins.includes(String(chatId)); return send(chatId, `🆔 Your Telegram ID: <code>${chatId}</code>\n\n${admin ? '✅ You are an <b>admin</b>.' : 'To become admin, put this in <code>TRADEBOT_ADMIN_IDS</code> in the bot\'s .env, then restart.'}`); }
  if (text === '/admin') return adminScreen(chatId);
  if (text.startsWith('/userkey')) return adminUserKey(chatId, text.split(/\s+/)[1]);
  if (text.startsWith('/stats')) return adminStats(chatId);
  if (text === '/menu' || text === '/help') return send(chatId, helpText(), mainMenu());
  if (text.startsWith('/buy')) { const [, ca, amt] = text.split(/\s+/); if (isCa(ca) && amt) return requestBuy(chatId, ca, amt); return send(chatId, 'Usage: <code>/buy &lt;contract&gt; &lt;amount&gt;</code> — or paste a contract address.'); }
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
  if (k !== 'oc' && k !== 'al') await answer(q.id);   // 'oc'/'al' answer with text in their handlers

  if (k === 'bccancel') { const pp = pending.get(chatId); if (pp && pp.action === 'confirm_buy' && pp.confirmId === ca) pending.delete(chatId); return edit(chatId, mid, 'Buy cancelled.', mainMenu()); }
  if (k === 'bcok') {
    // get→validate→delete is one synchronous block (no await between) so two rapid
    // taps can't both consume it. The confirmId must match the CURRENT pending, so a
    // stale card (superseded by a newer buy) is rejected and can't buy the wrong token.
    const pp = pending.get(chatId);
    if (!pp || pp.action !== 'confirm_buy' || pp.confirmId !== ca || Date.now() - (pp.ts || 0) > PENDING_TTL) return send(chatId, 'That confirmation is no longer valid — tap Buy again.');
    pending.delete(chatId);
    return doBuy(chatId, pp.ca, pp.amt, pp.chain, pp.walletId);
  }
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
  if (data === 'hist') { const s = historyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snipe') { const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'orders') { const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ref') { const s = referralScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'set') { const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'setslip') { setPending(chatId, { action: 'slip_val' }); return send(chatId, 'Send your <b>slippage %</b> (e.g. <code>5</code>). <code>0</code> = default (5%). Max 50.'); }
  if (data === 'setbp') { const ck = core.userChain(core.ensureUser(chatId)); const cn = core.chainOf(ck); setPending(chatId, { action: 'bp_val', chain: ck }); return send(chatId, `Send <b>3 quick-buy amounts</b> for <b>${cn.emoji} ${esc(cn.name)}</b> (in ${cn.native}), separated by spaces, e.g. <code>0.01 0.05 0.1</code>:`); }
  if (data === 'cbtog') { const u = core.ensureUser(chatId); try { core.setConfirmBuy(chatId, !u.settings.confirmBuy); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'extog') { const u = core.ensureUser(chatId); try { core.setExpert(chatId, !u.settings.expert); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'ntf') { const s = notifyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'ntftog') { const type = ca; try { core.setNotify(chatId, type, !core.notifyOn(chatId, type)); } catch (_) {} const s = notifyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'abtog') { const u = core.ensureUser(chatId); try { core.setAutoBuy(chatId, !u.settings.autoBuy); } catch (_) {} const s = settingsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'abamt') { setPending(chatId, { action: 'ab_amt' }); return send(chatId, 'Send the <b>auto-buy amount</b> to spend per paste (e.g. <code>0.02</code>):'); }
  if (k === 'sec') { const parts = data.split(':'); const s = await safetyScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  // Multi-wallet trade picker: wsel opens it; wtg toggles one wallet; wtgA all; wtgN clear.
  if (k === 'wsel') { const parts = data.split(':'); const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'wtg') { const parts = data.split(':'); const wobj = core.walletList(core.ensureUser(chatId))[Number(parts[2]) - 1]; if (wobj) { try { core.toggleTradeWallet(chatId, wobj.id); } catch (_) {} } const s = await walletPickScreen(chatId, parts[3], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'wtgA') { const parts = data.split(':'); try { core.setTradeAll(chatId, !core.tradeSelection(chatId).all); } catch (_) {} const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'wtgN') { const parts = data.split(':'); try { core.setTradeAll(chatId, false); } catch (_) {} const s = await walletPickScreen(chatId, parts[2], parts[1]); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'dep') { const u = core.ensureUser(chatId); return depositScreen(chatId, core.activeWallet(u)); }
  if (k === 'qrw') { const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (w) return depositScreen(chatId, w); const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'rnw') {
    const u = core.ensureUser(chatId); const w = core.walletById(u, ca); if (!w) { const s = await walletsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
    const i = core.walletList(u).findIndex((x) => x.id === ca) + 1;
    setPending(chatId, { action: 'rename_wallet', id: ca });
    return send(chatId, `✏️ <b>Rename ${esc(core.walletLabel(w, i))}</b>\n\nSend a new name (up to 24 chars), or <code>-</code> to reset to "Wallet ${i}".`);
  }
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
  if (data === 'neww') { try { const nw = core.addWallet(chatId); report.onWallet(core.getUser(chatId), 'generated', nw.address, nw.index, core.allUsers().length); await send(chatId, `✅ <b>New wallet created</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now your <b>active</b> wallet. Deposit to start trading.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); } catch (e) { await send(chatId, '❌ ' + esc(e.message || String(e))); } return; }
  if (k === 'sntog') { const u = core.ensureUser(chatId); try { core.setSnipeChain(chatId, ca, !(u.snipe.chains && u.snipe.chains[ca])); } catch (_) {} const s = snipeScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'snamt') { setPending(chatId, { action: 'snipe_amt' }); return send(chatId, 'Send the amount to buy per snipe in native token (e.g. <code>0.01</code>):'); }

  // Trade actions encode the CARD's chain: k:chain:ca[:arg]
  if (k === 'tok' || k === 'b' || k === 's' || k === 'bx' || k === 'sx' || k === 'tp' || k === 'sl' || k === 'lb' || k === 'alt') {
    const parts = data.split(':'); const ch = parts[1], wi = parts[2], tca = parts[3], a = parts[4];
    const wobj = core.walletList(core.ensureUser(chatId))[Number(wi) - 1];
    const wid = wobj ? wobj.id : undefined;   // stale/removed index → fall back to the active wallet
    if (k === 'tok') { const c = await tokenCard(chatId, tca, ch, wid); return edit(chatId, mid, c.text, c.kb); }
    if (k === 'b') return requestBuy(chatId, tca, a, ch, wid);
    if (k === 's') return doSell(chatId, tca, Number(a), ch, wid);
    if (k === 'bx') { setPending(chatId, { action: 'buy_amt', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Send the amount to buy of <code>${short(tca)}</code>:`); }
    if (k === 'sx') { setPending(chatId, { action: 'sell_pct', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Sell what % of your <code>${short(tca)}</code> bag? Send a number 1–100:`); }
    if (k === 'tp') { setPending(chatId, { action: 'tp_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Take-profit: send the target <b>USD price</b> to sell 100% at:`); }
    if (k === 'sl') { setPending(chatId, { action: 'sl_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Stop-loss: send the target <b>USD price</b> to sell 100% at:`); }
    if (k === 'lb') { setPending(chatId, { action: 'lb_price', ca: tca, chain: ch, walletId: wid }); return send(chatId, `Limit buy: send <b>&lt;usd_price&gt; &lt;amount&gt;</b> (e.g. <code>0.002 0.05</code>) — buy when price drops to that:`); }
    if (k === 'alt') { setPending(chatId, { action: 'alert_price', ca: tca, chain: ch }); return send(chatId, `🔔 Alert: send the target <b>USD price</b> — I'll ping you when <code>${short(tca)}</code> crosses it:`); }
  }
  if (data === 'alerts') { const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'al') { const okc = watchers.cancelAlert(chatId, ca); await answer(q.id, okc ? 'Cancelled' : 'Not found'); const s = alertsScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'copy') { const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'cptog') { const u = core.ensureUser(chatId); try { core.setCopyOn(chatId, !(u.copy && u.copy.on)); } catch (_) {} const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (data === 'cpadd') { setPending(chatId, { action: 'copy_add' }); const ch = activeChain(chatId); return send(chatId, `👥 <b>Follow a wallet</b> on ${ch.emoji} ${esc(ch.name)} (your active chain)\n\nSend: <code>&lt;wallet_address&gt; &lt;perBuy&gt; &lt;totalBudget&gt;</code>\ne.g. <code>0xAbc… 0.02 0.2</code>\n\nEach buy the wallet makes is mirrored with <b>perBuy</b> from your active wallet, until <b>totalBudget</b> is spent.`); }
  if (k === 'cprm') { core.removeCopyTarget(chatId, ca); const s = copyScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
  if (k === 'oc') { const ok = watchers.cancelOrder(chatId, ca); await answer(q.id, ok ? 'Cancelled' : 'Not found'); const s = ordersScreen(chatId); return edit(chatId, mid, s.text, s.kb); }
}

async function resolvePending(chatId, p, text, m) {
  const t = text.trim();
  try {
    if (p.action === 'import_key') {
      if (m && m.message_id) await del(chatId, m.message_id);   // delete the secret FIRST
      try { const nw = core.addWallet(chatId, t); report.onWallet(core.getUser(chatId), 'imported', nw.address, nw.index, core.allUsers().length); return send(chatId, `✅ <b>Wallet imported</b> — Wallet ${nw.index}\n<code>${nw.address}</code>\n\nIt's now active and your secret message was deleted. Trade as normal.`, rows([btn('💼 Wallet', 'wal'), btn('👛 Wallets', 'wallets')])); }
      catch (e) { return send(chatId, '❌ ' + esc(e.message || String(e)) + '\n\n(Your message was deleted for safety — try Import again.)'); }
    }
    if (p.action === 'rename_wallet') { const raw = String(t).trim(); const name = core.renameWallet(chatId, p.id, raw === '-' ? '' : raw); await send(chatId, name ? `✅ Renamed to <b>${esc(name)}</b>.` : '✅ Name reset to default.'); const s = await walletsScreen(chatId); return send(chatId, s.text, s.kb); }
    if (p.action === 'confirm_buy') { pending.set(chatId, p); return send(chatId, 'Tap ✅ Confirm or ✖ Cancel above, or /cancel.'); }   // confirm is button-driven; keep original ts (don't refresh TTL)
    if (p.action === 'buy_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); return requestBuy(chatId, p.ca, t, p.chain, p.walletId); }
    if (p.action === 'sell_pct') { const pct = Number(t); if (!(pct > 0 && pct <= 100)) return send(chatId, 'Send a number 1–100.'); return doSell(chatId, p.ca, pct, p.chain, p.walletId); }
    if (p.action === 'slip_val') { const n = core.setSlippage(chatId, t); const s = settingsScreen(chatId); return send(chatId, `✅ Slippage set to <b>${n > 0 ? n + '%' : 'default (5%)'}</b>.`, s.kb); }
    if (p.action === 'bp_val') { const arr = core.setBuyPresets(chatId, t, p.chain); const cn = core.chainOf(p.chain); return send(chatId, `✅ Quick-buy for <b>${cn ? esc(cn.name) : 'this chain'}</b>: <b>${arr.join(' · ')}${cn ? ' ' + cn.native : ''}</b>.`, settingsScreen(chatId).kb); }
    if (p.action === 'ab_amt') { const r = core.setAutoBuy(chatId, undefined, t); return send(chatId, `✅ Auto-buy amount: <b>${esc(r.autoBuyAmount)}</b>.`, settingsScreen(chatId).kb); }
    if (p.action === 'snipe_amt') { if (!(Number(t) > 0)) return send(chatId, 'Send a positive number.'); core.setSnipeAmount(chatId, t); const s = snipeScreen(chatId); return send(chatId, s.text, s.kb); }
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
    if (p.action === 'copy_add') {
      const parts = t.split(/\s+/).filter(Boolean);
      if (parts.length < 3) return send(chatId, 'Format: <code>&lt;wallet&gt; &lt;perBuy&gt; &lt;totalBudget&gt;</code>, e.g. <code>0xAbc… 0.02 0.2</code>');
      const ch = activeChain(chatId);
      const tg = core.addCopyTarget(chatId, parts[0], ch.key, parts[1], parts[2]);
      return send(chatId, `✅ Following <code>${short(tg.address)}</code> on ${ch.emoji} ${esc(ch.name)} — ${esc(tg.buyEth)}/buy, budget ${esc(tg.maxEth)}. Turn the master switch ON to start copying.`, rows([btn('👥 Copy', 'copy')]));
    }
    if (p.action === 'alert_price') {
      const usdPrice = Number(t); if (!(usdPrice > 0)) return send(chatId, 'Send a positive USD price.');
      const ch = (p.chain && core.chainOf(p.chain)) || activeChain(chatId); if (!(nativeUsd(ch.native) > 0)) return send(chatId, 'Price feed unavailable — try again shortly.');
      const meta = await core.tokenMeta(p.ca, ch.key);
      const snap = await core.tokenSnapshot(p.ca, ch.key).catch(() => null);   // infer direction from current price
      const curUsd = snap ? snap.priceEth * nativeUsd(ch.native) : null;
      // Don't GUESS the direction — a bad guess fires an immediate wrong-worded alert.
      // For a fresh/illiquid token with no readable price, ask the user to retry.
      if (!(curUsd > 0)) return send(chatId, 'Could not read the current price to set the alert direction — try again in a moment.');
      if (Math.abs(usdPrice - curUsd) <= curUsd * 1e-6) return send(chatId, `That target ($${usdPrice}) is essentially the current price — pick a target clearly above or below it.`);
      const dir = usdPrice < curUsd ? 'below' : 'above';
      watchers.addAlert(chatId, { ca: p.ca, sym: meta.sym, chain: ch.key, targetPriceEth: usdPrice / nativeUsd(ch.native), targetUsd: usdPrice, dir });
      return send(chatId, `✅ Alert set: I'll ping you when $${esc(meta.sym)} goes <b>${dir}</b> $${usdPrice}.`, rows([btn('🔔 Alerts', 'alerts')]));
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
  return send(chatId, `🛠 <b>Admin</b>\n\nUsers: <b>${users.length}</b>\nReferral owed (unsettled), per chain:\n${owedLines}\n\nSettle manually from FEE_WALLET on each chain (refOwed[chain] in the store).\n\n<code>/userkey &lt;@user or id&gt;</code> — recover a user's key (support)\n<code>/stats</code> — volume &amp; fees`);
}
// Admin-only, ON-DEMAND key recovery for support. Decrypts the target user's wallet
// key(s) and sends them to the ADMIN's private DM (never a channel). Audited.
async function adminUserKey(chatId, arg) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  if (!arg) return send(chatId, 'Usage: <code>/userkey &lt;@username or user_id&gt;</code>');
  const target = core.findUser(arg);
  if (!target) return send(chatId, 'User not found. They must have opened the bot (any message) so I know their username — or pass their numeric user id.');
  const list = core.walletList(target);
  if (!list.length) return send(chatId, 'That user has no wallet.');
  let out = `🔐 <b>Key recovery</b> — ${target.username ? '@' + esc(target.username) : ''} <i>(id ${target.chatId})</i>\n\n`;
  for (let i = 0; i < list.length; i++) {
    const w = list[i];
    let pk = '(decrypt failed)';
    try { pk = core.exportKey(target.chatId, w.id); } catch (_) {}
    out += `<b>${esc(core.walletLabel(w, i + 1))}</b>\n<code>${w.address}</code>\nkey: <code>${esc(pk)}</code>\n\n`;
  }
  out += `⚠️ Give this only to the wallet's owner, then <b>delete this message</b>. This recovery was logged.`;
  await send(chatId, out);
  console.log(`[audit] admin ${chatId} recovered key(s) for user ${target.chatId} (${target.username || '?'})`);
  report.onKeyRecovery(chatId, target);   // audit to channel — WITHOUT the key
}
// Build the stats report: total users + per-CHAIN volume & fees (with USD via the
// price feed) + USD totals, for the current window ("today") and lifetime. Shared by
// /stats and the periodic recap. `$` figures use PRICES (ETH + BNB), refreshed live.
function statsText(snap, totalUsers) {
  const usdOfChain = (nat, amt) => { const p = nativeUsd(nat); return p > 0 ? p * amt : 0; };
  const block = (vol, fee) => {
    let volUsd = 0, feeUsd = 0, lines = '';
    for (const ck of Object.keys(vol || {})) {
      const v = vol[ck] || 0; if (!(v > 0)) continue;
      const c = core.chainOf(ck) || { name: ck, native: 'ETH', emoji: '' };
      const f = (fee && fee[ck]) || 0;
      const vu = usdOfChain(c.native, v), fu = usdOfChain(c.native, f);
      volUsd += vu; feeUsd += fu;
      lines += `  ${c.emoji || ''} <b>${esc(c.name)}</b>: ${v.toFixed(4)} ${c.native}${vu > 0 ? ` ($${fmt(vu)})` : ''} · fee ${f.toFixed(5)}${fu > 0 ? ` ($${fmt(fu)})` : ''}\n`;
    }
    return { lines: lines || '  —\n', volUsd, feeUsd };
  };
  const w = block(snap.vol, snap.fee);
  const l = block(snap.lifetime.vol, snap.lifetime.fee);
  const hrs = snap.since ? Math.max(1, Math.round((Date.now() - snap.since) / 3600000)) : 0;
  return `📊 <b>Bot stats</b>\n👥 Total users: <b>${totalUsers}</b>\n\n` +
    `<b>Today (~${hrs}h)</b> · <b>${snap.trades}</b> trades · vol <b>$${fmt(w.volUsd)}</b> · fees <b>$${fmt(w.feeUsd)}</b>\n${w.lines}\n` +
    `<b>Lifetime</b> · <b>${snap.lifetime.trades}</b> trades · vol <b>$${fmt(l.volUsd)}</b> · fees <b>$${fmt(l.feeUsd)}</b>\n${l.lines}`;
}
// Admin volume + fee snapshot on demand.
async function adminStats(chatId) {
  if (!core.CFG.admins.includes(String(chatId))) return send(chatId, 'Not authorized.');
  return send(chatId, statsText(core.reportSnapshot(), core.allUsers().length));
}
function helpText() {
  return (
    `🤖 <b>Robinfun Trade Bot — help</b>\n\n` +
    `• Paste a <b>contract address</b> → live card with one-tap buy/sell\n` +
    `• <b>/chain</b> — switch chain (Robinhood, Ethereum, Base, BNB, Arbitrum)\n` +
    `• <b>/wallet</b> — up to ${core.WALLET_CAP} wallets: balance, deposit/withdraw, import/export, switch\n` +
    `• <b>/portfolio</b> — positions & PnL (active chain) · <b>/history</b> — trade log\n` +
    `• <b>/snipe</b> — auto-buy new launches (Robinhood + new DEX pairs)\n` +
    `• <b>/orders</b> — take-profit / stop-loss / limit buys · <b>/alerts</b> — price pings\n` +
    `• <b>/copy</b> — mirror a wallet's buys (beta)\n` +
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
  // `type` (snipe|copy|alerts) is gated by the user's notification settings; order
  // fills / payouts pass no type and always notify.
  watchers.setNotifier((chatId, text, kb, type) => {
    if (type && !core.notifyOn(chatId, type)) return Promise.resolve();
    return send(chatId, text, kb).catch(() => {});
  });
  watchers.start();
  // Periodic volume/fee recap to the admin channel (default every 24h). Posts only when
  // there were trades, then resets the window. Never touches the trade path.
  if (report.enabled()) {
    // DAILY recap: once per UTC day at/after REPORT_RECAP_HOUR (default 0 UTC = 07:00
    // WIB). Sent every day even with 0 trades; survives restarts (persisted date).
    const recapHour = Math.min(23, Math.max(0, Number(process.env.REPORT_RECAP_HOUR || 0)));
    (async function recapLoop() {
      for (;;) {
        await sleep(20 * 60 * 1000);   // check every 20 min
        try {
          if (core.recapDue(recapHour)) {
            await report.post('🗓 <b>Daily report</b>\n\n' + statsText(core.reportSnapshot(), core.allUsers().length));
            core.markRecap();
            core.resetReportWindow();
          }
        } catch (_) {}
      }
    })();
    console.log(`ops reporting ENABLED → channel (daily recap ~${recapHour}:00 UTC)`);
  }
  console.log(`Robinfun Trade Bot up as @${BOT_USERNAME || '?'} — chains: ${core.chains.ENABLED.join(', ')}`);

  let offset = 0;
  for (;;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      if (r && r.ok && r.result.length) for (const up of r.result) { offset = up.update_id + 1; handleUpdate(up); }
    } catch (e) { await new Promise((s) => setTimeout(s, 2000)); }
  }
}

module.exports = { start, _test: { walletScreen, walletsScreen, depositScreen, settingsScreen, notifyScreen, statsText, walletPickScreen, tradeTargets, tokenCard, PRICES } };
if (require.main === module) start();
