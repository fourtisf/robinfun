'use strict';
/*
 * Multi-chain registry for the Robinfun Trade Bot.
 *
 * Every chain here is EVM and exposes a Uniswap-V2-style router (we always use the
 * SupportingFeeOnTransfer swap variants so fee-on-transfer tokens work). A user's
 * single custodial key is the SAME address on all of these, so switching chains
 * needs no new wallet.
 *
 * `curve:true` marks a chain where Robinfun bonding curves exist (Robinhood Chain);
 * everywhere else the bot trades tokens directly on that chain's DEX.
 *
 * RPCs, routers and wrapped-native addresses are ALL overridable via env — verify
 * them for your deployment before going live (a wrong router/RPC = failed trades).
 * Solana / non-EVM is intentionally out of scope here (separate module).
 */
const { ethers } = require('ethers');
const env = (k, d) => { const v = (process.env[k] || '').trim(); return v || d; };

const CHAINS = {
  robinhood: {
    key: 'robinhood', name: 'Robinhood Chain', emoji: '🪶', chainId: Number(env('CHAIN_ID', '4663')), native: 'ETH', curve: true,
    rpc: env('RPC', 'https://rpc.mainnet.chain.robinhood.com'),
    factory: env('FACTORY_ADDR', '0xf0a093bc6ab5bb408ca1f084ec2161d879edaa57'),
    router: env('DEX_ROUTER', '0x89e5db8b5aa49aa85ac63f691524311aeb649eba'),
    weth: env('WETH', '0x0bd7d308f8e1639fab988df18a8011f41eacad73'),
    explorer: env('EXPLORER', 'https://explorer.mainnet.chain.robinhood.com').replace(/\/+$/, ''),
  },
  ethereum: {
    key: 'ethereum', name: 'Ethereum', emoji: '⟠', chainId: 1, native: 'ETH', curve: false,
    rpc: env('ETHEREUM_RPC', 'https://eth.llamarpc.com'),
    router: env('ETHEREUM_ROUTER', '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'),   // Uniswap V2
    weth: env('ETHEREUM_WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
    explorer: 'https://etherscan.io',
  },
  base: {
    key: 'base', name: 'Base', emoji: '🔵', chainId: 8453, native: 'ETH', curve: false,
    rpc: env('BASE_RPC', 'https://mainnet.base.org'),
    router: env('BASE_ROUTER', '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'),        // Uniswap V2 (Base)
    weth: env('BASE_WETH', '0x4200000000000000000000000000000000000006'),
    explorer: 'https://basescan.org',
  },
  bsc: {
    key: 'bsc', name: 'BNB Chain', emoji: '🟡', chainId: 56, native: 'BNB', curve: false,
    rpc: env('BSC_RPC', 'https://bsc-dataseed.binance.org'),
    router: env('BSC_ROUTER', '0x10ED43C718714eb63d5aA57B78B54704E256024E'),         // PancakeSwap V2
    weth: env('BSC_WBNB', '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'),             // WBNB
    explorer: 'https://bscscan.com',
  },
  arbitrum: {
    key: 'arbitrum', name: 'Arbitrum', emoji: '🔷', chainId: 42161, native: 'ETH', curve: false,
    rpc: env('ARBITRUM_RPC', 'https://arb1.arbitrum.io/rpc'),
    router: env('ARBITRUM_ROUTER', '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24'),    // Uniswap V2 (Arbitrum)
    weth: env('ARBITRUM_WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'),
    explorer: 'https://arbiscan.io',
  },
};

// Enabled set (default all). Operators can limit with ENABLED_CHAINS=robinhood,base
const ENABLED = env('ENABLED_CHAINS', 'robinhood,ethereum,base,bsc,arbitrum')
  .split(',').map((s) => s.trim()).filter((k) => CHAINS[k]);
const DEFAULT_CHAIN = ENABLED.includes('robinhood') ? 'robinhood' : (ENABLED[0] || 'robinhood');

const _providers = {};
function providerFor(key) {
  const ch = CHAINS[key];
  if (!ch) throw new Error('unknown chain: ' + key);
  if (!_providers[key]) {
    const net = new ethers.Network(ch.name, ch.chainId);
    _providers[key] = new ethers.JsonRpcProvider(ch.rpc, net, { batchMaxCount: 1, staticNetwork: net });
  }
  return _providers[key];
}
function chainOf(key) { return CHAINS[key] || null; }
function isEnabled(key) { return ENABLED.includes(key); }
function enabledChains() { return ENABLED.map((k) => CHAINS[k]); }

module.exports = { CHAINS, ENABLED, DEFAULT_CHAIN, providerFor, chainOf, isEnabled, enabledChains };
