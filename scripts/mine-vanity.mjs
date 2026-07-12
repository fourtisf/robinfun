#!/usr/bin/env node
// Robinfun vanity-address salt miner.
//
// Robinfun tokens are deployed by RobinfunFactory via CREATE2
// (Clones.cloneDeterministic). This grinds a `vanitySalt` until the resulting
// token address ends in a chosen hex suffix — Robinfun's signature is `…feed`.
//
// The predicted address must match RobinfunFactory.predictTokenAddress(...);
// the CREATE2 inputs below are pinned by the Foundry test
// `test_vanity_formulaMatchesRawCreate2`.
//
//   node mine-vanity.mjs --factory 0x.. --impl 0x.. --creator 0x.. --suffix feed
//
// Prints a `vanitySalt` to pass as CreateParams.vanitySalt in createToken().
import pkg from 'js-sha3';
const { keccak256 } = pkg;

// EIP-1167 minimal-proxy init code around the token implementation (OZ Clones).
const INIT_PREFIX = '3d602d80600a3d3981f3363d3d373d3d3d363d73';
const INIT_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

const strip = (h) => h.replace(/^0x/, '').toLowerCase();
const pad32 = (h) => strip(h).padStart(64, '0');
function bytes(hex) {
  hex = strip(hex);
  const a = new Uint8Array(hex.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
  return a;
}
const kec = (hex) => keccak256(bytes(hex)); // hex string, no 0x

function initCodeHash(impl) {
  return kec(INIT_PREFIX + strip(impl) + INIT_SUFFIX);
}
// salt = keccak256(abi.encode(address creator, bytes32 vanitySalt))
function tokenSalt(creatorPadded, vanitySalt) {
  return kec(creatorPadded + pad32(vanitySalt));
}
// address = keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
export function predict(factory, impl, creator, vanitySalt) {
  const salt = tokenSalt(pad32(creator), vanitySalt);
  return '0x' + kec('ff' + pad32(factory).slice(24) + salt + initCodeHash(impl)).slice(24);
}

export function mine(factory, impl, creator, suffix, { maxTries = 20_000_000 } = {}) {
  suffix = strip(suffix);
  const ich = initCodeHash(impl);
  const fac = strip(factory);
  const cre = pad32(creator);
  for (let i = 0; i < maxTries; i++) {
    const vanitySalt = i.toString(16).padStart(64, '0');
    const salt = kec(cre + vanitySalt);
    const addr = kec('ff' + fac + salt + ich).slice(24);
    if (addr.endsWith(suffix)) return { vanitySalt: '0x' + vanitySalt, address: '0x' + addr, tries: i + 1 };
  }
  return null;
}

// ---- CLI ----
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const factory = arg('factory');
  const impl = arg('impl');
  const creator = arg('creator');
  const suffix = arg('suffix', 'feed');
  if (!factory || !impl || !creator) {
    console.error('usage: mine-vanity.mjs --factory 0x.. --impl 0x.. --creator 0x.. [--suffix feed]');
    process.exit(1);
  }
  const t0 = Date.now();
  const r = mine(factory, impl, creator, suffix);
  if (!r) { console.error('no salt found within the try limit'); process.exit(1); }
  console.log(JSON.stringify({ ...r, suffix, ms: Date.now() - t0 }, null, 2));
}
