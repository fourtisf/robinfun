#!/usr/bin/env bash
#
# Install MongoDB on this VPS, bound to 127.0.0.1 only, with auth enabled, and
# create an app DB user. Prints the MONGODB_URI to set on the API.
#
#   sudo bash /opt/robinfun/deploy/install-mongo.sh
#
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "Run as root: sudo bash install-mongo.sh"; exit 1; }

DB_NAME="${MONGODB_DB:-robinfun}"
DB_USER="${DB_USER:-robinfun}"
# generate a strong password if not supplied
DB_PASS="${DB_PASS:-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 28)}"

if ! command -v mongod >/dev/null 2>&1; then
  echo "==> Installing MongoDB Community Server"
  . /etc/os-release
  curl -fsSL https://pgp.mongodb.com/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
  if [ "${ID:-}" = "ubuntu" ]; then
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/7.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-7.0.list
  else
    echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/debian ${VERSION_CODENAME}/mongodb-org/7.0 main" > /etc/apt/sources.list.d/mongodb-org-7.0.list
  fi
  apt-get update -y && apt-get install -y mongodb-org
fi

# bind to localhost only
sed -i 's/^\(\s*bindIp:\).*/\1 127.0.0.1/' /etc/mongod.conf || true
systemctl enable mongod >/dev/null 2>&1 || true
systemctl restart mongod
sleep 3

# create the app user (idempotent-ish: ignore "already exists")
mongosh --quiet "mongodb://127.0.0.1:27017/$DB_NAME" --eval "
  db.createUser({ user: '$DB_USER', pwd: '$DB_PASS', roles: [{ role: 'readWrite', db: '$DB_NAME' }] })
" 2>/dev/null || echo '   (user may already exist — reusing)'

# enable auth if not already
if ! grep -q 'authorization: enabled' /etc/mongod.conf; then
  printf '\nsecurity:\n  authorization: enabled\n' >> /etc/mongod.conf
  systemctl restart mongod
  sleep 2
fi

echo
echo "==> MongoDB ready (localhost only, auth on)."
echo "Set this on the API:"
echo
echo "  MONGODB_URI='mongodb://$DB_USER:$DB_PASS@127.0.0.1:27017/$DB_NAME?authSource=$DB_NAME' pm2 restart robinfun-api --update-env && pm2 save"
echo
echo "(Save that password somewhere safe — it is not stored anywhere else.)"
