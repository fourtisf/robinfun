#!/usr/bin/env node
/*
 * Robinfun seeder bot — auto-launches meme tokens on a schedule to keep the
 * board active. Each launch:
 *   - random meme NAME + TICKER (word-list generator),
 *   - a random MEME IMAGE from a public meme API (Reddit-sourced, SFW-filtered;
 *     NOT Pinterest scraping — that violates their ToS and blocks bots),
 *   - a configurable DEV-BUY, a configurable CREATOR LEVY (default 1%),
 *   - posts metadata + logo to the backend so it shows on the board.
 *
 * Everything is env-configurable and there is a HARD BUDGET CAP: the bot stops
 * itself once it has spent BUDGET_CAP_ETH (deploy fees + dev-buys + gas), so it
 * can never run away with real ETH. DRY_RUN=1 simulates without spending.
 *
 * Config (env):
 *   PRIVATE_KEY        allow-listed wallet key (required; the one that may create)
 *   RPC                default Robinhood Chain mainnet
 *   FACTORY_ADDR       launchpad factory (default = the live one on robinfun.io)
 *   BACKEND            metadata API base (default http://127.0.0.1:3001)
 *   INTERVAL_SECONDS   seconds between launches (default 60)
 *   DEV_BUY_ETH        ETH the bot buys of each token (default 0.001)
 *   CREATOR_LEVY_BPS   creator fee in bps, buy+sell (default 100 = 1%; max 1000)
 *   BUDGET_CAP_ETH     auto-stop after this much total spend (default 0.05)
 *   MAX_TOKENS         optional hard count cap (default 0 = unlimited)
 *   MEME_API           default https://meme-api.com/gimme
 *   DRY_RUN            1/true → simulate, send no transactions
 */
'use strict';
const { ethers } = require('ethers');

const CFG = {
  rpc: process.env.RPC || 'https://rpc.mainnet.chain.robinhood.com',
  factory: (process.env.FACTORY_ADDR || '0xfa5c740aec9d91cebdc9844e5ca6591f309a5dd2').trim(),
  pk: (process.env.PRIVATE_KEY || '').trim(),
  backend: (process.env.BACKEND || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
  intervalSec: Math.max(5, Number(process.env.INTERVAL_SECONDS || 60)),
  devBuyEth: String(process.env.DEV_BUY_ETH || '0.001'),
  levyBps: Math.min(1000, Math.max(0, Number(process.env.CREATOR_LEVY_BPS || 100))),
  budgetEth: String(process.env.BUDGET_CAP_ETH || '0.05'),
  maxTokens: Number(process.env.MAX_TOKENS || 0),
  memeApi: process.env.MEME_API || 'https://meme-api.com/gimme',
  dryRun: /^(1|true|yes)$/i.test(process.env.DRY_RUN || ''),
};

const FACTORY_ABI = [
  'function createToken((string name,string symbol,string metadataURI,uint16 buyLevyBps,uint16 sellLevyBps,bool decayAtGraduation,bool renounceRateControl,uint256 devBuyMinTokensOut,bytes32 vanitySalt,uint256 maxDeployFee)) payable returns (address token, address curve)',
  'function deployFee() view returns (uint256)',
  'function tradeAllowed(address) view returns (bool)',
  'event TokenCreated(address indexed token, address indexed curve, address indexed creator, string name, string symbol, string metadataURI, uint16 buyLevyBps, uint16 sellLevyBps, bool decayAtGraduation, bool renounceRateControl, uint256 deployFee, uint256 devBuyEth)',
];

// ---------- random meme name / ticker ----------
const PRE = ['Doge','Pepe','Wojak','Chad','Turbo','Giga','Baby','Based','Mega','Shib','Floki','Cyber','Rocket','Degen','Sigma','Ninja','Cosmic','Quantum','Hyper','Moon','Ser','Wen','Giga','Bonk','Wif','Fren','Comfy','Alpha','Vibe','Astro'];
const POST = ['Inu','Cat','Frog','Moon','Rocket','Coin','Lord','King','Ape','Bull','Bonk','Elon','Mars','Pump','Fren','Wojak','Pepe','Doge','Meme','Chad','Whale','Hodl','Lambo','Wagmi','Pamp','Gains','Chan','Bro','Fud','Zilla'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];
function genName() {
  const name = (pick(PRE) + ' ' + pick(POST) + (Math.random() < 0.3 ? ' ' + Math.floor(Math.random() * 1000) : '')).slice(0, 64);
  let ticker = (pick(PRE) + pick(POST)).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3 + Math.floor(Math.random() * 4));
  if (ticker.length < 3) ticker = ('MEME' + ticker).slice(0, 5);
  return { name, ticker };
}

// ---------- random meme image → data URL (SFW-filtered) ----------
async function fetchMeme() {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(CFG.memeApi, { signal: AbortSignal.timeout(8000) });
      const j = await res.json();
      if (!j || j.nsfw || j.spoiler) continue;
      const url = j.url || (Array.isArray(j.preview) && j.preview[j.preview.length - 1]);
      if (!url) continue;
      const img = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const ct = (img.headers.get('content-type') || '').toLowerCase();
      if (!/^image\/(png|jpe?g|gif|webp)/.test(ct)) continue;
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > 1_900_000 || buf.length < 200) continue; // backend cap ~2MB
      return { dataUrl: `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`, src: url, title: String(j.title || '') };
    } catch (_) { /* retry */ }
  }
  return null; // launch without a logo
}

async function postMeta(rec) {
  try {
    const r = await fetch(CFG.backend + '/api/tokens', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(rec), signal: AbortSignal.timeout(20000),
    });
    return r.ok;
  } catch (_) { return false; }
}

