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
# Static assets (logo used as the wallet-connect icon + favicon, etc.). Copy any
# images so /robinfun-logo.png is reachable — a real icon on the wallet's Connect
# screen (instead of a broken image) makes new users trust the connect prompt.
cp "$SRC_DIR"/deploy/site/*.png "$WEBROOT"/ 2>/dev/null || true
cp "$SRC_DIR"/deploy/site/*.svg "$WEBROOT"/ 2>/dev/null || true
cp "$SRC_DIR"/deploy/site/*.ico "$WEBROOT"/ 2>/dev/null || true
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
  [ -d "$SRC_DIR/tradebot" ] && ( cd "$SRC_DIR/tradebot" && npm install --omit=dev --no-audit --no-fund ) || true
  # restart whichever of these exist; fall back to restarting all
  pm2 restart robinfun-api robinfun-bot robinfun-seeder-bot robinfun-tradebot --update-env >/dev/null 2>&1 \
    || pm2 restart all >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  log "pm2 apps restarted"
  # First-time only: start the trade bot under pm2 if it isn't registered yet.
  # Requires TRADEBOT_TOKEN + WALLET_SECRET + FEE_WALLET in the environment/.env.
  if [ -d "$SRC_DIR/tradebot" ] && ! pm2 describe robinfun-tradebot >/dev/null 2>&1; then
    # Ready if the secrets are in the shell env OR in tradebot/.env (the bot loads
    # .env itself now — see core.js). Either way pm2 --update-env carries them in.
    TB_ENV="$SRC_DIR/tradebot/.env"
    if { [ -n "${TRADEBOT_TOKEN:-}" ] && [ -n "${WALLET_SECRET:-}" ]; } \
       || { [ -f "$TB_ENV" ] && grep -qE '^[[:space:]]*TRADEBOT_TOKEN=.+' "$TB_ENV" && grep -qE '^[[:space:]]*WALLET_SECRET=.+' "$TB_ENV"; }; then
      ( cd "$SRC_DIR/tradebot" && pm2 start index.js --name robinfun-tradebot --update-env ) && pm2 save >/dev/null 2>&1 || true
      log "robinfun-tradebot started"
    else
      warn "tradebot present but not started — create $TB_ENV with TRADEBOT_TOKEN + WALLET_SECRET + FEE_WALLET, then re-run this script (or: cd $SRC_DIR/tradebot && pm2 start index.js --name robinfun-tradebot --update-env)"
    fi
  fi
elif systemctl list-unit-files 2>/dev/null | grep -q '^robinfun-api\.service'; then
  log "Restarting the API via systemd"
  ( cd "$SRC_DIR/server" && npm install --omit=dev --no-audit --no-fund ) || true
  systemctl restart robinfun-api || true
else
  warn "No backend service found — run bootstrap-api.sh once if you need the backend."
fi

# ---- nginx: ensure the real-time feed's WS/SSE locations exist ----
# bootstrap-api.sh writes these on first setup, but a plain update won't re-run
# it, so a long-lived instance can be missing the WebSocket upgrade block. Add
# it idempotently and SAFELY: back up, patch, `nginx -t`, revert on failure.
patch_nginx_realtime() {
  local CONF="${NGINX_CONF:-/etc/nginx/sites-available/robinfun.conf}"
  [ -f "$CONF" ] || { warn "nginx conf $CONF not found — skipping real-time WS/SSE patch"; return; }
  # Already patched? Guard on EITHER block so a partial hand-edit can't trigger a
  # duplicate-location re-insert loop.
  grep -qE 'location /api/v1/(ws|stream)' "$CONF" && return
  grep -q 'location /api/ {' "$CONF" || { warn "no 'location /api/' in $CONF — skipping WS/SSE patch"; return; }
  # Only patch a config that's currently VALID. If 'nginx -t' already fails (e.g. a
  # broken unrelated vhost), our post-patch test would fail too and wrongly blame —
  # and revert — this valid insert on every run. Skip until the existing error is fixed.
  if ! nginx -t >/dev/null 2>&1; then
    warn "nginx config already fails 'nginx -t' — skipping WS/SSE patch (fix the existing error first)."
    return
  fi
  # Proxy WS/SSE to the SAME upstream port the working 'location /api/' block uses,
  # read straight from the conf — never a hardcoded guess (an instance on a custom
  # PORT would otherwise 502 on the feed).
  local BPORT
  BPORT="$(grep -oE 'proxy_pass http://127\.0\.0\.1:[0-9]+' "$CONF" | grep -oE '[0-9]+$' | head -1)"
  [ -n "$BPORT" ] || BPORT="${PORT:-3001}"
  local BAK INS
  BAK="${CONF}.rf-bak"                 # fixed name → no backup pile-up on repeats
  cp "$CONF" "$BAK" || { warn "could not back up $CONF — skipping WS/SSE patch"; return; }
  INS="$(mktemp)"
  cat > "$INS" <<'WSBLOCK'
    location /api/v1/ws {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /api/v1/stream {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

WSBLOCK
  sed -i "s/__PORT__/${BPORT}/g" "$INS"
  # Insert the blocks immediately before the FIRST "location /api/ {".
  awk -v insf="$INS" '
    BEGIN { while ((getline line < insf) > 0) ins = ins line "\n" }
    /^[[:space:]]*location \/api\/ \{/ && !done { printf "%s", ins; done=1 }
    { print }
  ' "$BAK" > "$CONF"
  rm -f "$INS"
  if nginx -t >/dev/null 2>&1; then
    log "nginx: added real-time WS/SSE locations (/api/v1/ws, /api/v1/stream) -> 127.0.0.1:${BPORT}"
  else
    cp "$BAK" "$CONF"
    warn "real-time WS/SSE nginx patch failed 'nginx -t' — reverted. Re-run deploy/bootstrap-api.sh to add it."
  fi
}
patch_nginx_realtime

log "Reloading nginx"
nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null || warn "nginx reload skipped (check 'nginx -t')."

log "Done — the VPS now serves the latest build (site + admin + bots)."
echo "  Serving: build ${BUILD_ID}"
echo "  Open robinfun.io, hard-refresh (Ctrl/Cmd+Shift+R), and check the footer"
echo "  shows this same build id. If it doesn't, a CDN/proxy is caching the page."
