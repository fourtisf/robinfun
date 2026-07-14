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
  makeL1Provider, verifyInbox, bridgeOne,
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
};
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8'));
    Object.assign(state, s);
    if (!Array.isArray(state.admins)) state.admins = [];
    if (!Array.isArray(state.last)) state.last = [];
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
<b>/go</b> · <b>/stop</b> — mulai / berhenti auto-launch
<b>/status</b> — status seeder + saldo
<b>/stats</b> — jumlah token dibuat + total market cap
<b>/last</b> — history token terakhir + MC per token
<b>/config</b> — lihat setelan
<b>/allowlist</b> — cek/allowlist wallet (mode beta)
<b>/sweep 0x…</b> — tarik ETH sisa ke wallet-mu

<b>Atur setelan:</b>
/devbuy 0.001 · /interval 60 · /levy 100 · /max 0

Alur: <b>/wallets → kirim ETH (L1) → /bridge → /go</b> ✅`;

async function walletsMsg() {
  const [l2bals, l1bals] = await Promise.all([balances(), l1Balances()]);
  let t = `<b>💰 Deployer wallets (${wallets.length})</b>\nKirim ETH ke alamat berikut:\n`;
  let tL2 = 0n, tL1 = 0n;
  wallets.forEach((w, i) => {
    const b2 = l2bals[i]; tL2 += b2;
    let line = `\n<code>${w.address}</code>\n   🟣 RH: ${fmt(b2)} ETH`;
    if (l1bals) { const b1 = l1bals[i]; tL1 += b1; line += ` · ⟠ L1: ${fmt(b1)} ETH${b1 > 0n ? ' 🌉' : ''}`; }
    t += line;
  });
  t += `\n\n<b>Total RH: ${fmt(tL2)} ETH</b>`;
  if (l1bals) t += ` · <b>Total L1: ${fmt(tL1)} ETH</b>\n🌉 = ada ETH di Ethereum → /bridge ke Robinhood Chain`;
  t += `\n\n🔑 /keys · backup wallets.json (chmod 600)`;
  return t;
}

function keysMsg() {
  let t = `🔑 <b>PRIVATE KEY deployer wallets</b>\n⚠️ RAHASIA. Siapa pun yang punya ini bisa kuras dompetnya. Jangan share, dan HAPUS pesan ini setelah dicatat/di-import.\n`;
  wallets.forEach((w, i) => { t += `\n${i + 1}. <code>${w.address}</code>\n<tg-spoiler><code>${w.privateKey}</code></tg-spoiler>`; });
  return t;
}

async function bridgeMsg() {
  if (!l1) return '⚠️ <b>L1_RPC belum aktif.</b> Set <code>L1_RPC</code> di seeder/.env untuk deteksi + bridge ETH dari Ethereum.';
  const l1bals = await l1Balances();
  const min = ethers.parseEther(CFG.bridgeMinEth);
  const inboxSet = ethers.isAddress(CFG.l1InboxAddr);
  const ver = inboxSet ? await verifyInbox(l1, CFG.l1InboxAddr) : { ok: false, reason: 'belum di-set' };
  let ready = 0, totalReady = 0n;
  let rows = '';
  wallets.forEach((w, i) => {
    const b = l1bals[i];
    if (b >= min) { ready++; totalReady += b; }
    rows += `<code>${w.address.slice(0, 12)}…</code>  ⟠ ${fmt(b)} ETH ${b >= min ? '✅ siap' : '—'}\n`;
  });
  let t = `<b>🌉 Bridge ETH → Robinhood Chain</b>\nEthereum L1 → RH Chain lewat <i>depositEth</i> resmi (address sama, ~10–15 menit).\n\n${rows}\nSiap bridge: <b>${ready}/${wallets.length}</b> wallet · ~${fmt(totalReady)} ETH\n`;
  t += `\nInbox L1: ${inboxSet ? `<code>${CFG.l1InboxAddr}</code>\n${ver.ok ? '✓ kontrak terdeteksi di L1' : '⚠️ ' + ver.reason}` : '❌ <b>belum di-set</b>'}\n`;
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
  if (bridging) { await send(chatId, '⏳ Bridge sedang berjalan — tunggu selesai dulu.'); return; }
  const ver = await verifyInbox(l1, CFG.l1InboxAddr);
  if (!ver.ok) { await send(chatId, `⚠️ Inbox gagal verifikasi: ${ver.reason}. Bridge dibatalkan demi keamanan.`); return; }
  bridging = true;
  try {
    await send(chatId, '🌉 Mulai bridge dari Ethereum L1… (mohon tunggu, jangan spam)');
    let done = 0, skipped = 0;
    for (const w of wallets) {
      try {
        const r = await bridgeOne(w, l1, CFG.l1InboxAddr, CFG.bridgeMinEth);
        if (r.ok) { done++; await send(chatId, `✅ <code>${w.address.slice(0, 12)}…</code> bridge <b>${fmt(r.bridged)} ETH</b>\ntx L1 <code>${r.hash}</code>`); }
        else skipped++;
      } catch (e) { await send(chatId, `❌ <code>${w.address.slice(0, 12)}…</code>: ${esc(e.shortMessage || e.reason || e.message)}`); }
    }
    await send(chatId, done
      ? `Selesai — ${done} wallet di-bridge${skipped ? `, ${skipped} dilewati` : ''}. ETH muncul di Robinhood Chain ~10–15 menit, lalu /go untuk deploy.`
      : 'Tidak ada wallet dengan cukup ETH di L1 untuk di-bridge.');
  } finally { bridging = false; }
}

async function statusMsg() {
  const bals = await balances();
  const total = bals.reduce((a, b) => a + b, 0n);
  let deployFee = 0n; try { deployFee = await readDeployFee(factoryRead); } catch (_) {}
  const need = deployFee + ethers.parseEther(CFG.devBuyEth) + gasBuf;
  const funded = bals.filter((b) => b >= need).length;
  let beta = '?', allow = '?';
  try { const c = await checkBeta(factoryRead, wallets); beta = c.beta ? 'ON' : 'OFF'; allow = c.missing.length ? `${wallets.length - c.missing.length}/${wallets.length} allowed` : 'semua allowed'; } catch (_) {}
  return `<b>📊 Status</b>
