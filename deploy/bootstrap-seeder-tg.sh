#!/usr/bin/env bash
#
# Robinfun — run the SEEDER TELEGRAM BOT under pm2. Control everything from
# Telegram: see wallets to fund, /go, /stop, /status, /last, tweak config.
#
# The bot generates its own deployer wallets (no private key input). It DOES
# need a Telegram bot token from @BotFather.
#
# 1) Put the token in seeder/.env  (git-ignored, chmod 600):
#      echo 'TELEGRAM_TOKEN=123456:ABC...' >> /opt/robinfun/seeder/.env
#    (Leak it? Revoke + regenerate in @BotFather first.)
# 2) Run:
#      bash /opt/robinfun/deploy/bootstrap-seeder-tg.sh
# 3) Message your bot on Telegram (first messager becomes admin) → /help.
#
set -uo pipefail
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node not found."
command -v pm2  >/dev/null 2>&1 || { log "Installing pm2"; npm install -g pm2 || die "pm2 install failed"; }
[ -f "$SRC_DIR/seeder/telegram.js" ] || die "seeder bot not found at $SRC_DIR/seeder — pull the branch first."

# Token must come from the shell (TELEGRAM_TOKEN / BOT_TOKEN) OR seeder/.env.
if [ -z "${TELEGRAM_TOKEN:-}${BOT_TOKEN:-}" ] && ! grep -qsE '^\s*(TELEGRAM_TOKEN|BOT_TOKEN)=' "$SRC_DIR/seeder/.env" 2>/dev/null; then
  die "No Telegram token. Add  TELEGRAM_TOKEN=...  to $SRC_DIR/seeder/.env  (from @BotFather), or run with TELEGRAM_TOKEN=... $0"
fi

log "Installing seeder deps"
( cd "$SRC_DIR/seeder" && npm install --no-audit --no-fund ) || die "npm install failed"

# Pass through ONLY what the operator set in the shell; the rest comes from .env.
for v in TELEGRAM_TOKEN BOT_TOKEN TELEGRAM_ADMIN_IDS FUNDER_KEY PRIVATE_KEY RPC \
         FACTORY_ADDR BACKEND APP_URL INTERVAL_SECONDS DEV_BUY_ETH CREATOR_LEVY_BPS \
         MAX_TOKENS NUM_WALLETS WALLET_FILE STATE_FILE; do
  if [ -n "${!v:-}" ]; then export "$v"; fi
done

# Avoid double-launching from the same wallets: stop the plain CLI seeder if present.
pm2 delete robinfun-seeder >/dev/null 2>&1 || true

log "Starting robinfun-seeder-bot under pm2"
cd "$SRC_DIR/seeder"
pm2 delete robinfun-seeder-bot >/dev/null 2>&1 || true
pm2 start telegram.js --name robinfun-seeder-bot --update-env || die "pm2 start failed"
pm2 save

log "Done. Open your bot in Telegram and send /help (first messager = admin)."
echo "   Logs:  pm2 logs robinfun-seeder-bot   ·   Stop: pm2 stop robinfun-seeder-bot"
pm2 logs robinfun-seeder-bot --lines 12 --nostream || true
