// Pure helpers for @robinlistbot — no side effects, unit-testable.

export const isTxHash  = (s) => /^0x[0-9a-fA-F]{64}$/.test(String(s || '').trim());
export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || '').trim());

/** Escape text for Telegram HTML parse_mode. */
export const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "0.01" -> 10000000000000000n (wei). Throws on bad input. */
export function ethToWei(s) {
  s = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('bad amount');
  const [i, f = ''] = s.split('.');
  const frac = (f + '0'.repeat(18)).slice(0, 18);
  return BigInt(i) * 10n ** 18n + BigInt(frac || '0');
}

/** wei -> trimmed decimal ETH string for display. */
export function weiToEth(w) {
  w = BigInt(w);
  const i = w / 10n ** 18n;
  const f = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${i}.${f}` : `${i}`;
}

/**
 * Verify an on-chain ETH payment to the treasury.
 *
 * `rpc(method, params)` is injected so this is testable without a network:
 * it must resolve to the JSON-RPC `result` (or throw on RPC error).
 *
 * Returns {ok:true, from, value} or {ok:false, reason}.
 */
export async function verifyPayment(rpc, { hash, treasury, feeWei, minConf = 2 }) {
  hash = String(hash || '').trim();
  if (!isTxHash(hash)) return { ok: false, reason: 'That is not a valid transaction hash (0x + 64 hex).' };
  if (!isAddress(treasury)) return { ok: false, reason: 'Listing treasury is misconfigured — contact an admin.' };

  let tx;
  try { tx = await rpc('eth_getTransactionByHash', [hash]); }
  catch { return { ok: false, reason: 'Could not reach the chain right now. Try again in a moment.' }; }
  if (!tx) return { ok: false, reason: 'Transaction not found yet. Wait a few seconds and resend the hash.' };

  if (!tx.to || tx.to.toLowerCase() !== treasury.toLowerCase())
    return { ok: false, reason: 'That payment was not sent to the Robinfun treasury address.' };

  let value;
  try { value = BigInt(tx.value); } catch { return { ok: false, reason: 'Could not read the payment amount.' }; }
  if (value < BigInt(feeWei))
    return { ok: false, reason: `Amount too low. The listing fee is ${weiToEth(feeWei)} ETH.` };

  let rcpt;
  try { rcpt = await rpc('eth_getTransactionReceipt', [hash]); }
  catch { return { ok: false, reason: 'Could not reach the chain right now. Try again in a moment.' }; }
  if (!rcpt || rcpt.blockNumber == null)
    return { ok: false, reason: 'Payment is still pending. Wait for it to confirm, then resend the hash.' };
  if (rcpt.status !== '0x1')
    return { ok: false, reason: 'That transaction failed (reverted) on-chain.' };

  let head;
  try { head = BigInt(await rpc('eth_blockNumber', [])); }
  catch { return { ok: false, reason: 'Could not reach the chain right now. Try again in a moment.' }; }
  const conf = head - BigInt(rcpt.blockNumber) + 1n;
  if (conf < BigInt(minConf))
    return { ok: false, reason: `Waiting for confirmations (${conf < 0n ? 0n : conf}/${minConf}). Resend the hash shortly.` };

  return { ok: true, from: tx.from, value };
}
