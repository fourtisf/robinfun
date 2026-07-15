'use strict';
/**
 * Storage layer for the Robinfun API.
 *
 * Two backends, chosen by env:
 *   - MONGODB_URI set  -> MongoDB (durable, replicated/backed-up if you use Atlas).
 *   - unset            -> the original JSON-file store (zero-setup fallback).
 *
 * Either way an in-memory mirror serves reads synchronously (the board polls
 * /api/tokens often), and writes go through to the backend. On first Mongo
 * boot the existing tokens.json/settings.json are imported once, so switching
 * to MongoDB never loses data.
 */
const fs = require('fs');
const path = require('path');

const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const DB_NAME = (process.env.MONGODB_DB || 'robinfun').trim();

let tokens = [];             // in-memory mirror (newest handling left to callers)
let settings = {};
let mongo = null;            // { client, tokensCol, settingsCol } when Mongo is active
let paths = null;            // { DB_FILE, SETTINGS_FILE }
let mode = 'json';

function readJsonTokens(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')).tokens || []; } catch { return []; } }
function readJsonSettings(file, def) { try { return { ...def, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { ...def }; } }
function writeAtomic(file, obj) { const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, file); }
function saveJsonTokens() { writeAtomic(paths.DB_FILE, { tokens }); }
function saveJsonSettings() { writeAtomic(paths.SETTINGS_FILE, settings); }

/**
 * @param {{dataDir:string, defaultSettings:object}} opts
 */
async function init({ dataDir, defaultSettings }) {
  paths = { DB_FILE: path.join(dataDir, 'tokens.json'), SETTINGS_FILE: path.join(dataDir, 'settings.json') };
  const jsonTokens = readJsonTokens(paths.DB_FILE);
  const jsonSettings = readJsonSettings(paths.SETTINGS_FILE, defaultSettings);

  if (!MONGODB_URI) {
    tokens = jsonTokens; settings = jsonSettings; mode = 'json';
    console.log(`[store] JSON file store — ${tokens.length} tokens (set MONGODB_URI to use MongoDB)`);
    return mode;
  }

  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db(DB_NAME);
    const tokensCol = db.collection('tokens');
    const settingsCol = db.collection('settings');
    await tokensCol.createIndex({ id: 1 }, { unique: true }).catch(() => {});
    mongo = { client, tokensCol, settingsCol };
    mode = 'mongodb';

    // One-time migration: import the JSON store if Mongo has no tokens yet.
    if ((await tokensCol.countDocuments()) === 0 && jsonTokens.length) {
      await tokensCol.insertMany(jsonTokens.map((t) => ({ ...t })), { ordered: false }).catch(() => {});
      console.log(`[store] migrated ${jsonTokens.length} tokens from JSON -> MongoDB`);
    }
    tokens = await tokensCol.find({}, { projection: { _id: 0 } }).toArray();

    const sdoc = await settingsCol.findOne({ _id: 'app' });
    settings = sdoc ? { ...defaultSettings, ...sdoc.value } : { ...jsonSettings };
    if (!sdoc) await settingsCol.updateOne({ _id: 'app' }, { $set: { value: settings } }, { upsert: true });

    console.log(`[store] MongoDB connected (db="${DB_NAME}") — ${tokens.length} tokens`);
    return mode;
  } catch (e) {
    // Keep the site up: fall back to the JSON store, loudly.
    tokens = jsonTokens; settings = jsonSettings; mode = 'json-fallback'; mongo = null;
    console.error(`[store] !! MongoDB connect FAILED (${e && e.message}). Falling back to JSON file store. Writes will persist to disk, NOT MongoDB. Fix MONGODB_URI and restart.`);
    return mode;
  }
}

// ---- reads (synchronous, from the mirror) ----
function allTokens() { return tokens; }
function findToken(id) { return tokens.find((t) => t.id === id); }
function countTokens() { return tokens.length; }
function getSettings() { return settings; }
function backend() { return mode; }

// ---- writes (async; mirror + backend) ----
async function addToken(rec) {
  tokens.push(rec);
  if (mongo) await mongo.tokensCol.insertOne({ ...rec });
  else saveJsonTokens();
  return rec;
}
async function updateToken(id, patch) {
  const t = tokens.find((x) => x.id === id);
  if (!t) return null;
  Object.assign(t, patch);
  if (mongo) await mongo.tokensCol.updateOne({ id }, { $set: patch });
  else saveJsonTokens();
  return t;
}
async function removeTokens(matchFn) {
  const removed = tokens.filter(matchFn);
  if (!removed.length) return removed;
  tokens = tokens.filter((t) => !matchFn(t));
  if (mongo) await mongo.tokensCol.deleteMany({ id: { $in: removed.map((t) => t.id) } });
  else saveJsonTokens();
  return removed;
}
async function saveSettings(next) {
  settings = next;
  if (mongo) await mongo.settingsCol.updateOne({ _id: 'app' }, { $set: { value: settings } }, { upsert: true });
  else saveJsonSettings();
  return settings;
}

module.exports = { init, allTokens, findToken, countTokens, getSettings, backend, addToken, updateToken, removeTokens, saveSettings };
