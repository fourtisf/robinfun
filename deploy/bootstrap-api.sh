#!/usr/bin/env bash
#
# Robinfun — add the metadata backend (M3) to the VPS that already serves the
# static site. Installs Node, runs the API as a systemd service, and wires
# nginx: /api → the service, /uploads → stored logos. Re-provisions HTTPS.
#
# Idempotent: safe to re-run to pick up new code (git pull) or config.
#
# Usage (root, on the VPS, AFTER bootstrap.sh):
#   curl -fsSL <raw>/deploy/bootstrap-api.sh | bash
#   # or: ./bootstrap-api.sh
#
set -euo pipefail

DOMAIN="${DOMAIN:-robinfun.io}"
WWW="www.${DOMAIN}"
EMAIL="${EMAIL:-alfapangestu07@gmail.com}"
WEBROOT="${WEBROOT:-/var/www/robinfun}"
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-claude/new-session-v8c9tt}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"
DATA_DIR="${DATA_DIR:-/var/lib/robinfun}"
UPLOAD_DIR="${UPLOAD_DIR:-$WEBROOT/uploads}"
PORT="${PORT:-3001}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root (sudo ./bootstrap-api.sh)"

export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300"

log "Installing Node.js, npm, git"
$APT update -y
$APT install -y nodejs npm git nginx certbot python3-certbot-nginx
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

log "Publishing the latest site HTML to ${WEBROOT}"
# bootstrap-api.sh clones the repo anyway, so publish the frontend here too —
# otherwise re-running this only updates the backend and the page stays stale.
mkdir -p "$WEBROOT"
if [ -f "$SRC_DIR/deploy/site/index.html" ]; then
    cp "$SRC_DIR/deploy/site/index.html" "$WEBROOT/index.html"
    chown -R www-data:www-data "$WEBROOT"
    chmod -R a+rX "$WEBROOT"
else
    log "WARN: $SRC_DIR/deploy/site/index.html not found — leaving existing page in place"
fi

log "Installing API dependencies"
( cd "$SRC_DIR/server" && npm install --omit=dev --no-audit --no-fund )

log "Preparing data + upload directories"
mkdir -p "$DATA_DIR" "$UPLOAD_DIR"
chown -R www-data:www-data "$DATA_DIR" "$UPLOAD_DIR"

log "Installing the systemd service"
cat > /etc/systemd/system/robinfun-api.service <<UNIT
[Unit]
Description=Robinfun metadata API
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${SRC_DIR}/server
Environment=PORT=${PORT}
Environment=HOST=127.0.0.1
Environment=DATA_DIR=${DATA_DIR}
Environment=UPLOAD_DIR=${UPLOAD_DIR}
Environment=UPLOAD_BASE=/uploads
ExecStart=$(command -v node) ${SRC_DIR}/server/index.js
Restart=always
RestartSec=2
# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} ${UPLOAD_DIR}
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable robinfun-api >/dev/null 2>&1 || true
systemctl restart robinfun-api
sleep 1
systemctl is-active --quiet robinfun-api || { journalctl -u robinfun-api --no-pager | tail -20; die "API service failed to start"; }
curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null || die "API health check failed"
log "API is up on 127.0.0.1:${PORT}"

log "Writing nginx config (site + /api proxy + /uploads)"
cat > /etc/nginx/sites-available/robinfun.conf <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW};

    root ${WEBROOT};
    index index.html;

    client_max_body_size 8m;   # allow base64 logo uploads through /api

    location / {
        # SPA fallback so /create, /staking, /whitepaper, /token/<id> and
        # refresh/deep-links all serve index.html (client-side routing).
        try_files \$uri \$uri/ /index.html;
    }

    location = /index.html { add_header Cache-Control "no-cache"; }

    # Stored token logos.
    location /uploads/ {
        alias ${UPLOAD_DIR}/;
        add_header X-Content-Type-Options "nosniff" always;
        expires 30d;
    }

    # Metadata API.
    location /api/ {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
NGINX

ln -sf /etc/nginx/sites-available/robinfun.conf /etc/nginx/sites-enabled/robinfun.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

log "Restoring HTTPS"
if certbot --nginx -d "${DOMAIN}" -d "${WWW}" --non-interactive --agree-tos -m "${EMAIL}" --redirect --keep-until-expiring; then
    systemctl reload nginx
else
    printf '\n\033[1;33mHTTPS step did not complete\033[0m — the site is live over HTTP; re-run after DNS settles.\n' >&2
fi

log "Done. The board now persists launches server-side."
echo "  API health : https://${DOMAIN}/api/health"
echo "  Tokens     : https://${DOMAIN}/api/tokens"
echo "  Logos      : ${UPLOAD_DIR}  →  https://${DOMAIN}/uploads/..."
echo "  Service    : systemctl status robinfun-api   ·   journalctl -u robinfun-api -f"
