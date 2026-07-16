#!/usr/bin/env node
/*
 * Robinfun seeder — Telegram control bot.
 *
 * Control the seeder from Telegram: see the deployer wallets to fund, /go,
 * /stop, /status, /stats (tokens created + market cap), /last (MC history),
 * live config, /allowlist, /sweep. Uses long-polling (getUpdates) so it works
 * behind a firewall — no webhook / open port needed. Inline buttons included.
 *
 * Setup (seeder/.env, git-ignored):
 *   TELEGRAM_TOKEN=123456:ABC...     ← from @BotFather (revoke + regenerate if leaked)
 *   TELEGRAM_ADMIN_IDS=              ← optional; blank = first messager claims admin
 *
 * Run:  node telegram.js   (or via deploy/bootstrap-seeder-tg.sh under pm2)
 */
'use strict';
const fs = require('fs');
const {
  ethers, CFG, FACTORY_ABI, makeProvider, loadOrCreateWallets,
  launchWith, readDeployFee, checkBeta, sweepAll, fmt, sleep, ethUsd, tokenStats,
  makeL1Provider, verifyInbox, bridgeOne, botBuy, botSell, seedVolume, sellHoldings, sellAllHoldings, randEthStr,
  creatorEarnings, claimCreator, protocolPending, treasuryInfo, tokenBalance, detectDeposits, walletCashflow,
  creatorOwedTotal, ownedTokens, tokenPnl, reactToBuys, gasOverrides, capGuard,
} = require('./core');

if (!CFG.tgToken) {
  console.error('Missing TELEGRAM_TOKEN. Put  TELEGRAM_TOKEN=...  in seeder/.env (from @BotFather).');
  process.exit(1);
}
const API = `https://api.telegram.org/bot${CFG.tgToken}`;
const START = Date.now();

// ---------------- persisted state ----------------
const state = {
  admins: CFG.tgAdmins.slice(),
  running: false,
  launched: 0,
  last: [],
  cfg: { devBuyEth: CFG.devBuyEth, intervalSec: CFG.intervalSec, levyBps: CFG.levyBps, maxTokens: CFG.maxTokens },
  l1seen: {}, // per-wallet last-seen L1 balance (decimal string) — survives restarts
  deposited: 0, // total ETH the user says they funded the bot with (for /pnl loss calc)
  spent: 0,     // cumulative ETH spent by the bot (deploy + buys) — auto-tracked
  react: {},    // react-to-buy checkpoint per token { [ca]: { last: block, hits: n } }
};
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    Object.assign(state, s);
    if (!Array.isArray(state.admins)) state.admins = [];
    if (!Array.isArray(state.last)) state.last = [];
    if (!state.l1seen || typeof state.l1seen !== 'object') state.l1seen = {};
    if (!state.react || typeof state.react !== 'object') state.react = {};
    if (!state.cfg) state.cfg = { devBuyEth: CFG.devBuyEth, intervalSec: CFG.intervalSec, levyBps: CFG.levyBps, maxTokens: CFG.maxTokens };
    if (CFG.tgAdmins.length) state.admins = Array.from(new Set([...state.admins.map(String), ...CFG.tgAdmins.map(String)]));
  } catch (_) {}
}
function saveState() { try { fs.writeFileSync(CFG.stateFile, JSON.stringify(state, null, 2)); fs.chmodSync(CFG.stateFile, 0o600); } catch (_) {} }
function applyCfg() {
  CFG.devBuyEth = String(state.cfg.devBuyEth);
  CFG.intervalSec = Math.max(5, Number(state.cfg.intervalSec) || 60);
  CFG.levyBps = Math.min(1000, Math.max(0, Number(state.cfg.levyBps) || 0));
  CFG.maxTokens = Math.max(0, Number(state.cfg.maxTokens) || 0);
  // Newer knobs — keep the env/CFG value when the (older) state has no entry.
  if (state.cfg.buyLevyBps !== undefined) CFG.buyLevyBps = Math.min(1000, Math.max(0, Number(state.cfg.buyLevyBps) || 0));
  if (state.cfg.sellLevyBps !== undefined) CFG.sellLevyBps = Math.min(1000, Math.max(0, Number(state.cfg.sellLevyBps) || 0));
  if (state.cfg.autoBuyEth !== undefined) CFG.autoBuyEth = String(state.cfg.autoBuyEth);
  if (state.cfg.autoSellPct !== undefined) CFG.autoSellPct = Math.min(100, Math.max(0, Number(state.cfg.autoSellPct) || 0));
  if (state.cfg.peerBuyers !== undefined) CFG.peerBuyers = Math.min(20, Math.max(0, Number(state.cfg.peerBuyers) || 0));
  if (state.cfg.peerBuyEth !== undefined) CFG.peerBuyEth = String(state.cfg.peerBuyEth);
  if (state.cfg.sellAfterSec !== undefined) CFG.sellAfterSec = Math.max(0, Number(state.cfg.sellAfterSec) || 0);
  if (state.cfg.sellPct !== undefined) CFG.sellPct = Math.min(100, Math.max(0, Number(state.cfg.sellPct) || 0));
  if (state.cfg.autoSaleOn !== undefined) CFG.autoSaleOn = !!state.cfg.autoSaleOn;
  if (state.cfg.autoSaleEverySec !== undefined) CFG.autoSaleEverySec = Math.max(30, Number(state.cfg.autoSaleEverySec) || 600);
  if (state.cfg.autoSalePct !== undefined) CFG.autoSalePct = Math.min(100, Math.max(1, Number(state.cfg.autoSalePct) || 100));
  if (state.cfg.reactOn !== undefined) CFG.reactOn = !!state.cfg.reactOn;
  if (state.cfg.reactEverySec !== undefined) CFG.reactEverySec = Math.max(20, Number(state.cfg.reactEverySec) || 45);
  if (state.cfg.reactMinUsd !== undefined) CFG.reactMinUsd = Math.max(1, Number(state.cfg.reactMinUsd) || 15);
  if (state.cfg.reactSellPct !== undefined) CFG.reactSellPct = Math.min(100, Math.max(1, Number(state.cfg.reactSellPct) || 25));
  if (state.cfg.reactMaxCount !== undefined) CFG.reactMaxCount = Math.max(1, Number(state.cfg.reactMaxCount) || 3);
  if (state.cfg.gasGwei !== undefined) CFG.gasGwei = Math.max(0, Number(state.cfg.gasGwei) || 0);
  if (state.cfg.gasMode !== undefined) CFG.gasMode = ['cheap', 'fixed', 'auto'].includes(String(state.cfg.gasMode)) ? String(state.cfg.gasMode) : 'cheap';
  if (state.cfg.capGuardOn !== undefined) CFG.capGuardOn = !!state.cfg.capGuardOn;
  if (state.cfg.capCeilingEth !== undefined) CFG.capCeilingEth = Math.max(0.1, Number(state.cfg.capCeilingEth) || 2.0);
  ['devBuyMin', 'devBuyMax', 'peerBuyMin', 'peerBuyMax'].forEach((k) => { if (state.cfg[k] !== undefined) CFG[k] = String(state.cfg[k]); });
}
loadState(); applyCfg();

// ---------------- telegram helpers ----------------
async function tg(method, params) {
  try {
    const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(65000) });
    return await r.json();
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtUsd = (n) => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : '$' + n.toFixed(0);
const ethShort = (wei) => { const n = Number(ethers.formatEther(wei)); return n === 0 ? '0' : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); };
const usdOf = (wei, usd) => { if (!usd) return ''; const v = Number(ethers.formatEther(wei)) * usd; return ` (${v >= 1000 ? fmtUsd(v) : '$' + v.toFixed(2)})`; };
async function send(chatId, text, extra) { return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); }
async function broadcast(text, extra) { for (const id of state.admins) { await send(id, text, extra); } }
async function answerCb(id, text) { return tg('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); }

// Detailed, chunked sale report (own module so it's unit-testable without booting the bot).
const { renderSaleReport } = require('./salereport');
const isAdmin = (id) => state.admins.map(String).includes(String(id));
function menu() {
  return { reply_markup: { inline_keyboard: [
    [{ text: state.running ? '⏸️ Stop' : '▶️ Go', callback_data: state.running ? 'stop' : 'go' }, { text: '📊 Status', callback_data: 'status' }],
    [{ text: '💰 Wallets', callback_data: 'wallets' }, { text: '🌉 Bridge', callback_data: 'bridge' }],
    [{ text: '📈 Stats', callback_data: 'stats' }, { text: '🆕 History (MC)', callback_data: 'last' }],
  ] } };
}

// ---------------- shared runtime ----------------
const provider = makeProvider();
const l1 = makeL1Provider(); // Ethereum mainnet (parent chain) for bridge deposits
const wallets = loadOrCreateWallets(provider);
const funder = /^0x[0-9a-fA-F]{64}$/.test(CFG.funderKey) ? new ethers.Wallet(CFG.funderKey, provider) : null;
const factoryRead = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);
const gasBuf = ethers.parseEther('0.0006');
const balances = () => Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => 0n)));
const l1Balances = () => l1 ? Promise.all(wallets.map((w) => l1.getBalance(w.address).catch(() => 0n))) : Promise.resolve(null);

