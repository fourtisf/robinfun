'use strict';
/*
 * solana.js — Solana (SVM) adapter for the Robinfun Trade Bot.
 *
 * The rest of the bot is 100% EVM (ethers). Solana is a different world — ed25519
 * keypairs, base58 addresses, lamports (9 decimals), SPL tokens, and swaps through
 * the Jupiter aggregator HTTP API instead of a Uniswap router. ALL of that lives
 * here so the EVM path in core.js/telegram.js stays untouched; callers branch on
 * `chain.kind === 'svm'` and delegate to these functions.
 *
 * This module is split into:
 *   - PURE helpers (derivation, validation, unit math, Jupiter request builders) —
 *     fully unit-testable offline;
 *   - LIVE helpers (Connection reads, swap execution) — thin wrappers over
 *     @solana/web3.js + fetch, exercised against a real RPC in production.
 */
const crypto = require('crypto');
const web3 = require('@solana/web3.js');
const { Keypair, PublicKey, Connection, VersionedTransaction, Transaction, SystemProgram, LAMPORTS_PER_SOL } = web3;
const _bs58 = require('bs58');
const bs58 = _bs58 && _bs58.encode ? _bs58 : (_bs58 && _bs58.default) ? _bs58.default : _bs58;
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');

const KIND = 'svm';
// Wrapped SOL — the "native" mint Jupiter routes through for SOL<->token swaps.
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
// Phantom / Solflare standard derivation path for the first account.
const SOL_PATH = "m/44'/501'/0'/0'";
const JUP_BASE = (process.env.JUP_BASE || 'https://quote-api.jup.ag/v6').replace(/\/+$/, '');

// ---------------------------------------------------------------- validation

// A base58-encoded 32-byte ed25519 public key (a wallet address or an SPL mint).
// PublicKey validates the length + base58 alphabet; on-curve isn't required (mints
// and PDAs are valid addresses too).
function isSolAddress(s) {
  if (typeof s !== 'string') return false;
  s = s.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;   // base58, no 0/O/I/l
  try { const b = bs58.decode(s); return b.length === 32; } catch (_) { return false; }
}
// A Solana SECRET key the user might import: base58 of 64 bytes (~87–88 chars),
// or a JSON byte array "[12,34,...]" of length 64.
function isSolSecretKey(s) {
  if (typeof s !== 'string') return false;
  s = s.trim();
  if (/^\[\s*\d/.test(s)) { try { const a = JSON.parse(s); return Array.isArray(a) && a.length === 64; } catch (_) { return false; } }
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) { try { return bs58.decode(s).length === 64; } catch (_) { return false; } }
  return false;
}

// ---------------------------------------------------------------- keypair

