# Robinfun Seeder Bot (self-funded, multi-wallet)

Auto-launches meme tokens on the Robinfun launchpad on a schedule. **You never
give it a private key.** The bot **generates its own N deployer wallets**,
prints their addresses, and your **only job is to send ETH to those
addresses**. It then round-robins launches from whichever wallets have ETH.

Each launch gets a random meme **name + ticker**, a random **meme image**
(public, SFW-filtered meme API — *not* Pinterest scraping), a configurable
**dev-buy**, and a **1% creator levy** by default. Metadata + logo are posted to
the backend so the token shows on the board.

## How it works

1. `node index.js` → the bot generates `NUM_WALLETS` (default **5**) wallets,
   saves the keys to `wallets.json` (chmod 600), and prints the addresses.
2. **You send ETH** to any/all of those addresses (the printed suggestion covers
   ~8 launches each).
3. The bot launches a token every `INTERVAL_SECONDS` from whichever wallet has
   enough ETH, and **waits** ("⏳ Waiting for ETH") whenever none are funded.

No funder key, no owner key, no secrets to paste anywhere.

## Config (env or `.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `NUM_WALLETS` | `5` | Deployer wallets the bot generates (1–20). |
| `DEV_BUY_ETH` | `0.001` | ETH each launch buys of its own token. |
| `CREATOR_LEVY_BPS` | `100` (1%) | Creator fee, buy + sell (max 1000 = 10%). |
| `INTERVAL_SECONDS` | `60` | Seconds between launches. |
| `MAX_TOKENS` | `0` | Optional count cap (0 = until wallets run dry). |
| `WALLET_FILE` | `./wallets.json` | Where the generated keys are stored (**keep private!**). |
| `FACTORY_ADDR`, `RPC`, `BACKEND`, `MEME_API`, `DRY_RUN` | live / defaults | See source. |
| `FUNDER_KEY` | *(blank)* | **Optional.** OWNER key → bot *also* auto-allow-lists + auto-funds the deployers. Not required. |
| `BUDGET_CAP_ETH` / `FUND_PER_WALLET_ETH` | `0.05` / `budget÷N` | Funder mode only: caps on ETH the funder sends out. |

## Run

**1. Dry run first — generates + prints the 5 wallets, spends nothing:**
```bash
cd /opt/robinfun/seeder && npm install
DRY_RUN=1 node index.js
```

**2. For real, under pm2:**
```bash
bash /opt/robinfun/deploy/bootstrap-seeder.sh
# then send ETH to the addresses it prints — it starts launching automatically
```
Or foreground: `cd /opt/robinfun/seeder && node index.js`.

**3. Reclaim leftover ETH** from the deployer wallets to any address:
```bash
cd /opt/robinfun/seeder && node index.js sweep 0xYourWallet
```

Control (pm2): `pm2 logs robinfun-seeder` · `pm2 stop robinfun-seeder` ·
`pm2 delete robinfun-seeder && pm2 save`.

## Allow-list note (betaMode)

The live factory has **betaMode ON**, so only allow-listed addresses can create
tokens. On startup the bot checks its wallets and, if they aren't allow-listed,
prints a warning and keeps running. Fix it **once** (no private key needed):

- **Admin panel** (robinfun.tech) → **Allow-list** → paste the printed addresses → **Allow**, **or**
- **Admin panel** → turn **beta OFF** (go public), after which funding alone is enough.

The bot launches the moment the wallets can create — no restart required.

*(Optional shortcut: set `FUNDER_KEY` to the owner wallet and the bot allow-lists
+ funds the deployers itself.)*

## Notes

- **`wallets.json` holds private keys** — it is git-ignored and chmod 600. It's
  how you (and `sweep`) recover the deployers' ETH. **Back it up.**
- **Instant graduation:** if `DEV_BUY_ETH` ≥ the graduation cap, tokens graduate
  to Uniswap immediately (thin pool). For tokens that stay *bonding*, use a
  smaller dev-buy (e.g. `0.0003` on a `0.001` cap) or raise the cap in the admin.
- Each launch logs which wallet created it, plus name, CA, dev-buy, gas ETH,
  levy %, logo, and tx hash.
