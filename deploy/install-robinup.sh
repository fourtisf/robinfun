#!/usr/bin/env bash
#
# One-time setup: installs a `robinup` command on the VPS so future deploys are
# a single word. After running this once:
#
#     robinup
#
# ...pulls the latest `main`, republishes robinfun.io + admin, restarts the
# backend + bots, reloads nginx, and stamps the served build id into the footer.
#
# Run once as root:  bash /opt/robinfun/deploy/install-robinup.sh
#
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "Run as root: sudo bash install-robinup.sh"; exit 1; }

SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-main}"
DEST="/usr/local/bin/robinup"

cat > "$DEST" <<EOF
#!/usr/bin/env bash
# Robinfun one-shot deploy. Edit BRANCH below to deploy a different branch.
set -uo pipefail
SRC_DIR="\${SRC_DIR:-$SRC_DIR}"
BRANCH="\${BRANCH:-$BRANCH}"
[ "\$(id -u)" = "0" ] || { echo "Run as root: sudo robinup"; exit 1; }
echo "==> robinup: deploying branch \$BRANCH"
# Pull latest FIRST (this also refreshes update-all.sh itself), then copy the
# script out of the repo before it runs — a mid-run reset can't truncate it.
git -C "\$SRC_DIR" fetch --depth 1 origin "\$BRANCH" || { echo "git fetch failed"; exit 1; }
# FETCH_HEAD, not origin/\$BRANCH — a shallow single-branch clone may not create
# a refs/remotes/origin/<branch> ref for other branches.
git -C "\$SRC_DIR" checkout -B "\$BRANCH" FETCH_HEAD >/dev/null 2>&1 || true
git -C "\$SRC_DIR" reset --hard FETCH_HEAD
cp "\$SRC_DIR/deploy/update-all.sh" /root/ua.sh
BRANCH="\$BRANCH" bash /root/ua.sh
EOF

chmod +x "$DEST"
echo "Installed: $DEST"
echo "From now on, deploy with just:  robinup"
echo "(deploys branch '$BRANCH' by default; override with  BRANCH=some/branch robinup )"
