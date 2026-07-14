#!/usr/bin/env node
/*
 * Robinfun seeder — CLI runner (self-funded, multi-wallet).
 *
 * The bot GENERATES its own N deployer wallets, prints their addresses, and
 * your ONLY job is to send ETH to those addresses. It then auto-launches meme
 * tokens from whichever wallets have ETH. NO private key input required.
 *
 * Prefer controlling it from Telegram? Run  node telegram.js  instead.
 *
 * Sweep leftover ETH from the deployers to an address:
 *   node index.js sweep 0xDestination
 */
'use strict';
const {
  ethers, CFG, FACTORY_ABI, makeProvider, loadOrCreateWallets,
  launchWith, readDeployFee, checkBeta, sweepAll, fmt, sleep,
} = require('./core');

let launched = 0, stopping = false;

async function main() {
  const provider = makeProvider();
  const wallets = loadOrCreateWallets(provider);
  const funder = /^0x[0-9a-fA-F]{64}$/.test(CFG.funderKey) ? new ethers.Wallet(CFG.funderKey, provider) : null;
  const factoryRead = new ethers.Contract(CFG.factory, FACTORY_ABI, provider);

  // ---- sweep mode: node index.js sweep 0xDest ----
  if ((process.argv[2] || '').toLowerCase() === 'sweep') {
    const dest = process.argv[3] || (funder && funder.address);
    if (!dest || !ethers.isAddress(dest)) { console.error('Usage: node index.js sweep 0xDESTINATION'); process.exit(1); }
    console.log(`\n🧹 Sweeping leftover ETH → ${dest}`);
    for (const r of await sweepAll(wallets, provider, dest)) {
      if (r.sent !== undefined) console.log(`   ${r.address} → ${fmt(r.sent)} ETH  (${r.tx.slice(0, 12)}…)`);
      else if (r.skip) console.log(`   ${r.address} — ${fmt(r.bal)} ETH (skip)`);
      else console.log(`   ${r.address} — failed: ${r.error}`);
    }
    console.log('Done.'); process.exit(0);
  }

  // ---- the action item: fund these addresses ----
  const devBuy = ethers.parseEther(CFG.devBuyEth);
  let deployFee = await readDeployFee(factoryRead);
  const gasBuf = ethers.parseEther('0.0006');
  const perLaunch = deployFee + devBuy;
  const suggest = fmt(perLaunch * 8n + gasBuf * 8n);

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
  const { beta, owner, missing } = await checkBeta(factoryRead, wallets);
  if (beta && missing.length) {
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
    deployFee = await readDeployFee(factoryRead);
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
    const r = await launchWith(chosen, provider, deployFee, devBuy);
    if (r.ok) {
      launched++;
      console.log(`\n✅ #${launched}  ${r.name}  $${r.ticker}   (creator ${r.creator.slice(0, 10)}…)`);
      console.log(`   CA       ${r.ca || '(parse failed)'}`);
      console.log(`   dev-buy  ${CFG.devBuyEth} ETH · levy ${CFG.levyBps / 100}% · gas ${fmt(r.gasCostWei)} ETH`);
      console.log(`   logo     ${r.memeSrc || '(none)'}  ·  board ${r.posted ? 'posted ✓' : 'POST failed'}`);
      console.log(`   tx       ${r.txHash}`);
    } else {
      console.log(`\n❌ launch failed (${r.creator.slice(0, 10)}…): ${r.error}`);
    }
    await sleep(CFG.intervalSec * 1000);
  }
  if (CFG.dryRun) console.log('\n🧪 DRY RUN — wallets generated & printed above. Set real ETH and remove DRY_RUN to go live.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
