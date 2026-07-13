#!/usr/bin/env bash
#
# Robinfun — set the LIVE on-chain deploy fee on the already-deployed factory.
#
# The website reads the deploy fee live from the factory, so changing it is an
# on-chain owner transaction — not a website edit. The current beta factory was
# deployed with a 0.0002 ETH fee; this sets it to 0.001 ETH (the intended
# value). Only the factory OWNER (the treasury the deploy handed ownership to)
# can call this.
#
# Usage (on the VPS, or anywhere with cast + RPC access):
#   PRIVATE_KEY=0xOWNER_KEY ./set-deploy-fee.sh
#
#   PRIVATE_KEY  the factory owner's key (the treasury wallet from the deploy,
#                0xA49dc277A65CCb35D94522cecDa19CA340AE991C for the beta).
# Optional env:
#   FEE_ETH      fee in ETH (default 0.001)
#   FACTORY      factory address (default the beta factory)
#   RPC          RPC URL (default Robinhood Chain testnet)
#
set -euo pipefail

RPC="${RPC:-https://rpc.testnet.chain.robinhood.com}"
FACTORY="${FACTORY:-0xD975d8F2d5447312810347C9c2D75548738D4E11}"
FEE_ETH="${FEE_ETH:-0.001}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

: "${PRIVATE_KEY:?Set PRIVATE_KEY to the factory OWNER (treasury) key}"
printf '%s' "$PRIVATE_KEY" | grep -Eq '^0x[0-9a-fA-F]{64}$' \
  || die "PRIVATE_KEY must be 0x followed by 64 hex characters."

export PATH="$HOME/.foundry/bin:$PATH"
command -v cast >/dev/null 2>&1 || die "cast not found — install Foundry first (see bootstrap-deploy-testnet.sh)."

FEE_WEI="$(cast to-wei "$FEE_ETH" ether)"
CALLER="$(cast wallet address --private-key "$PRIVATE_KEY")"

# Guard: only the owner can set the fee — check before sending so we fail with
# a clear message instead of an opaque revert.
OWNER="$(cast call "$FACTORY" 'owner()(address)' --rpc-url "$RPC")"
if [ "$(printf '%s' "$OWNER" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$CALLER" | tr 'A-Z' 'a-z')" ]; then
  die "Caller ${CALLER} is not the factory owner (${OWNER}). Use the treasury key."
fi

CURRENT="$(cast call "$FACTORY" 'deployFee()(uint256)' --rpc-url "$RPC")"
log "Factory ${FACTORY}"
log "Current deploy fee: ${CURRENT} wei"
log "Setting deploy fee to ${FEE_ETH} ETH (${FEE_WEI} wei)"

cast send "$FACTORY" 'setDeployFee(uint256)' "$FEE_WEI" \
  --private-key "$PRIVATE_KEY" --rpc-url "$RPC" >/dev/null

NEW="$(cast call "$FACTORY" 'deployFee()(uint256)' --rpc-url "$RPC")"
[ "$NEW" = "$FEE_WEI" ] || die "Fee did not update (got ${NEW}). Check the tx."
log "Done. Live deploy fee is now ${NEW} wei (${FEE_ETH} ETH). Hard-refresh the site to see it."
