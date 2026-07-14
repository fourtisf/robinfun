#!/usr/bin/env bash
#
# Move the admin console to a SECRET, unguessable path and make the bare domain
# return 404 — so a stranger who visits the domain sees "not working" and has no
# hint an admin panel exists.
#
#   https://<domain>/admin-<random-hex>   -> admin console (Basic Auth)
#   https://<domain>/                     -> 404 (nothing)
#
# Run as root on the VPS:   sudo bash /opt/robinfun/deploy/secret-admin.sh
# Re-use a fixed slug:      SLUG=admin-myfixedslug sudo bash .../secret-admin.sh
#
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "Run as root: sudo bash secret-admin.sh"; exit 1; }

DOMAIN="${ADMIN_DOMAIN:-robinfun.tech}"
WWW="www.${DOMAIN}"
WEBROOT="${ADMIN_WEBROOT:-/var/www/robinfun-admin}"
CONF="/etc/nginx/sites-available/robinfun-admin.conf"
AUTHFILE="/etc/nginx/.robinfun_admin"
SLUG="${SLUG:-admin-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

[ -f "$WEBROOT/admin.html" ] || { echo "!! $WEBROOT/admin.html missing — run bootstrap-admin.sh first."; exit 1; }
if [ ! -f "$AUTHFILE" ]; then
  echo "!! No Basic-Auth file at $AUTHFILE. Create one first, then re-run:"
  echo "   htpasswd -c $AUTHFILE admin"
  exit 1
fi

CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

HEADERS='    add_header Content-Security-Policy "default-src '"'"'none'"'"'; script-src '"'"'self'"'"' '"'"'unsafe-inline'"'"'; style-src '"'"'self'"'"' '"'"'unsafe-inline'"'"' https://fonts.googleapis.com; font-src '"'"'self'"'"' https://fonts.gstatic.com; img-src '"'"'self'"'"' data:; connect-src https://rpc.mainnet.chain.robinhood.com https://api.coingecko.com https://api.coinbase.com https://robinfun.io; base-uri '"'"'none'"'"'; form-action '"'"'none'"'"'; frame-ancestors '"'"'none'"'"'; object-src '"'"'none'"'"'" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow" always;'

# The location set: admin only at the secret path (with auth); the ethers vendor
# file (harmless) is reachable so the page can load; everything else is 404 and
# carries NO auth prompt, so the bare domain just looks dead to a stranger.
gen_locations() {
cat <<LOC
    location = /${SLUG} {
        auth_basic "Restricted";
        auth_basic_user_file ${AUTHFILE};
        try_files /admin.html =404;
    }
    location = /${SLUG}/ {
        auth_basic "Restricted";
        auth_basic_user_file ${AUTHFILE};
        try_files /admin.html =404;
    }
    location /vendor/ {
        auth_basic "Restricted";
        auth_basic_user_file ${AUTHFILE};
        expires 7d;
    }
    location / { return 404; }
LOC
}

cp -a "$CONF" "${CONF}.bak.$(date -u +%s)" 2>/dev/null || true

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "==> HTTPS cert found — writing HTTPS config (80 redirects to 443)"
  cat > "$CONF" <<NGINX
server {
    listen 80; listen [::]:80;
    server_name ${DOMAIN} ${WWW};
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl; listen [::]:443 ssl;
    server_name ${DOMAIN} ${WWW};
    ssl_certificate ${CERT};
    ssl_certificate_key ${KEY};
    root ${WEBROOT};
    index admin.html;
${HEADERS}
$(gen_locations)
    gzip on; gzip_types text/plain text/css application/javascript image/svg+xml; gzip_min_length 1024;
}
NGINX
else
  echo "==> No HTTPS cert yet — writing HTTP config (run certbot after; see note below)"
  cat > "$CONF" <<NGINX
server {
    listen 80; listen [::]:80;
    server_name ${DOMAIN} ${WWW};
    root ${WEBROOT};
    index admin.html;
${HEADERS}
$(gen_locations)
    gzip on; gzip_types text/plain text/css application/javascript image/svg+xml; gzip_min_length 1024;
}
NGINX
fi

ln -sf "$CONF" /etc/nginx/sites-enabled/robinfun-admin.conf
nginx -t || { echo "!! nginx test failed — restoring backup"; cp -a "${CONF}.bak."* "$CONF" 2>/dev/null || true; exit 1; }
systemctl reload nginx

SCHEME="http"; [ -f "$CERT" ] && SCHEME="https"
echo
echo "=================================================================="
echo " Admin console is now ONLY at:"
echo "   ${SCHEME}://${DOMAIN}/${SLUG}"
echo
echo " The bare domain ${SCHEME}://${DOMAIN}/  returns 404 (nothing)."
echo " SAVE that URL — the slug is your secret; without it there is no admin."
echo "=================================================================="
[ -f "$CERT" ] || echo " NOTE: no HTTPS yet. Run:  certbot --nginx -d ${DOMAIN} -d ${WWW}  then re-run this script."
