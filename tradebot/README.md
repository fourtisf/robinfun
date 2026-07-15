# Robinfun Trade Bot

A **custodial, Maestro-style Telegram trading bot** for [Robinfun](https://robinfun.io)
on Robinhood Chain. Users trade any Robinfun token straight from Telegram — no
website, no wallet extension.

## Features

- **Wallet** — every user gets a bot-managed wallet. Private keys are encrypted at
  rest with AES-256-GCM under `WALLET_SECRET` and only decrypted transiently to
  sign a trade the user asked for. Deposit / withdraw / export-key built in.
- **Buy / Sell by CA** — paste a contract address → live card (price, mcap,
  graduation %, your bag & PnL) with one-tap buy/sell. Routes to the bonding curve
  while listed, and to Uniswap V2 once graduated — same path as the website.
- **Portfolio** — open positions with live value and unrealized/realized PnL.
- **Snipe** — auto-buy every new launch the moment its `TokenCreated` event fires.
- **Limit / TP / SL** — set a USD target; the bot polls the curve price and
  executes the buy/sell when crossed.
- **Referrals** — share a `?start=<code>` link; referrers earn `REF_SHARE_BPS` of
  the bot fee from everyone they invite.

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
