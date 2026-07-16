'use strict';
/*
 * GoPlus Token Security — pre-trade safety checks (honeypot, buy/sell tax,
 * mintable, LP lock, ownership footguns) so a user sees the risk BEFORE buying.
 *
 * Free, no API key. Best-effort: returns null on an unsupported chain (GoPlus
 * doesn't cover Robinhood Chain), a bad address, or any network error, so callers
 * degrade gracefully instead of blocking a trade on a flaky third party.
 *
 * API: GET https://api.gopluslabs.io/api/v1/token_security/{chainId}?contract_addresses={ca}
 */

// GoPlus chain ids for the chains we route DEX trades on. Robinhood Chain (4663)
// is NOT covered — its Robinfun-native tokens are fair-launch by construction.
const GP_CHAIN = { ethereum: '1', bsc: '56', base: '8453', arbitrum: '42161' };

function supported(chainKey) { return !!GP_CHAIN[chainKey]; }

const yes = (v) => v === '1' || v === 1 || v === true;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// Fraction of LP that is burned or locked (0–100), null if unknown.
function lpLockedPct(d) {
  if (!Array.isArray(d.lp_holders) || !d.lp_holders.length) return null;
  let locked = 0;
  for (const h of d.lp_holders) {
    if (!h || typeof h !== 'object') continue;   // GoPlus can return sparse/null elements — never deref blindly
    const pct = Number(h.percent || 0);
    const burned = /^0x0{40}$|dead/i.test(String(h.address || ''));
    if (yes(h.is_locked) || burned) locked += (Number.isFinite(pct) ? pct : 0);
  }
  return Math.min(100, locked * 100);
}

// Short-TTL cache + in-flight de-dup. The snipe/copy loops re-check the same fresh
// token every few seconds; without this each check is a fresh HTTP round-trip that
// adds latency to a cycle and can trip GoPlus rate limits. A good result is cached
// briefly; a miss/error is cached for only a few seconds so an interactive re-scan
// still retries quickly. Never throws (callers degrade to "no data" on null).
const _secCache = new Map();   // 'cid:addr' -> { at, val }
const _secInflight = new Map();
const SEC_OK_TTL = Math.max(0, Number(process.env.GOPLUS_TTL_MS || 60000));       // cache a good result 60s
const SEC_ERR_TTL = Math.max(0, Number(process.env.GOPLUS_ERR_TTL_MS || 8000));   // cache a miss/error 8s
const SEC_CACHE_MAX = 5000;

async function tokenSecurity(chainKey, ca) {
  const cid = GP_CHAIN[chainKey];
  if (!cid) return null;
  const addr = String(ca || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  const key = cid + ':' + addr;
  const now = Date.now();
  const hit = _secCache.get(key);
  if (hit && (now - hit.at) < (hit.val ? SEC_OK_TTL : SEC_ERR_TTL)) return hit.val;
  if (_secInflight.has(key)) return _secInflight.get(key);
  const pr = (async () => {
    const val = await _fetchSecurity(cid, addr, ca);   // never throws
    if (_secCache.size >= SEC_CACHE_MAX) { const first = _secCache.keys().next().value; _secCache.delete(first); }
    _secCache.set(key, { at: Date.now(), val });
    return val;
  })().finally(() => _secInflight.delete(key));
  _secInflight.set(key, pr);
  return pr;
}

async function _fetchSecurity(cid, addr, ca) {
  let j;
  try {
    const r = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${cid}?contract_addresses=${addr}`, {
      signal: AbortSignal.timeout(8000),
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return null;
    j = await r.json();
  } catch (_) { return null; }
  const d = j && j.result && (j.result[addr] || j.result[ca]);
  if (!d || typeof d !== 'object') return null;
  const buyTax = num(d.buy_tax), sellTax = num(d.sell_tax);
  return {
    name: d.token_name || null,
    symbol: d.token_symbol || null,
    buyTaxPct: buyTax == null ? null : buyTax * 100,
    sellTaxPct: sellTax == null ? null : sellTax * 100,
    honeypot: yes(d.is_honeypot),
    cannotSellAll: yes(d.cannot_sell_all),
    transferPausable: yes(d.transfer_pausable),
    tradingCooldown: yes(d.trading_cooldown),
    mintable: yes(d.is_mintable),
    ownerChangeBalance: yes(d.owner_change_balance),
    hiddenOwner: yes(d.hidden_owner),
    canTakeBackOwnership: yes(d.can_take_back_ownership),
    selfDestruct: yes(d.selfdestruct),
    externalCall: yes(d.external_call),
    proxy: yes(d.is_proxy),
    openSource: yes(d.is_open_source),
    blacklisted: yes(d.is_blacklisted),
    antiWhale: yes(d.is_anti_whale),
    holders: num(d.holder_count),
    lpHolders: Array.isArray(d.lp_holders) ? d.lp_holders.length : null,
    lpLockedPct: lpLockedPct(d),
  };
}

// Turn the normalized fields into a risk verdict: 'danger' | 'warn' | 'ok',
// plus the specific red/yellow flags that drove it.
function verdict(s) {
  const red = [];
  if (s.honeypot) red.push('honeypot (can’t sell)');
  if (s.cannotSellAll) red.push('can’t sell all');
  if (s.transferPausable) red.push('transfers can be paused');
  if (s.ownerChangeBalance) red.push('owner can change balances');
  if (s.hiddenOwner) red.push('hidden owner');
  if (s.canTakeBackOwnership) red.push('owner can reclaim ownership');
  if (s.selfDestruct) red.push('self-destruct');
  if (s.blacklisted) red.push('blacklist function');
  if ((s.buyTaxPct || 0) > 10 || (s.sellTaxPct || 0) > 10) red.push('tax over 10%');
  const warn = [];
  if (s.mintable) warn.push('mintable supply');
  if (s.openSource === false) warn.push('not open-source');
  if (s.proxy) warn.push('proxy contract');
  if (s.tradingCooldown) warn.push('trading cooldown');
  if (s.externalCall) warn.push('external calls');
  if ((s.buyTaxPct || 0) > 5 || (s.sellTaxPct || 0) > 5) warn.push('tax 5–10%');
  let level = 'ok';
  if (red.length) level = 'danger';
  else if (warn.length) level = 'warn';
  return { level, red, warn };
}

module.exports = { supported, tokenSecurity, verdict, GP_CHAIN };
