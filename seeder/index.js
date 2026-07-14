#!/usr/bin/env node
/*
 * Robinfun seeder bot — self-funded, multi-wallet.
 *
 * The bot GENERATES its own N deployer wallets (private keys), prints their
 * addresses, and your ONLY job is to send ETH to those addresses. It then
 * auto-launches meme tokens from whichever wallets have ETH: random meme
 * name + ticker, a random meme IMAGE (public SFW meme API, not Pinterest),
 * a configurable dev-buy and 1% creator levy, posted to the backend so it
 * shows on the board. NO private key input required.
 *
 * (Optional convenience) if you set FUNDER_KEY to the OWNER wallet, the bot
 * will additionally auto-allow-list and auto-fund the deployers for you.
 *
 * Config (env or seeder/.env):
 *   NUM_WALLETS       deployer wallets to generate (default 5)
 *   DEV_BUY_ETH       ETH each launch buys (default 0.001)
 *   CREATOR_LEVY_BPS  creator fee bps, buy+sell (default 100 = 1%)
 *   INTERVAL_SECONDS  seconds between launches (default 60)
 *   MAX_TOKENS        optional count cap (0 = until wallets run dry)
 *   WALLET_FILE       where the generated keys are stored (default ./wallets.json)
 *   FUNDER_KEY        (optional) owner key → auto allow-list + fund the deployers
 *   BUDGET_CAP_ETH    (funder mode only) max ETH the funder sends out (default 0.05)
 *   FACTORY_ADDR, RPC, BACKEND, MEME_API, DRY_RUN
 *
 * Sweep leftover ETH from the deployers to an address:
 *   node index.js sweep 0xDestination
 */
'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// set-and-forget: auto-load seeder/.env once (CLI env still wins)
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch (_) {}