const HELP = `<b>🤖 Robinfun Seeder Bot</b>
Bot bikin ${wallets.length} wallet sendiri. Isi ETH → (bridge) → /go.

<b>/wallets</b> — alamat + saldo di Robinhood Chain & Ethereum L1
<b>/bridge</b> — pindah ETH dari Ethereum L1 → Robinhood Chain
<b>/keys</b> — 🔑 private key wallet (RAHASIA)
<b>/buy</b> 0xCA 0.01 — bot beli token (dorong ke graduated)
<b>/sell</b> 0xCA 50 — bot jual 50% token
<b>/earnings</b> — 💸 reward creator (levy fee) yg belum diklaim
<b>/claim</b> — 💸 klaim SEMUA reward creator ke wallet
<b>/autosale on|off</b> — 🔻 auto-jual holding di SEMUA token berkala
<b>/dumpall</b> [%] — 🔻 jual SEKARANG semua token dari semua wallet
<b>/pnl</b> — 📊 rugi/untung (saldo + treasury + fee)
<b>/pnltoken</b> — 📊 rugi PER TOKEN (wallet mana beli apa)
<b>/setdeposit</b> 1.0 — 📥 catat total ETH yang kamu setor
<b>/go</b> · <b>/stop</b> — mulai / berhenti auto-launch
<b>/status</b> — status seeder + saldo
<b>/stats</b> — jumlah token dibuat + total market cap
<b>/last</b> — history token terakhir + MC per token
<b>/config</b> — lihat setelan
<b>/allowlist</b> — cek/allowlist wallet (mode beta)
<b>/sweep 0x…</b> — tarik ETH sisa ke wallet-mu

<b>Atur setelan:</b>
/devbuy 0.001 · /interval 60 · /max 0
/buyfee 100 · /sellfee 100 · /levy 100 (set dua-duanya)
/autobuy 0.02 · /autosell 30  (wallet launcher beli/jual sendiri)
/peerbuyers 3  (jml wallet LAIN yg otomatis beli → volume + banyak holder)
/peerrange 0.001 0.01  (tiap wallet beli ACAK 0.001–0.01 ETH) · /peerbuy = fixed
/devrange 0.001 0.005  (dev-buy ACAK) · /devbuy = fixed
/sellafter 300 · /sellpct 50  (jual otomatis setelah 300s; 0=off)
/autosale on · /autosalepct 100 · /autosaleevery 600  (auto-jual berkala SEMUA token)

Alur: <b>/wallets → kirim ETH (L1) → /bridge → /go</b> ✅`;

// Cached per-wallet token counts (enumerating all factory tokens is heavy, so we
// refresh in the background and show the last-known count — first /wallets may
// show "…" until the first refresh lands).
let _ownedCache = { at: 0, rows: null, promise: null };
async function ownedCached() {
  if (_ownedCache.rows && Date.now() - _ownedCache.at < 180000) return _ownedCache.rows;
  // Dedupe concurrent scans: /wallets (fire-and-forget) and /earnings (awaited) share
  // ONE in-flight scan of the whole factory instead of each launching its own — the
  // scan reads creator()+owed() for every token on the factory, so doing it twice at
  // once is what made /earnings sit on "Cek reward creator…" for minutes.
  if (!_ownedCache.promise) {
    _ownedCache.promise = (async () => {
      try { const r = await ownedTokens(provider, wallets); _ownedCache.rows = r; _ownedCache.at = Date.now(); return r; }
      catch (_) { return _ownedCache.rows || []; }
      finally { _ownedCache.promise = null; }
    })();
  }
  return _ownedCache.promise;
}
async function walletsMsg() {
  const [l2bals, l1bals, usd] = await Promise.all([balances(), l1Balances(), ethUsd()]);
  ownedCached();   // fire-and-forget refresh; use whatever's cached now
  const counts = {};
  for (const r of (_ownedCache.rows || [])) { const k = String(r.creator).toLowerCase(); counts[k] = (counts[k] || 0) + 1; }
  let t = `<b>💰 Deployer wallets (${wallets.length})</b>\nKirim ETH ke alamat berikut:\n`;
  let tL2 = 0n, tL1 = 0n;
  wallets.forEach((w, i) => {
    const b2 = l2bals[i]; tL2 += b2;
    const nTok = counts[w.address.toLowerCase()];
    const tokTxt = _ownedCache.rows ? `🪙 ${nTok || 0} token` : '🪙 …';
    let line = `\n<code>${w.address}</code>\n   🟣 RH: ${ethShort(b2)} ETH${usdOf(b2, usd)} · ${tokTxt}`;
    if (l1bals) { const b1 = l1bals[i]; tL1 += b1; line += ` · ⟠ L1: ${ethShort(b1)} ETH${usdOf(b1, usd)}${b1 > 0n ? ' 🌉' : ''}`; }
    t += line;
  });
  t += `\n\n<b>Total RH: ${ethShort(tL2)} ETH${usdOf(tL2, usd)}</b>`;
  if (l1bals) t += `\n<b>Total L1: ${ethShort(tL1)} ETH${usdOf(tL1, usd)}</b>\n🌉 = ada ETH di Ethereum → /bridge ke Robinhood Chain`;
  t += `\n\n🔑 /keys · 📊 /pnltoken (rugi per token) · harga ETH ${usd ? fmtUsd(usd) : '—'}`;
  return t;
}

function keysMsg() {
  let t = `🔑 <b>PRIVATE KEY deployer wallets</b>\n⚠️ RAHASIA. Siapa pun yang punya ini bisa kuras dompetnya. Jangan share, dan HAPUS pesan ini setelah dicatat/di-import.\n`;
  wallets.forEach((w, i) => { t += `\n${i + 1}. <code>${w.address}</code>\n<tg-spoiler><code>${w.privateKey}</code></tg-spoiler>`; });
  return t;
}

async function bridgeMsg() {
  if (!l1) return '⚠️ <b>L1_RPC belum aktif.</b> Set <code>L1_RPC</code> di seeder/.env untuk deteksi + bridge ETH dari Ethereum.';
  const [l1bals, usd] = await Promise.all([l1Balances(), ethUsd()]);
  const min = ethers.parseEther(CFG.bridgeMinEth);
  const inboxSet = ethers.isAddress(CFG.l1InboxAddr);
  const ver = inboxSet ? await verifyInbox(l1, CFG.l1InboxAddr) : { ok: false, reason: 'belum di-set' };
  let ready = 0, totalReady = 0n;
  let rows = '';
  wallets.forEach((w, i) => {
    const b = l1bals[i];
    if (b >= min) { ready++; totalReady += b; }
    rows += `<code>${w.address.slice(0, 12)}…</code>  ⟠ ${ethShort(b)} ETH${usdOf(b, usd)} ${b >= min ? '✅ siap' : '—'}\n`;
  });
  let t = `<b>🌉 Bridge ETH → Robinhood Chain</b>\nEthereum L1 → RH Chain lewat <i>depositEth</i> resmi (address sama, ~10–15 menit).\n\n${rows}\nSiap bridge: <b>${ready}/${wallets.length}</b> wallet · ~${ethShort(totalReady)} ETH${usdOf(totalReady, usd)}\n`;
  t += `\nInbox L1: ${inboxSet ? `<code>${CFG.l1InboxAddr}</code>\n${ver.ok ? '✓ kontrak terdeteksi di L1' : '⚠️ ' + esc(ver.reason)}` : '❌ <b>belum di-set</b>'}\n`;
  if (!inboxSet) {
    t += `\n⚠️ <b>WAJIB set alamat Inbox resmi dulu.</b> Ambil dari <b>docs.robinhood.com/chain/protocol-contracts/</b>, verifikasi di Etherscan/Blockscout, lalu:\n<code>echo 'L1_INBOX_ADDR=0x...' >> seeder/.env</code> lalu <code>pm2 restart robinfun-seeder-bot</code>.\n\n🚫 JANGAN pakai alamat dari sumber tak resmi (robinhood-bridge.app / robinbridge.xyz = <b>scam</b>). Salah alamat = ETH hilang permanen.`;
  } else if (!ver.ok) {
    t += `\n⚠️ Inbox tidak lolos verifikasi — bridge dinonaktifkan demi keamanan. Cek lagi alamatnya.`;
  } else if (ready) {
    t += `\nTekan <b>🌉 Bridge semua</b> untuk memindahkan ETH wallet yang siap.`;
  } else {
    t += `\nBelum ada ETH di L1. Kirim ETH (jaringan Ethereum) ke address di /wallets dulu.`;
  }
  return t;
}
function bridgeMenu() {
  const canGo = ethers.isAddress(CFG.l1InboxAddr);
  return { reply_markup: { inline_keyboard: [[
    canGo ? { text: '🌉 Bridge semua', callback_data: 'bridge_go' } : { text: 'ℹ️ Cara set Inbox', callback_data: 'bridge_help' },
    { text: '🔄 Refresh', callback_data: 'bridge' },
  ]] } };
}
const BRIDGE_HELP = `<b>ℹ️ Cara mengaktifkan bridge</b>
1. Buka <b>docs.robinhood.com/chain/protocol-contracts/</b> → cari alamat <b>Inbox</b> (di Ethereum L1).
2. Verifikasi alamat itu di blockscout/etherscan (pastikan kontrak resmi).
3. Di VPS:
<code>echo 'L1_INBOX_ADDR=0xALAMAT_INBOX' >> /opt/robinfun/seeder/.env
pm2 restart robinfun-seeder-bot</code>
4. Balik ke /bridge → tombol "🌉 Bridge semua" akan aktif.

🚫 Jangan percaya alamat dari situs non-resmi. Salah Inbox = ETH hilang.`;

// Guard: never run two bridge passes at once (double-spend / nonce clash). Same
// stale-lock TTL as the trade lock so a hung bridge pass can't deadlock /bridge forever.
let bridgingSince = 0;
function bridgeBusy() { if (!bridgingSince) return false; if (Date.now() - bridgingSince > TRADE_LOCK_TTL) { bridgingSince = 0; return false; } return true; }
async function doBridgeAll(chatId) {
  if (!l1) { await send(chatId, 'L1_RPC belum aktif.'); return; }
  if (!ethers.isAddress(CFG.l1InboxAddr)) { await send(chatId, 'Inbox belum di-set. Lihat /bridge.'); return; }
  // Claim the lock SYNCHRONOUSLY (before any await) so two rapid taps can't both
  // pass the check — doBridgeAll is now fire-and-forget, so the poll loop no
  // longer serializes it for us.
  if (bridgeBusy()) { await send(chatId, '⏳ Bridge sedang berjalan — tunggu selesai dulu.'); return; }
  bridgingSince = Date.now();
  try {
    const ver = await verifyInbox(l1, CFG.l1InboxAddr);
    if (!ver.ok) { await send(chatId, `⚠️ Inbox gagal verifikasi: ${esc(ver.reason)}. Bridge dibatalkan demi keamanan.`); return; }
    await send(chatId, '🌉 Mulai bridge dari Ethereum L1… (mohon tunggu, jangan spam)');
    let done = 0, skipped = 0, errored = 0;
    for (const w of wallets) {
      const tag = `<code>${w.address.slice(0, 12)}…</code>`;
      try {
        const r = await bridgeOne(w, l1, CFG.l1InboxAddr, CFG.bridgeMinEth);
        if (r.ok && r.pending) { done++; await send(chatId, `⏳ ${tag} deposit terkirim (belum konfirmasi)\ntx L1 <code>${r.hash}</code>\nCek di explorer — JANGAN kirim ulang.`); }
        else if (r.ok && r.unconfirmed) { done++; await send(chatId, `⏳ ${tag} terkirim, konfirmasi RPC gagal: ${esc(r.error)}\ntx L1 <code>${r.hash}</code>\nCek di explorer — JANGAN kirim ulang.`); }
        else if (r.ok) { done++; await send(chatId, `✅ ${tag} bridge <b>${ethShort(r.bridged)} ETH</b>\ntx L1 <code>${r.hash}</code>`); }
        else skipped++;
      } catch (e) { errored++; await send(chatId, `❌ ${tag}: ${esc(e.shortMessage || e.reason || e.message)}`); }
    }
    await send(chatId, done
      ? `Selesai — ${done} wallet di-bridge${skipped ? `, ${skipped} dilewati` : ''}${errored ? `, ${errored} gagal (lihat error di atas)` : ''}. ETH muncul di Robinhood Chain ~10–15 menit, lalu /go untuk deploy.`
      : errored
        ? `Bridge gagal untuk ${errored} wallet — lihat error di atas. Tidak ada ETH yang ter-bridge.`
        : 'Tidak ada wallet dengan cukup ETH di L1 untuk di-bridge.');
  } finally { bridgingSince = 0; }
}

