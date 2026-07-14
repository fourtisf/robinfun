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

: "${PRIVATE_KEY:?Set PRIVATE_KEY to the allow-listed wallet key (0x + 64 hex)}"
command -v node >/dev/null 2>&1 || die "node not found."
command -v pm2  >/dev/null 2>&1 || { log "Installing pm2"; npm install -g pm2 || die "pm2 install failed"; }
[ -f "$SRC_DIR/seeder/index.js" ] || die "seeder not found at $SRC_DIR/seeder — pull the branch first."

log "Installing seeder deps"
( cd "$SRC_DIR/seeder" && npm install --no-audit --no-fund ) || die "npm install failed"

# Config → export so pm2 --update-env passes them to the app.
export PRIVATE_KEY
export RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"
export FACTORY_ADDR="${FACTORY_ADDR:-0xfa5c740aec9d91cebdc9844e5ca6591f309a5dd2}"
export BACKEND="${BACKEND:-http://127.0.0.1:3001}"
export INTERVAL_SECONDS="${INTERVAL_SECONDS:-60}"
export DEV_BUY_ETH="${DEV_BUY_ETH:-0.001}"
export CREATOR_LEVY_BPS="${CREATOR_LEVY_BPS:-100}"
export BUDGET_CAP_ETH="${BUDGET_CAP_ETH:-0.05}"
export MAX_TOKENS="${MAX_TOKENS:-0}"
export DRY_RUN="${DRY_RUN:-}"

log "Starting robinfun-seeder under pm2 (budget cap ${BUDGET_CAP_ETH} ETH, every ${INTERVAL_SECONDS}s)"
cd "$SRC_DIR/seeder"
pm2 delete robinfun-seeder >/dev/null 2>&1 || true
pm2 start index.js --name robinfun-seeder --update-env || die "pm2 start failed"
pm2 save

log "Done. Watch it: pm2 logs robinfun-seeder"
echo "   Stop it:  pm2 stop robinfun-seeder   ·   Remove: pm2 delete robinfun-seeder && pm2 save"
pm2 logs robinfun-seeder --lines 15 --nostream || true
