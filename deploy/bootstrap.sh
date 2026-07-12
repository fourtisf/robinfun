#!/usr/bin/env bash
#
# Robinfun — one-shot web deploy for a fresh Ubuntu VPS.
# Installs nginx + Let's Encrypt, serves the landing page at the web root,
# opens the firewall (without locking out SSH) and provisions HTTPS.
#
# Idempotent: safe to run again after editing the site or config.
#
# Usage (as root, on the VPS):
#   ./bootstrap.sh
# Optional overrides:
#   DOMAIN=robinfun.io EMAIL=you@example.com ./bootstrap.sh
#   SITE_URL=https://.../index.html ./bootstrap.sh   # fetch the page instead of using ./site/index.html
#
set -euo pipefail

DOMAIN="${DOMAIN:-robinfun.io}"
WWW="www.${DOMAIN}"
EMAIL="${EMAIL:-alfapangestu07@gmail.com}"     # Let's Encrypt expiry notices
WEBROOT="${WEBROOT:-/var/www/robinfun}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run as root (you are $(whoami)). Try: sudo ./bootstrap.sh"

# --------------------------------------------------------------- packages
log "Installing nginx, certbot and firewall"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx ufw curl

# --------------------------------------------------------------- site files
log "Publishing the site to ${WEBROOT}"
mkdir -p "$WEBROOT"
if [ -n "${SITE_URL:-}" ]; then
    curl -fsSL "$SITE_URL" -o "$WEBROOT/index.html" || die "Could not download SITE_URL"
elif [ -f "$SCRIPT_DIR/site/index.html" ]; then
    cp "$SCRIPT_DIR/site/index.html" "$WEBROOT/index.html"
elif [ -f "$WEBROOT/index.html" ]; then
    log "No source file bundled; keeping the existing $WEBROOT/index.html"
else
    die "No site found. Put the page at $SCRIPT_DIR/site/index.html, or set SITE_URL=..., then re-run."
fi
chown -R www-data:www-data "$WEBROOT"
chmod -R a+rX "$WEBROOT"

# --------------------------------------------------------------- nginx (HTTP)
log "Writing the nginx server block"
cat > /etc/nginx/sites-available/robinfun.conf <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW};

    root ${WEBROOT};
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }
    location ~* \.(?:css|js|png|jpg|jpeg|gif|svg|ico|webp|woff2?)\$ {
        expires 7d;
        add_header Cache-Control "public";
    }

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    gzip on;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;
    gzip_min_length 1024;
}
NGINX

ln -sf /etc/nginx/sites-available/robinfun.conf /etc/nginx/sites-enabled/robinfun.conf
rm -f /etc/nginx/sites-enabled/default          # drop the "Welcome to nginx" placeholder
nginx -t                                        # fail loudly on a bad config
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx

# --------------------------------------------------------------- firewall
# Order matters: allow SSH BEFORE enabling the firewall so we never lock ourselves out.
log "Configuring the firewall (SSH stays open)"
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true   # ports 80 + 443
yes | ufw enable >/dev/null 2>&1 || true

# --------------------------------------------------------------- HTTPS
log "Requesting a Let's Encrypt certificate for ${DOMAIN} and ${WWW}"
if certbot --nginx -d "${DOMAIN}" -d "${WWW}" \
        --non-interactive --agree-tos -m "${EMAIL}" --redirect --keep-until-expiring; then
    systemctl reload nginx
    log "Live: https://${DOMAIN}  (HTTP auto-redirects to HTTPS, auto-renews via certbot timer)"
else
    cat >&2 <<EOF

\033[1;33mHTTPS step did not complete.\033[0m The site is already live over HTTP:
    http://${DOMAIN}
Common causes:
  - DNS A record for ${DOMAIN} is not yet pointing at this server (give it a few minutes), or
  - port 80/443 is blocked upstream.
Verify DNS, then re-run this script — everything else is idempotent.
EOF
fi

log "Done."
echo "  HTTP : http://${DOMAIN}"
echo "  HTTPS: https://${DOMAIN}"
echo "  Root : ${WEBROOT}/index.html"
echo "  To update the site later: replace ${WEBROOT}/index.html (or re-run this script) — no restart needed."