async function statusMsg() {
  const [bals, usd] = await Promise.all([balances(), ethUsd()]);
  const total = bals.reduce((a, b) => a + b, 0n);
  let deployFee = 0n; try { deployFee = await readDeployFee(factoryRead); } catch (_) {}
  const need = deployFee + ethers.parseEther(CFG.devBuyEth) + gasBuf;
  const funded = bals.filter((b) => b >= need).length;
  let beta = '?', allow = '?';
  try { const c = await checkBeta(factoryRead, wallets); beta = c.beta ? 'ON' : 'OFF'; allow = c.missing.length ? `${wallets.length - c.missing.length}/${wallets.length} allowed` : 'semua allowed'; } catch (_) {}
  return `<b>📊 Status</b>
Seeder: ${state.running ? '▶️ ON' : '⏸️ OFF'}
Token dibuat: <b>${state.launched}</b>${CFG.maxTokens ? ` / ${CFG.maxTokens}` : ''}
Wallet ber-ETH: ${funded}/${wallets.length} · total ${ethShort(total)} ETH${usdOf(total, usd)}
betaMode: ${beta} · ${allow}
interval ${CFG.intervalSec}s · dev-buy ${CFG.devBuyEth} ETH · levy ${CFG.levyBps / 100}%
butuh ≥ ${fmt(need)} ETH/wallet untuk 1 launch`;
}

async function lastMsg() {
  if (!state.last.length) return 'Belum ada token yang di-launch. /go dulu.';
  const items = state.last.slice(-10).reverse();
  const usd = await ethUsd();
  const stats = await Promise.all(items.map((t) => tokenStats(t.curve, provider)));
  const rows = items.map((t, i) => {
    const s = stats[i];
    const mcEth = Number(ethers.formatEther(s.mcEth || 0n));
    const mcTxt = `${mcEth.toFixed(4)} ETH${usd ? ` ≈ ${fmtUsd(mcEth * usd)}` : ''}`;
    return `${i + 1}. <b>${esc(t.name)}</b> $${esc(t.ticker)}${s.graduated ? ' 🎓' : ''}\n   MC ${mcTxt}\n   CA <code>${t.ca || '-'}</code>`;
  });
  return `<b>🆕 History — ${items.length} token terakhir</b> (total ${state.launched})\n\n` + rows.join('\n');
}

async function statsMsg() {
  const usd = await ethUsd();
  const sample = state.last.filter((t) => t.curve).slice(-20);
  const stats = await Promise.all(sample.map((t) => tokenStats(t.curve, provider)));
  let totalMc = 0n, grad = 0;
  stats.forEach((s) => { totalMc += (s.mcEth || 0n); if (s.graduated) grad++; });
  const mcEth = Number(ethers.formatEther(totalMc));
  const per = {};
  state.last.forEach((t) => { const k = t.creator || '?'; per[k] = (per[k] || 0) + 1; });
  const perLines = Object.entries(per).map(([a, c]) => `  <code>${a.slice(0, 10)}…</code> ${c}`).join('\n') || '  —';
  const up = Math.floor((Date.now() - START) / 1000);
  const upStr = up >= 3600 ? `${Math.floor(up / 3600)}j ${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m`;
  return `<b>📈 Statistik</b>
Total token dibuat: <b>${state.launched}</b>
Graduated 🎓: ${grad}/${sample.length} (dari ${sample.length} terakhir)
Total MC (${sample.length} terakhir): <b>${mcEth.toFixed(4)} ETH</b>${usd ? ` ≈ ${fmtUsd(mcEth * usd)}` : ''}
Harga ETH: ${usd ? fmtUsd(usd) : '—'}
Seeder: ${state.running ? '▶️ ON' : '⏸️ OFF'} · uptime ${upStr}

<b>Per wallet (dari histori):</b>
${perLines}`;
}

function configMsg() {
  return `<b>⚙️ Config</b>
factory <code>${CFG.factory}</code>
wallets ${wallets.length}
dev-buy ${Number(CFG.devBuyMax) > 0 ? `${CFG.devBuyMin || CFG.devBuyEth}–${CFG.devBuyMax} ETH (acak)` : `${CFG.devBuyEth} ETH`}  <i>(/devbuy /devrange)</i>
interval ${CFG.intervalSec}s  <i>(/interval)</i>
buy fee ${(CFG.buyLevyBps / 100)}%  <i>(/buyfee)</i> · sell fee ${(CFG.sellLevyBps / 100)}%  <i>(/sellfee)</i>
auto-buy ${CFG.autoBuyEth} ETH  <i>(/autobuy)</i> · auto-sell ${CFG.autoSellPct}%  <i>(/autosell)</i>
peer-buy ${CFG.peerBuyers} wallet × ${Number(CFG.peerBuyMax) > 0 ? `${CFG.peerBuyMin || CFG.peerBuyEth}–${CFG.peerBuyMax} ETH (acak)` : `${CFG.peerBuyEth} ETH`}  <i>(/peerbuyers /peerbuy /peerrange)</i>
sell-after ${CFG.sellAfterSec ? CFG.sellAfterSec + 's · ' + CFG.sellPct + '%' : 'off'}  <i>(/sellafter /sellpct)</i>
auto-sale ${CFG.autoSaleOn ? `<b>ON</b> · ${CFG.autoSalePct}% tiap ${CFG.autoSaleEverySec}s` : 'off'}  <i>(/autosale /autosalepct /autosaleevery)</i>
react-buy ${CFG.reactOn ? `<b>ON</b> · pembeli asli ≥$${CFG.reactMinUsd} → jual ${CFG.reactSellPct}% (maks ${CFG.reactMaxCount}×)` : 'off'}  <i>(/react)</i>
anti-graduate ${CFG.capGuardOn ? `<b>ON</b> · pool ≥${CFG.capCeilingEth} ETH → jual semua` : '⚠️ off'}  <i>(/capguard /capmax)</i>
gas ${gasLabel()}  <i>(/gas)</i>
max tokens ${CFG.maxTokens || '∞'}  <i>(/max)</i>
backend ${CFG.backend}
funder ${funder ? 'set (auto allow-list + fund)' : 'none (self-funded)'}`;
}

async function allowlistMsg() {
  let c; try { c = await checkBeta(factoryRead, wallets); } catch (e) { return 'Gagal cek allow-list: ' + esc(e.shortMessage || e.message); }
  if (!c.beta) return '✅ betaMode OFF — semua wallet bisa create. Tinggal isi ETH lalu /go.';
  if (!c.missing.length) return '✅ Semua wallet sudah di-allowlist. Tinggal isi ETH lalu /go.';
  let t = `⚠️ betaMode ON. ${c.missing.length} wallet BELUM di-allowlist (createToken akan revert):\n` + c.missing.map((w) => `<code>${w.address}</code>`).join('\n');
  if (funder && c.owner.toLowerCase() === funder.address.toLowerCase()) {
    try { const tx = await new ethers.Contract(CFG.factory, FACTORY_ABI, funder).setBetaAllowed(c.missing.map((w) => w.address), true); await tx.wait(); return '✅ Sudah di-allowlist otomatis via FUNDER_KEY.'; }
    catch (e) { t += `\n\nGagal auto-allowlist: ${esc(e.shortMessage || e.message)}`; }
  } else {
    t += `\n\nFix di admin panel <b>robinfun.tech</b> → Allow-list → paste alamat → Allow. Atau matikan beta (go public).`;
  }
  return t;
}

async function setCfg(chatId, key, val, ok, label) {
  if (val === undefined || !ok(val)) { await send(chatId, `❌ Nilai tidak valid untuk ${label}.`); return; }
  state.cfg[key] = (key === 'devBuyEth' || key === 'autoBuyEth' || key === 'peerBuyEth') ? String(val) : Number(val);
  applyCfg(); saveState();
  await send(chatId, `✅ ${label} = <b>${state.cfg[key]}</b>`);
}

async function doGo(chatId) {
  if (state.running) { await send(chatId, '▶️ Seeder sudah ON.', menu()); return; }
  state.running = true; saveState();
  await send(chatId, `▶️ <b>Seeder ON</b> — launch tiap ${CFG.intervalSec}s dari wallet yang ada ETH-nya.`, menu());
}
async function doStop(chatId) {
  if (!state.running) { await send(chatId, '⏸️ Seeder sudah OFF.', menu()); return; }
  state.running = false; saveState();
  await send(chatId, '⏸️ <b>Seeder OFF</b> — berhenti launch.', menu());
}

