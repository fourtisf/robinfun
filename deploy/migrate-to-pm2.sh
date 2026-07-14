#!/usr/bin/env bash
#
# Robinfun — move robinfun-api + robinfun-bot from systemd to pm2, so `pm2 list`
# shows them and you get the easy pm2 workflow (pm2 logs / restart / monit).
#
# SAFE: it reads the current env/secrets straight from the running systemd units
# (nothing is printed), writes a locked-down pm2 ecosystem, then hands the apps
# over to pm2 with reboot-persistence. Idempotent — safe to re-run.
#
# Run as root on the VPS (in the VS Code tunnel terminal or Hostinger console):
#   curl -fsSL https://raw.githubusercontent.com/fourtisf/robinfun/claude/new-session-v8c9tt/deploy/migrate-to-pm2.sh -o /root/migrate-to-pm2.sh
#   chmod +x /root/migrate-to-pm2.sh && /root/migrate-to-pm2.sh
#
# Revert to systemd anytime:
#   pm2 delete all && pm2 save && systemctl enable --now robinfun-api robinfun-bot
#
set -euo pipefail
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
ECO="/root/robinfun.ecosystem.config.js"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root."
command -v node >/dev/null 2>&1 || die "node not found — the backend was never set up here."
NODE="$(command -v node)"

command -v pm2 >/dev/null 2>&1 || { log "Installing pm2"; npm install -g pm2 >/dev/null 2>&1 || die "npm install pm2 failed"; }

# emit `KEY: "value",` lines for a systemd unit's inline Environment= (JSON-safe, no printing)
dump_env(){
  systemctl show "$1" -p Environment --value 2>/dev/null | tr ' ' '\n' | while IFS='=' read -r k v; do
    [ -n "$k" ] && printf '        %s: %s,\n' "$k" "$("$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$v")"
  done
}
# emit the same from an EnvironmentFile (KEY=VALUE lines)
dump_env_file(){
  [ -f "$1" ] || return 0
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | while IFS='=' read -r k v; do
    printf '        %s: %s,\n' "$k" "$("$NODE" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$v")"
  done
}
BOT_ENVFILE="$(systemctl show robinfun-bot -p EnvironmentFile --value 2>/dev/null | awk 'NR==1{sub(/^-/,"",$1);print $1}')"
[ -z "${BOT_ENVFILE:-}" ] && BOT_ENVFILE="$(grep -oP '^EnvironmentFile=-?\K.*' /etc/systemd/system/robinfun-bot.service 2>/dev/null | head -1 || true)"

log "Building pm2 ecosystem from the running services (env preserved)"
{
  echo "module.exports = {"
  echo "  apps: ["
  echo "    {"
  echo "      name: 'robinfun-api',"
  echo "      script: '${SRC_DIR}/server/index.js',"
  echo "      cwd: '${SRC_DIR}/server',"
  echo "      interpreter: '${NODE}',"
  echo "      autorestart: true,"
  echo "      env: {"
  dump_env robinfun-api
  echo "      },"
  echo "    },"
  echo "    {"
  echo "      name: 'robinfun-bot',"
  echo "      script: '${SRC_DIR}/bot/index.js',"
  echo "      cwd: '${SRC_DIR}/bot',"
  echo "      interpreter: '${NODE}',"
  echo "      autorestart: true,"
  echo "      env: {"
  dump_env robinfun-bot
  if [ -n "${BOT_ENVFILE:-}" ]; then dump_env_file "$BOT_ENVFILE"; fi
  echo "      },"
  echo "    },"
  echo "  ],"
  echo "};"
} > "$ECO"
chmod 600 "$ECO"

log "Handing the apps over: stop + disable the systemd services"
systemctl disable --now robinfun-api robinfun-bot 2>/dev/null || true

log "Starting under pm2"
pm2 delete robinfun-api robinfun-bot >/dev/null 2>&1 || true
pm2 start "$ECO"
pm2 save

log "Enabling pm2 on boot (so it survives reboots)"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

log "Done. Use these from now on:"
echo "   pm2 list            # see both apps"
echo "   pm2 logs            # live logs (pm2 logs robinfun-bot for one)"
echo "   pm2 restart all     # restart after a code update"
echo "   pm2 monit           # live dashboard"
echo
pm2 list
