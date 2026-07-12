# Deploying robinfun.io

Serves the Robinfun landing page (`site/index.html`, the design prototype) from
the Hostinger VPS with nginx + free auto-renewing HTTPS.

> This publishes the **landing/prototype page**. The fully wired dApp (wallet,
> real trades, live data) is milestone **M4** and is not built yet — see the
> repo README. Deploying this now gets `robinfun.io` live with the real design.

## Prerequisites (already true for you)

- VPS: `ssh root@2.24.73.90` (Ubuntu 24.04).
- DNS: `robinfun.io` **A** → `2.24.73.90`, `www` **CNAME** → `robinfun.io`. ✅

## Deploy — pick ONE method

### A. One command (recommended)

Paste this into the VPS terminal (the VS Code Remote-SSH terminal, logged in as
`root`). It downloads the script + page and does everything:

```bash
curl -fsSL https://raw.githubusercontent.com/fourtisf/robinfun/claude/new-session-v8c9tt/deploy/bootstrap.sh -o /root/bootstrap.sh && chmod +x /root/bootstrap.sh && SITE_URL=https://raw.githubusercontent.com/fourtisf/robinfun/claude/new-session-v8c9tt/deploy/site/index.html /root/bootstrap.sh
```

That's it — nginx, the page, the firewall, and HTTPS are all set up.

### B. From a full clone

```bash
cd /root
git clone -b claude/new-session-v8c9tt https://github.com/fourtisf/robinfun.git
cd robinfun/deploy
chmod +x bootstrap.sh
./bootstrap.sh
```

### C. Upload the page by hand (no internet fetch)

1. In VS Code (connected to the VPS), create the folder and file:
   ```bash
   mkdir -p /var/www/robinfun
   ```
2. Drag your local `robinfun-prototype.html` into VS Code's file explorer at
   `/var/www/robinfun/`, and rename it to `index.html`.
   (Or `File → Open Folder → /var/www/robinfun`, then paste the HTML into a new
   `index.html`.)
3. Save `bootstrap.sh` to the VPS (drag it in too), then:
   ```bash
   cd /root && chmod +x bootstrap.sh && WEBROOT=/var/www/robinfun ./bootstrap.sh
   ```
   The script sees the existing `index.html` and configures nginx + HTTPS around it.

## What the script does

1. Installs `nginx`, `certbot`, `ufw`.
2. Publishes the page to `/var/www/robinfun`.
3. Writes an nginx server block for `robinfun.io` + `www.robinfun.io`.
4. Opens the firewall for HTTP/HTTPS **after** allowing SSH (never locks you out).
5. Gets a Let's Encrypt certificate and turns on HTTP→HTTPS redirect + auto-renew.

Idempotent — safe to re-run after editing the site or config.

## Updating the site later

Replace the file and reload isn't even needed (static files):

```bash
# overwrite /var/www/robinfun/index.html with the new page, e.g.
cp new-index.html /var/www/robinfun/index.html
```

Or re-run `./bootstrap.sh` after `git pull`.

## Troubleshooting

- **`https://robinfun.io` not secure / certbot failed:** DNS may not have
  propagated yet. Check with `dig +short robinfun.io` (should print `2.24.73.90`),
  wait a few minutes, then re-run `./bootstrap.sh`.
- **Site shows "Welcome to nginx":** the default site wasn't removed — re-run the
  script (it deletes `/etc/nginx/sites-enabled/default`).
- **502/404:** confirm `/var/www/robinfun/index.html` exists and
  `nginx -t` passes.
- **Check logs:** `journalctl -u nginx --no-pager | tail`, `tail /var/log/nginx/error.log`.