// ---------------- bot trading: buy / sell a token ----------------
// One on-chain trade at a time (avoid nonce clashes across wallets). Timestamp-based
// with a stale-lock TTL: if a trade ever HANGS on an un-timed-out RPC/tx.wait, its
// finally never runs — the old boolean lock would then stay held FOREVER and deadlock
// every command with "Ada trade lain jalan". Auto-releasing a lock held longer than the
// TTL lets the bot recover on its own (worst case a rare nonce retry, never a deadlock).
let tradingSince = 0;                       // ms when the lock was taken (0 = free)
const TRADE_LOCK_TTL = 8 * 60 * 1000;       // held longer than this ⇒ presumed hung ⇒ freed
function tradeBusy() {
  if (!tradingSince) return false;
  if (Date.now() - tradingSince > TRADE_LOCK_TTL) { tradingSince = 0; return false; }
  return true;
}
function lockTrade() { tradingSince = Date.now(); }
function unlockTrade() { tradingSince = 0; }
// User-initiated trades (buttons / commands like /dumpall, /sell, /buy, /claim)
// PREEMPT the background loops. They raise a priority flag — the auto-sale / react /
// guard loops then YIELD instead of grabbing the lock — briefly wait for any in-flight
// op to finish, then take the lock. This is why /dumpall can never be starved forever
// by a slow or stuck background loop (the #1 cause of "Ada trade lain jalan").
let userPriority = 0;
async function takeUserLock(maxWaitMs = 40000) {
  userPriority++;
  const start = Date.now();
  while (tradeBusy() && Date.now() - start < maxWaitMs) await sleep(500);
  lockTrade();   // force-take: loops yield on userPriority, so a lock still held here is a stuck/slow op we intentionally preempt
}
function freeUserLock() { unlockTrade(); if (userPriority > 0) userPriority--; }
async function doBuy(chatId, args) {
  const ca = args[0]; const eth = args[1];
  if (!ca || !ethers.isAddress(ca) || !eth || !(Number(eth) > 0)) { await send(chatId, 'Format: <code>/buy 0xCONTRACT 0.01</code> — beli 0.01 ETH token itu.'); return; }
  await takeUserLock();
  try {
    const need = ethers.parseEther(String(eth)) + gasBuf;
    const bals = await balances();
    const i = bals.findIndex((b) => b >= need);
    if (i < 0) { await send(chatId, `Nggak ada wallet dengan ≥ ${fmt(need)} ETH. Isi ETH dulu (/wallets).`); return; }
    const w = wallets[i];
    await send(chatId, `🟢 BUY ${eth} ETH · <code>${ca.slice(0, 12)}…</code> · dari <code>${w.address.slice(0, 10)}…</code>`);
    const r = await botBuy(w, provider, ca, eth);
    await send(chatId, `✅ Beli di ${r.venue === 'curve' ? 'bonding curve' : 'Uniswap'}${r.pending ? ' (terkirim, belum konfirmasi)' : ''}\ntx <code>${r.hash}</code>`);
  } catch (e) { await send(chatId, `❌ Buy gagal: ${esc(e.shortMessage || e.reason || e.message)}`); }
  finally { freeUserLock(); }
}
async function doSell(chatId, args) {
  const ca = args[0]; const pct = args[1] || '100';
  if (!ca || !ethers.isAddress(ca) || !(Number(pct) > 0 && Number(pct) <= 100)) { await send(chatId, 'Format: <code>/sell 0xCONTRACT 50</code> — jual 50% dari tiap wallet yang punya (default 100%).'); return; }
  await takeUserLock();
  try {
    await send(chatId, `🔴 SELL ${pct}% · <code>${ca.slice(0, 12)}…</code> · dari wallet yang punya…`);
    let done = 0;
    for (const w of wallets) {
      try {
        const r = await botSell(w, provider, ca, pct);
        if (r.skip) continue;
        if (r.ok) { done++; await send(chatId, `✅ ${w.address.slice(0, 10)}… jual di ${r.venue === 'curve' ? 'curve' : 'Uniswap'}${r.pending ? ' (terkirim)' : ''}\ntx <code>${r.hash}</code>`); }
        else if (r.error) { await send(chatId, `❌ ${w.address.slice(0, 10)}…: ${esc(r.error)}${r.retryable ? ' (coba lagi)' : ''}`); }   // botSell now RETURNS errors (no throw) — surface them
      } catch (e) { await send(chatId, `❌ ${w.address.slice(0, 10)}…: ${esc(e.shortMessage || e.reason || e.message)}`); }
    }
    if (!done) await send(chatId, 'Nggak ada wallet yang pegang token ini.');
  } finally { freeUserLock(); }
}

