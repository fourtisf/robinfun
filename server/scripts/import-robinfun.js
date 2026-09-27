#!/usr/bin/env node
'use strict';
/**
 * Import the old Robinfun board into Famspad.
 *
 * Reads the old server's token metadata and merges it into this store:
 *   - token already here (e.g. added by chainsync from the chain) → fill in
 *     its logo, description and socials from the old record
 *   - token missing → add the old record as-is
 *   - old records without a contract address (launches that never landed
 *     on-chain) are skipped
 * Matching is by contract address, so it is safe to run more than once.
 *
 * Input: the old tokens.json ({ "tokens": [...] }), a plain JSON array, or a
 * `mongoexport` dump (one JSON document per line).
 *
 * Stop the API first so it can't overwrite the file with its in-memory copy:
 *   pm2 stop famspad-api
 *   DATA_DIR=/var/lib/famspad node /opt/famspad/server/scripts/import-robinfun.js /root/rf/tokens.json
 *   pm2 start famspad-api
 * (Set MONGODB_URI too if this Famspad instance runs on MongoDB.)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('../store');

const file = process.argv[2];
if (!file) { console.error('usage: import-robinfun.js <old tokens.json | mongoexport.json>'); process.exit(2); }
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function readOld(p) {
  const raw = fs.readFileSync(p, 'utf8').trim();
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (j && Array.isArray(j.tokens)) return j.tokens;
  } catch (_) { /* fall through to JSON lines */ }
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}

const META = ['logo', 'description', 'website', 'x', 'tg'];
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim());

(async () => {
  const old = readOld(file);
  await store.init({ dataDir: DATA_DIR, defaultSettings: { gradLpEth: 2.6 } });
  console.log(`store: ${store.backend()} · ${store.countTokens()} tokens before import · ${old.length} records in ${file}`);

  const byCa = new Map(store.allTokens().filter((t) => isAddr(t.ca)).map((t) => [t.ca.toLowerCase(), t]));
  let filled = 0, added = 0, skipped = 0, same = 0;

  for (const o of old) {
    if (!o || !isAddr(o.ca) || !o.name || !o.ticker) { skipped++; continue; }
    const ca = o.ca.trim().toLowerCase();
    const cur = byCa.get(ca);
    if (cur) {
      const patch = {};
      for (const k of META) if (o[k] && !cur[k]) patch[k] = o[k];
      if (Object.keys(patch).length) {
        patch.source = 'robinfun-import';
        await store.updateToken(cur.id, patch);
        filled++;
      } else same++;
      continue;
    }
    const rec = { ...o };
    delete rec._id;                       // mongoexport artefact
    rec.ca = o.ca.trim();
    rec.id = rec.id && !store.findToken(rec.id) ? rec.id : crypto.randomBytes(8).toString('hex');
    rec.source = 'robinfun-import';
    await store.addToken(rec);
    byCa.set(ca, rec);
    added++;
  }

  console.log(`done: ${added} added · ${filled} filled with logo/description/socials · ${same} already complete · ${skipped} skipped (no contract address)`);
  console.log(`store now has ${store.countTokens()} tokens`);
  process.exit(0);
})().catch((e) => { console.error('import failed:', e && e.message); process.exit(1); });
