#!/usr/bin/env bash
#
# Robinfun — discover & verify the REAL Uniswap V2 addresses on Robinhood Chain.
#
# Read-only. Makes ZERO transactions and spends ZERO ETH — it only does
# `cast call` / `cast code` reads. Safe to run anytime.
#
# It checks Uniswap's deterministic V2 Factory/Router (the same addresses
# Uniswap uses across its newer multichain deployments) against the live chain,
# and DERIVES WETH from router.WETH() (authoritative). If the candidates are
# wrong on this chain it says so, and you can pass the right ones via env.
#
# Usage (on the VPS):
#   ./discover-dex.sh
#   # or override candidates:
#   FACTORY=0x... ROUTER=0x... ./discover-dex.sh
#
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
RPC="${RPC:-https://rpc.mainnet.chain.robinhood.com}"

# Uniswap's canonical deterministic V2 addresses (Base/Blast/newer chains).
FACTORY="${FACTORY:-0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6}"
ROUTER="${ROUTER:-0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24}"

command -v cast >/dev/null 2>&1 || { echo "cast not found — install Foundry first (see bootstrap-deploy-testnet.sh)"; exit 1; }

has_code(){ local c; c="$(cast code "$1" --rpc-url "$RPC" 2>/dev/null || echo 0x)"; [ "${#c}" -gt 4 ]; }
call(){ cast call "$1" "$2" --rpc-url "$RPC" 2>/dev/null || echo ''; }

echo "RPC     : $RPC"
echo "chainId : $(cast chain-id --rpc-url "$RPC" 2>/dev/null || echo '??  (RPC unreachable!)')"
echo

WETH=""
echo "== Router  $ROUTER =="
if has_code "$ROUTER"; then
  RF="$(call "$ROUTER" 'factory()(address)')"
  RW="$(call "$ROUTER" 'WETH()(address)')"
  echo "  ✓ has code"
  echo "  factory() = ${RF:-<none>}"
  echo "  WETH()    = ${RW:-<none>}"
  WETH="$RW"
else
  echo "  ✗ NO CODE on this chain — this Router address is wrong here."
fi
echo

echo "== Factory $FACTORY =="
if has_code "$FACTORY"; then
  echo "  ✓ has code · allPairsLength() = $(call "$FACTORY" 'allPairsLength()(uint256)')"
else
  echo "  ✗ NO CODE on this chain — this Factory address is wrong here."
fi
echo

if [ -n "$WETH" ] && [ "$WETH" != "0x0000000000000000000000000000000000000000" ]; then
  echo "== WETH    $WETH  (from router.WETH()) =="
  if has_code "$WETH"; then
    echo "  ✓ has code · symbol() = $(call "$WETH" 'symbol()(string)')"
  else
    echo "  ✗ NO CODE — unexpected."
  fi
  echo
fi

echo "──────────────────────────────────────────────"
echo "Send these 3 back to wire graduation to real Uniswap:"
echo "  FACTORY = $FACTORY"
echo "  ROUTER  = $ROUTER"
echo "  WETH    = ${WETH:-<router had no code — get WETH from robinscan.io>}"
echo
echo "If either Router/Factory said 'NO CODE', open developers.uniswap.org/"
echo "docs/protocols/v2/deployments, copy the Robinhood Chain (4663) V2 Factory"
echo "and Router02, then re-run:  FACTORY=0x.. ROUTER=0x.. ./discover-dex.sh"