// ---- creator reward (levy fee): view + claim ----
async function doEarnings(chatId) {
  await send(chatId, `⏳ Cek reward creator di SEMUA token (baca chain)…`);
  const rows = (await ownedCached()) || [];   // chain-truth, ALL tokens (not just /last) — shared/cached scan (fast when warm)
  if (!rows.length) { await send(chatId, 'Belum ada token yang dibuat wallet bot.'); return; }
  const usd = await ethUsd();
  const u = (e) => usd ? ` ≈ ${e * usd >= 1 ? fmtUsd(e * usd) : '$' + (e * usd).toFixed(2)}` : '';
  const byCa = new Map(state.last.map((t) => [String(t.ca).toLowerCase(), t]));
  const withOwed = rows.filter((r) => r.owedWei > 0n).map((r) => ({ ca: r.ca, owed: Number(ethers.formatEther(r.owedWei)) })).sort((a, b) => b.owed - a.owed);
  const totOwed = withOwed.reduce((s, r) => s + r.owed, 0);
  const lines = withOwed.slice(0, 20).map((r) => {
    const t = byCa.get(String(r.ca).toLowerCase());
    return `• $${esc((t && t.ticker) || '?')} <code>${r.ca.slice(0, 8)}…</code> — <b>${r.owed.toFixed(6)} ETH</b>${u(r.owed)}`;
  });
  await send(chatId,
    `💸 <b>Reward creator (levy fee)</b>\n` +
    `Total belum diklaim: <b>${totOwed.toFixed(6)} ETH</b>${u(totOwed)}\n` +
    `Token dgn fee: <b>${withOwed.length}</b> dari ${rows.length} token\n` +
    (lines.length ? `\n${lines.join('\n')}${withOwed.length > 20 ? '\n…' : ''}\n` : '\n(belum ada yang bisa diklaim — perlu ada BELI/JUAL dulu di token kamu)\n') +
    `\nKetik <code>/claim</code> untuk klaim semua ke wallet creator, lalu <code>/sweep 0xTreasury</code> untuk pindah ke treasury.`);
}
async function doClaim(chatId) {
  await takeUserLock();
  try {
    await send(chatId, '💸 Klaim reward creator dari SEMUA token (baca chain)…');
    const res = await claimCreator(wallets, provider);   // chain-truth: all tokens, not just /last
    if (!res.length) { await send(chatId, 'Nggak ada reward yang bisa diklaim (semua 0). Cek /earnings — reward muncul setelah ada BELI/JUAL di token kamu.'); return; }
    const usd = await ethUsd();
    const u = (e) => usd ? ` ≈ ${e * usd >= 1 ? fmtUsd(e * usd) : '$' + (e * usd).toFixed(2)}` : '';
    let total = 0;
    const lines = res.map((r) => {
      if (r.error) return `❌ ${r.address.slice(0, 10)}… (${r.tokens.length} token): ${esc(r.error).slice(0, 80)}`;
      total += r.claimedEth || 0;
      return `✅ ${r.address.slice(0, 10)}… klaim <b>${(r.claimedEth || 0).toFixed(6)} ETH</b>${u(r.claimedEth || 0)} (${r.tokens.length} token)\n   tx <code>${r.tx}</code>`;
    });
    await send(chatId, `💸 <b>Klaim selesai</b> — total <b>${total.toFixed(6)} ETH</b>${u(total)}\n\n${lines.join('\n')}\n\n💡 ETH masuk ke wallet creator. Pindahkan ke treasury: <code>/sweep 0xTreasury</code>.`);
  } catch (e) { await send(chatId, `❌ Claim gagal: ${esc(e.shortMessage || e.reason || e.message)}`); }
  finally { freeUserLock(); }
}
// ---- auto-sale: sell holdings across ALL already-created tokens ----
async function doDumpAll(chatId, args) {
  const pct = args[0] ? Number(args[0]) : 100;
  if (!(pct > 0 && pct <= 100)) { await send(chatId, 'Format: <code>/dumpall 100</code> — jual 100% SEMUA token dari semua wallet.'); return; }
  const cas = state.last.map((t) => t.ca).filter((ca) => ca && ethers.isAddress(ca));
  if (!cas.length) { await send(chatId, 'Belum ada token yang di-launch.'); return; }
  await takeUserLock();
  try {
    await send(chatId, `🔻 DUMP ALL ${pct}% · ${cas.length} token · dari semua wallet…`);
    const res = await sellAllHoldings(provider, wallets, cas, pct);
    const usd = await ethUsd().catch(() => 0);
    const rep = renderSaleReport(res, usd, { title: `🔻 Dump ${pct}%` });
    if (!rep.sold && !rep.errors) {
      await send(chatId, `Nggak ada wallet yang pegang token ini (semua saldo 0)${rep.skipped ? ` · 💤 ${rep.skipped} dilewati` : ''}${rep.retry ? ` · 🔁 ${rep.retry} retry` : ''}. (${cas.length} token dicek)`);
    } else {
      for (const m of rep.messages) await send(chatId, m);
    }
  } catch (e) { await send(chatId, `❌ Dump gagal: ${esc(e.shortMessage || e.reason || e.message)}`); }
  finally { freeUserLock(); }
}
async function doAutoSale(chatId, args) {
  const a = (args[0] || '').toLowerCase();
  if (a !== 'on' && a !== 'off') {
    await send(chatId, `Format: <code>/autosale on</code> / <code>/autosale off</code>\nSekarang: <b>${CFG.autoSaleOn ? 'ON' : 'OFF'}</b> · jual ${CFG.autoSalePct}% tiap ${CFG.autoSaleEverySec}s\nAtur: <code>/autosalepct 50</code> · <code>/autosaleevery 600</code>`);
    return;
  }
  state.cfg.autoSaleOn = (a === 'on'); applyCfg(); saveState();
  await send(chatId, a === 'on'
    ? `✅ Auto-sale <b>ON</b> — tiap <b>${CFG.autoSaleEverySec}s</b> bot jual <b>${CFG.autoSalePct}%</b> holding di SEMUA token yang sudah dibuat. (/autosale off untuk stop)`
    : `🛑 Auto-sale <b>OFF</b>.`);
}
// React-to-buy: kalau ada pembeli ASLI (bukan wallet kita) beli ≥ $reactMin,
// bot jual sebagian (capped) buat recover modal — bukan dump total.
async function doReact(chatId, args) {
  const a = (args[0] || '').toLowerCase();
  if (a !== 'on' && a !== 'off') {
    await send(chatId,
      `🟢➡️🔻 <b>React-to-buy</b> (market-maker / recover modal)\n` +
      `Sekarang: <b>${CFG.reactOn ? 'ON' : 'OFF'}</b>\n\n` +
      `Kalau ada pembeli ASLI (bukan wallet bot) beli ≥ <b>$${CFG.reactMinUsd}</b> di token yang kita punya, bot jual <b>${CFG.reactSellPct}%</b> dari bag terbesar — maksimal <b>${CFG.reactMaxCount}×</b> per token (biar TIDAK dump total / rug holder asli).\n` +
      `Gas dipakai: <b>${gasLabel()}</b> · cek tiap ${CFG.reactEverySec}s\n\n` +
      `Nyalakan: <code>/react on</code> · matikan: <code>/react off</code>\n` +
      `Atur: <code>/reactmin 15</code> (USD) · <code>/reactpct 25</code> (%) · <code>/reacthits 3</code> · <code>/reactevery 45</code> · <code>/gas cheap</code>`);
    return;
  }
  state.cfg.reactOn = (a === 'on'); applyCfg(); saveState();
  await send(chatId, a === 'on'
    ? `✅ React-to-buy <b>ON</b> — pembeli asli ≥ $${CFG.reactMinUsd} → jual ${CFG.reactSellPct}% (maks ${CFG.reactMaxCount}×/token). Gas: ${gasLabel()}. (/react off untuk stop)`
    : `🛑 React-to-buy <b>OFF</b>.`);
}
// Anti-graduation guard: bot tokens dijual SEMUA sebelum graduate (LP burn = rugi).
async function doCapGuard(chatId, args) {
  const a = (args[0] || '').toLowerCase();
  if (a !== 'on' && a !== 'off') {
    await send(chatId,
      `🛡️ <b>Anti-graduate guard</b>\nSekarang: <b>${CFG.capGuardOn ? 'ON' : 'OFF'}</b> · batas pool <b>${CFG.capCeilingEth} ETH</b>\n\n` +
      `Token bot JANGAN sampai graduate (cap ~2.6 ETH) karena LP di-burn = rugi. Kalau pool token bot nyentuh <b>${CFG.capCeilingEth} ETH</b>, bot otomatis <b>jual SEMUA</b> holding token itu → pool turun, nggak jadi graduate.\n\n` +
      `Cuma menyentuh token yang dibuat BOT (token user lain aman). Cek tiap 30s.\n\n` +
      `Nyalakan: <code>/capguard on</code> · matikan: <code>/capguard off</code>\n` +
      `Atur batas: <code>/capmax 2</code> (ETH — kasih margin di bawah 2.6)`);
    return;
  }
  state.cfg.capGuardOn = (a === 'on'); applyCfg(); saveState();
  await send(chatId, a === 'on'
    ? `✅ Anti-graduate <b>ON</b> — pool ≥ ${CFG.capCeilingEth} ETH → jual SEMUA (token bot tidak akan graduate). (/capguard off untuk stop)`
    : `🛑 Anti-graduate <b>OFF</b> — ⚠️ hati-hati, token bot bisa graduate & LP ke-burn (rugi ~23%).`);
}
function gasLabel() {
  return CFG.gasMode === 'cheap' ? '💚 termurah (base-fee network)'
    : CFG.gasMode === 'auto' ? 'auto (network yang tentukan)'
    : `fixed ${CFG.gasGwei} gwei`;
}
// Live gas quote: read the price the bot WOULD pay right now (per current mode)
// and turn it into a per-tx USD estimate. Returns '' if the chain read fails.
async function gasQuote() {
  try {
    const g = await gasOverrides(provider);   // {gasPrice} per current mode, or {} for auto
    let gp = g.gasPrice;
    if (gp === undefined) { const fd = await provider.getFeeData(); gp = fd.gasPrice || fd.maxFeePerGas || 0n; }
    if (!gp || gp <= 0n) return '';
    const usd = await ethUsd();
    const gwei = Number(ethers.formatUnits(gp, 'gwei'));
    const costUsd = (units) => usd ? Number(ethers.formatEther(gp * BigInt(units))) * usd : 0;
    const fmtUsd = (u) => !usd ? '~' : u >= 1 ? '$' + u.toFixed(2) : u >= 0.01 ? '$' + u.toFixed(3) : '$' + u.toFixed(4);
    // typical gas: curve buy/sell ~180k, deploy+dev-buy ~600k
    return `💵 Harga gas sekarang: <b>${gwei.toPrecision(2)} gwei</b>\n` +
      `Perkiraan biaya/tx: beli/jual <b>${fmtUsd(costUsd(180000))}</b> · deploy <b>${fmtUsd(costUsd(600000))}</b>` +
      `${usd ? ` <i>(ETH $${Math.round(usd).toLocaleString('en-US')})</i>` : ''}`;
  } catch (_) { return ''; }
}
// Pilih gas: cheap (termurah) / angka manual / auto. No-arg → tampilkan menu.
async function doGas(chatId, args) {
  const a = (args[0] || '').toLowerCase().trim();
  const q = await gasQuote();
  const qline = q ? `\n${q}` : '';
  const menu = () => send(chatId,
    `⛽ <b>Setelan Gas</b>\nSekarang: <b>${gasLabel()}</b>${qline}\n\n` +
    `Pilih:\n` +
    `• <code>/gas cheap</code> — 💚 <b>termurah</b> (ikut base-fee network, tanpa tip) — hemat, dipakai default\n` +
    `• <code>/gas 0.01</code> — set manual (gwei); otomatis dinaikin ke base-fee kalau network lebih tinggi biar tx nggak nyangkut\n` +
    `• <code>/gas auto</code> — biar network yang tentukan (paling aman kalau tx sering nyangkut)`);
  if (!a) return menu();
  if (['cheap', 'murah', 'min', 'termurah'].includes(a)) { state.cfg.gasMode = 'cheap'; applyCfg(); saveState(); }
  else if (a === 'auto') { state.cfg.gasMode = 'auto'; applyCfg(); saveState(); }
  else if (Number.isFinite(Number(a)) && Number(a) >= 0) { state.cfg.gasMode = 'fixed'; state.cfg.gasGwei = Number(a); applyCfg(); saveState(); }
  else return menu();
  const q2 = await gasQuote();   // reflect the NEW mode's price
  return send(chatId, `✅ Gas: <b>${gasLabel()}</b>${q2 ? `\n${q2}` : ''}`);
}
// ---- P&L: how much of the deposit is left / lost across all launched tokens ----
async function doSetDeposit(chatId, args) {
  const v = Number(args[0]);
  if (!(v >= 0)) { await send(chatId, 'Format: <code>/setdeposit 1.0</code> — catat total ETH yang kamu setor ke bot (buat hitung rugi di /pnl).'); return; }
  state.deposited = v; saveState();
  await send(chatId, `✅ Deposit tercatat: <b>${v} ETH</b>. Ketik <code>/pnl</code> untuk lihat rugi/untung.`);
}
async function doPnl(chatId, args) {
  await send(chatId, '📊 Menghitung P&L… (baca saldo langsung dari chain + arus kas)');
  const usd = await ethUsd();
  const u = (e) => usd ? ` ($${(e * usd).toFixed(2)})` : '';
  // === RELIABLE, DIRECTLY-READ balances (all verifiable on robinhoodscan) ===
  const bals = await balances();
  const walletByAddr = {}; wallets.forEach((w, i) => { walletByAddr[w.address.toLowerCase()] = Number(ethers.formatEther(bals[i] || 0n)); });
  const walletEth = bals.reduce((s, b) => s + Number(ethers.formatEther(b)), 0);
  const protoEth = await protocolPending(provider);
  const treasury = await treasuryInfo(provider);          // real treasury balance, read directly
  // Creator fees owed across ALL our tokens (chain-truth), reused for per-wallet.
  const owned = await ownedTokens(provider, wallets);
  const owedByAddr = {};
  for (const r of owned) { const k = String(r.creator).toLowerCase(); owedByAddr[k] = (owedByAddr[k] || 0n) + (r.owedWei || 0n); }
  const claimEth = Number(ethers.formatEther(owned.reduce((s, r) => s + (r.owedWei || 0n), 0n)));
  // held tokens still un-sold
  const cas = state.last.map((t) => t.ca).filter((ca) => ca && ethers.isAddress(ca));
  const heldFlags = await Promise.all(cas.map(async (ca) => { for (const w of wallets) { if (await tokenBalance(provider, ca, w.address) > 0) return true; } return false; }));
  const held = heldFlags.filter(Boolean).length;
  // === Trading cost from chain history (approx): total bought vs total got back ===
  const cf = await walletCashflow(wallets);
  const tradeLoss = cf.spent - cf.tradeIn;
  const deployEth = (Number(state.launched) || 0) * 0.001;

  const nowTotal = walletEth + claimEth + protoEth;       // still IN the bot's control (excl. treasury)
  const perLines = wallets.map((w, i) => {
    const k = w.address.toLowerCase();
    const owed = Number(ethers.formatEther(owedByAddr[k] || 0n));
    const c = cf.per[k] || { spent: 0, tradeIn: 0 };
    return `#${i + 1} <code>${w.address.slice(0, 8)}…</code> saldo <b>${(walletByAddr[k] || 0).toFixed(4)}</b> · beli ${c.spent.toFixed(3)} · jual ${c.tradeIn.toFixed(3)} · fee ${owed.toFixed(4)}`;
  });

  await send(chatId,
    `📊 <b>P&L</b>  <i>(semua saldo bisa dicek di robinhoodscan)</i>\n` +
    `\n<b>━ Uang kamu SEKARANG ━</b>\n` +
    `👛 Wallet bot (5): <b>${walletEth.toFixed(4)} ETH</b>${u(walletEth)}\n` +
    `🏦 Treasury <code>${treasury.addr ? treasury.addr.slice(0, 8) + '…' : '?'}</code>: <b>${treasury.balance.toFixed(4)} ETH</b>${u(treasury.balance)}  <i>(hasil sweep + flush)</i>\n` +
    `💸 Fee creator (klaim): <b>${claimEth.toFixed(4)} ETH</b>${u(claimEth)}  <i>(/claim)</i>\n` +
    `📤 Fee protokol (flush): <b>${protoEth.toFixed(4)} ETH</b>${u(protoEth)}  <i>(admin)</i>\n` +
    `🪙 Token belum dijual: <b>${held}</b> posisi${held ? '  <i>(/dumpall)</i>' : ''}\n` +
    `💰 <b>Total = ${(nowTotal + treasury.balance).toFixed(4)} ETH</b>${u(nowTotal + treasury.balance)}\n` +
    `   ↳ di bot ${nowTotal.toFixed(4)} + treasury ${treasury.balance.toFixed(4)}\n` +
    `\n<b>━ Trading (dari histori chain) ━</b>\n` +
    `📤 Total beli+deploy: <b>${cf.spent.toFixed(4)} ETH</b>${u(cf.spent)}  <i>(${state.launched || 0} launch)</i>\n` +
    `📥 Total balik dari jual: <b>${cf.tradeIn.toFixed(4)} ETH</b>${u(cf.tradeIn)}\n` +
    `📉 <b>Biaya/rugi trading ≈ ${tradeLoss.toFixed(4)} ETH</b>${u(Math.abs(tradeLoss))}  <i>(fee + slippage + LP burned)</i>\n` +
    `\n<b>━ Per wallet ━</b>\n${perLines.join('\n')}\n` +
    `\n<i>Setoranmu (cek /wallets sebelum trading) − Total di atas = rugi. Deposit tidak dihitung otomatis karena bridge tidak terbaca akurat.</i>` +
    (held ? `\n💡 Jual sisa token dulu (<code>/dumpall</code>) lalu <code>/pnl</code> lagi.` : ''));
}
// Per-token P&L: which token each wallet bought/sold, and the loss on each.
async function doPnlToken(chatId) {
  await send(chatId, '📊 Menghitung P&L per token dari histori curve… (agak lama, ~1 menit)');
  const rows = await tokenPnl(provider, wallets, 40);
  if (!rows.length) { await send(chatId, 'Belum ada data trading token.'); return; }
  const usd = await ethUsd();
  const u = (e) => usd ? ` ($${(e * usd).toFixed(2)})` : '';
  const byCa = new Map(state.last.map((t) => [String(t.ca).toLowerCase(), t]));
  const walletNo = {}; wallets.forEach((w, i) => { walletNo[w.address.toLowerCase()] = i + 1; });
  const active = rows.filter((r) => r.buy > 0 || r.sell > 0).sort((a, b) => a.pnl - b.pnl);   // biggest loss first
  const totBuy = active.reduce((s, r) => s + r.buy, 0), totSell = active.reduce((s, r) => s + r.sell, 0);
  const lines = active.slice(0, 30).map((r) => {
    const t = byCa.get(String(r.ca).toLowerCase());
    const wNo = walletNo[String(r.creator).toLowerCase()] || '?';
    const tick = (t && t.ticker) ? '$' + t.ticker : r.ca.slice(0, 8) + '…';
    return `${r.pnl < 0 ? '📉' : '📈'} <b>${tick}</b> <i>(W${wNo})</i> beli ${r.buy.toFixed(3)} · jual ${r.sell.toFixed(3)} · <b>${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(4)}</b>`;
  });
  await send(chatId,
    `📊 <b>P&L per token</b>  <i>(${active.length} token aktif, ${rows.length} dicek — max 40 terbaru)</i>\n` +
    `Total beli <b>${totBuy.toFixed(3)} ETH</b> · jual <b>${totSell.toFixed(3)} ETH</b> · rugi <b>${(totSell - totBuy).toFixed(4)} ETH</b>${u(Math.abs(totSell - totBuy))}\n` +
    `<i>W1..W5 = wallet pembuat (urutan /wallets)</i>\n\n` +
    lines.join('\n') +
    (active.length > 30 ? `\n… (${active.length - 30} token lagi)` : ''));
}

