# @robinlistbot — Robinfun listing bot

A Telegram bot that lets projects **pay to list** their token on Robinfun. It
verifies the fee payment **on-chain**, then auto-posts the token to the
listings channel (`@robinfunlisting`) and saves it to the Robinfun board (the
M3 API). No admin approval — the payment is the anti-spam gate.

```
User DMs the bot ─ /list ─▶ wizard (name, ticker, CA, fee, socials, logo)
        ▼
  "Send 0.01 ETH to <treasury>, paste the tx hash"
        ▼
  bot verifies the tx on Robinhood Chain (to == treasury, value ≥ fee,
  confirmed, not reused)
        ▼
  posts to @robinfunlisting  +  POST /api/tokens  ─▶ shows on robinfun.io
```

## Why on-chain payment (not Telegram Payments)

The fee is a plain ETH transfer to the Robinfun treasury on Robinhood Chain, so
it needs no card processor and the money lands directly in your wallet. The bot
checks the transaction with `eth_getTransactionByHash` / `…Receipt` and rejects
wrong-recipient, underpaid, unconfirmed, failed, or **already-used** hashes.

## Commands

- `/list` — start a listing (private chat only)
- `/fee` — show the current listing fee + treasury address
- `/help` — how it works
- `/cancel` — abort the current listing
- `/stats` — admin only (set `ADMIN_IDS`)

## Configure

Copy `config.example.env` → `/etc/robinfun-bot.env` and fill it in. Key vars:

| Var | Meaning |
|---|---|
| `BOT_TOKEN` | from [@BotFather](https://t.me/BotFather) — **secret** |
| `TREASURY` | wallet that receives listing fees |
| `LISTING_CHANNEL` | e.g. `@robinfunlisting` (add the bot as **admin**) |
| `LISTING_FEE_ETH` | fee in ETH (default `0.01`) |
| `RPC_URL` / `CHAIN_ID` | Robinhood Chain (testnet by default) |
| `API_URL` | the Robinfun metadata API (default `http://127.0.0.1:3001`) |
| `MIN_CONFIRMATIONS` | confirmations required (default `2`) |
| `ADMIN_IDS` | Telegram user ids allowed to run `/stats` |

> **Testnet first:** with the default testnet RPC the fee is faucet ETH (free),
> so you can rehearse the whole flow at no cost. Switch `RPC_URL`/`CHAIN_ID` +
> `TREASURY` and set a real `LISTING_FEE_ETH` when you go to mainnet.

## Run

**On the VPS (recommended):** use `deploy/bootstrap-bot.sh` — installs Node,
pulls the code, writes the env file, and runs the bot as the `robinfun-bot`
systemd service. See `deploy/README.md`.

**Locally:**
```bash
cd bot
npm install
BOT_TOKEN=… TREASURY=0x… LISTING_CHANNEL=@robinfunlisting npm start
```

## Setup checklist

1. Create the bot with @BotFather → get `BOT_TOKEN`. Reserve the username
   `@robinlistbot`.
2. Create the channel `@robinfunlisting` and **add the bot as an administrator**
   (needs "Post messages").
3. Run `deploy/bootstrap-bot.sh` with `BOT_TOKEN` / `TREASURY` /
   `LISTING_CHANNEL`.
4. Try it: DM the bot `/list`.

## Tests

```bash
npm test        # offline unit tests for the payment-verification logic
```

## Security notes

- **Replay-proof:** every accepted tx hash is stored; reuse is rejected.
- **Content is HTML-escaped** before it is posted to the channel (no markup
  injection from user-supplied names/links).
- `BOT_TOKEN` lives only in `/etc/robinfun-bot.env` (chmod 600); never commit it.
- The bot never holds funds or keys — it only *reads* the chain to confirm a
  payment that went straight to your treasury.
- Auto-post means anyone who pays can list any contract address. Listing is a
  paid promotion, **not** an endorsement or an audit — consider a disclaimer in
  the channel description.
