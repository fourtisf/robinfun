#!/usr/bin/env node
/*
 * Robinfun seeder — Telegram control bot.
 *
 * Control the seeder entirely from Telegram: see the deployer wallets to fund,
 * start/stop launching, tweak config, view the last tokens. Uses long-polling
 * (getUpdates) so it works behind a firewall — no webhook / open port needed.
 *
 * Setup (seeder/.env, git-ignored):
 *   TELEGRAM_TOKEN=123456:ABC...     ← from @BotFather (revoke + regenerate if leaked)
 *   TELEGRAM_ADMIN_IDS=              ← optional; if blank, the FIRST user to
 *                                      message the bot auto-claims admin.
 *
 * Run:  node telegram.js   (or via deploy/bootstrap-seeder-tg.sh under pm2)
 */
'use strict';
const fs = require('fs');
const {
  ethers, CFG, FACTORY_ABI, makeProvider, loadOrCreateWallets,
  launchWith, readDeployFee, checkBeta, sweepAll, fmt, sleep,
} = require('./core');

if (!CFG.tgToken) {
  console.error('Missing TELEGRAM_TOKEN. Put  TELEGRAM_TOKEN=...  in seeder/.env (from @BotFather).');
  process.exit(1);
}
const API = `https://api.telegram.org/bot${CFG.tgToken}`;

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
    // env-provided admins are always merged in
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
async function send(chatId, text, extra) { return tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }); }
async function broadcast(text) { for (const id of state.admins) { await send(id, text); } }
const isAdmin = (id) => state.admins.map(String).includes(String(id));

// ---------------- shared runtime ----------------
const provider = makeProvider();
const wallets = loadOrCreateWallets(provider);
const funder = /^0x[0-9a-fA-F]{64}$/.test(CFG.funderKey) ? new ethers.Wallet(CFG.funderKey, provider) : null;
const factoryRead = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);
const gasBuf = ethers.parseEther('0.0006');
const balances = () => Promise.all(wallets.map((w) => provider.getBalance(w.address).catch(() => 0n)));

const HELP = `<b>🤖 Robinfun Seeder Bot</b>
Bot bikin ${wallets.length} wallet sendiri. Tugasmu cuma isi ETH, lalu /go.

<b>/wallets</b> — 5 alamat wallet + saldo (kirim ETH ke sini)
<b>/go</b> — mulai auto-launch token tiap ${CFG.intervalSec}s
<b>/stop</b> — berhenti launch
<b>/status</b> — status seeder + saldo
<b>/last</b> — token terakhir yang di-launch
<b>/config</b> — lihat setelan
<b>/allowlist</b> — cek/allowlist wallet (mode beta)
<b>/sweep 0x…</b> — tarik ETH sisa ke wallet-mu

<b>Atur setelan:</b>
/devbuy 0.001 · /interval 60 · /levy 100 · /max 0

Alur: <b>/wallets → kirim ETH → /go</b> ✅`;

