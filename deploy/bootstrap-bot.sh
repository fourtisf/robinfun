#!/usr/bin/env bash
#
# Robinfun — deploy the Telegram listing bot (@robinlistbot) on the VPS.
# Runs as a systemd service (long polling — no inbound port / nginx needed).
# The bot verifies listing-fee payments on Robinhood Chain, then posts the
# token to the listings channel and the Robinfun board (the M3 API).
#
# Idempotent: re-run to pick up new code or config.
#
# Usage (root, on the VPS):
#   BOT_TOKEN=123:ABC TREASURY=0xYourWallet LISTING_CHANNEL=@robinfunlisting \
#   LISTING_FEE_ETH=0.01 ./bootstrap-bot.sh
#
#   BOT_TOKEN        from @BotFather (required)
#   TREASURY         wallet that receives listing fees (required)
#   LISTING_CHANNEL  channel the bot posts to; add the bot as ADMIN there (required)
#   LISTING_FEE_ETH  fee in ETH (default 0.01)
#   RPC_URL          chain RPC (default: Robinhood Chain testnet)
#   CHAIN_ID         default 46630
#   ADMIN_IDS        Telegram user ids allowed to run /stats (optional)
#
# You can also just run it once to install everything, then edit
# /etc/robinfun-bot.env and `systemctl restart robinfun-bot`.
set -euo pipefail

SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-claude/new-session-v8c9tt}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"
DATA_DIR="${DATA_DIR:-/var/lib/robinfun-bot}"
ENV_FILE="${ENV_FILE:-/etc/robinfun-bot.env}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root (sudo ./bootstrap-bot.sh)"

export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300"
log "Installing Node.js, npm, git"
$APT update -y
$APT install -y nodejs npm git curl

# grammy + global fetch need Node >= 18. Ubuntu 24.04's apt Node is fine; on
# older boxes, pull Node 20 from NodeSource.
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
    log "Node ${NODE_MAJOR} too old — installing Node 20 from NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    $APT install -y nodejs
fi
node --version || die "node failed to install"

log "Fetching the code into ${SRC_DIR} (branch ${BRANCH})"
if [ -d "$SRC_DIR/.git" ]; then
    git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$SRC_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
    git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
else
    rm -rf "$SRC_DIR"
    git clone --depth 1 -b "$BRANCH" "$REPO" "$SRC_DIR"
fi

log "Installing bot dependencies"
( cd "$SRC_DIR/bot" && npm install --omit=dev --no-audit --no-fund )

log "Preparing data directory"
mkdir -p "$DATA_DIR"
chown -R www-data:www-data "$DATA_DIR"

# ------------------------------------------------------------------ env file
# Merge: values passed in this run win; otherwise keep what's already in the
# env file; otherwise fall back to defaults. Secrets stay in a 600 root file.
get_existing(){ [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true; }

BOT_TOKEN="${BOT_TOKEN:-$(get_existing BOT_TOKEN)}"
TREASURY="${TREASURY:-$(get_existing TREASURY)}"
LISTING_CHANNEL="${LISTING_CHANNEL:-$(get_existing LISTING_CHANNEL)}"
LISTING_FEE_ETH="${LISTING_FEE_ETH:-$(get_existing LISTING_FEE_ETH)}"; LISTING_FEE_ETH="${LISTING_FEE_ETH:-0.01}"
RPC_URL="${RPC_URL:-$(get_existing RPC_URL)}"; RPC_URL="${RPC_URL:-https://rpc.testnet.chain.robinhood.com}"
CHAIN_ID="${CHAIN_ID:-$(get_existing CHAIN_ID)}"; CHAIN_ID="${CHAIN_ID:-46630}"
CHAIN_NAME="${CHAIN_NAME:-$(get_existing CHAIN_NAME)}"; CHAIN_NAME="${CHAIN_NAME:-Robinhood Chain}"
MIN_CONFIRMATIONS="${MIN_CONFIRMATIONS:-$(get_existing MIN_CONFIRMATIONS)}"; MIN_CONFIRMATIONS="${MIN_CONFIRMATIONS:-2}"
API_URL="${API_URL:-$(get_existing API_URL)}"; API_URL="${API_URL:-http://127.0.0.1:3001}"
SITE_URL="${SITE_URL:-$(get_existing SITE_URL)}"; SITE_URL="${SITE_URL:-https://robinfun.io}"
ADMIN_IDS="${ADMIN_IDS:-$(get_existing ADMIN_IDS)}"

# ------------------------------------------------------------------ install unit
# Restart policy that RECOVERS from transient errors but does NOT crash-loop
# forever on a permanent config mistake: after StartLimitBurst failures within
# StartLimitIntervalSec, systemd gives up instead of spamming the journal.
log "Installing the systemd service"
cat > /etc/systemd/system/robinfun-bot.service <<UNIT
[Unit]
Description=Robinfun Telegram listing bot (@robinlistbot)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${SRC_DIR}/bot
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) ${SRC_DIR}/bot/index.js
Restart=on-failure
RestartSec=3
# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR}
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable robinfun-bot >/dev/null 2>&1 || true

