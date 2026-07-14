# MongoDB for the Robinfun API

The API stores tokens + settings in **MongoDB when `MONGODB_URI` is set**, and
falls back to the JSON file store otherwise. On the first MongoDB boot it
**imports the existing `server/data/tokens.json`** automatically, so switching
over never loses data. Check which backend is live:

    curl -s http://127.0.0.1:3001/api/health
    # {"ok":true,"tokens":6,"backend":"mongodb"}   <- good
    # ...            "backend":"json"              <- MONGODB_URI not set
    # ...            "backend":"json-fallback"     <- URI set but Mongo unreachable

Pick ONE of the two options below, then set the URI in pm2 and restart.

---

## Option A — MongoDB Atlas (managed, recommended for "safer")

Managed, replicated, automatic daily backups — the safest with the least ops.

1. Create a free account at https://www.mongodb.com/atlas and a free **M0**
   cluster.
2. **Database Access** → add a user (e.g. `robinfun`) with a strong password.
3. **Network Access** → add your VPS's public IP (or `0.0.0.0/0` only if you
   must; prefer the exact IP).
4. **Connect → Drivers** → copy the connection string, e.g.
   `mongodb+srv://robinfun:PASSWORD@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`
5. Set it on the API and restart (see "Wire it up" below).

---

## Option B — self-hosted on the VPS (bound to localhost + auth)

Run `deploy/install-mongo.sh` as root. It installs MongoDB, binds it to
`127.0.0.1` only (never exposed to the internet), enables auth, and creates a
DB user. It prints the `MONGODB_URI` to use.

    sudo bash /opt/robinfun/deploy/install-mongo.sh

> Self-hosted is only "safe" if it stays bound to localhost with auth on — which
> the script does. Never bind MongoDB to 0.0.0.0 without a firewall + auth
> (open MongoDB instances get wiped by ransomware bots).

---

## Wire it up (both options)

Set the URI in the pm2 environment and restart — never commit it to git:

    MONGODB_URI='mongodb+srv://robinfun:PASSWORD@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority' \
      pm2 restart robinfun-api --update-env && pm2 save

Verify:

    curl -s http://127.0.0.1:3001/api/health      # backend should say "mongodb"

Optional: override the database name with `MONGODB_DB` (default `robinfun`).

---

## Backups

- **Atlas**: backups are automatic on paid tiers; on M0 use
  `mongodump --uri "$MONGODB_URI"` on a cron.
- **Self-hosted**: `mongodump` on a daily cron, e.g.
  `0 3 * * * mongodump --uri "$MONGODB_URI" --archive=/root/backups/robinfun-$(date +\%F).gz --gzip`