// ---------------- command dispatch (shared by text + buttons) ----------------
async function dispatch(chatId, cmd, args) {
  switch (cmd) {
    case '/start': case '/help': await send(chatId, HELP, menu()); break;
    case '/wallets': await send(chatId, await walletsMsg()); break;
    case '/keys': case '/key': await send(chatId, keysMsg()); break;
    case '/bridge': await send(chatId, await bridgeMsg(), bridgeMenu()); break;
    // fire-and-forget: don't block the poll loop while deposits confirm on L1
    case '/bridge_go': doBridgeAll(chatId).catch((e) => send(chatId, 'Bridge error: ' + esc(e.message || String(e)))); break;
    case '/bridge_help': await send(chatId, BRIDGE_HELP); break;
    case '/status': await send(chatId, await statusMsg(), menu()); break;
    case '/stats': await send(chatId, await statsMsg(), menu()); break;
    case '/go': case '/run': await doGo(chatId); break;
    case '/stop': case '/pause': await doStop(chatId); break;
    case '/last': case '/history': await send(chatId, await lastMsg(), menu()); break;
    case '/config': await send(chatId, configMsg()); break;
    case '/allowlist': await send(chatId, await allowlistMsg()); break;
    case '/devbuy': await setCfg(chatId, 'devBuyEth', args[0], (v) => /^\d*\.?\d+$/.test(v) && Number(v) > 0, 'dev-buy (ETH)'); break;
    case '/interval': await setCfg(chatId, 'intervalSec', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 5, 'interval (detik)'); break;
    case '/levy': {                                   // set BOTH buy + sell fee (bps) at once
      const v = args[0]; const okv = Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000;
      if (!okv) { await send(chatId, '❌ Nilai tidak valid untuk levy (bps 0-1000).'); break; }
      state.cfg.buyLevyBps = Number(v); state.cfg.sellLevyBps = Number(v); applyCfg(); saveState();
      await send(chatId, `✅ buy fee & sell fee = <b>${Number(v) / 100}%</b>`); break;
    }
    case '/buyfee': await setCfg(chatId, 'buyLevyBps', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000, 'buy fee (bps)'); break;
    case '/sellfee': await setCfg(chatId, 'sellLevyBps', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000, 'sell fee (bps)'); break;
    case '/autobuy': await setCfg(chatId, 'autoBuyEth', args[0], (v) => /^\d*\.?\d+$/.test(v) && Number(v) >= 0, 'auto-buy (ETH)'); break;
    case '/autosell': await setCfg(chatId, 'autoSellPct', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100, 'auto-sell (%)'); break;
    case '/peerbuyers': await setCfg(chatId, 'peerBuyers', args[0], (v) => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 20, 'peer buyers (jumlah wallet)'); break;
    case '/peerbuy': await setCfg(chatId, 'peerBuyEth', args[0], (v) => /^\d*\.?\d+$/.test(v) && Number(v) > 0, 'peer-buy (ETH/wallet)'); break;
    case '/devrange': case '/peerrange': {
      const isDev = cmd === '/devrange', lbl = isDev ? 'dev-buy' : 'peer-buy';
      if (args[0] === 'off') { state.cfg[isDev ? 'devBuyMin' : 'peerBuyMin'] = ''; state.cfg[isDev ? 'devBuyMax' : 'peerBuyMax'] = ''; applyCfg(); saveState(); await send(chatId, `✅ ${lbl} acak OFF (pakai jumlah fixed).`); break; }
      const mn = args[0], mx = args[1], num = (v) => /^\d*\.?\d+$/.test(v);
      if (!num(mn) || !num(mx) || Number(mx) < Number(mn) || Number(mx) <= 0) { await send(chatId, `❌ Format: ${cmd} <min> <max>  (mis. ${cmd} 0.001 0.01) · atau ${cmd} off`); break; }
      state.cfg[isDev ? 'devBuyMin' : 'peerBuyMin'] = String(mn); state.cfg[isDev ? 'devBuyMax' : 'peerBuyMax'] = String(mx); applyCfg(); saveState();
      await send(chatId, `✅ ${lbl} acak = <b>${mn}–${mx} ETH</b>${isDev ? '' : ' per wallet'}`); break;
    }
    case '/sellafter': await setCfg(chatId, 'sellAfterSec', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0, 'sell-after (detik, 0=off)'); break;
    case '/sellpct': await setCfg(chatId, 'sellPct', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 100, 'sell (%)'); break;
    case '/max': await setCfg(chatId, 'maxTokens', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0, 'max tokens'); break;
    case '/buy': doBuy(chatId, args).catch((e) => send(chatId, 'Buy error: ' + esc(e.message || String(e)))); break;
    case '/sell': doSell(chatId, args).catch((e) => send(chatId, 'Sell error: ' + esc(e.message || String(e)))); break;
    case '/earnings': case '/rewards': doEarnings(chatId).catch((e) => send(chatId, 'Earnings error: ' + esc(e.message || String(e)))); break;
    case '/claim': doClaim(chatId).catch((e) => send(chatId, 'Claim error: ' + esc(e.message || String(e)))); break;
    case '/autosale': doAutoSale(chatId, args).catch((e) => send(chatId, 'Auto-sale error: ' + esc(e.message || String(e)))); break;
    case '/autosalepct': await setCfg(chatId, 'autoSalePct', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 100, 'auto-sale (%)'); break;
    case '/autosaleevery': await setCfg(chatId, 'autoSaleEverySec', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 30, 'auto-sale interval (detik)'); break;
    case '/react': doReact(chatId, args).catch((e) => send(chatId, 'React error: ' + esc(e.message || String(e)))); break;
    case '/reactmin': await setCfg(chatId, 'reactMinUsd', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 1, 'react min buy (USD)'); break;
    case '/reactpct': await setCfg(chatId, 'reactSellPct', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 100, 'react jual (%)'); break;
    case '/reacthits': await setCfg(chatId, 'reactMaxCount', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 1, 'react maks hit/token'); break;
    case '/reactevery': await setCfg(chatId, 'reactEverySec', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 20, 'react interval (detik)'); break;
    case '/gas': case '/gasgwei': doGas(chatId, args).catch((e) => send(chatId, 'Gas error: ' + esc(e.message || String(e)))); break;
    case '/capguard': doCapGuard(chatId, args).catch((e) => send(chatId, 'Guard error: ' + esc(e.message || String(e)))); break;
    case '/capmax': await setCfg(chatId, 'capCeilingEth', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0.1 && Number(v) < 2.6, 'batas pool (ETH, < 2.6)'); break;
    case '/dumpall': doDumpAll(chatId, args).catch((e) => send(chatId, 'Dump error: ' + esc(e.message || String(e)))); break;
    case '/pnl': case '/profit': doPnl(chatId, args).catch((e) => send(chatId, 'P&L error: ' + esc(e.message || String(e)))); break;
    case '/pnltoken': case '/pnltokens': doPnlToken(chatId).catch((e) => send(chatId, 'P&L token error: ' + esc(e.message || String(e)))); break;
    case '/setdeposit': doSetDeposit(chatId, args).catch((e) => send(chatId, 'Deposit error: ' + esc(e.message || String(e)))); break;
    case '/sweep': {
      const dest = args[0];
      if (!dest || !ethers.isAddress(dest)) { await send(chatId, 'Format: <code>/sweep 0xTujuan</code>'); break; }
      await send(chatId, '🧹 Sweeping…');
      const res = await sweepAll(wallets, provider, dest);
      const lines = res.map((r) => r.sent !== undefined ? `${r.address.slice(0, 10)}… → ${fmt(r.sent)} ETH` : r.skip ? null : `${r.address.slice(0, 10)}… gagal: ${esc(r.error)}`).filter(Boolean);
      await send(chatId, lines.length ? '✅ Sweep:\n' + lines.join('\n') : 'Tidak ada ETH untuk di-sweep.');
      break;
    }
    default: await send(chatId, '❓ Perintah tidak dikenal. /help');
  }
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message;
  if (!msg || !msg.text || !msg.from) return;
  const chatId = msg.chat.id;      // reply destination
  const uid = msg.from.id;         // authorization principal (the acting USER)
  // auto-claim admin ONLY in a private chat, and claim the USER id (never a group id)
  if (state.admins.length === 0 && msg.chat.type === 'private') {
    state.admins.push(String(uid)); saveState();
    await send(chatId, '✅ Kamu sekarang <b>admin</b> bot ini. Ketik /help.');
  }
  if (!isAdmin(uid)) { await send(chatId, '⛔ Bot ini privat.'); return; }
  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  await dispatch(chatId, cmd, args);
}

