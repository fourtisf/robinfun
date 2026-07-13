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
# A freshly booted cloud VPS runs cloud-init / unattended-upgrades, which hold
# the apt lock for a minute or two. `DPkg::Lock::Timeout` makes apt wait for it
# instead of aborting with a scary lock error.
log "Installing nginx, certbot and firewall (waiting for apt if the VPS just booted)"
export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-o DPkg::Lock::Timeout=300"
apt-get $APT_OPTS update -y
apt-get $APT_OPTS install -y nginx certbot python3-certbot-nginx ufw curl

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
# Owner-only admin console (served at /admin — gated on-chain + in-page lock).
# Ships a self-hosted, SRI-pinned ethers under vendor/ (no CDN dependency).
[ -f "$SCRIPT_DIR/site/admin.html" ] && cp "$SCRIPT_DIR/site/admin.html" "$WEBROOT/admin.html"
[ -d "$SCRIPT_DIR/site/vendor" ] && { mkdir -p "$WEBROOT/vendor"; cp -f "$SCRIPT_DIR"/site/vendor/* "$WEBROOT/vendor/"; }
chown -R www-data:www-data "$WEBROOT"
chmod -R a+rX "$WEBROOT"

# --------------------------------------------------------------- nginx (HTTP)
CONF=/etc/nginx/sites-available/robinfun.conf
# On a re-run after HTTPS is already set up, certbot has added a `listen 443`
# block to this file — don't clobber it, or we'd briefly (or, if certbot then
# hiccups, lastingly) drop HTTPS. Only (re)write the base HTTP block on the
# first run or before HTTPS exists.
if [ ! -f "$CONF" ] || ! grep -q "listen 443" "$CONF"; then
    log "Writing the nginx server block"
    cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} ${WWW};

    root ${WEBROOT};
    index index.html;

    location = /admin {
        # Owner-only console — clean URL /admin → admin.html. Security headers
        # here are the server-side half of the hardening (CSP frame-ancestors /
        # X-Frame-Options / Referrer-Policy cannot be enforced from a meta tag).
        # OPTIONAL real gate: uncomment to require a server password before load:
        #   auth_basic "Robinfun Admin";
        #   auth_basic_user_file /etc/nginx/.robinfun_admin;   # create with htpasswd
        try_files /admin.html =404;
        add_header Cache-Control "no-cache" always;
        add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src https://rpc.mainnet.chain.robinhood.com https://api.coingecko.com https://api.coinbase.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "no-referrer" always;
        add_header Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()" always;
        add_header X-Robots-Tag "noindex, nofollow" always;
    }

    location / {
        # SPA fallback: /create, /staking, /whitepaper, /token/<id>,
        # /profile/<addr> all serve index.html so client-side routing +
        # refresh/deep-links work.
        try_files \$uri \$uri/ /index.html;
    }

    location = /index.html {
        add_header Cache-Control "no-cache";
    }
    # Force the console through the hardened /admin location — the raw /admin.html
    # URL would otherwise be served WITHOUT the CSP / X-Frame-Options headers set
    # on /admin (nginx does not merge add_header across levels).
    location = /admin.html {
        return 301 /admin;
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
else
    log "HTTPS server block already present — leaving certbot's config in place"
fi

# Idempotently upgrade older configs (incl. the block certbot copied into the
# 443 server) to the SPA fallback, so deep links stop 404-ing on existing installs.
sed -i 's#try_files $uri $uri/ =404;#try_files $uri $uri/ /index.html;#g' "$CONF"

ln -sf "$CONF" /etc/nginx/sites-enabled/robinfun.conf
rm -f /etc/nginx/sites-enabled/default          # drop the "Welcome to nginx" placeholder
nginx -t                                        # fail loudly on a bad config
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx

# --------------------------------------------------------------- firewall
# Order matters: allow SSH BEFORE enabling the firewall so we never lock ourselves out.
log "Configuring the firewall (SSH stays open)"
ufw allow 22/tcp >/dev/null 2>&1 || true         # port-based rule (always available)
ufw allow OpenSSH >/dev/null 2>&1 || true        # named profile (belt and suspenders)
ufw allow 'Nginx Full' >/dev/null 2>&1 || true   # ports 80 + 443
# Only enable the firewall once an SSH allow rule is actually in place — never
# risk locking the user out of their own server.
if ufw show added 2>/dev/null | grep -qiE 'allow.*(22|ssh)'; then
    yes | ufw enable >/dev/null 2>&1 || true
else
    log "No SSH allow rule detected — skipping firewall enable to avoid a lockout."
fi

# --------------------------------------------------------------- HTTPS
log "Requesting a Let's Encrypt certificate for ${DOMAIN} and ${WWW}"
if certbot --nginx -d "${DOMAIN}" -d "${WWW}" \
        --non-interactive --agree-tos -m "${EMAIL}" --redirect --keep-until-expiring; then
    systemctl reload nginx
    log "Live: https://${DOMAIN}  (HTTP auto-redirects to HTTPS, auto-renews via certbot timer)"
else
    printf '\n\033[1;33mHTTPS step did not complete.\033[0m The site is already live over HTTP:\n' >&2
    printf '    http://%s\n' "${DOMAIN}" >&2
    printf 'Common causes:\n' >&2
    printf '  - DNS A record for %s is not yet pointing at this server (give it a few minutes), or\n' "${DOMAIN}" >&2
    printf '  - port 80/443 is blocked upstream.\n' >&2
    printf 'Verify DNS (dig +short %s), then re-run this script — everything else is idempotent.\n' "${DOMAIN}" >&2
fi

log "Done."
echo "  HTTP : http://${DOMAIN}"
echo "  HTTPS: https://${DOMAIN}"
echo "  Root : ${WEBROOT}/index.html"
echo "  To update the site later: replace ${WEBROOT}/index.html (or re-run this script) — no restart needed."
