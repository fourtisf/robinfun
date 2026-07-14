#!/usr/bin/env node
/*
 * Robinfun seeder bot — MULTI-WALLET edition.
 *
 * Auto-launches meme tokens on a schedule, spreading launches across N freshly
 * generated deployer wallets so the board shows varied creators. Each launch:
 *   - random meme NAME + TICKER, a random MEME IMAGE (public SFW meme API, not
 *     Pinterest scraping), a configurable DEV-BUY and CREATOR LEVY (default 1%),
 *   - metadata + logo posted to the backend so it shows on the board.
 *
 * The FUNDER wallet (your allow-listed OWNER key) automatically:
 *   1. generates/loads N deployer wallets (persisted to WALLET_FILE, chmod 600),
 *   2. allow-lists them on-chain (setBetaAllowed) while betaMode is ON,
 *   3. funds each with ETH,
 * then the bot round-robins launches across them. HARD budget cap = total ETH
 * the funder sends out. `node index.js sweep` returns leftover ETH to the funder.
 *
 * Config (env):
 *   FUNDER_KEY / PRIVATE_KEY  funder + owner wallet key (required)
 *   NUM_WALLETS               deployer wallets to use (default 5)
 *   FUND_PER_WALLET_ETH       ETH sent to each (default = BUDGET_CAP_ETH / NUM_WALLETS)
 *   BUDGET_CAP_ETH            hard cap on total funded out (default 0.05)
 *   DEV_BUY_ETH               ETH each launch buys (default 0.001)
 *   CREATOR_LEVY_BPS          creator fee bps, buy+sell (default 100 = 1%)
 *   INTERVAL_SECONDS          seconds between launches (default 60)
 *   MAX_TOKENS                optional count cap (0 = until wallets exhausted)
 *   WALLET_FILE               where keys are stored (default ./wallets.json)
 *   FACTORY_ADDR, RPC, BACKEND, MEME_API, DRY_RUN
 */
'use strict';
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

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

// ---- deployer wallets: load or generate + persist (chmod 600) ----
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

let launched = 0, totalFunded = 0n, stopping = false;

async function main() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(CFG.funderKey)) { console.error('ERROR: set FUNDER_KEY (0x + 64 hex) to the allow-listed owner wallet.'); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(CFG.rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
  const funder = new ethers.Wallet(CFG.funderKey, provider);
  const factoryF = new ethers.Contract(CFG.factory, FACTORY_ABI, funder);
  const wallets = loadOrCreateWallets(provider);

  console.log('🤖 Robinfun seeder — multi-wallet');
  console.log(`   funder   ${funder.address}`);
  console.log(`   wallets  ${wallets.map((w) => w.address.slice(0, 8)).join(', ')}  (${wallets.length})`);
  console.log(`   config   every ${CFG.intervalSec}s · dev-buy ${CFG.devBuyEth} · levy ${CFG.levyBps / 100}% · budget ${CFG.budgetEth} ETH${CFG.dryRun ? ' · DRY RUN' : ''}`);

  // sweep mode: return leftover ETH from deployer wallets to the funder, then exit
  if ((process.argv[2] || '').toLowerCase() === 'sweep') {
    console.log('\n🧹 Sweeping leftover ETH back to the funder…');
    for (const w of wallets) {
      try {
        const bal = await provider.getBalance(w.address);
        const gas = ethers.parseEther('0.0003');
        if (bal <= gas) { console.log(`   ${w.address} — ${fmt(bal)} ETH (too low, skip)`); continue; }
        const tx = await w.sendTransaction({ to: funder.address, value: bal - gas });
        await tx.wait();
        console.log(`   ${w.address} → funder  ${fmt(bal - gas)} ETH  (${tx.hash.slice(0, 12)}…)`);
      } catch (e) { console.log(`   ${w.address} — sweep failed: ${e.shortMessage || e.message}`); }
    }
    console.log('Done.'); process.exit(0);
  }

  const budget = ethers.parseEther(CFG.budgetEth);
  const fundPer = CFG.fundPerWalletEth ? ethers.parseEther(CFG.fundPerWalletEth) : budget / BigInt(wallets.length);
  const devBuy = ethers.parseEther(CFG.devBuyEth);

  // 1) allow-list the deployer wallets (owner-only; needed while betaMode is ON)
  try {
    const [beta, owner] = await Promise.all([factoryF.betaMode(), factoryF.owner()]);
    if (beta) {
      if (owner.toLowerCase() !== funder.address.toLowerCase()) {
        console.log('   ⚠️ betaMode is ON and the funder is NOT the owner — cannot allow-list; launches will revert.');
      } else {
        const need = [];
        for (const w of wallets) { try { if (!(await factoryF.tradeAllowed(w.address))) need.push(w.address); } catch (_) { need.push(w.address); } }
        if (need.length && !CFG.dryRun) { console.log(`   allow-listing ${need.length} wallet(s)…`); const tx = await factoryF.setBetaAllowed(need, true); await tx.wait(); console.log('   allow-listed ✓'); }
      }
    }
  } catch (e) { console.log('   allow-list step skipped:', e.shortMessage || e.message); }

  // 2) fund each deployer wallet up to fundPer (bounded by budget)
  if (!CFG.dryRun) {
    for (const w of wallets) {
      if (totalFunded >= budget) break;
      try {
        const bal = await provider.getBalance(w.address);
        if (bal >= fundPer) continue;
        let top = fundPer - bal;
        if (totalFunded + top > budget) top = budget - totalFunded;
        if (top <= 0n) break;
        const tx = await funder.sendTransaction({ to: w.address, value: top });
        await tx.wait();
        totalFunded += top;
        console.log(`   funded ${w.address.slice(0, 10)}… +${fmt(top)} ETH (total funded ${fmt(totalFunded)}/${CFG.budgetEth})`);
      } catch (e) { console.log(`   fund ${w.address.slice(0, 10)}… failed: ${e.shortMessage || e.message}`); }
    }
  }

  process.on('SIGINT', () => { stopping = true; console.log(`\n👋 stopping — launched ${launched}, funded ${fmt(totalFunded)} ETH. Reclaim leftover: node index.js sweep`); process.exit(0); });

  const deployFee = await factoryF.deployFee();
  const perLaunch = deployFee + devBuy;
  const gasBuf = ethers.parseEther('0.0006');
  let rr = 0;

  while (!stopping) {
    if (CFG.maxTokens && launched >= CFG.maxTokens) { console.log(`\n🛑 MAX_TOKENS ${CFG.maxTokens} reached.`); break; }
    // pick the next deployer wallet that can still afford a launch
    let chosen = null;
    for (let k = 0; k < wallets.length; k++) {
      const w = wallets[(rr + k) % wallets.length];
      const bal = await provider.getBalance(w.address);
      if (bal >= perLaunch + gasBuf) { chosen = w; rr = (rr + k + 1) % wallets.length; break; }
    }
    if (!chosen) { console.log(`\n🛑 All deployer wallets are out of ETH (budget ${CFG.budgetEth} spent). Stopping.`); break; }

    await launchWith(chosen, provider, deployFee, devBuy);
    if (stopping) break;
    await new Promise((res) => setTimeout(res, CFG.intervalSec * 1000));
  }
  console.log(`\nSeeder finished — launched ${launched}. Reclaim leftover ETH: node index.js sweep`);
  process.exit(0);
}

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

main().catch((e) => { console.error(e); process.exit(1); });