async function handleCallback(cq) {
  const chatId = cq.message && cq.message.chat.id;
  const uid = cq.from && cq.from.id;   // the user who actually pressed the button
  if (!chatId || !uid) return;
  if (!isAdmin(uid)) { await answerCb(cq.id, 'Bukan admin'); return; }
  await answerCb(cq.id);
  await dispatch(chatId, '/' + String(cq.data || '').toLowerCase(), []);
}

// ---------------- launch loop (gated by state.running) ----------------
async function launchLoop() {
  let rr = 0, warned = false;
  for (;;) {
    if (!state.running) { warned = false; await sleep(3000); continue; }
    if (CFG.maxTokens && state.launched >= CFG.maxTokens) { state.running = false; saveState(); await broadcast(`🛑 MAX_TOKENS ${CFG.maxTokens} tercapai. Seeder OFF.`, menu()); continue; }
    let deployFee = 0n; try { deployFee = await readDeployFee(factoryRead); } catch (_) {}
    // Dev buy: random in [DEV_BUY_MIN, DEV_BUY_MAX] when a max is set, else fixed.
    let devBuyStr = CFG.devBuyEth;
    if (Number(CFG.devBuyMax) > 0) { const mn = Number(CFG.devBuyMin) > 0 ? CFG.devBuyMin : CFG.devBuyEth; devBuyStr = randEthStr(mn, CFG.devBuyMax) || CFG.devBuyEth; }
    const devBuy = ethers.parseEther(devBuyStr);
    const need = deployFee + devBuy + gasBuf;
    let chosen = null;
    for (let k = 0; k < wallets.length; k++) {
      const w = wallets[(rr + k) % wallets.length];
      const bal = await provider.getBalance(w.address).catch(() => 0n);
      if (bal >= need) { chosen = w; rr = (rr + k + 1) % wallets.length; break; }
    }
    if (!chosen) {
      if (!warned) { await broadcast(`⏳ Menunggu ETH — kirim ≥ ${fmt(need)} ETH ke salah satu wallet (/wallets). Cek tiap ${CFG.intervalSec}s.`); warned = true; }
      await sleep(CFG.intervalSec * 1000); continue;
    }
    warned = false;
    const r = await launchWith(chosen, provider, deployFee, devBuy);
    if (r.ok) {
      state.launched++;
      state.last.push({ name: r.name, ticker: r.ticker, ca: r.ca, curve: r.curve, tx: r.txHash, creator: r.creator });
      if (state.last.length > 50) state.last = state.last.slice(-50);
      saveState();
      const usd = await ethUsd();
      const u = (e) => usd ? ` ≈ ${fmtUsd(e * usd)}` : '';
      // ---- multi-wallet volume: OTHER funded wallets buy RANDOM amounts ----
      const pMin = Number(CFG.peerBuyMin) > 0 ? CFG.peerBuyMin : CFG.peerBuyEth;
      const pMax = Number(CFG.peerBuyMax) > 0 ? CFG.peerBuyMax : CFG.peerBuyEth;
      let peer = [];
      if (CFG.peerBuyers > 0 && r.ca) {
        const buyers = wallets.filter((w) => w.address !== chosen.address).slice(0, CFG.peerBuyers);
        peer = await seedVolume(provider, buyers, r.ca, pMin, pMax);
      }
      const peerOk = peer.filter((p) => p.ok).length;
      const peerEth = peer.reduce((s, p) => s + (p.eth || 0), 0);        // sum of the actual random buys
      const peerRange = Number(pMin) === Number(pMax) ? `${pMin}` : `${pMin}–${pMax}`;
      // Clear peer-buy line: explain OFF / skips (no ETH) / errors so it's obvious.
      let peerLine;
      if (CFG.peerBuyers <= 0) {
        peerLine = '👥 peer-buy <b>OFF</b> — ketik <code>/peerbuyers 3</code> supaya wallet lain ikut beli';
      } else {
        const skip = peer.filter((p) => p.skip).length, fail = peer.filter((p) => !p.ok && !p.skip).length;
        peerLine = `👥 peer-buy <b>${peerOk}/${peer.length} wallet</b> beli (acak ${peerRange} ETH) = <b>${peerEth.toFixed(4)} ETH</b>${u(peerEth)}`;
        if (skip) peerLine += `\n   ⚠️ ${skip} wallet skip (ETH kurang — isi /wallets)`;
        if (fail) peerLine += `\n   ❌ ${fail} gagal: ${esc(((peer.find((p) => p.error) || {}).error || '?')).slice(0, 90)}`;
      }
      // ---- market cap + graduation status AFTER the buys ----
      let mcEth = 0, graduated = false; try { const s = await tokenStats(r.curve, provider); mcEth = Number(ethers.formatEther(s.mcEth || 0n)); graduated = !!s.graduated; } catch (_) {}
      // Dev-buy: report what ACTUALLY entered the curve. The curve caps a buy at
      // the graduation cap and refunds the surplus, so the intended amount (e.g.
      // 0.03 ETH) is often far above the real spend (e.g. 0.005 ETH).
      const devIntended = Number(devBuyStr);
      const devBuyEth = r.devBuyActualWei !== undefined ? Number(ethers.formatEther(r.devBuyActualWei)) : devIntended;
      const refunded = Math.max(0, devIntended - devBuyEth);
      const gasEth = Number(ethers.formatEther(r.gasCostWei || 0n)), deployEth = Number(ethers.formatEther(deployFee));
      const totalEth = deployEth + devBuyEth + gasEth + peerEth;
      state.spent = (Number(state.spent) || 0) + totalEth;   // cumulative spend for /pnl
      const devLine = refunded > 1e-6
        ? `💰 dev-buy <b>${devBuyEth.toFixed(6)} ETH</b>${u(devBuyEth)}  <i>(diminta ${devIntended} — sisa ${refunded.toFixed(6)} ETH refund, kena cap graduasi)</i>`
        : `💰 dev-buy <b>${devBuyEth.toFixed(6)} ETH</b>${u(devBuyEth)}`;
      await broadcast(`✅ <b>#${state.launched} ${esc(r.name)}</b> $${esc(r.ticker)}
CA <code>${r.ca || '(parse gagal)'}</code>
creator <code>${r.creator}</code>
${devLine}
${peerLine}
📈 MC <b>${mcEth.toFixed(4)} ETH</b>${u(mcEth)}
${graduated ? '🎓 <b>GRADUATED</b> — LP sudah di Uniswap (burned)' : '◈ masih di bonding curve (belum graduate)'}
⛽ gas ${gasEth.toFixed(6)} ETH${u(gasEth)} · deploy ${deployEth} ETH
🧾 total keluar <b>${totalEth.toFixed(5)} ETH</b>${u(totalEth)}
fee ${CFG.buyLevyBps / 100}%/${CFG.sellLevyBps / 100}% · board ${r.posted ? '✓' : 'gagal'} · logo ${r.memeSrc ? 'yes' : 'none'}
tx <code>${r.txHash}</code>`);
      // ---- scheduled sell (dump) SELL_AFTER_SEC later ----
      // Sell across the LAUNCHER (its dev-buy tokens) AND the peer buyers, so
      // every wallet that bought actually dumps — not just the peers.
      if (CFG.sellAfterSec > 0 && r.ca && (peerOk > 0 || devBuyEth > 0 || Number(CFG.autoBuyEth) > 0)) {
        const ca = r.ca, tk = r.ticker;
        const peers = wallets.filter((w) => w.address !== chosen.address).slice(0, CFG.peerBuyers);
        const sellers = [chosen, ...peers];   // launcher first, then peers
        setTimeout(async () => {
          try {
            const res = await sellHoldings(provider, sellers, ca, CFG.sellPct);
            const ok = res.filter((x) => x.ok).length;
            await broadcast(`🔻 Jual terjadwal $${esc(tk)} — <b>${ok} wallet</b> jual ${CFG.sellPct}% (setelah ${CFG.sellAfterSec}s).`);
          } catch (_) {}
        }, CFG.sellAfterSec * 1000);
      }
    } else {
      await broadcast(`❌ Launch gagal (${chosen.address.slice(0, 10)}…): ${esc(r.error)}`);
    }
    await sleep(CFG.intervalSec * 1000);
  }
}

