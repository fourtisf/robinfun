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
  creatorEarnings, claimCreator, protocolPending, tokenBalance, detectDeposits, walletCashflow,
  creatorOwedTotal, ownedTokens,
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
};
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    Object.assign(state, s);
    if (!Array.isArray(state.admins)) state.admins = [];
    if (!Array.isArray(state.last)) state.last = [];
    if (!state.l1seen || typeof state.l1seen !== 'object') state.l1seen = {};
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
<b>/pnl</b> — 📊 rugi/untung dari deposit (semua token history)
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

async function walletsMsg() {
  const [l2bals, l1bals, usd] = await Promise.all([balances(), l1Balances(), ethUsd()]);
  let t = `<b>💰 Deployer wallets (${wallets.length})</b>\nKirim ETH ke alamat berikut:\n`;
  let tL2 = 0n, tL1 = 0n;
  wallets.forEach((w, i) => {
    const b2 = l2bals[i]; tL2 += b2;
    let line = `\n<code>${w.address}</code>\n   🟣 RH: ${ethShort(b2)} ETH${usdOf(b2, usd)}`;
    if (l1bals) { const b1 = l1bals[i]; tL1 += b1; line += ` · ⟠ L1: ${ethShort(b1)} ETH${usdOf(b1, usd)}${b1 > 0n ? ' 🌉' : ''}`; }
    t += line;
  });
  t += `\n\n<b>Total RH: ${ethShort(tL2)} ETH${usdOf(tL2, usd)}</b>`;
  if (l1bals) t += `\n<b>Total L1: ${ethShort(tL1)} ETH${usdOf(tL1, usd)}</b>\n🌉 = ada ETH di Ethereum → /bridge ke Robinhood Chain`;
  t += `\n\n🔑 /keys · harga ETH ${usd ? fmtUsd(usd) : '—'} · backup wallets.json`;
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

let bridging = false; // guard: never run two bridge passes at once (double-spend / nonce clash)
async function doBridgeAll(chatId) {
  if (!l1) { await send(chatId, 'L1_RPC belum aktif.'); return; }
  if (!ethers.isAddress(CFG.l1InboxAddr)) { await send(chatId, 'Inbox belum di-set. Lihat /bridge.'); return; }
  // Claim the lock SYNCHRONOUSLY (before any await) so two rapid taps can't both
  // pass the check — doBridgeAll is now fire-and-forget, so the poll loop no
  // longer serializes it for us.
  if (bridging) { await send(chatId, '⏳ Bridge sedang berjalan — tunggu selesai dulu.'); return; }
  bridging = true;
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
  } finally { bridging = false; }
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
let trading = false; // one on-chain trade at a time (avoid nonce clashes across wallets)
async function doBuy(chatId, args) {
  const ca = args[0]; const eth = args[1];
  if (!ca || !ethers.isAddress(ca) || !eth || !(Number(eth) > 0)) { await send(chatId, 'Format: <code>/buy 0xCONTRACT 0.01</code> — beli 0.01 ETH token itu.'); return; }
  if (trading) { await send(chatId, '⏳ Ada trade lain jalan — tunggu selesai.'); return; }
  trading = true;
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
  finally { trading = false; }
}
async function doSell(chatId, args) {
  const ca = args[0]; const pct = args[1] || '100';
  if (!ca || !ethers.isAddress(ca) || !(Number(pct) > 0 && Number(pct) <= 100)) { await send(chatId, 'Format: <code>/sell 0xCONTRACT 50</code> — jual 50% dari tiap wallet yang punya (default 100%).'); return; }
  if (trading) { await send(chatId, '⏳ Ada trade lain jalan — tunggu selesai.'); return; }
  trading = true;
  try {
    await send(chatId, `🔴 SELL ${pct}% · <code>${ca.slice(0, 12)}…</code> · dari wallet yang punya…`);
    let done = 0;
    for (const w of wallets) {
      try {
        const r = await botSell(w, provider, ca, pct);
        if (r.skip) continue;
        if (r.ok) { done++; await send(chatId, `✅ ${w.address.slice(0, 10)}… jual di ${r.venue === 'curve' ? 'curve' : 'Uniswap'}${r.pending ? ' (terkirim)' : ''}\ntx <code>${r.hash}</code>`); }
      } catch (e) { await send(chatId, `❌ ${w.address.slice(0, 10)}…: ${esc(e.shortMessage || e.reason || e.message)}`); }
    }
    if (!done) await send(chatId, 'Nggak ada wallet yang pegang token ini.');
  } finally { trading = false; }
}

// ---- creator reward (levy fee): view + claim ----
async function doEarnings(chatId) {
  await send(chatId, `⏳ Cek reward creator di SEMUA token (baca chain)…`);
  const rows = await ownedTokens(provider, wallets);   // chain-truth, ALL tokens (not just /last)
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
  if (trading) { await send(chatId, '⏳ Ada trade lain jalan — tunggu selesai.'); return; }
  trading = true;
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
  finally { trading = false; }
}
// ---- auto-sale: sell holdings across ALL already-created tokens ----
async function doDumpAll(chatId, args) {
  const pct = args[0] ? Number(args[0]) : 100;
  if (!(pct > 0 && pct <= 100)) { await send(chatId, 'Format: <code>/dumpall 100</code> — jual 100% SEMUA token dari semua wallet.'); return; }
  if (trading) { await send(chatId, '⏳ Ada trade lain jalan — tunggu selesai.'); return; }
  const cas = state.last.map((t) => t.ca).filter((ca) => ca && ethers.isAddress(ca));
  if (!cas.length) { await send(chatId, 'Belum ada token yang di-launch.'); return; }
  trading = true;
  try {
    await send(chatId, `🔻 DUMP ALL ${pct}% · ${cas.length} token · dari semua wallet…`);
    const res = await sellAllHoldings(provider, wallets, cas, pct);
    const ok = res.filter((r) => r.ok).length, err = res.filter((r) => r.error).length;
    await send(chatId, ok || err
      ? `✅ Dump selesai: <b>${ok}</b> posisi terjual${err ? `, ⚠️ ${err} error` : ''} (${cas.length} token dicek).`
      : `Nggak ada wallet yang pegang token ini (semua saldo 0).`);
  } catch (e) { await send(chatId, `❌ Dump gagal: ${esc(e.shortMessage || e.reason || e.message)}`); }
  finally { trading = false; }
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
// ---- P&L: how much of the deposit is left / lost across all launched tokens ----
async function doSetDeposit(chatId, args) {
  const v = Number(args[0]);
  if (!(v >= 0)) { await send(chatId, 'Format: <code>/setdeposit 1.0</code> — catat total ETH yang kamu setor ke bot (buat hitung rugi di /pnl).'); return; }
  state.deposited = v; saveState();
  await send(chatId, `✅ Deposit tercatat: <b>${v} ETH</b>. Ketik <code>/pnl</code> untuk lihat rugi/untung.`);
}
async function doPnl(chatId, args) {
  const forced = (args[0] !== undefined && Number(args[0]) >= 0) ? Number(args[0]) : null;
  if (forced !== null) { state.deposited = forced; saveState(); }
  await send(chatId, '📊 Menghitung P&L lengkap… (arus kas on-chain + saldo + fee)');
  const usd = await ethUsd();
  const u = (e) => usd ? ` ($${(e * usd).toFixed(2)})` : '';
  // Full cash-flow from chain history: deposit IN, spend OUT, trade proceeds IN.
  const cf = await walletCashflow(wallets);
  // Deposit: manual override wins; else the auto-detected external funding.
  const manual = Number(state.deposited) || 0;
  const dep = manual > 0 ? manual : cf.depositIn;
  const depSrc = manual > 0 ? 'manual (/setdeposit)' : (dep > 0 ? 'auto on-chain' : 'tidak terdeteksi');
  // Live position: wallet ETH, claimable creator fees (ALL tokens), protocol pending.
  const bals = await balances();
  const walletByAddr = {}; wallets.forEach((w, i) => { walletByAddr[w.address.toLowerCase()] = Number(ethers.formatEther(bals[i] || 0n)); });
  const walletEth = bals.reduce((s, b) => s + Number(ethers.formatEther(b)), 0);
  const protoEth = await protocolPending(provider);
  // Creator fees owed across ALL our tokens (chain-truth), read once and reused
  // for the total AND the per-wallet breakdown.
  const owned = await ownedTokens(provider, wallets);
  const owedByAddr = {};
  for (const r of owned) { const k = String(r.creator).toLowerCase(); owedByAddr[k] = (owedByAddr[k] || 0n) + (r.owedWei || 0n); }
  const claimEth = Number(ethers.formatEther(owned.reduce((s, r) => s + (r.owedWei || 0n), 0n)));
  // held tokens still un-sold across the tracked list
  const cas = state.last.map((t) => t.ca).filter((ca) => ca && ethers.isAddress(ca));
  const heldFlags = await Promise.all(cas.map(async (ca) => { for (const w of wallets) { if (await tokenBalance(provider, ca, w.address) > 0) return true; } return false; }));
  const held = heldFlags.filter(Boolean).length;

  // "Bisa ditarik" INCLUDES the ETH already swept to the treasury — that's still
  // your money, just moved out of the bot wallets.
  const recoverable = walletEth + cf.sweepOut + claimEth + protoEth;
  const pnl = recoverable - dep;
  const pct = dep > 0 ? (pnl / dep * 100) : 0;
  const tradeLoss = cf.spent - cf.tradeIn;   // deposit-independent: what trading itself cost
  const deployEth = (Number(state.launched) || 0) * 0.001;
  const perLines = wallets.map((w, i) => {
    const k = w.address.toLowerCase();
    const bal = walletByAddr[k] || 0;
    const owed = Number(ethers.formatEther(owedByAddr[k] || 0n));
    const c = cf.per[k] || { spent: 0, tradeIn: 0 };
    return `#${i + 1} <code>${w.address.slice(0, 8)}…</code> saldo <b>${bal.toFixed(4)}</b> · beli ${c.spent.toFixed(3)} · jual ${c.tradeIn.toFixed(3)} · fee ${owed.toFixed(4)}`;
  });

  await send(chatId,
    `📊 <b>P&L LENGKAP</b>\n` +
    `\n<b>━ Arus kas (on-chain) ━</b>\n` +
    `📥 Deposit masuk: <b>${dep.toFixed(4)} ETH</b>${u(dep)}  <i>(${depSrc})</i>\n` +
    `📤 Beli+deploy: <b>${cf.spent.toFixed(4)} ETH</b>${u(cf.spent)}  <i>(${state.launched || 0} launch, deploy ±${deployEth.toFixed(3)})</i>\n` +
    `📥 Balik dari jual/refund: <b>${cf.tradeIn.toFixed(4)} ETH</b>${u(cf.tradeIn)}\n` +
    `📉 <b>Rugi trading: ${tradeLoss.toFixed(4)} ETH</b>${u(Math.abs(tradeLoss))}  <i>(beli − jual)</i>\n` +
    `\n<b>━ Posisi sekarang ━</b>\n` +
    `👛 Saldo wallet: <b>${walletEth.toFixed(4)} ETH</b>${u(walletEth)}\n` +
    `🏦 Sudah di treasury (sweep): <b>${cf.sweepOut.toFixed(4)} ETH</b>${u(cf.sweepOut)}\n` +
    `💸 Fee creator claimable: <b>${claimEth.toFixed(4)} ETH</b>${u(claimEth)}  <i>(/claim)</i>\n` +
    `📤 Fee protokol → treasury: <b>${protoEth.toFixed(4)} ETH</b>${u(protoEth)}  <i>(flush admin)</i>\n` +
    `🪙 Token belum dijual: <b>${held}</b> posisi${held ? '  <i>(/dumpall)</i>' : ''}\n` +
    `\n<b>━ Hasil ━</b>\n` +
    `💰 Total masih milikmu: <b>${recoverable.toFixed(4)} ETH</b>${u(recoverable)}\n` +
    (dep > 0
      ? `${pnl >= 0 ? '📈' : '📉'} <b>P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ETH</b>${u(Math.abs(pnl))} · <b>${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</b> (vs deposit)\n`
      : `⚠️ Deposit belum terbaca (explorer down) — /setdeposit &lt;eth&gt;\n`) +
    (dep > 0 && pnl < 0 ? `⚠️ Rugi = ETH terkunci di <b>LP graduated (burned)</b> + slippage jual. Tidak bisa balik.\n` : '') +
    `\n<b>━ Per wallet ━</b>\n${perLines.join('\n')}\n` +
    (held ? `\n💡 Jual sisa token dulu (<code>/dumpall</code>) lalu <code>/pnl</code> lagi biar akurat.` : ''));
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
    case '/dumpall': doDumpAll(chatId, args).catch((e) => send(chatId, 'Dump error: ' + esc(e.message || String(e)))); break;
    case '/pnl': case '/profit': doPnl(chatId, args).catch((e) => send(chatId, 'P&L error: ' + esc(e.message || String(e)))); break;
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
async function autoSaleLoop() {
  for (;;) {
    if (!CFG.autoSaleOn) { await sleep(3000); continue; }
    const cas = state.last.map((t) => t.ca).filter((ca) => ca && ethers.isAddress(ca));
    if (cas.length && !trading) {
      trading = true;
      try {
        const res = await sellAllHoldings(provider, wallets, cas, CFG.autoSalePct);
        const ok = res.filter((r) => r.ok).length, err = res.filter((r) => r.error).length;
        if (ok > 0) await broadcast(`🔻 Auto-sale — jual <b>${CFG.autoSalePct}%</b> di <b>${ok}</b> posisi${err ? ` (⚠️ ${err} error)` : ''} · ${cas.length} token dicek.`);
      } catch (_) {} finally { trading = false; }
    }
    await sleep(CFG.autoSaleEverySec * 1000);
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
    { command: 'dumpall', description: 'Jual SEKARANG semua token: /dumpall 100' },
    { command: 'pnl', description: 'Rugi/untung dari deposit (semua token)' },
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
  l1Watcher().catch((e) => console.error('l1 watcher crashed:', e));
  await poll();
}
main().catch((e) => { console.error(e); process.exit(1); });
