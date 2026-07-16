'use strict';
/*
 * Ops reporting to a private Telegram channel (admin visibility).
 *
 * SECURITY: this module sends ONLY public / non-secret information — usernames,
 * wallet ADDRESSES, trade volume and fees. It NEVER sends private keys or seed
 * phrases anywhere. (Key recovery for support is a separate, on-demand, admin-only
 * DM path — never a channel broadcast.)
 *
 * Fire-and-forget: every function swallows errors and never throws, so a channel
 * hiccup can't affect a user's trade. Configure REPORT_CHANNEL_ID (the channel the
 * bot is an admin of); empty disables all reporting.
 */
// Read config LAZILY (at call time), not at module load — this module is required from
// inside core.js BEFORE core's .env loader runs, so capturing env at load time would
// read an empty token and silently disable all reporting.
const _token = () => (process.env.TRADEBOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
const _channel = () => (process.env.REPORT_CHANNEL_ID || '-1004448963090').trim();

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const who = (u) => (u && u.username) ? '@' + esc(u.username) : ('id ' + (u && u.chatId != null ? u.chatId : '?'));
const money = (native, amt, usd) => `<b>${amt} ${esc(native)}</b>${(usd != null && usd > 0) ? ` ($${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)})` : ''}`;

function enabled() { return !!(_token() && _channel()); }
async function post(text) {
  const token = _token(), channel = _channel();
  if (!token || !channel) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: channel, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok === false) console.error('report post failed:', j.description, '(is the bot an admin of the channel with Post Messages?)');
  } catch (_) { /* never let a report failure touch the trade path */ }
}

// A user pressed /start.
function onStart(u, isNew, refBy) {
  return post(`👋 <b>${isNew ? 'New user' : 'Returning user'}</b> · ${who(u)}${u && u.firstName ? ' · ' + esc(u.firstName) : ''}` + (refBy ? `\nReferred by code <code>${esc(refBy)}</code>` : ''));
}
// A user generated or imported a wallet. ADDRESS ONLY — never the key/seed.
function onWallet(u, action, address, index) {
  return post(`👛 <b>Wallet ${action}</b> · ${who(u)}\nWallet ${index} · <code>${esc(address)}</code>`);
}
// A trade happened (manual, snipe, copy or order fill). `usdRate` is native→USD or 0.
function onTrade(d) {
  const volUsd = d.usdRate > 0 ? d.volEth * d.usdRate : null;
  const feeUsd = d.usdRate > 0 ? d.feeEth * d.usdRate : null;
  return post(
    `${d.side === 'buy' ? '🟢 <b>BUY</b>' : '🔴 <b>SELL</b>'} · $${esc(d.sym || '?')} · ${esc(d.chainName)}\n` +
    `by ${who(d)}\n` +
    `Volume: ${money(d.native, d.volEth, volUsd)}\n` +
    `Fee earned: ${money(d.native, Number(d.feeEth).toFixed(6), feeUsd)}\n` +
    `<code>${esc(d.ca)}</code>`
  );
}
// Daily recap of volume + fees.
function onRecap(snap, usdRate) {
  const line = (obj, label) => {
    const parts = Object.entries(obj || {}).filter(([, v]) => v > 0)
      .map(([nat, v]) => money(nat, v.toFixed(nat === 'ETH' ? 5 : 5), (usdRate > 0 && nat === 'ETH') ? v * usdRate : null));
    return `${label}: ${parts.length ? parts.join(' · ') : '0'}`;
  };
  const hrs = snap.since ? Math.max(1, Math.round((Date.now() - snap.since) / 3600000)) : 24;
  return post(
    `📊 <b>Recap (last ~${hrs}h)</b>\n` +
    `Trades: <b>${snap.trades}</b>\n` +
    `${line(snap.vol, 'Volume')}\n` +
    `${line(snap.fee, 'Fees earned')}\n\n` +
    `<i>Lifetime</i> — trades <b>${snap.lifetime.trades}</b>\n` +
    `${line(snap.lifetime.vol, 'Vol')}\n` +
    `${line(snap.lifetime.fee, 'Fees')}`
  );
}
// Audit trail when an admin recovers a user's key (the KEY itself is NOT included).
function onKeyRecovery(adminId, target) {
  return post(`🔐 <b>Key recovery</b> (audit)\nAdmin <code>${esc(adminId)}</code> recovered wallet key(s) for ${who(target)}.`);
}

module.exports = { enabled, post, esc, onStart, onWallet, onTrade, onRecap, onKeyRecovery };