# ------------------------------------------------------------------ validate
# Reject empties, leftover PLACEHOLDER text, and wrong formats BEFORE we start
# anything — a bad value must never become an endless restart loop.
is_placeholder(){
  case "$1" in
    ""|*TOKEN_DARI_BOTFATHER*|*WALLET_KAMU*|*ISI_ALAMAT*|*YOUR_WALLET*|*your-bot-token*|*YourTreasury*|*0xYour*) return 0 ;;
    *) return 1 ;;
  esac
}
PROBLEMS=""
if is_placeholder "$BOT_TOKEN" || ! printf '%s' "$BOT_TOKEN" | grep -Eq '^[0-9]{6,}:[A-Za-z0-9_-]{30,}$'; then
  PROBLEMS="${PROBLEMS}  - BOT_TOKEN is missing or not a real token (it looks like 8635871815:AAG...). Get it from @BotFather.\n"
fi
if is_placeholder "$TREASURY" || ! printf '%s' "$TREASURY" | grep -Eq '^0x[0-9a-fA-F]{40}$'; then
  PROBLEMS="${PROBLEMS}  - TREASURY is missing or not a wallet address (must be 0x + 40 hex). Copy it from MetaMask.\n"
fi
if [ -z "$LISTING_CHANNEL" ]; then
  PROBLEMS="${PROBLEMS}  - LISTING_CHANNEL is missing (e.g. @robinfunlisting).\n"
fi

if [ -n "$PROBLEMS" ]; then
  # Stop any previous crash-loop so the journal stops spamming, and don't
  # persist bad values.
  systemctl stop robinfun-bot >/dev/null 2>&1 || true
  systemctl reset-failed robinfun-bot >/dev/null 2>&1 || true
  printf '\n\033[1;31m✗ Not started — fix these first:\033[0m\n' >&2
  printf '%b' "$PROBLEMS" >&2
  printf '\nThen run ONE line like this (fill in the real values):\n\n' >&2
  printf '  BOT_TOKEN=%s TREASURY=%s LISTING_CHANNEL=%s LISTING_FEE_ETH=%s %s\n\n' \
    "'8635871815:AAG...'" "0xYourWalletAddress" "@robinfunlisting" "${LISTING_FEE_ETH}" "/root/bootstrap-bot.sh" >&2
  exit 1
fi

# ------------------------------------------------------------------ env file
log "Writing ${ENV_FILE}"
umask 077
cat > "$ENV_FILE" <<ENV
BOT_TOKEN=${BOT_TOKEN}
TREASURY=${TREASURY}
LISTING_CHANNEL=${LISTING_CHANNEL}
LISTING_FEE_ETH=${LISTING_FEE_ETH}
RPC_URL=${RPC_URL}
CHAIN_ID=${CHAIN_ID}
CHAIN_NAME=${CHAIN_NAME}
MIN_CONFIRMATIONS=${MIN_CONFIRMATIONS}
API_URL=${API_URL}
SITE_URL=${SITE_URL}
DATA_DIR=${DATA_DIR}
ADMIN_IDS=${ADMIN_IDS}
ENV
chmod 600 "$ENV_FILE"

# ------------------------------------------------------------------ token check
# Ask Telegram if the token is real — a wrong token is the #1 mistake, and this
# turns a cryptic crash into one clear line.
log "Checking the bot token with Telegram"
GM="$(curl -fsS --max-time 10 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>/dev/null || true)"
if printf '%s' "$GM" | grep -q '"ok":true'; then
    BOT_UN="$(printf '%s' "$GM" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
    log "Token OK — bot is @${BOT_UN:-unknown}"
elif printf '%s' "$GM" | grep -q '"ok":false'; then
    die "Telegram REJECTED the token. Re-copy it from @BotFather (or /revoke a fresh one) and re-run."
else
    log "Couldn't reach Telegram to pre-check the token (network?) — continuing."
fi

# ------------------------------------------------------------------ start
systemctl reset-failed robinfun-bot >/dev/null 2>&1 || true   # clear any old loop
systemctl restart robinfun-bot
sleep 2
if ! systemctl is-active --quiet robinfun-bot; then
    printf '\n\033[1;31m✗ Bot failed to start — last log lines:\033[0m\n' >&2
    journalctl -u robinfun-bot --no-pager | tail -25 >&2
    die "See the reason above."
fi

echo
printf '\033[1;32m✔ IT WORKED — @robinlistbot is running.\033[0m\n'
echo
echo "  Fee      : ${LISTING_FEE_ETH} ETH  →  ${TREASURY}"
echo "  Chain    : ${CHAIN_NAME} (chainId ${CHAIN_ID})"
echo "  Config   : ${ENV_FILE}   (chmod 600 — keep BOT_TOKEN secret)"
echo "  Logs     : journalctl -u robinfun-bot -f"
echo "  Status   : systemctl status robinfun-bot"
echo
echo "  NEXT — 2 steps to accept listings:"
echo "   1) Create the channel ${LISTING_CHANNEL} (if you haven't)."
echo "   2) Add @robinlistbot as an ADMIN there (Post Messages)."
echo "  Then DM the bot and send /list to test."