const CFG = {
  rpc: process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com',
  factory: (process.env.FACTORY_ADDR || '0xfa5c740aec9d91cebdc9844e5ca6591f309a5dd2').trim(),
  funderKey: (process.env.FUNDER_KEY || process.env.PRIVATE_KEY || '').trim(),
  numWallets: Math.min(20, Math.max(1, Number(process.env.NUM_WALLETS || 5))),
  walletFile: process.env.WALLET_FILE || path.join(__dirname, 'wallets.json'),
  backend: (process.env.BACKEND || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
  intervalSec: Math.max(5, Number(process.env.INTERVAL_SECONDS || 60)),
  devBuyEth: String(process.env.DEV_BUY_ETH || '0.001'),
  levyBps: Math.min(1000, Math.max(0, Number(process.env.CREATOR_LEVY_BPS || 100))),
  budgetEth: String(process.env.BUDGET_CAP_ETH || '0.05'),
  fundPerWalletEth: process.env.FUND_PER_WALLET_ETH || '',
  maxTokens: Number(process.env.MAX_TOKENS || 0),
  memeApi: process.env.MEME_API || 'https://meme-api.com/gimme',
  dryRun: /^(1|true|yes)$/i.test(process.env.DRY_RUN || ''),
};

const FACTORY_ABI = [
  'function createToken((string name,string symbol,string metadataURI,uint16 buyLevyBps,uint16 sellLevyBps,bool decayAtGraduation,bool renounceRateControl,uint256 devBuyMinTokensOut,bytes32 vanitySalt,uint256 maxDeployFee)) payable returns (address token, address curve)',
  'function deployFee() view returns (uint256)',
  'function betaMode() view returns (bool)',
  'function owner() view returns (address)',
  'function tradeAllowed(address) view returns (bool)',
  'function setBetaAllowed(address[] who, bool allowed)',
  'event TokenCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint16 buyLevyBps, uint16 sellLevyBps, bool decayAtGraduation, bool renounceRateControl, uint256 deployFee, uint256 devBuyEth)',
];

const PRE = ['Doge','Pepe','Wojak','Chad','Turbo','Giga','Baby','Based','Mega','Shib','Floki','Cyber','Rocket','Degen','Sigma','Ninja','Cosmic','Quantum','Hyper','Moon','Ser','Wen','Bonk','Wif','Fren','Comfy','Alpha','Vibe','Astro','Retro'];
const POST = ['Inu','Cat','Frog','Moon','Rocket','Coin','Lord','King','Ape','Bull','Bonk','Elon','Mars','Pump','Fren','Wojak','Pepe','Doge','Meme','Chad','Whale','Hodl','Lambo','Wagmi','Pamp','Gains','Chan','Bro','Fud','Zilla'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function genName() {
  const name = (pick(PRE) + ' ' + pick(POST) + (Math.random() < 0.3 ? ' ' + Math.floor(Math.random() * 1000) : '')).slice(0, 64);
  let ticker = (pick(PRE) + pick(POST)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3 + Math.floor(Math.random() * 4));
  if (ticker.length < 3) ticker = ('MEME' + ticker).slice(0, 5);
  return { name, ticker };
}

async function fetchMeme() {
  for (let i = 0; i < 4; i++) {
    try {
      const j = await (await fetch(CFG.memeApi, { signal: AbortSignal.timeout(8000) })).json();
      if (!j || j.nsfw || j.spoiler) continue;
      const url = j.url || (Array.isArray(j.preview) && j.preview[j.preview.length - 1]);
      if (!url) continue;
      const img = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const ct = (img.headers.get('content-type') || '').toLowerCase();
      if (!/^image\/(png|jpe?g|gif|webp)/.test(ct)) continue;
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > 1_900_000 || buf.length < 200) continue;
      return { dataUrl: `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`, src: url, title: String(j.title || '') };
    } catch (_) {}
  }
  return null;
}
async function postMeta(rec) {
  try { const r = await fetch(CFG.backend + '/api/tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec), signal: AbortSignal.timeout(20000) }); return r.ok; }
  catch (_) { return false; }
}
const fmt = (wei) => ethers.formatEther(wei);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// deployer wallets: generate once + persist (chmod 600), reuse forever
function loadOrCreateWallets(provider) {
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(CFG.walletFile, 'utf8')); } catch (_) {}
  if (!Array.isArray(saved)) saved = [];
  let changed = false;
  while (saved.length < CFG.numWallets) { const w = ethers.Wallet.createRandom(); saved.push({ address: w.address, privateKey: w.privateKey }); changed = true; }
  saved = saved.slice(0, CFG.numWallets);
  if (changed) { fs.writeFileSync(CFG.walletFile, JSON.stringify(saved, null, 2)); try { fs.chmodSync(CFG.walletFile, 0o600); } catch (_) {} }
  return saved.map((s) => new ethers.Wallet(s.privateKey, provider));
}

let launched = 0, stopping = false;

async function launchWith(wallet, provider, deployFee, devBuy) {
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, wallet);
  const { name, ticker } = genName();
  const meme = await fetchMeme();
  const value = deployFee + devBuy;
  const params = {
    name, symbol: ticker, metadataURI: '',
    buyLevyBps: CFG.levyBps, sellLevyBps: CFG.levyBps,
    decayAtGraduation: false, renounceRateControl: false,
    devBuyMinTokensOut: 0n, vanitySalt: ethers.ZeroHash, maxDeployFee: deployFee,
  };
  if (CFG.dryRun) { launched++; console.log(`\n🧪 [DRY] ${name} $${ticker} · from ${wallet.address.slice(0, 10)}… · logo ${meme ? 'yes' : 'none'}`); return; }

  let receipt;
  try { const tx = await factory.createToken(params, { value }); receipt = await tx.wait(); }
  catch (e) { console.log(`\n❌ launch failed (${wallet.address.slice(0, 10)}…): ${e.shortMessage || e.reason || e.message}`); return; }

  let ca = '';
  for (const lg of receipt.logs) { try { const p = factory.interface.parseLog(lg); if (p && p.name === 'TokenCreated') { ca = p.args.token; break; } } catch (_) {} }
  const gasCost = receipt.gasUsed * (receipt.gasPrice || 0n);
  launched++;

  const posted = await postMeta({
    name, ticker, ca,
    description: (meme && meme.title ? meme.title : `${name} — a Robinfun fair launch`).slice(0, 280),
    buyFee: CFG.levyBps / 100, sellFee: CFG.levyBps / 100,
    creator: wallet.address, logo: meme ? meme.dataUrl : undefined,
  });

  console.log(`\n✅ #${launched}  ${name}  $${ticker}   (creator ${wallet.address.slice(0, 10)}…)`);
  console.log(`   CA       ${ca || '(parse failed)'}`);
  console.log(`   dev-buy  ${CFG.devBuyEth} ETH · levy ${CFG.levyBps / 100}% · gas ${fmt(gasCost)} ETH`);
  console.log(`   logo     ${meme ? meme.src : '(none)'}  ·  board ${posted ? 'posted ✓' : 'POST failed'}`);
  console.log(`   tx       ${receipt.hash}`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(CFG.rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
  const wallets = loadOrCreateWallets(provider);
  const funder = /^0x[0-9a-fA-F]{64}$/.test(CFG.funderKey) ? new ethers.Wallet(CFG.funderKey, provider) : null;
  const factoryRead = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);

  // ---- sweep mode: node index.js sweep 0xDest ----
  if ((process.argv[2] || '').toLowerCase() === 'sweep') {
    const dest = process.argv[3] || (funder && funder.address);
    if (!dest || !ethers.isAddress(dest)) { console.error('Usage: node index.js sweep 0xDESTINATION'); process.exit(1); }
    console.log(`\n🧹 Sweeping leftover ETH → ${dest}`);
    for (const w of wallets) {
      try {
        const bal = await provider.getBalance(w.address); const gas = ethers.parseEther('0.0003');
        if (bal <= gas) { console.log(`   ${w.address} — ${fmt(bal)} ETH (skip)`); continue; }
        const tx = await w.sendTransaction({ to: dest, value: bal - gas }); await tx.wait();
        console.log(`   ${w.address} → ${fmt(bal - gas)} ETH  (${tx.hash.slice(0, 12)}…)`);
      } catch (e) { console.log(`   ${w.address} — failed: ${e.shortMessage || e.message}`); }
    }
    console.log('Done.'); process.exit(0);
  }

  // ---- the action item: fund these addresses ----
  const devBuy = ethers.parseEther(CFG.devBuyEth);
  let deployFee = 0n; try { deployFee = await factoryRead.deployFee(); } catch (_) {}
  const perLaunch = deployFee + devBuy;
  const gasBuf = ethers.parseEther('0.0006');
  const suggest = fmt(perLaunch * 8n + gasBuf * 8n); // enough for ~8 launches

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(` 🤖 Robinfun seeder — ${wallets.length} deployer wallets generated`);
  console.log(' 👉 YOUR ONLY JOB: send ETH to these addresses:');
  console.log('');
  wallets.forEach((w, i) => console.log(`    ${i + 1}. ${w.address}`));
  console.log('');
  console.log(`    Suggested ≈ ${suggest} ETH each (covers ~8 launches). Fund some/all.`);
  console.log(`    Keys are saved in ${CFG.walletFile} (chmod 600) — back it up.`);
  console.log('════════════════════════════════════════════════════════════');

  // beta / allow-list status
  let beta = false, owner = ethers.ZeroAddress;
  try { [beta, owner] = await Promise.all([factoryRead.betaMode(), factoryRead.owner()]); } catch (_) {}
  if (beta) {
    const allowed = await Promise.all(wallets.map((w) => factoryRead.tradeAllowed(w.address).catch(() => false)));
    const missing = wallets.filter((_, i) => !allowed[i]);
    if (missing.length) {
      if (funder && owner.toLowerCase() === funder.address.toLowerCase() && !CFG.dryRun) {
        console.log(`\n allow-listing ${missing.length} wallet(s) via FUNDER_KEY…`);
        try { const tx = await new ethers.Contract(CFG.factory, FACTORY_ABI, funder).setBetaAllowed(missing.map((w) => w.address), true); await tx.wait(); console.log(' allow-listed ✓'); }
        catch (e) { console.log(' allow-list failed:', e.shortMessage || e.message); }
      } else {
        console.log('\n⚠️  betaMode is ON and these wallets are NOT allow-listed → createToken will REVERT.');
        console.log('    Fix ONCE (no private key needed) — pick one:');
        console.log('    (a) Admin panel (robinfun.tech) → "Allow-list" → paste the addresses above → Allow, or');
        console.log('    (b) Admin panel → turn beta OFF (public). Then just funding is enough.');
        console.log('    The bot keeps running and will start launching the moment they can create.');
      }
    }
  }

  // optional: auto-fund from FUNDER_KEY (budget-capped)
  if (funder && !CFG.dryRun) {
    const budget = ethers.parseEther(CFG.budgetEth);
    const fundPer = CFG.fundPerWalletEth ? ethers.parseEther(CFG.fundPerWalletEth) : budget / BigInt(wallets.length);
    let funded = 0n;
    for (const w of wallets) {
      if (funded >= budget) break;
      try {
        const bal = await provider.getBalance(w.address);
        if (bal >= fundPer) continue;
        let top = fundPer - bal; if (funded + top > budget) top = budget - funded; if (top <= 0n) break;
        const tx = await funder.sendTransaction({ to: w.address, value: top }); await tx.wait(); funded += top;
        console.log(`   funded ${w.address.slice(0, 10)}… +${fmt(top)} ETH`);
      } catch (e) { console.log(`   fund ${w.address.slice(0, 10)}… failed: ${e.shortMessage || e.message}`); }
    }
  }

  process.on('SIGINT', () => { stopping = true; console.log(`\n👋 stopping — launched ${launched}. Reclaim ETH: node index.js sweep 0xYourWallet`); process.exit(0); });

  // ---- launch loop: use whichever wallet currently has ETH ----
  let rr = 0, warnedWaiting = false;
  while (!stopping) {
    if (CFG.maxTokens && launched >= CFG.maxTokens) { console.log(`\n🛑 MAX_TOKENS ${CFG.maxTokens} reached.`); break; }
    try { deployFee = await factoryRead.deployFee(); } catch (_) {}
    const need = deployFee + devBuy + gasBuf;
    let chosen = null;
    for (let k = 0; k < wallets.length; k++) {
      const w = wallets[(rr + k) % wallets.length];
      const bal = await provider.getBalance(w.address).catch(() => 0n);
      if (bal >= need) { chosen = w; rr = (rr + k + 1) % wallets.length; break; }
    }
    if (!chosen) {
      if (!warnedWaiting) { console.log(`\n⏳ Waiting for ETH — send ≥ ${fmt(need)} ETH to any address above. Re-checking every ${CFG.intervalSec}s…`); warnedWaiting = true; }
      await sleep(CFG.intervalSec * 1000); continue;
    }
    warnedWaiting = false;
    if (CFG.dryRun) break; // dry run just shows the setup, doesn't loop
    await launchWith(chosen, provider, deployFee, devBuy);
    await sleep(CFG.intervalSec * 1000);
  }
  if (CFG.dryRun) console.log('\n🧪 DRY RUN — wallets generated & printed above. Set real ETH and remove DRY_RUN to go live.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
