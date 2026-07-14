#!/usr/bin/env bash
#
# Robinfun — update EVERYTHING on the VPS in one shot:
#   pull latest branch → republish robinfun.io (site) AND robinfun.tech (admin)
#   → restart the backend + bots (api, listing bot, seeder bot) → reload nginx.
#
# Idempotent and quick. Run as root on the VPS. Because this script edits the
# repo it lives in, COPY IT OUT first so a mid-run reset can't truncate it:
#   cp /opt/robinfun/deploy/update-all.sh /root/ua.sh && bash /root/ua.sh
#
set -uo pipefail

WEBROOT="${WEBROOT:-/var/www/robinfun}"
ADMIN_WEBROOT="${ADMIN_WEBROOT:-/var/www/robinfun-admin}"
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-main}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root (sudo bash /root/ua.sh)."

log "Pulling the latest code (branch ${BRANCH})"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH" || die "git fetch failed"
  # Reset to FETCH_HEAD, not origin/$BRANCH: a shallow single-branch clone's
  # fetch refspec may not create a refs/remotes/origin/<other-branch> ref, so
  # `origin/main` can be "unknown revision". FETCH_HEAD always points at what we
  # just fetched.
  git -C "$SRC_DIR" checkout -B "$BRANCH" FETCH_HEAD
  git -C "$SRC_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$SRC_DIR" || die "git clone failed"
fi

# ---- public site: robinfun.io ----
[ -f "$SRC_DIR/deploy/site/index.html" ] || die "deploy/site/index.html missing"
log "Republishing robinfun.io -> ${WEBROOT}"
mkdir -p "$WEBROOT"
cp "$SRC_DIR/deploy/site/index.html" "$WEBROOT/index.html"
# Stamp the served page with the exact build so you can VERIFY the new version
# is live (footer shows it). If the footer build doesn't change after a deploy,
# something between here and the browser is caching (CDN/nginx), not the code.
BUILD_ID="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown) · $(date -u +'%Y-%m-%d %H:%MZ')"
sed -i "s|__BUILD__|build ${BUILD_ID}|g" "$WEBROOT/index.html"
chown -R www-data:www-data "$WEBROOT" 2>/dev/null || true
chmod -R a+rX "$WEBROOT" 2>/dev/null || true

# ---- admin console: robinfun.tech (only if it was set up via bootstrap-admin.sh) ----
if [ -d "$ADMIN_WEBROOT" ]; then
  log "Republishing admin -> ${ADMIN_WEBROOT}"
  cp "$SRC_DIR/deploy/admin-hostinger/admin.html" "$ADMIN_WEBROOT/admin.html"
  mkdir -p "$ADMIN_WEBROOT/vendor"
  cp "$SRC_DIR/deploy/admin-hostinger/vendor/ethers-6.15.0.umd.min.js" "$ADMIN_WEBROOT/vendor/" 2>/dev/null || true
  cp "$SRC_DIR/deploy/admin-hostinger/vendor/wc-provider.js" "$ADMIN_WEBROOT/vendor/" 2>/dev/null || true
  chown -R www-data:www-data "$ADMIN_WEBROOT" 2>/dev/null || true
  chmod -R a+rX "$ADMIN_WEBROOT" 2>/dev/null || true
else
  warn "Admin webroot ${ADMIN_WEBROOT} not found — run deploy/bootstrap-admin.sh once to set up robinfun.tech."
fi

# ---- backend + bots ----
if command -v pm2 >/dev/null 2>&1; then
  log "Refreshing deps + restarting pm2 apps"
  ( cd "$SRC_DIR/server" && npm install --omit=dev --no-audit --no-fund ) || true
  ( cd "$SRC_DIR/seeder" && npm install --no-audit --no-fund ) || true
  # restart whichever of these exist; fall back to restarting all
  pm2 restart robinfun-api robinfun-bot robinfun-seeder-bot --update-env >/dev/null 2>&1 \
    || pm2 restart all >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  log "pm2 apps restarted"
elif systemctl list-unit-files 2>/dev/null | grep -q '^robinfun-api\.service'; then
  log "Restarting the API via systemd"
  ( cd "$SRC_DIR/server" && npm install --omit=dev --no-audit --no-fund ) || true
  systemctl restart robinfun-api || true
else
  warn "No backend service found — run bootstrap-api.sh once if you need the backend."
fi

log "Reloading nginx"
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || warn "nginx reload skipped (check 'nginx -t')."

log "Done — the VPS now serves the latest build (site + admin + bots)."
echo "  Serving: build ${BUILD_ID}"
echo "  Open robinfun.io, hard-refresh (Ctrl/Cmd+Shift+R), and check the footer"
echo "  shows this same build id. If it doesn't, a CDN/proxy is caching the page."
