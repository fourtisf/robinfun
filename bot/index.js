// @robinlistbot — Robinfun paid listing bot.
//
// Flow: a project DMs the bot, runs /list, answers a short wizard (name,
// ticker, contract address, fee, socials, logo), then pays the listing fee in
// ETH to the Robinfun treasury on Robinhood Chain and pastes the tx hash. The
// bot verifies the payment on-chain, saves the token to the Robinfun board
// (the M3 API) and auto-posts it to the listings channel.
//
// TESTNET-friendly: point RPC_URL/TREASURY at Robinhood Chain testnet and the
// "fee" is faucet ETH (free) — perfect for trying the whole flow. Switch to
// mainnet RPC + treasury + a real fee when you go live.

import { Bot } from 'grammy';
import fs from 'node:fs';
import path from 'node:path';
import { isTxHash, isAddress, esc, ethToWei, weiToEth, verifyPayment } from './verify.js';

// ------------------------------------------------------------------ config
const env = process.env;
const BOT_TOKEN       = env.BOT_TOKEN;
const TREASURY        = (env.TREASURY || '').trim();
const RPC_URL         = env.RPC_URL || 'https://rpc.testnet.chain.robinhood.com';
const CHAIN_ID        = env.CHAIN_ID || '46630';
const CHAIN_NAME      = env.CHAIN_NAME || 'Robinhood Chain';
const LISTING_FEE_ETH = env.LISTING_FEE_ETH || '0.01';
const LISTING_CHANNEL = env.LISTING_CHANNEL || '';        // @robinfunlisting or -100…
const CHANNEL_URL     = env.CHANNEL_URL || (LISTING_CHANNEL.startsWith('@') ? 'https://t.me/' + LISTING_CHANNEL.slice(1) : '');
const API_URL         = env.API_URL || 'http://127.0.0.1:3001';
const SITE_URL        = env.SITE_URL || 'https://robinfun.io';
const MIN_CONFIRMATIONS = Number(env.MIN_CONFIRMATIONS || 2);
const DATA_DIR        = env.DATA_DIR || '/var/lib/robinfun-bot';
const ADMIN_IDS       = new Set((env.ADMIN_IDS || '').split(/[,\s]+/).filter(Boolean).map(Number));

if (!BOT_TOKEN)  { console.error('FATAL: set BOT_TOKEN (from @BotFather).'); process.exit(1); }
if (!isAddress(TREASURY)) { console.error('FATAL: set TREASURY to a 0x… address (listing-fee recipient).'); process.exit(1); }
if (!LISTING_CHANNEL) { console.error('FATAL: set LISTING_CHANNEL (e.g. @robinfunlisting).'); process.exit(1); }

let FEE_WEI;
try { FEE_WEI = ethToWei(LISTING_FEE_ETH); } catch { console.error('FATAL: LISTING_FEE_ETH is not a number.'); process.exit(1); }

// ------------------------------------------------------------------ storage
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'data.json');
function loadDb() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { usedTx: [], listed: 0 }; } }
const store = loadDb();
const usedTx = new Set(store.usedTx || []);
function persist() {
  store.usedTx = [...usedTx].slice(-5000);            // bound the file
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, DB_FILE);
}

// ------------------------------------------------------------------ chain
async function rpc(method, params) {
  const r = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'rpc error');
  return j.result;
}

// ------------------------------------------------------------------ wizard
const STEPS = ['name', 'ticker', 'ca', 'fee', 'desc', 'website', 'x', 'tg', 'logo', 'pay'];
const OPTIONAL = new Set(['fee', 'desc', 'website', 'x', 'tg', 'logo']);
const PROMPTS = {
  name:    '🏷️ Send the <b>token name</b> (e.g. Sherwood).',
  ticker:  '🔤 Now the <b>ticker</b> (e.g. WOOD).',
  ca:      '📜 Paste the <b>contract address</b> (0x… 40 hex).',
  fee:     '💸 Buy/sell <b>fee %</b> — e.g. <code>3/3</code>. Send /skip for 0/0.',
  desc:    '📝 A short <b>description</b> (1–2 lines). /skip to leave blank.',
  website: '🌐 <b>Website</b> URL? /skip if none.',
  x:       '🐦 <b>X (Twitter)</b> URL? /skip if none.',
  tg:      '💬 <b>Telegram</b> URL? /skip if none.',
  logo:    '🖼️ Send the <b>logo</b> as a photo. /skip if none.',
};
const sessions = new Map();     // userId -> { i, data, ts }