// Build a Keypair from whatever the user has. Deterministic where it matters, so a
// user's existing generate/import flow yields a STABLE Solana address:
//   - a BIP39 mnemonic  → Phantom-compatible m/44'/501'/0'/0' derivation;
//   - a Solana secret   → the key itself (base58 64-byte or JSON array);
//   - an EVM 0x privkey → a domain-separated ed25519 seed (so an EVM-only wallet
//                          still maps to ONE fixed Solana address, distinct from EVM);
//   - nothing           → a fresh random keypair.
function deriveKeypair(secret) {
  secret = String(secret == null ? '' : secret).trim();
  if (!secret) return Keypair.generate();
  // Solana secret key (JSON array or base58 64-byte)
  if (isSolSecretKey(secret)) {
    const bytes = /^\[/.test(secret) ? Uint8Array.from(JSON.parse(secret)) : bs58.decode(secret);
    return Keypair.fromSecretKey(bytes);
  }
  const words = secret.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length) && bip39.validateMnemonic(words.join(' '))) {
    const seed = bip39.mnemonicToSeedSync(words.join(' '));                 // 64-byte BIP39 seed
    const { key } = derivePath(SOL_PATH, seed.toString('hex'));             // 32-byte ed25519 seed
    return Keypair.fromSeed(Uint8Array.from(key));
  }
  // EVM private key (64 hex, optional 0x): derive a SEPARATE, deterministic Solana
  // seed. Domain-separated so it can never collide with the EVM key's own bytes.
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(secret)) {
    const raw = Buffer.from(secret.replace(/^0x/, ''), 'hex');
    const seed = crypto.createHash('sha512').update(Buffer.concat([Buffer.from('robinfun:solana:v1'), raw])).digest().subarray(0, 32);
    return Keypair.fromSeed(Uint8Array.from(seed));
  }
  throw new Error('not a Solana key, EVM key, or seed phrase');
}
// The stored (encrypted) plaintext for a Solana wallet: base58 of the 64-byte secret
// key — exactly what Phantom/Solflare import. Round-trips via deriveKeypair.
function secretToBase58(keypair) { return bs58.encode(keypair.secretKey); }
function keypairFromStored(plain) {
  const bytes = /^\[/.test(String(plain).trim()) ? Uint8Array.from(JSON.parse(plain)) : bs58.decode(String(plain).trim());
  return Keypair.fromSecretKey(bytes);
}
// New Solana wallet material (encryption is core.js's job). `plain` is what gets
// stored (encrypted); `address` is the public base58.
function newWallet(secret) {
  const kp = deriveKeypair(secret);
  return { kind: KIND, address: kp.publicKey.toBase58(), plain: secretToBase58(kp) };
}

// ---------------------------------------------------------------- unit math

const solToLamports = (sol) => BigInt(Math.round(Number(sol) * LAMPORTS_PER_SOL));
const lamportsToSol = (lamports) => Number(lamports) / LAMPORTS_PER_SOL;
// Format a raw u64 token amount with its mint decimals (SPL mints are 6 or 9, never
// assume 18). Returns a JS number for display.
function fmtUnits(raw, decimals) {
  const d = Number.isFinite(decimals) ? decimals : 9;
  return Number(BigInt(raw)) / Math.pow(10, d);
}
function toRaw(amount, decimals) {
  const d = Number.isFinite(decimals) ? decimals : 9;
  return BigInt(Math.round(Number(amount) * Math.pow(10, d)));
}

// ---------------------------------------------------------------- Jupiter (pure builders)

// GET .../quote URL. amountRaw is the input amount in the input mint's base units
// (lamports for WSOL). platformFeeBps (optional) is the bot's cut Jupiter withholds.
function quoteUrl({ inputMint, outputMint, amountRaw, slippageBps = 100, platformFeeBps }) {
  const p = new URLSearchParams({
    inputMint, outputMint, amount: String(amountRaw),
    slippageBps: String(slippageBps), swapMode: 'ExactIn',
    onlyDirectRoutes: 'false', asLegacyTransaction: 'false',
  });
  if (platformFeeBps > 0) p.set('platformFeeBps', String(platformFeeBps));
  return `${JUP_BASE}/quote?${p.toString()}`;
}
// POST .../swap body. `quoteResponse` is the JSON object returned by /quote.
function swapBody(quoteResponse, userPublicKey, { feeAccount, priorityLamports } = {}) {
  const body = {
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: false,
  };
  if (feeAccount) body.feeAccount = feeAccount;                                   // ATA that receives the platform fee
  if (priorityLamports > 0) body.prioritizationFeeLamports = Math.floor(priorityLamports);
  else body.prioritizationFeeLamports = 'auto';
  return body;
}
// Pull the headline numbers out of a /quote response (defensive).
function parseQuote(q) {
  if (!q || q.error) return null;
  return {
    inAmount: BigInt(q.inAmount || 0),
    outAmount: BigInt(q.outAmount || 0),
    minOut: BigInt(q.otherAmountThreshold || 0),        // after slippage
    priceImpactPct: Number(q.priceImpactPct || 0),
    raw: q,
  };
}
// Bot fee in bps applied to an ETH/SOL-denominated notional (mirrors EVM BOT_FEE_BPS).
function feeLamports(notionalLamports, feeBps) {
  return (BigInt(notionalLamports) * BigInt(Math.max(0, Math.round(feeBps || 0)))) / 10000n;
}

// ---------------------------------------------------------------- live RPC (production)

const _conns = {};
function getConnection(rpc) {
  const url = rpc || (process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com');
  if (!_conns[url]) _conns[url] = new Connection(url, { commitment: 'confirmed' });
  return _conns[url];
}
async function solBalance(conn, address) {
  try { return BigInt(await conn.getBalance(new PublicKey(address), 'confirmed')); } catch (_) { return 0n; }
}
// SPL balance of `mint` held by `owner`. Sums all token accounts (usually one ATA).
async function splBalance(conn, owner, mint) {
  try {
    const res = await conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
    let raw = 0n, decimals = 9;
    for (const it of (res.value || [])) {
      const info = it.account.data.parsed.info.tokenAmount;
      raw += BigInt(info.amount); decimals = info.decimals;
    }
    return { raw, decimals };
  } catch (_) { return { raw: 0n, decimals: 9 }; }
}
// Execute a Jupiter swap: deserialize the base64 tx, sign with the keypair, send,
// confirm. Returns the base58 signature. Throws with a readable reason on failure.
async function sendJupiterSwap(conn, keypair, swapTransactionB64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransactionB64, 'base64'));
  tx.sign([keypair]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  const bh = await conn.getLatestBlockhash('confirmed');
  const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
  if (conf && conf.value && conf.value.err) throw new Error('swap reverted on-chain: ' + JSON.stringify(conf.value.err));
  return sig;
}

// ---------------------------------------------------------------- Jupiter (live HTTP)

const _fetch = (...a) => (global.fetch ? global.fetch(...a) : Promise.reject(new Error('fetch unavailable')));
// GET a Jupiter quote and return the parsed headline numbers + the raw object (which
// the /swap endpoint requires verbatim). Throws a readable reason when there's no route.
async function getQuote({ inputMint, outputMint, amountRaw, slippageBps = 100, platformFeeBps }) {
  const url = quoteUrl({ inputMint, outputMint, amountRaw, slippageBps, platformFeeBps });
  const r = await _fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('Jupiter quote failed (' + r.status + ')');
  const j = await r.json();
  const q = parseQuote(j);
  if (!q || q.outAmount <= 0n) throw new Error('no route / no liquidity for this token on Jupiter');
  return q;   // { inAmount, outAmount, minOut, priceImpactPct, raw }
}
// POST the quote back to /swap and get the base64 VersionedTransaction to sign.
async function getSwapTx(quoteRaw, userPublicKey, { feeAccount, priorityLamports } = {}) {
  const body = swapBody(quoteRaw, userPublicKey, { feeAccount, priorityLamports });
  const r = await _fetch(JUP_BASE + '/swap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('Jupiter swap-build failed (' + r.status + ')');
  const j = await r.json();
  if (!j || !j.swapTransaction) throw new Error('Jupiter returned no swap transaction');
  return j.swapTransaction;   // base64
}
// One-shot: quote → build → sign → send → confirm. Returns { sig, quote }.
async function swap(conn, keypair, { inputMint, outputMint, amountRaw, slippageBps, priorityLamports }) {
  const quote = await getQuote({ inputMint, outputMint, amountRaw, slippageBps });
  const txB64 = await getSwapTx(quote.raw, keypair.publicKey.toBase58(), { priorityLamports });
  const sig = await sendJupiterSwap(conn, keypair, txB64);
  return { sig, quote };
}

// ---------------------------------------------------------------- native SOL transfer

// Send `lamports` SOL from `keypair` to `toBase58`. Used for the bot fee and for
// withdrawals. Confirms and returns the base58 signature.
async function sendSol(conn, keypair, toBase58, lamports) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey, toPubkey: new PublicKey(toBase58), lamports: BigInt(lamports),
  }));
  const bh = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = bh.blockhash; tx.feePayer = keypair.publicKey;
  tx.sign(keypair);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
  if (conf && conf.value && conf.value.err) throw new Error('SOL transfer failed: ' + JSON.stringify(conf.value.err));
  return sig;
}

