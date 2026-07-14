# Robinfun Seeder Bot (self-funded, multi-wallet)

Auto-launches meme tokens on the Robinfun launchpad on a schedule. **You never
give it a private key.** The bot **generates its own N deployer wallets**
(default 5), and your **only job is to send ETH to them**. It then round-robins
launches from whichever wallets have ETH.

Each launch gets a random meme **name + ticker**, a random **meme image**
(public, SFW-filtered meme API — *not* Pinterest scraping), a configurable
**dev-buy**, and a **1% creator levy** by default. Metadata + logo are posted to
the backend so the token shows on the board.

Two ways to run it:

- **🤖 Telegram bot** (recommended) — control it from your phone: see the wallets
  to fund, `/go`, `/stop`, `/status`, `/last`, tweak config. → `node telegram.js`
- **🖥️ CLI** — runs in a terminal, prints the wallets, launches automatically once
  funded. → `node index.js`

Both share the **same** generated wallets (`wallets.json`) and logic (`core.js`).
Run **only one** at a time so the same wallets aren't used twice.

---

## 🤖 Telegram bot (recommended)

1. **Create the bot** in [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token.
   (If the token ever leaks, `/revoke` in BotFather and regenerate.)
2. **Add the token** to `seeder/.env` (git-ignored):
   ```bash
   echo 'TELEGRAM_TOKEN=123456:ABC...' >> /opt/robinfun/seeder/.env
   ```
3. **Start it under pm2:**
   ```bash
   bash /opt/robinfun/deploy/bootstrap-seeder-tg.sh
   ```
4. **Open your bot in Telegram and send `/help`.** The first person to message it
   becomes the admin (lock it down with `TELEGRAM_ADMIN_IDS` if you prefer).

### Commands
| Command | What it does |
|---------|--------------|
| `/wallets` | Deployer addresses + balances on **both** Robinhood Chain and Ethereum L1, each with a live **USD** value. |
| `/bridge` | Move ETH from **Ethereum L1 → Robinhood Chain** (canonical Orbit `depositEth`, same address). Requires a verified `L1_INBOX_ADDR`. |
| `/keys` | 🔑 Reveal the deployer **private keys** (admin only, spoiler-hidden). |
| `/go` | Start auto-launching (every `interval`s from any funded wallet). |
| `/stop` | Pause launching. |
| `/status` | Running state, launch count, balances (+ USD), beta/allow-list. |
| `/stats` | Tokens created + total market cap (ETH + USD). |
| `/last` | The most recently launched tokens (name, ticker, CA, MC). |
| `/config` | Show current settings. |
| `/devbuy 0.001` · `/interval 60` · `/levy 100` · `/max 0` | Change settings live. |
| `/allowlist` | Check (and, with `FUNDER_KEY`, fix) beta allow-listing. |
| `/sweep 0x…` | Reclaim leftover ETH from the deployer wallets. |

**Security:** the bot authenticates by Telegram **user id** (not chat id) and only
auto-claims admin in a **private** chat. Set `TELEGRAM_ADMIN_IDS` to lock the admin
list explicitly. `/keys` and `/bridge` move real value — keep the bot private.

### Bridge (Ethereum L1 → Robinhood Chain)

Robinhood Chain settles to Ethereum mainnet, so a deployer wallet can bridge its
own ETH to the **same address** on Robinhood Chain via the canonical Orbit
`Inbox.depositEth()`. To enable it you must set the **verified** L1 Inbox address:

```bash
# get the REAL Inbox address from https://docs.robinhood.com/chain/protocol-contracts/
# verify it on blockscout/etherscan, then:
echo 'L1_INBOX_ADDR=0x...' >> seeder/.env
pm2 restart robinfun-seeder-bot
```

The bot never sends ETH to an unverified/scam Inbox: `L1_INBOX_ADDR` has no default,
and the bot checks the address has contract code before depositing. Deposits keep a
gas reserve, use a bounded confirmation wait, and take ~10–15 min to appear on
Robinhood Chain. ⚠️ Never use `robinhood-bridge.app` / `robinbridge.xyz` — phishing.

**Flow: `/wallets` → send ETH → `/go` ✅** — it launches automatically and DMs you
each new token.

---

## 🖥️ CLI

**1. Dry run first — generates + prints the wallets, spends nothing:**
```bash
cd /opt/robinfun/seeder && npm install
DRY_RUN=1 node index.js
```

**2. For real, under pm2:**
```bash
bash /opt/robinfun/deploy/bootstrap-seeder.sh
# then send ETH to the printed addresses — it starts launching automatically
```

**3. Reclaim leftover ETH** from the deployer wallets to any address:
```bash
cd /opt/robinfun/seeder && node index.js sweep 0xYourWallet
```

---

## Config (env or `.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `NUM_WALLETS` | `5` | Deployer wallets the bot generates (1–20). |
| `DEV_BUY_ETH` | `0.001` | ETH each launch buys of its own token. |
| `CREATOR_LEVY_BPS` | `100` (1%) | Creator fee, buy + sell (max 1000 = 10%). |
| `INTERVAL_SECONDS` | `60` | Seconds between launches. |
| `MAX_TOKENS` | `0` | Optional count cap (0 = until wallets run dry). |
| `WALLET_FILE` | `./wallets.json` | Where the generated keys are stored (**keep private!**). |
| `TELEGRAM_TOKEN` | *(blank)* | Telegram bot token (only for `telegram.js`). |
| `TELEGRAM_ADMIN_IDS` | *(blank)* | Comma-separated chat IDs; blank = first messager claims admin. |
| `FACTORY_ADDR`, `RPC`, `BACKEND`, `APP_URL`, `MEME_API`, `DRY_RUN` | live / defaults | See source. |
| `FUNDER_KEY` | *(blank)* | **Optional.** OWNER key → bot *also* auto-allow-lists + auto-funds the deployers. Not required. |
| `BUDGET_CAP_ETH` / `FUND_PER_WALLET_ETH` | `0.05` / `budget÷N` | Funder mode only. |

## Allow-list note (betaMode)

The live factory has **betaMode ON**, so only allow-listed addresses can create
tokens. The bot checks its wallets on startup / via `/allowlist` and warns if
they aren't allowed. Fix it **once** (no private key needed):

- **Admin panel** (robinfun.tech) → **Allow-list** → paste the addresses → **Allow**, or
- **Admin panel** → turn **beta OFF** (go public), after which funding alone is enough.

*(Optional shortcut: set `FUNDER_KEY` to the owner wallet and the bot allow-lists
+ funds the deployers itself.)*

## Files

- `core.js` — shared config, wallet generation, meme fetch, launch logic.
- `index.js` — CLI runner.
- `telegram.js` — Telegram control bot (long-polling, no open port needed).
- `wallets.json` — **the generated private keys** (git-ignored, chmod 600). **Back it up** — it's how you (and `sweep`) recover the deployers' ETH.
- `bot-state.json` — Telegram admins + config + launch history (git-ignored).

## Notes

- **Instant graduation:** if `DEV_BUY_ETH` ≥ the graduation cap, tokens graduate
  to Uniswap immediately (thin pool). For tokens that stay *bonding*, use a
  smaller dev-buy (e.g. `0.0003` on a `0.001` cap) or raise the cap in the admin.
- Each launch logs/announces which wallet created it, plus name, CA, dev-buy,
  gas ETH, levy %, logo, and tx hash.
