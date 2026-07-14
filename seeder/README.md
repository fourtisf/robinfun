# Robinfun Seeder Bot (multi-wallet)

Auto-launches meme tokens on the Robinfun launchpad on a schedule, spreading
launches across **N freshly generated deployer wallets** so the board shows
varied creators. Each launch gets a random meme **name + ticker**, a random
**meme image** (public, SFW-filtered meme API — *not* Pinterest scraping), a
configurable **dev-buy**, and a **1% creator levy** by default. Metadata + logo
are posted to the backend so the token shows on the board.

The **funder** (your allow-listed **owner** key) does the plumbing automatically:
1. generates / loads N deployer wallets → persisted to `wallets.json` (chmod 600),
2. **allow-lists** them on-chain (`setBetaAllowed`) while `betaMode` is ON,
3. **funds** each with ETH,

then the bot round-robins launches across them. There is a **hard budget cap**
(total ETH the funder sends out), so it can never run away with real ETH.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `FUNDER_KEY` (or `PRIVATE_KEY`) | — (required) | Funder **+ owner** wallet key (funds + allow-lists the deployers). |
| `NUM_WALLETS` | `5` | How many deployer wallets to use (2–5+). |
| `FUND_PER_WALLET_ETH` | `BUDGET_CAP_ETH / NUM_WALLETS` | ETH sent to each deployer. |
| `BUDGET_CAP_ETH` | `0.05` | **Hard stop** — max total ETH the funder sends out. |
| `DEV_BUY_ETH` | `0.001` | ETH each launch buys of its token. |
| `CREATOR_LEVY_BPS` | `100` (1%) | Creator fee, buy + sell (max 1000 = 10%). |
| `INTERVAL_SECONDS` | `60` | Seconds between launches. |
| `MAX_TOKENS` | `0` | Optional count cap (0 = until wallets run dry). |
| `WALLET_FILE` | `./wallets.json` | Where the generated keys are stored (keep private!). |
| `FACTORY_ADDR`, `RPC`, `BACKEND`, `MEME_API`, `DRY_RUN` | live / defaults | See source. |

## Run

**1. Dry run first (generates wallets, spends nothing):**
```bash
cd /opt/robinfun/seeder && npm install
DRY_RUN=1 FUNDER_KEY=0xOWNERKEY NUM_WALLETS=5 node index.js
```

**2. For real, under pm2:**
```bash
FUNDER_KEY=0xOWNERKEY NUM_WALLETS=5 DEV_BUY_ETH=0.001 CREATOR_LEVY_BPS=100 \
BUDGET_CAP_ETH=0.05 INTERVAL_SECONDS=60 \
  bash /opt/robinfun/deploy/bootstrap-seeder.sh
```

**3. Reclaim leftover ETH** from the deployer wallets back to the funder:
```bash
cd /opt/robinfun/seeder && FUNDER_KEY=0xOWNERKEY node index.js sweep
```

Control: `pm2 logs robinfun-seeder` · `pm2 stop robinfun-seeder` ·
`pm2 delete robinfun-seeder && pm2 save`.

## Notes

- **`wallets.json` holds private keys** — it is git-ignored and chmod 600. Keep
  it safe; it's how you (and `sweep`) recover the deployers' ETH. Back it up.
- The funder must be the **owner** (to allow-list) and hold enough ETH to fund
  all deployers + a little gas.
- **Instant graduation:** if `DEV_BUY_ETH` ≥ the graduation cap, tokens graduate
  to Uniswap immediately (thin pool). For tokens that stay *bonding*, use a
  smaller dev-buy (e.g. `0.0003` on a `0.001` cap) or raise the cap in the admin.
- Each launch logs which wallet created it, plus name, CA, dev-buy, gas ETH,
  levy %, logo, and tx hash.