// ---------------------------------------------------------------- SPL metadata

// Mint decimals straight from the mint account (authoritative; name/symbol live in
// Metaplex metadata, fetched best-effort below).
async function splDecimals(conn, mint) {
  try { const s = await conn.getTokenSupply(new PublicKey(mint)); return Number(s.value.decimals); } catch (_) { return 9; }
}
// Best-effort token identity from Jupiter's token registry (name/symbol/decimals).
// Returns null on any failure — callers fall back to a shortened mint. Never throws.
async function jupTokenMeta(mint) {
  try {
    const r = await _fetch('https://tokens.jup.ag/token/' + mint, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || (!j.symbol && !j.name)) return null;
    return { name: String(j.name || j.symbol || 'Token').slice(0, 40), sym: String(j.symbol || 'TOKEN').slice(0, 20), decimals: Number.isFinite(j.decimals) ? Number(j.decimals) : undefined };
  } catch (_) { return null; }
}
// Combined SPL meta: decimals from the chain (authoritative), name/symbol from Jupiter
// (best-effort). Always resolves to a usable object so a trade can be recorded.
async function splMeta(conn, mint) {
  const dec = await splDecimals(conn, mint);
  const j = await jupTokenMeta(mint);
  const shortMint = mint.slice(0, 4) + '…' + mint.slice(-4);
  return { name: (j && j.name) || shortMint, sym: (j && j.sym) || shortMint, decimals: (j && Number.isFinite(j.decimals)) ? j.decimals : dec };
}

