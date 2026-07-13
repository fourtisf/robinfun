#!/usr/bin/env bash
#
# Robinfun — deploy the ADMIN console on its OWN domain (robinfun.tech) from the
# same VPS, as a SEPARATE nginx server block. This does NOT touch the public
# robinfun.io site, its config, or its webroot in any way.
#
# What it does:
#   - publishes the admin page + vendored (SRI-pinned) ethers to a separate
#     webroot (/var/www/robinfun-admin),
#   - writes a dedicated nginx server block for robinfun.tech with the security
#     headers a <meta> tag can't enforce (CSP, X-Frame-Options DENY, Referrer-
#     Policy, noindex) + optional HTTP Basic-Auth,
#   - provisions HTTPS for robinfun.tech via certbot.
#
# Prereqs:
#   - This VPS already runs the robinfun.io site (nginx + certbot installed).
#   - robinfun.tech's DNS A record points to THIS server's public IP. The script
#     prints the IP and reminds you; certbot needs DNS to resolve here first.
#
# Usage (as root, on the VPS):
#   curl -fsSL https://raw.githubusercontent.com/fourtisf/robinfun/claude/new-session-v8c9tt/deploy/bootstrap-admin.sh -o /root/bootstrap-admin.sh
#   chmod +x /root/bootstrap-admin.sh && /root/bootstrap-admin.sh
#
# Optional env:
#   ADMIN_DOMAIN   default robinfun.tech
#   ADMIN_WEBROOT  default /var/www/robinfun-admin
#   BASIC_AUTH_USER + BASIC_AUTH_PASS  if set, adds a server password before the
#                                      page loads (strongly recommended).
#
set -euo pipefail

ADMIN_DOMAIN="${ADMIN_DOMAIN:-robinfun.tech}"
ADMIN_WWW="www.${ADMIN_DOMAIN}"
ADMIN_WEBROOT="${ADMIN_WEBROOT:-/var/www/robinfun-admin}"
EMAIL="${EMAIL:-alfapangestu07@gmail.com}"
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-claude/new-session-v8c9tt}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"
CONF="/etc/nginx/sites-available/robinfun-admin.conf"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root (sudo /root/bootstrap-admin.sh)"

command -v nginx >/dev/null 2>&1 || die "nginx not found. Run the robinfun.io bootstrap first."

# --------------------------------------------------------------- fetch the code
log "Fetching the code (branch ${BRANCH})"
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y git
if [ -d "$SRC_DIR/.git" ]; then
    git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$SRC_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
    git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
else
    git clone --depth 1 -b "$BRANCH" "$REPO" "$SRC_DIR"
fi

PKG="$SRC_DIR/deploy/admin-hostinger"
[ -f "$PKG/admin.html" ] || die "admin.html not found at $PKG — wrong branch?"
[ -f "$PKG/vendor/ethers-6.15.0.umd.min.js" ] || die "vendored ethers missing at $PKG/vendor/"

# --------------------------------------------------------------- publish files
log "Publishing the admin console to ${ADMIN_WEBROOT} (separate from robinfun.io)"
mkdir -p "$ADMIN_WEBROOT/vendor"
cp "$PKG/admin.html" "$ADMIN_WEBROOT/admin.html"
cp "$PKG/vendor/ethers-6.15.0.umd.min.js" "$ADMIN_WEBROOT/vendor/ethers-6.15.0.umd.min.js"
chown -R www-data:www-data "$ADMIN_WEBROOT"
chmod -R a+rX "$ADMIN_WEBROOT"

# --------------------------------------------------------------- optional auth
AUTH_BLOCK=""
if [ -n "${BASIC_AUTH_USER:-}" ] && [ -n "${BASIC_AUTH_PASS:-}" ]; then
    command -v htpasswd >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y apache2-utils
    htpasswd -bc /etc/nginx/.robinfun_admin "$BASIC_AUTH_USER" "$BASIC_AUTH_PASS" >/dev/null
    AUTH_BLOCK=$'    auth_basic "Robinfun Admin";\n    auth_basic_user_file /etc/nginx/.robinfun_admin;'
    log "HTTP Basic-Auth enabled for ${ADMIN_DOMAIN} (user: ${BASIC_AUTH_USER})"
else
    warn "No BASIC_AUTH_USER/PASS set — skipping the server password. Strongly recommended:"
    warn "  re-run with:  BASIC_AUTH_USER=admin BASIC_AUTH_PASS='a-strong-pass' /root/bootstrap-admin.sh"
fi

# --------------------------------------------------------------- nginx block
# Only (re)write the base HTTP block on first run or before certbot's 443 block
# exists — same guard as the robinfun.io bootstrap, so re-runs don't drop HTTPS.
if [ ! -f "$CONF" ] || ! grep -q "listen 443" "$CONF"; then
    log "Writing the nginx server block for ${ADMIN_DOMAIN} (separate file: ${CONF})"
    cat > "$CONF" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${ADMIN_DOMAIN} ${ADMIN_WWW};

    root ${ADMIN_WEBROOT};
    index admin.html;

    # All security headers at SERVER level so every response carries them.
    # (nginx drops inherited add_header if a location declares its own — so no
    # location below uses add_header; caching uses \`expires\`, which is separate.)
    add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src https://rpc.mainnet.chain.robinhood.com https://api.coingecko.com https://api.coinbase.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=()" always;
    add_header X-Robots-Tag "noindex, nofollow" always;

${AUTH_BLOCK}

    location / {
        try_files \$uri \$uri/ /admin.html;
    }
    location /vendor/ {
        expires 7d;
    }

    gzip on;
    gzip_types text/plain text/css application/javascript image/svg+xml;
    gzip_min_length 1024;
}
NGINX
else
    log "HTTPS server block already present for ${ADMIN_DOMAIN} — leaving certbot's config in place"
    warn "To change the Basic-Auth password on an existing install, run:"
    warn "  htpasswd -c /etc/nginx/.robinfun_admin <user>   # then: systemctl reload nginx"
fi

ln -sf "$CONF" /etc/nginx/sites-enabled/robinfun-admin.conf
nginx -t || die "nginx config test failed — not reloading (robinfun.io is unaffected)."
systemctl reload nginx

# --------------------------------------------------------------- DNS + HTTPS
IP="$(curl -fsSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
log "This server's public IP: ${IP}"
echo "   Make sure ${ADMIN_DOMAIN} DNS A record points here (currently it may point to Hostinger)."

log "Requesting HTTPS for ${ADMIN_DOMAIN}"
if certbot --nginx -d "${ADMIN_DOMAIN}" -d "${ADMIN_WWW}" \
        --non-interactive --agree-tos -m "${EMAIL}" --redirect --keep-until-expiring; then
    systemctl reload nginx
    log "Live: https://${ADMIN_DOMAIN}  (admin console, separate from robinfun.io)"
else
    warn "HTTPS step did not complete — the admin is live over HTTP for now:  http://${ADMIN_DOMAIN}"
    warn "Most likely ${ADMIN_DOMAIN} DNS isn't pointing at ${IP} yet. Point the A record here, wait a few minutes, then re-run this script."
fi

echo
log "Done."
echo "  Admin  : https://${ADMIN_DOMAIN}   (webroot ${ADMIN_WEBROOT})"
echo "  Public : robinfun.io is UNCHANGED (separate server block + webroot)."
echo "  Update later: just re-run this script (it re-pulls the branch)."
