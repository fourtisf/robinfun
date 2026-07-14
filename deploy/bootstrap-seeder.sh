#!/usr/bin/env bash
#
# Robinfun — start the SEEDER bot under pm2 (auto-launch meme tokens on a
# schedule). ZERO private-key setup: the bot GENERATES its own deployer wallets
# and prints their addresses — your only job is to send ETH to them.
#
# ⚠️ Spends REAL ETH (deploy fee + dev-buy + gas per launch) — but only from the
#    generated wallets, and only up to whatever ETH you actually send them.
#
# TEST FIRST with a dry run (generates + prints wallets, spends nothing):
#   cd /opt/robinfun/seeder && DRY_RUN=1 node index.js
#
# Run for real (as root, on the VPS) — no key needed:
#   DEV_BUY_ETH=0.001 CREATOR_LEVY_BPS=100 INTERVAL_SECONDS=60 \
#   /root/bootstrap-seeder.sh
#   # then send ETH to the addresses it prints; it starts launching automatically.
#
set -uo pipefail
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# No key required — the bot self-generates its deployer wallets. (Optional:
# FUNDER_KEY / PRIVATE_KEY, or seeder/.env, to auto-allow-list + auto-fund.)
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

log "Starting robinfun-seeder under pm2 (${NUM_WALLETS:-5} self-generated wallets, every ${INTERVAL_SECONDS:-60}s)"
cd "$SRC_DIR/seeder"
pm2 delete robinfun-seeder >/dev/null 2>&1 || true
pm2 start index.js --name robinfun-seeder --update-env || die "pm2 start failed"
pm2 save

log "Done. The addresses to fund are in the logs below (send ETH to them)."
log "Watch it: pm2 logs robinfun-seeder"
echo "   Stop it:  pm2 stop robinfun-seeder   ·   Remove: pm2 delete robinfun-seeder && pm2 save"
pm2 logs robinfun-seeder --lines 15 --nostream || true
