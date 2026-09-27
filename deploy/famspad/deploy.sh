#!/usr/bin/env bash
#
# Famspad — deploy famspad.com (static site + metadata API under pm2) onto a VPS
# that ALREADY hosts other apps (e.g. dualyne-api / dualyne-web).
#
# Safe on a shared server:
#   - works with whichever web server already owns :80/:443:
#       Caddy → adds its own site file (famspad.caddy) + one `import` line,
#               validated first and auto-reverted on error; HTTPS is automatic
#       nginx → adds its own vhost (sites-available/famspad.conf) + certbot
#     never deletes or edits other sites
#   - runs the API as its own pm2 app "famspad-api" on a free local port;
#     never restarts/deletes other pm2 apps
#   - only installs packages that are missing
#
# Idempotent: re-run it to deploy a new version (git pull → republish → reload).
#
# First run / every update (as root on the VPS):
#   curl -fsSL https://raw.githubusercontent.com/fourtisf/robinfun/main/deploy/famspad/deploy.sh -o /root/famspad-deploy.sh
#   bash /root/famspad-deploy.sh
#
# Optional env:
#   MONGODB_URI=...   reuse an existing MongoDB (e.g. the old Robinfun Atlas DB)
#   MONGODB_DB=...    database name (default: robinfun, so the old data carries over)
#   PORT=3101         local API port (auto-bumped if taken by another app)
#
set -uo pipefail

DOMAIN="${DOMAIN:-famspad.com}"
WWW="www.${DOMAIN}"
EMAIL="${EMAIL:-alfapangestu07@gmail.com}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"
BRANCH="${BRANCH:-main}"
SRC_DIR="${SRC_DIR:-/opt/famspad}"
WEBROOT="${WEBROOT:-/var/www/famspad}"
DATA_DIR="${DATA_DIR:-/var/lib/famspad}"
UPLOAD_DIR="${UPLOAD_DIR:-$WEBROOT/uploads}"
APP_NAME="${APP_NAME:-famspad-api}"
ECO="/root/famspad.ecosystem.config.js"
CONF="/etc/nginx/sites-available/famspad.conf"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root."

# ---------------------------------------------------------------- web server
# Share whatever already owns :80 — Caddy (e.g. fronting dualyne) or nginx.
# If nothing listens yet, install nginx.
WEB=""
P80=""
command -v ss >/dev/null 2>&1 && P80="$(ss -ltnpH 'sport = :80' 2>/dev/null | head -1)"
if [ -z "$P80" ]; then WEB=nginx
elif printf '%s' "$P80" | grep -q '"caddy"'; then WEB=caddy
elif printf '%s' "$P80" | grep -q '"nginx"'; then WEB=nginx
else
  die "Port 80 is held by an unsupported server:
  $P80
Famspad can share a box with Caddy or nginx. Put that app behind one of them first."
fi
log "Web server on :80 → ${WEB}"

# ---------------------------------------------------------------- packages
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300"
NEED=()
command -v git  >/dev/null 2>&1 || NEED+=(git)
command -v curl >/dev/null 2>&1 || NEED+=(curl)
if [ "$WEB" = nginx ]; then
  command -v nginx   >/dev/null 2>&1 || NEED+=(nginx)
  command -v certbot >/dev/null 2>&1 || NEED+=(certbot)
  dpkg -s python3-certbot-nginx >/dev/null 2>&1 || NEED+=(python3-certbot-nginx)