// ---------------------------------------------------------------- market data (DexScreener)

// Best Solana market for `mint` from DexScreener (the deepest-liquidity pair). Gives
// price (USD + native), liquidity, 24h volume, market cap, and token identity — all a
// card needs. null when the token isn't indexed / has no pool. Never throws.
async function dexScreener(mint) {
  try {
    const r = await _fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const pairs = ((j && j.pairs) || []).filter((p) => p && p.chainId === 'solana' && Number(p.priceUsd) > 0);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (Number(b.liquidity && b.liquidity.usd) || 0) - (Number(a.liquidity && a.liquidity.usd) || 0));
    const p = pairs[0], base = p.baseToken || {};
    return {
      priceUsd: Number(p.priceUsd) || 0,
      priceNative: Number(p.priceNative) || 0,               // price in the quote token (SOL for SOL-quoted pairs)
      quoteSym: (p.quoteToken && p.quoteToken.symbol) || '',
      liquidityUsd: Number(p.liquidity && p.liquidity.usd) || 0,
      volH24Usd: Number(p.volume && p.volume.h24) || 0,
      mcapUsd: Number(p.marketCap) || Number(p.fdv) || 0,
      fdvUsd: Number(p.fdv) || 0,
      name: String(base.name || '').slice(0, 40),
      symbol: String(base.symbol || '').slice(0, 20),
      dexId: p.dexId || '',
    };
  } catch (_) { return null; }
}

module.exports = {
  KIND, WSOL_MINT, SOL_PATH, LAMPORTS_PER_SOL, JUP_BASE,
  isSolAddress, isSolSecretKey,
  deriveKeypair, secretToBase58, keypairFromStored, newWallet,
  solToLamports, lamportsToSol, fmtUnits, toRaw,
  quoteUrl, swapBody, parseQuote, feeLamports,
  getConnection, solBalance, splBalance, sendJupiterSwap,
  getQuote, getSwapTx, swap, sendSol, splDecimals, jupTokenMeta, splMeta, dexScreener,
};