function startWizard(ctx) {
  sessions.set(ctx.from.id, { i: 0, data: {}, ts: Date.now() });
  return enterStep(ctx);
}
function enterStep(ctx) {
  const s = sessions.get(ctx.from.id);
  const step = STEPS[s.i];
  if (step === 'pay') return sendPayInstructions(ctx, s);
  return ctx.reply(PROMPTS[step], { parse_mode: 'HTML' });
}
function advance(ctx) { sessions.get(ctx.from.id).i++; return enterStep(ctx); }

function sendPayInstructions(ctx, s) {
  const d = s.data;
  const lines = [
    '✅ Almost done — here is your listing:',
    '',
    `<b>${esc(d.name)}</b> ($${esc(d.ticker)})`,
    `CA: <code>${esc(d.ca)}</code>`,
    (d.buyFee || d.sellFee) ? `Fee: ${d.buyFee}/${d.sellFee}` : 'Fee: 0/0',
    '',
    `To publish it, send <b>${esc(weiToEth(FEE_WEI))} ETH</b> to the Robinfun treasury on <b>${esc(CHAIN_NAME)}</b> (chainId ${esc(CHAIN_ID)}):`,
    `<code>${esc(TREASURY)}</code>`,
    '',
    'Then paste the <b>transaction hash</b> here. Send /cancel to abort.',
  ];
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// ------------------------------------------------------------------ finalize
async function buildLogoDataUrl(fileId) {
  try {
    const f = await bot.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`;
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    if (!buf.length || buf.length > 2 * 1024 * 1024) return null;
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch { return null; }
}

function caption(d) {
  const L = [];
  L.push(`🆕 <b>${esc(d.name)}</b> ($${esc(d.ticker)})`);
  if (d.desc) L.push('', esc(d.desc));
  L.push('', `📜 <code>${esc(d.ca)}</code>`);
  if (d.buyFee || d.sellFee) L.push(`💸 Fee ${d.buyFee}/${d.sellFee}`);
  const links = [];
  if (d.website) links.push(`<a href="${esc(d.website)}">Website</a>`);
  if (d.x)       links.push(`<a href="${esc(d.x)}">X</a>`);
  if (d.tg)      links.push(`<a href="${esc(d.tg)}">Telegram</a>`);
  if (links.length) L.push('🔗 ' + links.join(' · '));
  L.push('', `🪶 Listed on <a href="${esc(SITE_URL)}">Robinfun</a>`);
  return L.join('\n');
}

async function postBackend(d, from) {
  const body = {
    name: d.name, ticker: d.ticker, ca: d.ca, description: d.desc || '',
    website: d.website || '', x: d.x || '', tg: d.tg || '',
    buyFee: d.buyFee || 0, sellFee: d.sellFee || 0,
    creator: from || '', logo: d.logoDataUrl || undefined,
  };
  const r = await fetch(API_URL + '/api/tokens', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('backend ' + r.status);
  return r.json();
}

async function finalize(ctx, s, from) {
  const d = s.data;
  if (d.logoFileId) d.logoDataUrl = await buildLogoDataUrl(d.logoFileId);

  // Post to the channel (photo if we have a logo, else text).
  const cap = caption(d);
  if (d.logoFileId) await bot.api.sendPhoto(LISTING_CHANNEL, d.logoFileId, { caption: cap, parse_mode: 'HTML' });
  else await bot.api.sendMessage(LISTING_CHANNEL, cap, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

  // Save to the board (best-effort — the channel post is the source of truth).
  try { await postBackend(d, from); } catch (e) { console.error('backend save failed:', e.message); }

  store.listed = (store.listed || 0) + 1; persist();
  sessions.delete(ctx.from.id);

  const link = CHANNEL_URL ? `\n📣 ${CHANNEL_URL}` : '';
  await ctx.reply(`🎉 <b>${esc(d.name)}</b> is live on the listings channel!${link}\n🌐 ${esc(SITE_URL)}`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

// ------------------------------------------------------------------ bot
const bot = new Bot(BOT_TOKEN);
const priv = (ctx) => ctx.chat?.type === 'private';

bot.command('start', (ctx) =>
  ctx.reply(
    `🪶 <b>Robinfun listings</b>\n\nList your token on Robinfun and broadcast it to the community.\n\n` +
    `• /list — submit a token\n• /fee — see the listing fee\n• /help — how it works\n\n🌐 ${esc(SITE_URL)}`,
    { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));

bot.command('help', (ctx) =>
  ctx.reply(
    `<b>How listing works</b>\n\n1. /list and answer a few questions.\n2. Pay <b>${esc(weiToEth(FEE_WEI))} ETH</b> to the Robinfun treasury on ${esc(CHAIN_NAME)}.\n3. Paste the transaction hash — once it confirms, your token is auto-posted to the listings channel and the Robinfun board.\n\nSend /cancel any time to stop.`,
    { parse_mode: 'HTML' }));

bot.command('fee', (ctx) =>
  ctx.reply(`💸 Listing fee: <b>${esc(weiToEth(FEE_WEI))} ETH</b>\nNetwork: ${esc(CHAIN_NAME)} (chainId ${esc(CHAIN_ID)})\nTreasury: <code>${esc(TREASURY)}</code>`,
    { parse_mode: 'HTML' }));

bot.command('cancel', (ctx) => {
  if (sessions.delete(ctx.from.id)) return ctx.reply('Cancelled. Send /list to start over.');
  return ctx.reply('Nothing to cancel. Send /list to begin.');
});

bot.command('list', (ctx) => {
  if (!priv(ctx)) return ctx.reply('Please DM me to list a token: open a private chat and send /list.');
  return startWizard(ctx);
});

bot.command('skip', (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s) return ctx.reply('Nothing to skip. Send /list to begin.');
  const step = STEPS[s.i];
  if (!OPTIONAL.has(step)) return ctx.reply('This field is required — please provide a value.');
  return advance(ctx);
});

bot.command('stats', (ctx) => {
  if (!ADMIN_IDS.has(ctx.from.id)) return;
  return ctx.reply(`📊 Listings published: ${store.listed || 0}\nTx hashes on record: ${usedTx.size}\nActive wizards: ${sessions.size}`);
});

// Logo photo → captured at the 'logo' step.
bot.on('message:photo', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s || !priv(ctx)) return;
  if (STEPS[s.i] !== 'logo') return ctx.reply('Send /list to start, or /cancel first.');
  s.data.logoFileId = ctx.message.photo.at(-1).file_id;   // largest size
  await ctx.reply('🖼️ Logo saved.');
  return advance(ctx);
});

// Wizard text input.
bot.on('message:text', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s || !priv(ctx)) return;                            // not mid-wizard → ignore
  const step = STEPS[s.i];
  const t = ctx.message.text.trim();
  const d = s.data;

  if (step === 'pay') return handlePay(ctx, s, t);

  switch (step) {
    case 'name':
      if (t.length < 1 || t.length > 64) return ctx.reply('Name must be 1–64 characters. Try again.');
      d.name = t; return advance(ctx);
    case 'ticker': {
      const tk = t.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
      if (!tk) return ctx.reply('Ticker must be letters/numbers (e.g. WOOD). Try again.');
      d.ticker = tk; return advance(ctx);
    }
    case 'ca':
      if (!isAddress(t)) return ctx.reply('That is not a valid contract address (0x + 40 hex). Try again.');
      d.ca = t; return advance(ctx);
    case 'fee': {
      const m = /^(\d{1,2})\s*[/ ]\s*(\d{1,2})$/.exec(t) || /^(\d{1,2})$/.exec(t);
      if (!m) return ctx.reply('Send it like <code>3/3</code> (buy/sell), a single number, or /skip.', { parse_mode: 'HTML' });
      d.buyFee = Math.min(10, Number(m[1]));
      d.sellFee = Math.min(10, Number(m[2] ?? m[1]));
      return advance(ctx);
    }
    case 'desc':
      d.desc = t.slice(0, 280); return advance(ctx);
    case 'website': case 'x': case 'tg':
      if (!/\.[a-z]{2,}/i.test(t)) return ctx.reply('That does not look like a link. Send a URL or /skip.');
      d[step] = t; return advance(ctx);
    case 'logo':
      return ctx.reply('Please send the logo as a <b>photo</b>, or /skip.', { parse_mode: 'HTML' });
  }
});

const inFlight = new Set();   // tx hashes mid-processing (concurrency guard)
async function handlePay(ctx, s, text) {
  if (!isTxHash(text)) return ctx.reply('Paste a valid transaction hash (0x + 64 hex), or /cancel.');
  const key = text.toLowerCase();
  if (usedTx.has(key)) return ctx.reply('That transaction was already used for a listing. Send a different payment.');
  if (inFlight.has(key)) return ctx.reply('That payment is already being processed — one moment.');

  await ctx.reply('⏳ Verifying your payment on-chain…');
  const v = await verifyPayment(rpc, { hash: text, treasury: TREASURY, feeWei: FEE_WEI, minConf: MIN_CONFIRMATIONS });
  if (!v.ok) return ctx.reply('❌ ' + v.reason);
  if (usedTx.has(key)) return ctx.reply('That transaction was already used for a listing.');   // race guard

  inFlight.add(key);
  try {
    await finalize(ctx, s, v.from);       // posts to the channel + saves the board
    usedTx.add(key); persist();            // burn the tx ONLY after a successful post
  } catch (e) {
    console.error('finalize failed:', e);
    // Tx is NOT consumed — the user can retry once the problem (usually: the bot
    // isn't an admin of the channel yet) is fixed.
    await ctx.reply('⚠️ Payment verified, but posting failed — is the bot an admin of the listings channel? Your transaction was NOT used; fix it and resend the same hash, or contact an admin.');
  } finally {
    inFlight.delete(key);
  }
}

bot.catch((err) => console.error('bot error:', err?.error?.message || err?.message || err));

// Best-effort menu registration — never let a transient network blip at boot
// crash the service (systemd would just restart-loop it).
bot.api.setMyCommands([
  { command: 'list', description: 'List a token on Robinfun' },
  { command: 'fee', description: 'Show the listing fee' },
  { command: 'help', description: 'How listing works' },
  { command: 'cancel', description: 'Cancel the current listing' },
]).catch((e) => console.error('setMyCommands failed (non-fatal):', e?.message || e));

// Profile texts (About + the pre-Start description). Best-effort.
bot.api.setMyShortDescription(
  'Pay-to-list your token on Robinfun. Auto-posted to ' + LISTING_CHANNEL + ' the moment your ETH fee confirms on-chain. 🪶'
).catch((e) => console.error('setMyShortDescription failed (non-fatal):', e?.message || e));
bot.api.setMyDescription(
  '🪶 Robinfun listings — get your token in front of the community.\n\n' +
  '1) /list and answer a few quick questions\n' +
  '2) Pay the listing fee in ETH on Robinhood Chain\n' +
  '3) Paste the transaction hash\n\n' +
  'The moment it confirms, your token is auto-posted to ' + LISTING_CHANNEL + ' and the Robinfun board. Tap /list to begin.'
).catch((e) => console.error('setMyDescription failed (non-fatal):', e?.message || e));

console.log(`@robinlistbot up · fee ${weiToEth(FEE_WEI)} ETH · channel ${LISTING_CHANNEL} · chain ${CHAIN_ID}`);
bot.start();
