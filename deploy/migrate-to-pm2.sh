#!/usr/bin/env bash
#
# Robinfun — move robinfun-api + robinfun-bot from systemd to pm2, so `pm2 list`
# shows them and you get the easy pm2 workflow (pm2 logs / restart / monit).
#
# SAFE: env/secrets are read straight from the running systemd units by a small
# Node helper (nothing printed), written to a chmod-600 pm2 ecosystem, then the
# apps are handed to pm2 with reboot-persistence. Idempotent — safe to re-run.
#
# Run as root on the VPS (VS Code tunnel terminal or Hostinger console):
#   curl -fsSL https://raw.githubusercontent.com/fourtisf/robinfun/claude/new-session-v8c9tt/deploy/migrate-to-pm2.sh -o /root/migrate-to-pm2.sh
#   chmod +x /root/migrate-to-pm2.sh && /root/migrate-to-pm2.sh
#
# Revert to systemd anytime:
#   pm2 delete all && pm2 save && systemctl enable --now robinfun-api robinfun-bot
#
set -uo pipefail   # deliberately NOT -e: we check the few critical steps explicitly.
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
ECO="/root/robinfun.ecosystem.config.js"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "Run as root."
command -v node >/dev/null 2>&1 || die "node not found — the backend was never set up here."
command -v pm2  >/dev/null 2>&1 || { log "Installing pm2"; npm install -g pm2 || die "npm install pm2 failed"; }

# Find the bot's EnvironmentFile (where BOT_TOKEN lives).
BOT_ENVFILE="$(systemctl show robinfun-bot -p EnvironmentFile --value 2>/dev/null | awk 'NR==1{sub(/^-/,"",$1);print $1}')"
[ -z "$BOT_ENVFILE" ] && BOT_ENVFILE="$(grep -oP '^EnvironmentFile=-?\K.*' /etc/systemd/system/robinfun-bot.service 2>/dev/null | head -1)"

log "Building pm2 ecosystem from the running services (env preserved)"
node - "$SRC_DIR" "$ECO" "${BOT_ENVFILE:-}" <<'NODE'
const { execSync } = require('child_process');
const fs = require('fs');
const [SRC, OUT, BOTENV] = process.argv.slice(2);
const unitEnv = (u) => {
  try {
    const raw = execSync('systemctl show ' + u + ' -p Environment --value', { encoding: 'utf8' }).trim();
    const e = {};
    for (const t of raw.split(/\s+/)) { if (!t) continue; const i = t.indexOf('='); if (i > 0) e[t.slice(0, i)] = t.slice(i + 1); }
    return e;
  } catch (_) { return {}; }
};
const fileEnv = (p) => {
  const e = {};
  try { for (const l of fs.readFileSync(p, 'utf8').split('\n')) { const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); if (m) e[m[1]] = m[2]; } } catch (_) {}
  return e;
};
const api = unitEnv('robinfun-api');
const bot = Object.assign({}, unitEnv('robinfun-bot'), BOTENV ? fileEnv(BOTENV) : {});
const cfg = { apps: [
  { name: 'robinfun-api', script: SRC + '/server/index.js', cwd: SRC + '/server', interpreter: process.execPath, autorestart: true, env: api },
  { name: 'robinfun-bot', script: SRC + '/bot/index.js',    cwd: SRC + '/bot',    interpreter: process.execPath, autorestart: true, env: bot },
] };
fs.writeFileSync(OUT, 'module.exports = ' + JSON.stringify(cfg, null, 2) + ';');
console.log('   captured — api: ' + Object.keys(api).length + ' env vars · bot: ' + Object.keys(bot).length + ' env vars');
if (!bot.BOT_TOKEN) console.log('   \x1b[1;33m!! bot has no BOT_TOKEN captured — check ' + (BOTENV||'(no env file)') + '\x1b[0m');
NODE
[ -f "$ECO" ] || die "ecosystem build failed (no file written)."
chmod 600 "$ECO"
grep -q "robinfun-api" "$ECO" || die "ecosystem looks wrong — aborting before touching systemd."

log "Handing over: stop + disable the systemd services"
systemctl disable --now robinfun-api robinfun-bot 2>/dev/null

log "Starting under pm2"
pm2 delete robinfun-api robinfun-bot >/dev/null 2>&1
pm2 start "$ECO" || die "pm2 start failed — revert with: systemctl enable --now robinfun-api robinfun-bot"
pm2 save

log "Enabling pm2 on boot"
env PATH="$PATH" pm2 startup systemd -u root --hp /root >/dev/null 2>&1
pm2 save

log "Done. From now on use:  pm2 list · pm2 logs · pm2 restart all · pm2 monit"
echo
pm2 list
