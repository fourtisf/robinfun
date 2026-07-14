# Robinfun Seeder Bot

Auto-launches meme tokens on the Robinfun launchpad on a schedule, so the board
stays active. Each launch gets a random meme **name + ticker**, a random **meme
image** (from a public, SFW-filtered meme API — *not* Pinterest scraping), a
configurable **dev-buy**, and a **1% creator levy** by default. Metadata + logo
are posted to the backend so the token shows on the board.

**It spends real ETH** (deploy fee + dev-buy + gas per launch) — so there is a
**hard budget cap**: the bot stops itself once it has spent `BUDGET_CAP_ETH`.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PRIVATE_KEY` | — (required) | Allow-listed wallet key (the one permitted to create). |
| `DEV_BUY_ETH` | `0.001` | ETH the bot buys of each token at launch. |
| `CREATOR_LEVY_BPS` | `100` (1%) | Creator fee, buy + sell, in bps (max 1000 = 10%). |
| `BUDGET_CAP_ETH` | `0.05` | **Hard stop** — bot exits after spending this much total. |
| `INTERVAL_SECONDS` | `60` | Seconds between launches. |
| `MAX_TOKENS` | `0` | Optional count cap (0 = unlimited, until budget). |
| `FACTORY_ADDR` | live factory | Launchpad factory address. |
| `RPC` | Robinhood mainnet | RPC URL. |
| `BACKEND` | `http://127.0.0.1:3001` | Metadata API for logos/board. |
| `MEME_API` | `meme-api.com/gimme` | Random meme image source. |
| `DRY_RUN` | off | `1` → simulate, send **no** transactions. |

## Run

**1. Dry run first (no ETH spent):**
```bash
cd /opt/robinfun/seeder && npm install
DRY_RUN=1 PRIVATE_KEY=0xYOURKEY node index.js
```

**2. For real, under pm2 (survives reboots):**
```bash
PRIVATE_KEY=0xYOURKEY DEV_BUY_ETH=0.001 CREATOR_LEVY_BPS=100 BUDGET_CAP_ETH=0.05 INTERVAL_SECONDS=60 \
  bash /opt/robinfun/deploy/bootstrap-seeder.sh
```

Watch / control:
```bash
pm2 logs robinfun-seeder     # live launches
pm2 stop robinfun-seeder     # pause
pm2 delete robinfun-seeder && pm2 save   # remove
```

## Notes

- The wallet must be **allow-listed** (while `betaMode` is ON) and hold enough
  ETH. The bot warns if it isn't allow-listed and stops on low balance.
- **Instant graduation:** if `DEV_BUY_ETH` ≥ the graduation cap, a token
  graduates to Uniswap immediately (thin pool). To keep tokens *bonding* on the
  curve, use a dev-buy smaller than the cap (e.g. `0.0003` on a `0.001` cap), or
  raise the cap in the admin panel.
- Each launch is logged with name, CA, dev-buy, **gas ETH used**, creator fee,
  logo URL, running total vs cap, and tx hash.