Seeder: ${state.running ? '▶️ ON' : '⏸️ OFF'}
Token dibuat: <b>${state.launched}</b>${CFG.maxTokens ? ` / ${CFG.maxTokens}` : ''}
Wallet ber-ETH: ${funded}/${wallets.length} · total ${fmt(total)} ETH
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
dev-buy ${CFG.devBuyEth} ETH  <i>(/devbuy)</i>
interval ${CFG.intervalSec}s  <i>(/interval)</i>
levy ${CFG.levyBps} bps = ${CFG.levyBps / 100}%  <i>(/levy)</i>
max tokens ${CFG.maxTokens || '∞'}  <i>(/max)</i>
backend ${CFG.backend}
funder ${funder ? 'set (auto allow-list + fund)' : 'none (self-funded)'}`;
}

async function allowlistMsg() {
  let c; try { c = await checkBeta(factoryRead, wallets); } catch (e) { return 'Gagal cek allow-list: ' + (e.shortMessage || e.message); }
  if (!c.beta) return '✅ betaMode OFF — semua wallet bisa create. Tinggal isi ETH lalu /go.';
  if (!c.missing.length) return '✅ Semua wallet sudah di-allowlist. Tinggal isi ETH lalu /go.';
  let t = `⚠️ betaMode ON. ${c.missing.length} wallet BELUM di-allowlist (createToken akan revert):\n` + c.missing.map((w) => `<code>${w.address}</code>`).join('\n');
  if (funder && c.owner.toLowerCase() === funder.address.toLowerCase()) {
    try { const tx = await new ethers.Contract(CFG.factory, FACTORY_ABI, funder).setBetaAllowed(c.missing.map((w) => w.address), true); await tx.wait(); return '✅ Sudah di-allowlist otomatis via FUNDER_KEY.'; }
    catch (e) { t += `\n\nGagal auto-allowlist: ${e.shortMessage || e.message}`; }
  } else {
    t += `\n\nFix di admin panel <b>robinfun.tech</b> → Allow-list → paste alamat → Allow. Atau matikan beta (go public).`;
  }
  return t;
}

async function setCfg(chatId, key, val, ok, label) {
  if (val === undefined || !ok(val)) { await send(chatId, `❌ Nilai tidak valid untuk ${label}.`); return; }
  state.cfg[key] = (key === 'devBuyEth') ? String(val) : Number(val);
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

// ---------------- command dispatch (shared by text + buttons) ----------------
async function dispatch(chatId, cmd, args) {
  switch (cmd) {
    case '/start': case '/help': await send(chatId, HELP, menu()); break;
    case '/wallets': await send(chatId, await walletsMsg()); break;
    case '/keys': case '/key': await send(chatId, keysMsg()); break;
    case '/bridge': await send(chatId, await bridgeMsg(), bridgeMenu()); break;
    case '/bridge_go': await doBridgeAll(chatId); break;
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
    case '/levy': await setCfg(chatId, 'levyBps', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1000, 'levy (bps)'); break;
    case '/max': await setCfg(chatId, 'maxTokens', args[0], (v) => Number.isFinite(Number(v)) && Number(v) >= 0, 'max tokens'); break;
    case '/sweep': {
      const dest = args[0];
      if (!dest || !ethers.isAddress(dest)) { await send(chatId, 'Format: <code>/sweep 0xTujuan</code>'); break; }
      await send(chatId, '🧹 Sweeping…');
      const res = await sweepAll(wallets, provider, dest);
      const lines = res.map((r) => r.sent !== undefined ? `${r.address.slice(0, 10)}… → ${fmt(r.sent)} ETH` : r.skip ? null : `${r.address.slice(0, 10)}… gagal: ${r.error}`).filter(Boolean);
      await send(chatId, lines.length ? '✅ Sweep:\n' + lines.join('\n') : 'Tidak ada ETH untuk di-sweep.');
      break;
    }
    default: await send(chatId, '❓ Perintah tidak dikenal. /help');
  }
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');
  if (state.admins.length === 0) { state.admins.push(String(chatId)); saveState(); await send(chatId, '✅ Kamu sekarang <b>admin</b> bot ini. Ketik /help.'); }
  if (!isAdmin(chatId)) { await send(chatId, '⛔ Bot ini privat.'); return; }
  await dispatch(chatId, cmd, args);
}

async function handleCallback(cq) {
  const chatId = cq.message && cq.message.chat.id;
  if (!chatId) return;
  if (!isAdmin(chatId)) { await answerCb(cq.id, 'Bukan admin'); return; }
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
    const devBuy = ethers.parseEther(CFG.devBuyEth);
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
      let mcTxt = '';
      try { const s = await tokenStats(r.curve, provider); const usd = await ethUsd(); const mcEth = Number(ethers.formatEther(s.mcEth || 0n)); mcTxt = `\nMC ${mcEth.toFixed(4)} ETH${usd ? ` ≈ ${fmtUsd(mcEth * usd)}` : ''}`; } catch (_) {}
      await broadcast(`✅ <b>#${state.launched} ${esc(r.name)}</b> $${esc(r.ticker)}