function walletsMsg(bals) {
  let t = `<b>💰 Deployer wallets (${wallets.length})</b>\nKirim ETH ke alamat berikut:\n`;
  let total = 0n;
  wallets.forEach((w, i) => { const b = bals ? bals[i] : 0n; total += b; t += `\n<code>${w.address}</code>${bals ? ` — ${fmt(b)} ETH` : ''}`; });
  if (bals) t += `\n\n<b>Total: ${fmt(total)} ETH</b>`;
  t += `\n\nKunci disimpan di wallets.json (chmod 600) — backup!`;
  return t;
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
Launched: <b>${state.launched}</b>${CFG.maxTokens ? ` / ${CFG.maxTokens}` : ''}
Wallet ber-ETH: ${funded}/${wallets.length} · total ${fmt(total)} ETH
betaMode: ${beta} · ${allow}
interval ${CFG.intervalSec}s · dev-buy ${CFG.devBuyEth} ETH · levy ${CFG.levyBps / 100}%
butuh ≥ ${fmt(need)} ETH/wallet untuk 1 launch`;
}

function lastMsg() {
  if (!state.last.length) return 'Belum ada token yang di-launch. /go dulu.';
  const rows = state.last.slice(-10).reverse().map((t, i) =>
    `${i + 1}. <b>${esc(t.name)}</b> $${esc(t.ticker)}\n   CA <code>${t.ca || '-'}</code>\n   creator <code>${(t.creator || '').slice(0, 12)}…</code>`);
  return `<b>🆕 ${Math.min(10, state.last.length)} token terakhir</b> (total ${state.launched})\n\n` + rows.join('\n');
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
    t += `\n\nFix di admin panel <b>robinfun.tech</b> → Allow-list → paste alamat di atas → Allow. Atau matikan beta (go public).`;
  }
  return t;
}

async function setCfg(chatId, key, val, ok, label) {
  if (val === undefined || !ok(val)) { await send(chatId, `❌ Nilai tidak valid untuk ${label}.`); return; }
  state.cfg[key] = (key === 'devBuyEth') ? String(val) : Number(val);
  applyCfg(); saveState();
  await send(chatId, `✅ ${label} = <b>${state.cfg[key]}</b>`);
}

// ---------------- command router ----------------
async function handleUpdate(u) {
  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const [cmdRaw, ...args] = msg.text.trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase().replace(/@.*$/, '');

  // first user to talk claims admin (when none configured)
  if (state.admins.length === 0) {
    state.admins.push(String(chatId)); saveState();
    await send(chatId, '✅ Kamu sekarang <b>admin</b> bot ini. Ketik /help.');
  }
  if (!isAdmin(chatId)) { await send(chatId, '⛔ Bot ini privat.'); return; }

  switch (cmd) {
    case '/start': case '/help': await send(chatId, HELP); break;
    case '/wallets': await send(chatId, walletsMsg(await balances())); break;
    case '/status': await send(chatId, await statusMsg()); break;
    case '/go': case '/run':
      if (state.running) await send(chatId, '▶️ Seeder sudah ON.');
      else { state.running = true; saveState(); await send(chatId, `▶️ <b>Seeder ON</b> — launch tiap ${CFG.intervalSec}s dari wallet yang ada ETH-nya. /stop untuk berhenti.`); }
      break;
    case '/stop': case '/pause':
      if (!state.running) await send(chatId, '⏸️ Seeder sudah OFF.');
      else { state.running = false; saveState(); await send(chatId, '⏸️ <b>Seeder OFF</b> — berhenti launch.'); }
      break;
    case '/last': await send(chatId, lastMsg()); break;
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

// ---------------- launch loop (gated by state.running) ----------------
async function launchLoop() {
  let rr = 0, warned = false;
  for (;;) {
    if (!state.running) { warned = false; await sleep(3000); continue; }
    if (CFG.maxTokens && state.launched >= CFG.maxTokens) { state.running = false; saveState(); await broadcast(`🛑 MAX_TOKENS ${CFG.maxTokens} tercapai. Seeder OFF.`); continue; }
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
      state.last.push({ name: r.name, ticker: r.ticker, ca: r.ca, tx: r.txHash, creator: r.creator });
      if (state.last.length > 50) state.last = state.last.slice(-50);
      saveState();
      await broadcast(`✅ <b>#${state.launched} ${esc(r.name)}</b> $${esc(r.ticker)}
CA <code>${r.ca || '(parse gagal)'}</code>
creator <code>${r.creator}</code>
dev-buy ${CFG.devBuyEth} ETH · levy ${CFG.levyBps / 100}% · gas ${fmt(r.gasCostWei)} ETH
board ${r.posted ? 'posted ✓' : 'POST gagal'} · logo ${r.memeSrc ? 'yes' : 'none'}
tx <code>${r.txHash}</code>`);
    } else {
      await broadcast(`❌ Launch gagal (${chosen.address.slice(0, 10)}…): ${esc(r.error)}`);
    }
    await sleep(CFG.intervalSec * 1000);
  }
}

// ---------------- long-poll updates ----------------
async function poll() {
  let offset = 0;
  console.log('🤖 Telegram bot online — long-polling…');
  for (;;) {
    const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
    if (r && r.ok && Array.isArray(r.result)) {
      for (const u of r.result) { offset = u.update_id + 1; try { await handleUpdate(u); } catch (e) { console.error('handle error:', e.message); } }
    } else {
      await sleep(2000); // transient error / conflict — back off
    }
  }
}

async function main() {
  await tg('setMyCommands', { commands: [
    { command: 'help', description: 'Bantuan & daftar perintah' },
    { command: 'wallets', description: 'Alamat wallet (kirim ETH ke sini)' },
    { command: 'go', description: 'Mulai auto-launch token' },
    { command: 'stop', description: 'Berhenti launch' },
    { command: 'status', description: 'Status seeder & saldo' },
    { command: 'last', description: 'Token terakhir' },
    { command: 'config', description: 'Lihat setelan' },
    { command: 'allowlist', description: 'Cek/allowlist wallet (beta)' },
    { command: 'sweep', description: 'Tarik ETH sisa' },
  ] });
  if (state.admins.length) await broadcast('🤖 Robinfun seeder bot online. /help');
  else console.log('No admin yet — send any message to the bot to claim admin.');
  launchLoop().catch((e) => console.error('loop crashed:', e));
  await poll();
}
main().catch((e) => { console.error(e); process.exit(1); });
