# Robinfun Trade Bot

A **custodial, Maestro-style, multi-chain Telegram trading bot** for
[Robinfun](https://robinfun.io). Users trade tokens straight from Telegram — no
website, no wallet extension.

**Chains:** Robinhood Chain (Robinfun bonding curves), Ethereum, Base, BNB Chain,
Arbitrum. One EVM key is the **same address on every chain** — switch with `/chain`.
On Robinhood Chain trades route to the Robinfun curve (then its DEX after
graduation); on every other chain they route to that chain's Uniswap-V2/PancakeSwap
DEX (any token, by contract address). Solana / non-EVM is a separate future module.

## Features

- **Wallets (up to 10 per user)** — hold multiple bot-managed wallets, **generate**
  fresh ones or **import** your own (private key or 12–24-word seed phrase — the
  message holding the secret is deleted immediately), and **switch** the active one
  anytime. Each wallet has its own balance, positions and orders. Private keys are
  encrypted at rest with AES-256-GCM under `WALLET_SECRET` and only decrypted
  transiently to sign a trade the user asked for. Deposit / withdraw / export-key
  built in. Removing a wallet is blocked while it still holds native (no stranding),
  and you always keep at least one.
- **Buy / Sell by CA** — paste a contract address → live card (price, mcap,
  graduation %, your bag & PnL) with one-tap buy/sell. Routes to the bonding curve
  while listed, and to Uniswap V2 once graduated — same path as the website.
- **Rich token scan** — paste a CA for a Maestro-style card: price, market cap,
  liquidity/raised, 24h volume, holders, LP status, buy/sell tax, honeypot, age
  and socials (on-chain + Robinfun API + GoPlus), with a HIGH-RISK banner.
- **Portfolio + History** — open positions with live value and unrealized PnL, a
  per-wallet trade log, and realized PnL.
- **Snipe (multi-chain)** — auto-buy every new Robinfun launch, and (opt-in per
  chain) every new Uniswap/Pancake pair on ETH/Base/BNB/Arbitrum; honeypots skipped.
- **Limit / TP / SL + Price alerts** — set a USD target; the bot polls the price
  and executes (orders) or just pings you (alerts, notify-only) when crossed.
- **Copy-trading (beta)** — follow a wallet and mirror its BUYS with your active
  wallet; honeypots skipped and total spend per target is hard-capped (bounded loss).
- **Referrals** — share a `?start=<code>` link; referrers earn `REF_SHARE_BPS` of
  the bot fee. Auto-paid from `FEE_WALLET` when `FEE_WALLET_KEY` is set (else manual).

## Revenue

A flat `BOT_FEE_BPS` (default **1%**) of each trade's ETH value is sent to
`FEE_WALLET`. Referrers get `REF_SHARE_BPS` (default 30%) of that fee, accrued in
the store (`_refOwedWei`) for you to settle.

## Run

```bash
cp .env.example .env      # fill in TRADEBOT_TOKEN, WALLET_SECRET, FEE_WALLET
npm install
npm start                 # long-polls Telegram; no inbound ports needed
```

On the VPS it runs under pm2 as `robinfun-tradebot` (see `deploy/update-all.sh`).

## Security notes (custodial = high responsibility)

- **`WALLET_SECRET` is the crown jewel.** Set it once to a long random value and
  back it up offline. If it leaks, every user wallet is compromised; if it changes,
  existing wallets can't be decrypted.
- Keys are never logged and never written in plaintext. The store
  (`data/tradebot.json`) holds only ciphertext.
- Withdrawals require the user to type the destination — nothing leaves a wallet
  without an explicit user action.
- This is beta software holding real funds. Tell users to keep balances small.

## Files

| file | role |
|------|------|
| `core.js` | chain + custody + trading engine + referrals |
| `watchers.js` | snipe + limit/TP-SL background loops |
| `telegram.js` | Telegram UI (commands, inline buttons, flows) |
| `index.js` | entrypoint |