CA <code>${r.ca || '(parse gagal)'}</code>
creator <code>${r.creator}</code>${mcTxt}
dev-buy ${CFG.devBuyEth} ETH · levy ${CFG.levyBps / 100}% · gas ${fmt(r.gasCostWei)} ETH
board ${r.posted ? 'posted ✓' : 'POST gagal'} · logo ${r.memeSrc ? 'yes' : 'none'}
tx <code>${r.txHash}</code>`);
    } else {
      await broadcast(`❌ Launch gagal (${chosen.address.slice(0, 10)}…): ${esc(r.error)}`);
    }
    await sleep(CFG.intervalSec * 1000);
  }
}

// ---------------- L1 watcher: auto-detect ETH arriving on Ethereum ----------------
async function l1Watcher() {
  if (!l1) return;
  const seen = {};
  const min = ethers.parseEther(CFG.bridgeMinEth);
  for (;;) {
    try {
      for (const w of wallets) {
        const b = await l1.getBalance(w.address).catch(() => null);
        if (b === null) continue;
        const prev = seen[w.address];
        if (prev !== undefined && b > prev && b >= min) {
          await broadcast(`💰 ETH masuk di <b>Ethereum L1</b>\n<code>${w.address.slice(0, 14)}…</code> = <b>${fmt(b)} ETH</b>\n🌉 /bridge untuk pindah ke Robinhood Chain.`);
        }
        seen[w.address] = b;
      }
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
    { command: 'go', description: 'Mulai auto-launch token' },
    { command: 'stop', description: 'Berhenti launch' },
    { command: 'status', description: 'Status seeder & saldo' },
    { command: 'stats', description: 'Jumlah token dibuat + market cap' },
    { command: 'last', description: 'History token terakhir + MC' },
    { command: 'config', description: 'Lihat setelan' },
    { command: 'allowlist', description: 'Cek/allowlist wallet (beta)' },
    { command: 'sweep', description: 'Tarik ETH sisa' },
  ] });
  if (state.admins.length) await broadcast('🤖 Robinfun seeder bot online. /help', menu());
  else console.log('No admin yet — send any message to the bot to claim admin.');
  launchLoop().catch((e) => console.error('loop crashed:', e));
  l1Watcher().catch((e) => console.error('l1 watcher crashed:', e));
  await poll();
}
main().catch((e) => { console.error(e); process.exit(1); });