fi
if [ ${#NEED[@]} -gt 0 ]; then
  log "Installing missing packages: ${NEED[*]}"
  $APT update -y && $APT install -y "${NEED[@]}" || die "apt install failed"
fi
if ! command -v node >/dev/null 2>&1; then
  log "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && $APT install -y nodejs || die "node install failed"
fi
command -v pm2 >/dev/null 2>&1 || { log "Installing pm2"; npm install -g pm2 || die "pm2 install failed"; }
[ "$WEB" = nginx ] && { systemctl enable --now nginx >/dev/null 2>&1 || true; }

# ---------------------------------------------------------------- code
log "Fetching code (${BRANCH}) into ${SRC_DIR}"
if [ -d "$SRC_DIR/.git" ]; then
  git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH" || die "git fetch failed"
  git -C "$SRC_DIR" checkout -B "$BRANCH" FETCH_HEAD
  git -C "$SRC_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$SRC_DIR" || die "git clone failed"
fi
BUILD_ID="$(git -C "$SRC_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown) · $(date -u +'%Y-%m-%d %H:%MZ')"

# ---------------------------------------------------------------- site
log "Publishing site -> ${WEBROOT}"
mkdir -p "$WEBROOT" "$UPLOAD_DIR" "$DATA_DIR"
cp "$SRC_DIR/deploy/site/index.html" "$WEBROOT/index.html" || die "deploy/site/index.html missing"
cp "$SRC_DIR"/deploy/site/*.png "$WEBROOT"/ 2>/dev/null || true
cp "$SRC_DIR"/deploy/site/*.svg "$WEBROOT"/ 2>/dev/null || true
sed -i "s|__BUILD__|build ${BUILD_ID}|g" "$WEBROOT/index.html"
chmod -R a+rX "$WEBROOT"

# ---------------------------------------------------------------- API (pm2)
log "Installing API dependencies"
( cd "$SRC_DIR/server" && npm install --omit=dev --no-audit --no-fund ) || die "npm install failed"

# Keep the port we used last time; otherwise take PORT (default 3101) or the
# next free one — never collide with dualyne or anything else on this box.
PORT_FILE="$DATA_DIR/port"
if [ -z "${PORT:-}" ] && [ -s "$PORT_FILE" ]; then PORT="$(cat "$PORT_FILE")"; fi
PORT="${PORT:-3101}"
port_busy(){ ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  : # our own app holds the port — it will be reloaded in place
else
  while port_busy "$PORT"; do PORT=$((PORT+1)); done
fi
echo "$PORT" > "$PORT_FILE"

SECRET_FILE="$DATA_DIR/admin.secret"
[ -s "$SECRET_FILE" ] || (umask 077; head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$SECRET_FILE")

log "Writing pm2 ecosystem (${ECO}) — ${APP_NAME} on 127.0.0.1:${PORT}"
SRC_DIR="$SRC_DIR" APP_NAME="$APP_NAME" PORT="$PORT" DATA_DIR="$DATA_DIR" UPLOAD_DIR="$UPLOAD_DIR" \
DOMAIN="$DOMAIN" SECRET_FILE="$SECRET_FILE" MONGODB_URI="${MONGODB_URI:-}" MONGODB_DB="${MONGODB_DB:-}" \
node - "$ECO" <<'NODE'
const fs = require('fs');
const e = process.env;
const env = {
  NODE_ENV: 'production',
  PORT: e.PORT, HOST: '127.0.0.1',
  DATA_DIR: e.DATA_DIR, UPLOAD_DIR: e.UPLOAD_DIR, UPLOAD_BASE: '/uploads',
  STATS_FILE: e.DATA_DIR + '/stats.json', WEBHOOKS_FILE: e.DATA_DIR + '/webhooks.json',
  APP_URL: 'https://' + e.DOMAIN,
  ADMIN_SECRET: fs.readFileSync(e.SECRET_FILE, 'utf8').trim(),
};
if (e.MONGODB_URI) { env.MONGODB_URI = e.MONGODB_URI; env.MONGODB_DB = e.MONGODB_DB || 'robinfun'; }
const cfg = { apps: [{
  name: e.APP_NAME, script: e.SRC_DIR + '/server/index.js', cwd: e.SRC_DIR + '/server',
  autorestart: true, max_memory_restart: '400M', time: true, env,
}] };
fs.writeFileSync(process.argv[2], 'module.exports = ' + JSON.stringify(cfg, null, 2) + ';\n');
NODE
chmod 600 "$ECO"

if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 delete "$APP_NAME" >/dev/null 2>&1   # re-create so env changes (port/secret/mongo) always apply
fi
pm2 start "$ECO" || die "pm2 start failed"
pm2 save >/dev/null
# Boot persistence (no-op if dualyne already set it up).
[ -f /etc/systemd/system/pm2-root.service ] || env PATH="$PATH" pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save >/dev/null

ok=""
for _ in $(seq 1 15); do
  curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 && { ok=1; break; }
  sleep 1
done
[ -n "$ok" ] || { pm2 logs "$APP_NAME" --lines 30 --nostream; die "API health check failed on :${PORT}"; }
log "API healthy: $(curl -fsS "http://127.0.0.1:${PORT}/api/health")"

# ---------------------------------------------------------------- caddy
setup_caddy() {
  command -v caddy >/dev/null 2>&1 || die "caddy holds :80 but the caddy binary isn't on PATH."
  local CADDYFILE SITE BAK
  CADDYFILE="$(systemctl cat caddy 2>/dev/null | grep -oP -- '--config[= ]\K\S+' | head -1)"
  CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
  [ -f "$CADDYFILE" ] || die "Caddyfile not found at $CADDYFILE (set CADDYFILE=... and re-run)."
  SITE="$(dirname "$CADDYFILE")/famspad.caddy"

  if grep -qE "(^|[[:space:],])(www\.)?${DOMAIN//./\\.}([[:space:],:{]|$)" "$CADDYFILE"; then
    die "$CADDYFILE already has a site block for ${DOMAIN}. Remove it (Famspad manages its own in $SITE), then re-run."
  fi

  log "Writing Caddy site ${SITE} (HTTPS is automatic)"
  cat > "$SITE" <<CADDY
# Famspad — managed by deploy/famspad/deploy.sh (re-run the script to update)
www.${DOMAIN} {
	redir https://${DOMAIN}{uri} permanent
}

${DOMAIN} {
	encode gzip
	request_body {
		max_size 8MB
	}

	# live feed (SSE) — flush events immediately
	handle /api/v1/stream {
		reverse_proxy 127.0.0.1:${PORT} {
			flush_interval -1
		}
	}
	# API + WebSocket (/api/v1/ws — Caddy upgrades WS automatically)
	handle /api/* {
		reverse_proxy 127.0.0.1:${PORT}
	}
	# static site + uploaded logos, SPA fallback for /create, /token/<ca>, ...
	handle {
		root * ${WEBROOT}
		@assets path *.png *.jpg *.jpeg *.gif *.svg *.webp *.ico
		header @assets Cache-Control "public, max-age=604800"
		@pages not path *.png *.jpg *.jpeg *.gif *.svg *.webp *.ico
		header @pages Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}

	header {
		X-Frame-Options SAMEORIGIN
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
	}
}
CADDY

  BAK="${CADDYFILE}.famspad-bak"
  cp "$CADDYFILE" "$BAK"
  grep -qF "import $SITE" "$CADDYFILE" || printf '\nimport %s\n' "$SITE" >> "$CADDYFILE"
  if ! caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/famspad-caddy-validate.log 2>&1; then
    cp "$BAK" "$CADDYFILE"
    cat /tmp/famspad-caddy-validate.log | tail -15
    die "Caddy config invalid — Caddyfile restored, dualyne untouched."
  fi
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || { cp "$BAK" "$CADDYFILE"; systemctl reload caddy; die "caddy reload failed — Caddyfile restored."; }
  else
    caddy reload --config "$CADDYFILE" --adapter caddyfile || { cp "$BAK" "$CADDYFILE"; die "caddy reload failed — Caddyfile restored."; }
  fi
  log "Caddy reloaded — certificate for ${DOMAIN} + www is issued automatically on first visit (takes a few seconds)."
}

setup_nginx() {
# ---------------------------------------------------------------- nginx
if grep -rlsE "server_name[^;]*\b${DOMAIN//./\\.}\b" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | grep -v 'famspad.conf' | grep -q .; then
  warn "Another nginx vhost already claims ${DOMAIN}:"
  grep -rlsE "server_name[^;]*\b${DOMAIN//./\\.}\b" /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ | grep -v famspad.conf
  die "Remove ${DOMAIN} from that vhost first, then re-run."
fi

# Only (re)write the vhost when certbot hasn't taken it over yet, so updates
# don't wipe the TLS block. Delete $CONF to force a fresh one.
if [ ! -f "$CONF" ] || ! grep -q 'managed by Certbot' "$CONF"; then
  log "Writing nginx vhost ${CONF}"
  cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW};

    root ${WEBROOT};
    index index.html;
    client_max_body_size 8m;

    location / { try_files \$uri \$uri/ /index.html; }
    location = /index.html { add_header Cache-Control "no-cache"; }

    location /uploads/ {
        alias ${UPLOAD_DIR}/;
        add_header X-Content-Type-Options "nosniff" always;
        expires 30d;
    }

    location /api/v1/ws {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /api/v1/stream {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location ~* \.(?:png|jpg|jpeg|gif|svg|ico|webp)\$ { expires 7d; add_header Cache-Control "public"; }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
NGINX
else
  # Certbot owns the file: keep TLS, just re-point the API port if it moved.
  sed -i -E "s#proxy_pass http://127\.0\.0\.1:[0-9]+#proxy_pass http://127.0.0.1:${PORT}#g" "$CONF"
fi
ln -sf "$CONF" /etc/nginx/sites-enabled/famspad.conf
nginx -t || die "nginx config test failed — nothing reloaded. Fix the error above (other vhosts are untouched)."
systemctl reload nginx

# ---------------------------------------------------------------- HTTPS
if ! grep -q 'managed by Certbot' "$CONF"; then
  log "Requesting HTTPS certificate for ${DOMAIN} + ${WWW}"
  certbot --nginx -d "$DOMAIN" -d "$WWW" --non-interactive --agree-tos -m "$EMAIL" --redirect \
    && systemctl reload nginx \
    || warn "certbot failed — site is up on http:// only. Check DNS (A @ and CNAME www → this server), then re-run."
fi

}

if [ "$WEB" = caddy ]; then setup_caddy; else setup_nginx; fi

log "Done — https://${DOMAIN} is live (build ${BUILD_ID})."
echo "  Hard-refresh the page (Ctrl/Cmd+Shift+R) and check the footer shows: build ${BUILD_ID}"
echo
pm2 list
