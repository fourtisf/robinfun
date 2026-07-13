#!/usr/bin/env bash
#
# Robinfun — fast update. Pull the latest branch, republish the frontend HTML,
# restart the backend, reload nginx. Use this after the first-time bootstrap.sh
# + bootstrap-api.sh, whenever you just want the live site to pick up new code.
#
# Idempotent and quick (no apt/certbot). Usage (root, on the VPS):
#   curl -fsSL https://raw.githubusercontent.com/fourtisf/robinfun/claude/new-session-v8c9tt/deploy/update.sh -o /root/update.sh
#   chmod +x /root/update.sh && /root/update.sh
#
set -euo pipefail

WEBROOT="${WEBROOT:-/var/www/robinfun}"
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-claude/new-session-v8c9tt}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root (sudo /root/update.sh)"

log "Pulling the latest code (branch ${BRANCH})"
if [ -d "$SRC_DIR/.git" ]; then
    git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$SRC_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
    git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
else
    rm -rf "$SRC_DIR"
    git clone --depth 1 -b "$BRANCH" "$REPO" "$SRC_DIR"
fi

log "Republishing the frontend to ${WEBROOT}"
[ -f "$SRC_DIR/deploy/site/index.html" ] || die "deploy/site/index.html missing in the repo"
mkdir -p "$WEBROOT"
cp "$SRC_DIR/deploy/site/index.html" "$WEBROOT/index.html"
# Owner-only admin console (served at /admin — noindex, gated on-chain + in-page
# lock). Ships a self-hosted, SRI-pinned ethers under vendor/ (no CDN).
[ -f "$SRC_DIR/deploy/site/admin.html" ] && cp "$SRC_DIR/deploy/site/admin.html" "$WEBROOT/admin.html"
[ -d "$SRC_DIR/deploy/site/vendor" ] && { mkdir -p "$WEBROOT/vendor"; cp -f "$SRC_DIR"/deploy/site/vendor/* "$WEBROOT/vendor/"; }
chown -R www-data:www-data "$WEBROOT"
chmod -R a+rX "$WEBROOT"

# Backend: pick up new server code if the service exists.
if systemctl list-unit-files 2>/dev/null | grep -q '^robinfun-api\.service'; then
    log "Refreshing backend dependencies + restarting the API"
    ( cd "$SRC_DIR/server" && npm install --omit=dev --no-audit --no-fund ) || true
    systemctl restart robinfun-api
    sleep 1
    systemctl is-active --quiet robinfun-api \
        && log "API restarted OK" \
        || { journalctl -u robinfun-api --no-pager | tail -20; die "API failed to restart"; }
else
    log "No robinfun-api service yet — run bootstrap-api.sh once to set up the backend."
fi

log "Reloading nginx"
nginx -t && systemctl reload nginx

log "Done — the live site now serves the latest build."
echo "  Hard-refresh your browser (Ctrl/Cmd+Shift+R) to bypass the cache."
