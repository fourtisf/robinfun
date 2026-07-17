# Solana go-live checklist (Robinfun Trade Bot)

Solana ships **off by default**. Everything below is what to do — in order — before real
users trade SOL on the bot. Do the read-only preflight first; only spend money once it's
green, and only tiny amounts until the manual pass succeeds.

## 0. Prerequisites
- A **private Solana RPC** (Helius / Triton / QuickNode). The public mainnet-beta node is
  rate-limited far too hard for signature polling (copy-trade) and snipe.
- A **Solana fee wallet** (base58) for the 1% bot fee — or leave `SOL_FEE_WALLET` empty to
  waive it while testing.

Set in `.env`:
```
SOLANA_RPC=https://<your-rpc>
SOL_FEE_WALLET=<your base58 fee wallet>   # optional
SOL_PRIORITY_LAMPORTS=200000              # optional: competitive snipe priority
```
Do **not** add `solana` to `ENABLED_CHAINS` yet.

## 1. Read-only preflight (no funds)
```
cd tradebot
SOLANA_RPC=$SOLANA_RPC node scripts/solana-preflight.js
```
All checks must be ✅: RPC reachable, key-derivation anchor stable, Jupiter quote +
swap-build, DexScreener, RugCheck, pump.fun feed. A ❌ means that feature won't work in
production — fix it (usually the RPC or network egress) before continuing.

## 2. Enable Solana
Add it to the enabled set and restart:
```
ENABLED_CHAINS=robinhood,ethereum,base,bsc,arbitrum,solana
```
`sudo bash /root/ua.sh` (pulls, `npm install`, restarts pm2). `npm install` will pull the
Solana deps (`@solana/web3.js`, `@solana/spl-token`, `bip39`, `bs58`, `ed25519-hd-key`).

## 3. Manual money pass — TINY amounts (0.01–0.03 SOL)
From your own Telegram account on the bot:
1. `🌐 Chain → 🟣 Solana`. Tap `📥` on a wallet → **deposit ~0.03 SOL** to the shown
   base58 address. `🔄 Refresh` until it lands.
2. Paste a **liquid SPL mint** (e.g. BONK/WIF). Confirm the card shows price, mcap,
   liquidity, 24h vol, and a 🛡 Safety (RugCheck) line.
3. **Buy** the smallest preset. Confirm: tokens received, `Spent … SOL`, fee to
   `SOL_FEE_WALLET`, a Solscan tx link that resolves.
4. **Sell 100%.** Confirm SOL comes back (minus fee) and the position closes.
5. **📤 Send** a small amount of a held token to a second wallet (Phantom) — confirm the
   SPL transfer lands (a brand-new recipient costs ~0.002 SOL rent from you).
6. **Withdraw** the remaining SOL to an external base58 address (`📤 Withdraw`).
7. Optional: set a **TP/SL/Trail** and a small **DCA**; confirm they trigger.

## 4. Security before opening it up
- Turn on **⚙️ Security → 🔒 Lock / whitelist** for your own funds; confirm a withdrawal to
  a non-whitelisted address is refused.
- Confirm `/backup` writes a snapshot, and that `data/` is **rsynced off the VPS** and
  `WALLET_SECRET` is backed up offline. Losing either loses every user's funds.
- `/health` should show all loops 🟢.

## Known limits (by design)
- **Snipe** buys via Jupiter, so it catches tokens once they're routable — true
  first-second pump.fun-curve sniping needs a pump.fun program integration (future).
- **Referral** on Solana accrues in lamports and is **settled manually** (the EVM
  hot-key auto-payout does not apply to SOL).
- Solana RugCheck won't have data on a brand-new token (the safety gate fails open, same
  as GoPlus on a fresh EVM token).
