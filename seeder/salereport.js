'use strict';
/*
 * Detailed, chunked sale-report renderer for the seeder auto-sale / dumpall.
 * Kept in its own module so it can be unit-tested without booting the Telegram bot.
 *
 * Input: rows from core.sellAllHoldings / core.sellHoldings, each one of:
 *   { ok, venue, hash, pending, tokensSold, expEthWei, proceedsWei, remaining,
 *     ca, name, symbol, decimals, address }        ← a SALE
 *   { skip, reason, ca, name, symbol, address }     ← nothing to sell / can't sell now
 *   { error, retryable, ca, address }               ← soft (approve/RPC/race)
 * Output: { messages[], sold, skipped, errors, retry, totalWei } — send each message.
 */
const { ethers } = require('ethers');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtUsd = (n) => n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'k' : '$' + n.toFixed(0);
const ethShort = (wei) => { const n = Number(ethers.formatEther(wei)); return n === 0 ? '0' : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); };
const usdOf = (wei, usd) => { if (!usd) return ''; const v = Number(ethers.formatEther(wei)) * usd; return ` (${v >= 1000 ? fmtUsd(v) : '$' + v.toFixed(2)})`; };
const EXPLORER = (process.env.EXPLORER || 'https://explorer.mainnet.chain.robinhood.com').replace(/\/+$/, '');
// Only build a link for a well-formed tx hash (0x + 64 hex). This keeps the <a href>
// safe even if a row's `hash` ever came from an untrusted source (esc doesn't escape ").
const txLink = (hash) => /^0x[0-9a-fA-F]{64}$/.test(String(hash || '')) ? `<a href="${EXPLORER}/tx/${hash}">tx↗</a>` : (hash ? `tx <code>${esc(String(hash).slice(0, 14))}…</code>` : '');
const fmtNum = (n) => { n = Number(n); if (!isFinite(n) || n === 0) return '0'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(1) + 'k'; if (a >= 1) return n.toFixed(2); return n.toPrecision(2); };
const clamp = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };   // bound name/symbol so a long one can't blow the message size

function renderSaleReport(res, usd, opts) {
  opts = opts || {};
  res = Array.isArray(res) ? res : [];
  const title = opts.title || '🔻 Auto-sale';
  const maxDetail = opts.maxDetail || 40;   // cap detail lines so a huge dump can't flood
  const perMsg = opts.perMsg || 10;         // detail blocks per Telegram message (each ~270 chars incl. tx URL → 4096-char guard)
  const sold = res.filter((r) => r && r.ok);
  const skipped = res.filter((r) => r && r.skip).length;
  const hardErr = res.filter((r) => r && r.error && !r.retryable).length;
  const retry = res.filter((r) => r && r.error && r.retryable).length;
  const gotWeiOf = (r) => { try { return (r.proceedsWei && BigInt(r.proceedsWei) > 0n) ? BigInt(r.proceedsWei) : BigInt(r.expEthWei || 0); } catch (_) { return 0n; } };
  let totalWei = 0n; for (const r of sold) totalWei += gotWeiOf(r);

  const header = `${title} — <b>${sold.length}</b> posisi terjual · total <b>${ethShort(totalWei)} ETH</b>${usdOf(totalWei, usd)}`
    + ((skipped || hardErr || retry) ? `\n<i>${[skipped ? `💤 ${skipped} dilewati` : '', hardErr ? `⚠️ ${hardErr} error` : '', retry ? `🔁 ${retry} retry` : ''].filter(Boolean).join(' · ')}</i>` : '');

  const lines = [];
  for (const r of sold.slice(0, maxDetail)) {
    const dec = (r.decimals != null && Number.isFinite(Number(r.decimals))) ? Number(r.decimals) : 18;   // 0-decimal is valid — don't coerce to 18
    const gotWei = gotWeiOf(r);
    let soldTok = '0', remTok = '0';
    try { soldTok = fmtNum(ethers.formatUnits(BigInt(r.tokensSold || 0), dec)); } catch (_) {}
    try { remTok = fmtNum(ethers.formatUnits(BigInt(r.remaining || 0), dec)); } catch (_) {}   // a malformed field must not crash the whole report
    let remWorthWei = 0n;
    try { if (r.tokensSold && BigInt(r.tokensSold) > 0n && gotWei > 0n && r.remaining) remWorthWei = (BigInt(r.remaining) * gotWei) / BigInt(r.tokensSold); } catch (_) {}
    const sym = clamp(r.symbol || r.name || '?', 24);
    const nm = clamp(r.name, 40);
    lines.push(
      `✅ <b>$${esc(sym)}</b>${nm && nm !== sym ? ' · ' + esc(nm) : ''} — <b>${ethShort(gotWei)} ETH</b>${usdOf(gotWei, usd)} <i>(${esc(r.venue || '?')})</i>\n`
      + `   jual ${soldTok} · sisa ${remTok}${(remWorthWei > 0n && usd) ? ' ' + usdOf(remWorthWei, usd).trim() : ''}${r.pending ? ' · ⏳ pending' : ''}\n`
      + `   👛 <code>${esc(r.address)}</code>\n`
      + `   🪙 <code>${esc(r.ca)}</code> · ${txLink(r.hash)}`
    );
  }
  if (sold.length > maxDetail) lines.push(`…dan <b>${sold.length - maxDetail}</b> penjualan lagi.`);

  // Chunk by BYTE BUDGET (not block count): Telegram silently drops a >4096-char
  // message (it returns {ok:false}, not an exception), which would lose a whole batch
  // of blocks — or the header. Keep each message well under the limit.
  const MAX = 3500;
  const messages = [];
  let cur = header;
  for (const ln of lines) {
    const piece = '\n\n' + ln;
    if (cur.length + piece.length > MAX && cur.length) { messages.push(cur); cur = ln; }   // flush; continuation starts with the block (no header)
    else cur += piece;
  }
  messages.push(cur);
  return { messages, sold: sold.length, skipped, errors: hardErr, retry, totalWei };
}

module.exports = { renderSaleReport, fmtNum, txLink, esc, ethShort, usdOf };
