'use strict';
/*
 * safety.js — one door for pre-trade token safety, chain-aware. Routes to GoPlus on
 * EVM chains and RugCheck on Solana, both of which expose the same
 * supported/tokenSecurity/verdict shape. Callers pass the chainKey and never care
 * which provider answered.
 */
const goplus = require('./goplus');
const rugcheck = require('./rugcheck');
const chains = require('./chains');

const modOf = (chainKey) => (chains.isSvm(chainKey) ? rugcheck : goplus);

module.exports = {
  supported: (chainKey) => modOf(chainKey).supported(chainKey),
  tokenSecurity: (chainKey, ca) => modOf(chainKey).tokenSecurity(chainKey, ca),
  verdict: (chainKey, sec) => modOf(chainKey).verdict(sec),
  goplus, rugcheck,
};
