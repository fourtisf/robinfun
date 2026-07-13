#!/usr/bin/env bash
#
# Robinfun — change the graduation cap on the live factory (owner-only), for
# FUTURE launches. No redeploy. Existing tokens keep the cap they were born with.
#
# The cap (graduationEth) is the ETH a curve collects before it graduates to
# Uniswap — and ~= the DEX liquidity the token launches with. Bigger cap =
# thicker pool = shows better on DexScreener + less slippage for retail.
#
# virtualEth is scaled with the cap (× 1122/2600) so the CURVE SHAPE — price
# multiple and % of supply sold — stays identical to the audited production
# config; only the ETH denomination changes. virtualToken is unchanged.
#
# Usage (on the VPS), owner = the treasury/deployer wallet:
#   PRIVATE_KEY=0xOWNER_KEY ./set-graduation-cap.sh          # 0.05 ETH (default)
#   GRAD_ETH=1 PRIVATE_KEY=0xOWNER_KEY ./set-graduation-cap.sh   # 1 ETH
#
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"
FACTORY="${FACTORY:-0xfa5c740aec9d91cebdc9844e5ca6591f309a5dd2}"
GRAD_ETH="${GRAD_ETH:-0.05}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

: "${PRIVATE_KEY:?Set PRIVATE_KEY to the factory OWNER (treasury) key}"
command -v cast >/dev/null 2>&1 || die "cast not found — install Foundry first."

GRAD_WEI="$(cast to-wei "$GRAD_ETH" ether)"
VTOK_WEI="1080000000000000000000000000"   # 1.08e27 — unchanged
# virtualEth = graduationEth * 1122 / 2600 (exact big-int math).
if command -v python3 >/dev/null 2>&1; then
  VETH_WEI="$(python3 -c "print(${GRAD_WEI} * 1122 // 2600)")"
elif command -v bc >/dev/null 2>&1; then
  VETH_WEI="$(echo "${GRAD_WEI} * 1122 / 2600" | bc)"
else
  die "need python3 or bc to compute virtualEth."
fi

OWNER="$(cast call "$FACTORY" 'owner()(address)' --rpc-url "$RPC")"
CALLER="$(cast wallet address --private-key "$PRIVATE_KEY")"
[ "$(printf '%s' "$OWNER" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$CALLER" | tr 'A-Z' 'a-z')" ] \
  || die "Caller ${CALLER} is not the factory owner (${OWNER}). Use the treasury key."

log "Factory        : ${FACTORY}"
log "New graduation cap: ${GRAD_ETH} ETH (${GRAD_WEI} wei)"
log "  virtualEth   = ${VETH_WEI}"
log "  virtualToken = ${VTOK_WEI}"
log "  graduationEth= ${GRAD_WEI}"

cast send "$FACTORY" 'setCurveParams((uint128,uint128,uint128))' \
  "(${VETH_WEI},${VTOK_WEI},${GRAD_WEI})" \
  --private-key "$PRIVATE_KEY" --rpc-url "$RPC" >/dev/null

NEW="$(cast call "$FACTORY" 'curveParams()(uint128,uint128,uint128)' --rpc-url "$RPC" 2>/dev/null || echo '')"
log "curveParams() now: ${NEW}"
log "Done. NEW tokens launched from now on graduate at ${GRAD_ETH} ETH."
echo "Existing tokens keep their original cap. Now run ./deploy/update.sh and hard-refresh."
