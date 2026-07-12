#!/usr/bin/env bash
#
# Robinfun — deploy the contracts to Robinhood Chain TESTNET from the VPS.
# Installs Foundry, builds the contracts, and runs the self-contained testnet
# deployment (protocol + a functional Uniswap-v2 DEX + WETH).
#
# TESTNET ONLY. The contracts are NOT audited — never point this at mainnet.
#
# Usage (root or a sudo user, on the VPS):
#   PRIVATE_KEY=0xYOUR_FRESH_TESTNET_KEY TREASURY=0xYOUR_WALLET ./bootstrap-deploy-testnet.sh
#
#   PRIVATE_KEY  a FRESH throwaway wallet's key, funded from the faucet
#                (faucet.testnet.chain.robinhood.com). NEVER your main wallet.
#   TREASURY     (optional) wallet that receives protocol fees; default = deployer.
#
set -euo pipefail

RPC="${RPC:-https://rpc.testnet.chain.robinhood.com}"
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-claude/new-session-v8c9tt}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

: "${PRIVATE_KEY:?Set PRIVATE_KEY to a FUNDED testnet deployer key (fresh throwaway wallet, not your main one)}"

# Validate the key EARLY (before the long build) — reject leftover placeholders
# and wrong formats with a clear message.
case "$PRIVATE_KEY" in
  *KUNCI_WALLET*|*WALLET_BARU*|*YOUR_*|*your-*|*ISI_*)
    die "PRIVATE_KEY is still a placeholder. Paste the REAL private key of your fresh, faucet-funded testnet wallet (MetaMask → Account details → Show private key)." ;;
esac
printf '%s' "$PRIVATE_KEY" | grep -Eq '^0x[0-9a-fA-F]{64}$' \
  || die "PRIVATE_KEY must be 0x followed by 64 hex characters (a wallet private key), e.g. 0xabc123...  Export it from MetaMask → Account details → Show private key."

export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y git
command -v node >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y nodejs npm
command -v curl >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y curl

# ---- Foundry ----
export PATH="$HOME/.foundry/bin:$PATH"
if ! command -v forge >/dev/null 2>&1; then
    log "Installing Foundry"
    curl -L https://foundry.paradigm.xyz | bash
    "$HOME/.foundry/bin/foundryup"
    export PATH="$HOME/.foundry/bin:$PATH"
fi
forge --version >/dev/null || die "forge failed to install"

# ---- code ----
log "Fetching the code (branch ${BRANCH})"
if [ -d "$SRC_DIR/.git" ]; then
    git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
else
    git clone --depth 1 -b "$BRANCH" "$REPO" "$SRC_DIR"
fi
cd "$SRC_DIR/contracts"

log "Installing contract dependencies (OpenZeppelin + solc)"
npm install --no-audit --no-fund

# On the VPS we use NATIVE solc (svm downloads the real 0.8.26), NOT the WASM
# shim that foundry.toml pins for the sandbox (that WASM build crashes here with
# "memory access out of bounds"). `--use 0.8.26` overrides the pinned solc.
#
# We compile for the PARIS evm, not cancun: solc's cancun output contains the
# `mcopy` opcode (EIP-5656), which Robinhood Chain testnet does not support yet
# — the deploy simulates fine locally but every real tx reverts on an unknown
# opcode. paris is mcopy-free. (This is why the repo pins OpenZeppelin 5.0.2:
# newer OZ hardcodes mcopy and would not compile for paris.) Override with
# EVM_VERSION=... if the target chain supports a newer EVM.
EVM_VERSION="${EVM_VERSION:-paris}"
SOLC_FLAGS="--use 0.8.26 --evm-version ${EVM_VERSION}"

log "Building contracts with native solc 0.8.26 (evm: ${EVM_VERSION})"
forge build $SOLC_FLAGS

# Default the treasury to the deployer's own address if not given.
if [ -z "${TREASURY:-}" ]; then
    TREASURY="$(cast wallet address --private-key "$PRIVATE_KEY")"
fi
export TREASURY
log "Deployer treasury (protocol-fee recipient): ${TREASURY}"

# Sanity: is the deployer funded?
DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
BAL="$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null || echo 0)"
log "Deployer ${DEPLOYER} balance: ${BAL} wei"
[ "$BAL" != "0" ] || die "Deployer has 0 ETH. Fund ${DEPLOYER} at faucet.testnet.chain.robinhood.com, then re-run."

log "Deploying to Robinhood Chain testnet (${RPC})"
forge script script/DeployTestnet.s.sol $SOLC_FLAGS --rpc-url "$RPC" --broadcast -vvv 2>&1 | tee /tmp/robinfun-deploy.log

log "Done. Copy the addresses below (also in broadcast/DeployTestnet.s.sol/46630/run-latest.json):"
grep -E "WETH|DEX (factory|router)|FeeRouter|Factory|tokenImpl|treasury|deployFee" /tmp/robinfun-deploy.log || true
echo
echo "Send the 'Factory' address back so the frontend can be wired to it."
