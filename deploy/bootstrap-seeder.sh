#!/usr/bin/env bash
#
# Robinfun — start the SEEDER bot under pm2 (auto-launch meme tokens on a
# schedule, budget-capped). Reads config from env; sensible defaults below.
#
# ⚠️ Spends REAL ETH (deploy fee + dev-buy + gas per launch). The BUDGET_CAP_ETH
#    is a hard stop — the bot exits once it has spent that much.
#
# TEST FIRST with a dry run (no transactions):
#   cd /opt/robinfun/seeder && DRY_RUN=1 PRIVATE_KEY=0x... node index.js
#
# Run for real (as root, on the VPS):
#   PRIVATE_KEY=0xYOUR_ALLOWLISTED_KEY \
#   DEV_BUY_ETH=0.001 CREATOR_LEVY_BPS=100 BUDGET_CAP_ETH=0.05 INTERVAL_SECONDS=60 \
#   /root/bootstrap-seeder.sh
#
set -uo pipefail
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Key comes from EITHER the shell (FUNDER_KEY/PRIVATE_KEY) OR seeder/.env.
if [ -z "${FUNDER_KEY:-}${PRIVATE_KEY:-}" ] && [ ! -f "$SRC_DIR/seeder/.env" ]; then
  die "No funder key. Either: (a) cp $SRC_DIR/seeder/.env.example $SRC_DIR/seeder/.env && edit it, or (b) run with FUNDER_KEY=0x... ./bootstrap-seeder.sh"
fi
command -v node >/dev/null 2>&1 || die "node not found."
command -v pm2  >/dev/null 2>&1 || { log "Installing pm2"; npm install -g pm2 || die "pm2 install failed"; }
[ -f "$SRC_DIR/seeder/index.js" ] || die "seeder not found at $SRC_DIR/seeder — pull the branch first."

log "Installing seeder deps"
( cd "$SRC_DIR/seeder" && npm install --no-audit --no-fund ) || die "npm install failed"

# Pass through ONLY what the operator actually set in the shell; everything else
# comes from seeder/.env (or the app defaults). This keeps .env authoritative.
for v in FUNDER_KEY PRIVATE_KEY RPC FACTORY_ADDR BACKEND INTERVAL_SECONDS \
         DEV_BUY_ETH CREATOR_LEVY_BPS BUDGET_CAP_ETH MAX_TOKENS DRY_RUN \
         NUM_WALLETS FUND_PER_WALLET_ETH WALLET_FILE; do
  if [ -n "${!v:-}" ]; then export "$v"; fi
done

log "Starting robinfun-seeder under pm2 (budget cap ${BUDGET_CAP_ETH:-from .env/default} ETH, every ${INTERVAL_SECONDS:-60}s)"
cd "$SRC_DIR/seeder"
pm2 delete robinfun-seeder >/dev/null 2>&1 || true
pm2 start index.js --name robinfun-seeder --update-env || die "pm2 start failed"
pm2 save

log "Done. Watch it: pm2 logs robinfun-seeder"
echo "   Stop it:  pm2 stop robinfun-seeder   ·   Remove: pm2 delete robinfun-seeder && pm2 save"
pm2 logs robinfun-seeder --lines 15 --nostream || true
