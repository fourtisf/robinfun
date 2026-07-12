// Offline tests for the payment-verification logic (no network, no bot token).
// Run: node selftest.mjs
import { ethToWei, weiToEth, isTxHash, isAddress, verifyPayment } from './verify.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', msg); } };

// --- unit conversions ---
ok(ethToWei('0.01') === 10_000_000_000_000_000n, 'ethToWei 0.01');
ok(ethToWei('1') === 10n ** 18n, 'ethToWei 1');
ok(ethToWei('0.000000000000000001') === 1n, 'ethToWei 1 wei');
ok(weiToEth(10_000_000_000_000_000n) === '0.01', 'weiToEth 0.01');
ok(weiToEth(10n ** 18n) === '1', 'weiToEth 1');

ok(isTxHash('0x' + 'a'.repeat(64)), 'isTxHash good');
ok(!isTxHash('0x' + 'a'.repeat(63)), 'isTxHash short');
ok(isAddress('0x' + 'b'.repeat(40)), 'isAddress good');
ok(!isAddress('0x' + 'b'.repeat(41)), 'isAddress long');

const TREASURY = '0x' + '1'.repeat(40);
const OTHER    = '0x' + '2'.repeat(40);
const HASH     = '0x' + 'f'.repeat(64);
const FEE      = ethToWei('0.01');

// Build a fake RPC from a scenario.
function fakeRpc({ tx, receipt, head }) {
  return async (method) => {
    if (method === 'eth_getTransactionByHash') return tx;
    if (method === 'eth_getTransactionReceipt') return receipt;
    if (method === 'eth_blockNumber') return '0x' + head.toString(16);
    throw new Error('unexpected ' + method);
  };
}
const val = (eth) => '0x' + ethToWei(eth).toString(16);

async function scenario(name, cfg, expectOk, reasonIncludes) {
  const rpc = fakeRpc(cfg);
  const res = await verifyPayment(rpc, { hash: HASH, treasury: TREASURY, feeWei: FEE, minConf: 2 });
  ok(res.ok === expectOk, `${name} → ok=${expectOk} (got ${res.ok}: ${res.reason || ''})`);
  if (!expectOk && reasonIncludes) ok((res.reason || '').includes(reasonIncludes), `${name} reason ~ "${reasonIncludes}"`);
}

await (async () => {
  // happy path: paid exactly, confirmed with 3 confs (head 102, block 100)
  await scenario('exact payment confirmed',
    { tx: { to: TREASURY, from: OTHER, value: val('0.01') }, receipt: { status: '0x1', blockNumber: '0x64' }, head: 102 },
    true);

  // overpayment is fine
  await scenario('overpayment',
    { tx: { to: TREASURY, from: OTHER, value: val('0.05') }, receipt: { status: '0x1', blockNumber: '0x64' }, head: 102 },
    true);

  // wrong recipient
  await scenario('wrong recipient',
    { tx: { to: OTHER, from: OTHER, value: val('0.01') }, receipt: { status: '0x1', blockNumber: '0x64' }, head: 102 },
    false, 'treasury');

  // underpayment
  await scenario('underpayment',
    { tx: { to: TREASURY, from: OTHER, value: val('0.009') }, receipt: { status: '0x1', blockNumber: '0x64' }, head: 102 },
    false, 'too low');

  // not found
  await scenario('tx not found',
    { tx: null, receipt: null, head: 102 },
    false, 'not found');

  // pending (no receipt)
  await scenario('pending receipt',
    { tx: { to: TREASURY, from: OTHER, value: val('0.01') }, receipt: null, head: 102 },
    false, 'pending');

  // reverted
  await scenario('reverted tx',
    { tx: { to: TREASURY, from: OTHER, value: val('0.01') }, receipt: { status: '0x0', blockNumber: '0x64' }, head: 102 },
    false, 'failed');

  // not enough confirmations (head == block → 1 conf, need 2)
  await scenario('too few confirmations',
    { tx: { to: TREASURY, from: OTHER, value: val('0.01') }, receipt: { status: '0x1', blockNumber: '0x64' }, head: 100 },
    false, 'confirmations');
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