// ---------------- auto-sale loop: periodically dump holdings across ALL tokens ----------------
// Runs continuously when CFG.autoSaleOn. Every CFG.autoSaleEverySec it sells
// CFG.autoSalePct% of every wallet's balance across every already-created token.
// Shares the `trading` lock with launches/manual trades to avoid nonce clashes;
// only broadcasts when it actually sold something (no spam on idle rounds).
let _lastAutoErrAt = 0;
async function autoSaleLoop() {
  for (;;) {
    if (!CFG.autoSaleOn) { await sleep(3000); continue; }
    const cas = state.last.map((t) => t.ca).filter((ca) => ca && ethers.isAddress(ca));
    if (cas.length && !tradeBusy() && !userPriority) {
      lockTrade();
      try {
        const res = await sellAllHoldings(provider, wallets, cas, CFG.autoSalePct);
        const usd = await ethUsd().catch(() => 0);
        const rep = renderSaleReport(res, usd, { title: `🔻 Auto-sale ${CFG.autoSalePct}%` });
        if (rep.sold > 0) { for (const m of rep.messages) await broadcast(m); }   // sold → full detailed report
        else if (rep.errors > 0 && Date.now() - _lastAutoErrAt > 1800000) {        // no sales but HARD errors → 1 heads-up / 30 min (not idle-cycle spam)
          _lastAutoErrAt = Date.now();
          await broadcast(rep.messages[0] + `\n\n<i>Tidak ada yang terjual siklus ini — cek RPC / likuiditas. Detail: <code>/dumpall</code>.</i>`);
        }
      } catch (_) {} finally { unlockTrade(); }
    }
    await sleep(CFG.autoSaleEverySec * 1000);
  }
}

// ---------------- react-to-buy: sell a capped slice when REAL buyers appear ----------------
async function reactLoop() {
  for (;;) {
    if (!CFG.reactOn) { await sleep(3000); continue; }
    if (!tradeBusy() && !userPriority) {
      lockTrade();
      try {
        const { actions } = await reactToBuys(provider, wallets, state.react);
        saveState();
        const sells = actions.filter((a) => a.hash);
        for (const a of sells) {
          const short = `${a.ca.slice(0, 8)}…`;
          await broadcast(`🟢➡️🔻 Ada pembeli asli di <code>${short}</code> (~$${Math.round(a.realUsd)}) → jual <b>${a.pct}%</b> (hit ${a.hits}/${CFG.reactMaxCount}) untuk recover modal.`);
        }
      } catch (e) { console.error('react loop error:', e.message); } finally { unlockTrade(); }
    }
    await sleep(CFG.reactEverySec * 1000);
  }
}

// ---------------- anti-graduation guard: never let a bot token graduate ----------------
async function guardLoop() {
  for (;;) {
    if (!CFG.capGuardOn) { await sleep(3000); continue; }
    if (!tradeBusy() && !userPriority) {
      lockTrade();
      try {
        const acted = await capGuard(provider, wallets, CFG.capCeilingEth);
        for (const a of acted) {
          await broadcast(`🛡️ <b>Anti-graduate</b> — <code>${a.ca.slice(0, 8)}…</code> pool ≈ <b>${a.collected.toFixed(2)} ETH</b> (cap ${a.target ? a.target.toFixed(1) : '2.6'}). Jual <b>SEMUA</b> (${a.sold} wallet) biar TIDAK graduate / LP ke-burn.`);
        }
      } catch (e) { console.error('guard loop error:', e.message); } finally { unlockTrade(); }
    }
    await sleep(30000);   // check every 30s (keep a safe margin below the cap)
  }
}

// ---------------- L1 watcher: auto-detect ETH arriving on Ethereum ----------------
// Baseline (state.l1seen) is persisted, so a pm2 restart with ETH already sitting
// on L1 still nudges once, and known balances don't re-notify on every restart.
async function l1Watcher() {
  if (!l1) return;
  const min = ethers.parseEther(CFG.bridgeMinEth);
  for (;;) {
    try {
      let changed = false;
      for (const w of wallets) {
        const b = await l1.getBalance(w.address).catch(() => null);
        if (b === null) continue; // failed read: don't touch baseline
        const prevStr = state.l1seen[w.address];
        const prev = prevStr !== undefined ? BigInt(prevStr) : undefined;
        if (b >= min && (prev === undefined || b > prev)) {
          const usd = await ethUsd();
          const label = prev === undefined ? '⟠ ETH tersedia di <b>Ethereum L1</b>' : '💰 ETH masuk di <b>Ethereum L1</b>';
          await broadcast(`${label}\n<code>${w.address.slice(0, 14)}…</code> = <b>${ethShort(b)} ETH${usdOf(b, usd)}</b>\n🌉 /bridge untuk pindah ke Robinhood Chain.`);
        }
        if (prevStr !== b.toString()) { state.l1seen[w.address] = b.toString(); changed = true; }
      }
      if (changed) saveState();
    } catch (_) {}
    await sleep(120000); // every 2 min
  }
}

// ---------------- long-poll updates ----------------
async function poll() {
  let offset = 0;
  console.log('🤖 Long-polling for Telegram updates…');
  for (;;) {
    const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
    if (r && r.ok && Array.isArray(r.result)) {
      for (const u of r.result) { offset = u.update_id + 1; try { await handleUpdate(u); } catch (e) { console.error('handle error:', e.message); } }
    } else {
      await sleep(2000); // transient error / bad token — back off
    }
  }
}

async function main() {
  const me = await tg('getMe');
  if (me && me.ok) {
    console.log(`🤖 Bot @${me.result.username} online (id ${me.result.id}).`);
  } else {
    console.error('════════════════════════════════════════════════════');
    console.error('❌ TELEGRAM TOKEN REJECTED — bot cannot talk to Telegram.');
    console.error('   Response:', JSON.stringify(me));
    console.error('   Fix: put your REAL @BotFather token in seeder/.env as');
    console.error('        TELEGRAM_TOKEN=123456:ABC...   (not a placeholder)');
    console.error('   then:  pm2 restart robinfun-seeder-bot');
    console.error('════════════════════════════════════════════════════');
  }
  await tg('setMyCommands', { commands: [
    { command: 'help', description: 'Bantuan & daftar perintah' },
    { command: 'wallets', description: 'Alamat + saldo (RH Chain & Ethereum L1)' },
    { command: 'bridge', description: 'Bridge ETH: Ethereum L1 -> Robinhood Chain' },
    { command: 'keys', description: '🔑 Private key wallet (RAHASIA)' },
    { command: 'buy', description: 'Bot beli token: /buy 0xCA 0.01' },
    { command: 'sell', description: 'Bot jual token: /sell 0xCA 50' },
    { command: 'earnings', description: 'Reward creator (levy) yg belum diklaim' },
    { command: 'claim', description: 'Klaim semua reward creator ke wallet' },
    { command: 'autosale', description: 'Auto-jual berkala SEMUA token: /autosale on' },
    { command: 'autosalepct', description: 'Persen auto-sale: /autosalepct 100' },
    { command: 'autosaleevery', description: 'Interval auto-sale (detik): /autosaleevery 600' },
    { command: 'react', description: 'Jual pas ada pembeli asli: /react on' },
    { command: 'reactmin', description: 'Min beli asli (USD) buat trigger: /reactmin 15' },
    { command: 'reactpct', description: 'Persen dijual per trigger: /reactpct 25' },
    { command: 'gas', description: 'Pilih gas: /gas cheap (termurah) / /gas 0.01 / /gas auto' },
    { command: 'capguard', description: 'Anti-graduate: jual semua sebelum pool graduate: /capguard on' },
    { command: 'capmax', description: 'Batas pool sebelum jual semua (ETH): /capmax 2' },
    { command: 'dumpall', description: 'Jual SEKARANG semua token: /dumpall 100' },
    { command: 'pnl', description: 'Rugi/untung (saldo + treasury + fee)' },
    { command: 'pnltoken', description: 'Rugi PER TOKEN (wallet mana beli apa)' },
    { command: 'setdeposit', description: 'Catat total ETH disetor: /setdeposit 1.0' },
    { command: 'go', description: 'Mulai auto-launch token' },
    { command: 'stop', description: 'Berhenti launch' },
    { command: 'status', description: 'Status seeder & saldo' },
    { command: 'stats', description: 'Jumlah token dibuat + market cap' },
    { command: 'last', description: 'History token terakhir + MC' },
    { command: 'config', description: 'Lihat setelan' },
    { command: 'buyfee', description: 'Set fee beli token bot (bps): /buyfee 100' },
    { command: 'sellfee', description: 'Set fee jual token bot (bps): /sellfee 100' },
    { command: 'autobuy', description: 'Wallet launcher beli sendiri (ETH): /autobuy 0.02' },
    { command: 'autosell', description: 'Wallet launcher jual sendiri (%): /autosell 30' },
    { command: 'peerbuyers', description: 'Jml wallet lain yg auto-beli: /peerbuyers 3' },
    { command: 'peerbuy', description: 'ETH per wallet (fixed): /peerbuy 0.002' },
    { command: 'peerrange', description: 'Peer-buy ACAK min-max: /peerrange 0.001 0.01' },
    { command: 'devrange', description: 'Dev-buy ACAK min-max: /devrange 0.001 0.005' },
    { command: 'sellafter', description: 'Auto-jual setelah N detik (0=off): /sellafter 300' },
    { command: 'sellpct', description: 'Persen dijual saat sell terjadwal: /sellpct 50' },
    { command: 'allowlist', description: 'Cek/allowlist wallet (beta)' },
    { command: 'sweep', description: 'Tarik ETH sisa' },
  ] });
  if (state.admins.length) await broadcast('🤖 Robinfun seeder bot online. /help', menu());
  else console.log('⚠️ No admin yet — the FIRST person to DM the bot IN A PRIVATE CHAT claims admin. Set TELEGRAM_ADMIN_IDS in seeder/.env to lock this down and close the claim window.');
  launchLoop().catch((e) => console.error('loop crashed:', e));
  autoSaleLoop().catch((e) => console.error('auto-sale loop crashed:', e));
  reactLoop().catch((e) => console.error('react loop crashed:', e));
  guardLoop().catch((e) => console.error('guard loop crashed:', e));
  l1Watcher().catch((e) => console.error('l1 watcher crashed:', e));
  await poll();
}
main().catch((e) => { console.error(e); process.exit(1); });