const fmt = (wei) => ethers.formatEther(wei);
let launched = 0;
let totalSpent = 0n;
let stopping = false;

async function launchOnce(provider, wallet, factory) {
  const budget = ethers.parseEther(CFG.budgetEth);
  if (totalSpent >= budget) { console.log(`\n🛑 Budget cap ${CFG.budgetEth} ETH reached (spent ${fmt(totalSpent)}). Stopping.`); return 'stop'; }
  if (CFG.maxTokens && launched >= CFG.maxTokens) { console.log(`\n🛑 MAX_TOKENS ${CFG.maxTokens} reached. Stopping.`); return 'stop'; }

  const { name, ticker } = genName();
  const [meme, deployFee] = await Promise.all([fetchMeme(), factory.deployFee()]);
  const devBuy = ethers.parseEther(CFG.devBuyEth);
  const value = deployFee + devBuy;

  const balBefore = await provider.getBalance(wallet.address);
  if (balBefore < value + ethers.parseEther('0.0005')) { console.log(`\n⚠️  Low balance ${fmt(balBefore)} ETH (need ~${fmt(value)} + gas). Stopping.`); return 'stop'; }
  if (totalSpent + value > budget) { console.log(`\n🛑 Next launch would exceed the ${CFG.budgetEth} ETH cap. Stopping.`); return 'stop'; }

  const params = {
    name, symbol: ticker, metadataURI: '',
    buyLevyBps: CFG.levyBps, sellLevyBps: CFG.levyBps,
    decayAtGraduation: false, renounceRateControl: false,
    devBuyMinTokensOut: 0n, vanitySalt: ethers.ZeroHash, maxDeployFee: deployFee,
  };

  if (CFG.dryRun) {
    console.log(`\n🧪 [DRY] ${name} $${ticker} · devBuy ${CFG.devBuyEth} · levy ${CFG.levyBps / 100}% · logo ${meme ? 'yes' : 'none'} · value ${fmt(value)} ETH`);
    launched++; totalSpent += value; return 'ok';
  }

  let receipt;
  try {
    const tx = await factory.createToken(params, { value });
    receipt = await tx.wait();
  } catch (e) {
    console.log(`\n❌ launch failed: ${e.shortMessage || e.reason || e.message}`);
    return 'ok';
  }
  let ca = '';
  for (const lg of receipt.logs) {
    try { const p = factory.interface.parseLog(lg); if (p && p.name === 'TokenCreated') { ca = p.args.token; break; } } catch (_) {}
  }
  const balAfter = await provider.getBalance(wallet.address);
  const spent = balBefore - balAfter;         // exact: deployFee + net dev-buy + gas (refund already back)
  totalSpent += spent; launched++;
  const gasCost = receipt.gasUsed * (receipt.gasPrice || 0n);

  const posted = await postMeta({
    name, ticker, ca,
    description: (meme && meme.title ? meme.title : `${name} — a Robinfun fair launch`).slice(0, 280),
    buyFee: CFG.levyBps / 100, sellFee: CFG.levyBps / 100,
    creator: wallet.address, logo: meme ? meme.dataUrl : undefined,
  });

  console.log(`\n✅ #${launched}  ${name}  $${ticker}`);
  console.log(`   CA       ${ca || '(parse failed)'}`);
  console.log(`   dev-buy  ${CFG.devBuyEth} ETH · levy ${CFG.levyBps / 100}% · gas ${fmt(gasCost)} ETH`);
  console.log(`   spent    ${fmt(spent)} ETH  ·  total ${fmt(totalSpent)} / ${CFG.budgetEth} ETH`);
  console.log(`   logo     ${meme ? meme.src : '(none)'}  ·  board ${posted ? 'posted ✓' : 'POST failed'}`);
  console.log(`   tx       ${receipt.hash}`);
  return 'ok';
}

async function main() {
  if (!/^0x[0-9a-fA-F]{64}$/.test(CFG.pk)) { console.error('ERROR: set PRIVATE_KEY (0x + 64 hex) to the allow-listed wallet.'); process.exit(1); }
  if (!/^0x[0-9a-fA-F]{40}$/.test(CFG.factory)) { console.error('ERROR: bad FACTORY_ADDR.'); process.exit(1); }
  const provider = new ethers.JsonRpcProvider(CFG.rpc, undefined, { batchMaxCount: 1, staticNetwork: true });
  const wallet = new ethers.Wallet(CFG.pk, provider);
  const factory = new ethers.Contract(CFG.factory, FACTORY_ABI, wallet);

  console.log('🤖 Robinfun seeder bot');
  console.log(`   wallet   ${wallet.address}`);
  console.log(`   factory  ${CFG.factory}`);
  console.log(`   config   every ${CFG.intervalSec}s · dev-buy ${CFG.devBuyEth} · levy ${CFG.levyBps / 100}% · budget ${CFG.budgetEth} ETH${CFG.maxTokens ? ' · max ' + CFG.maxTokens : ''}${CFG.dryRun ? ' · DRY RUN' : ''}`);
  try { if (!(await factory.tradeAllowed(wallet.address))) console.log('   ⚠️  wallet is NOT allow-listed — real launches will revert while betaMode is ON.'); } catch (_) {}

  process.on('SIGINT', () => { stopping = true; console.log(`\n👋 stopping — launched ${launched}, spent ${fmt(totalSpent)} ETH`); process.exit(0); });

  while (!stopping) {
    let r = 'ok';
    try { r = await launchOnce(provider, wallet, factory); } catch (e) { console.log('iteration error:', e.message); }
    if (r === 'stop') break;
    await new Promise((res) => setTimeout(res, CFG.intervalSec * 1000));
  }
  console.log(`\nSeeder finished — launched ${launched}, spent ${fmt(totalSpent)} ETH.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
