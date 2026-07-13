#!/usr/bin/env bash
#
# Robinfun — deploy to Robinhood Chain MAINNET as a LOCKED-DOWN PRIVATE BETA.
#
# ⚠️  THIS SPENDS REAL ETH. Read this header before running.
#
# What it deploys (DeployMainnetBeta.s.sol):
#   - our own Uniswap-v2 DEX (faithful constant-product pair) + WETH,
#   - FeeRouter + Factory (token/curve implementations),
#   with betaMode ON so ONLY the allowlisted BETA_TESTER wallet can create
#   tokens or trade, and a per-token graduation cap of 0.001 ETH (~$1-2) — the
#   provable maximum any single curve can hold before it graduates and burns
#   100% of the LP. So the funds a bug could ever strand are ~$1-2 per token.
#
# Wallet model (IMPORTANT):
#   PRIVATE_KEY  = a FRESH mainnet wallet you have NEVER pasted anywhere. It is
#                  the admin (owner + fee treasury). Fund it with a little real
#                  ETH for gas + the deploy. DO NOT reuse a key you have shown
#                  in a screenshot, chat, or terminal — those are compromised.
#   BETA_TESTER  = the ONE wallet allowed to create/trade in the beta. Defaults
#                  to 0xA49dc277A65CCb35D94522cecDa19CA340AE991C. This can be a
#                  low-value hot wallet; keep only test amounts in it.
#
# Usage (on the VPS):
#   RPC=https://<mainnet-rpc> PRIVATE_KEY=0xFRESH_ADMIN_KEY ./bootstrap-deploy-mainnet.sh
#
# Optional env:
#   TREASURY      owner + fee recipient (default: the deployer wallet).
#   BETA_TESTER   the sole allowlisted create/trade wallet (default above).
#   DEPLOY_FEE    per-launch fee in wei (default 0.001 ether = 1000000000000000).
#   EVM_VERSION   default 'paris' (mcopy-free — Robinhood Chain rejects mcopy).
#   GAS_MULT      gas-estimate multiplier % for the Arbitrum L1 data component
#                 (default 600). Real mainnet gas is NOT free, so a smaller
#                 buffer than testnet is fine once you confirm txs land.
#
set -euo pipefail

: "${RPC:?Set RPC to the Robinhood Chain MAINNET RPC URL (there is no default for mainnet)}"
SRC_DIR="${SRC_DIR:-/opt/robinfun}"
BRANCH="${BRANCH:-claude/new-session-v8c9tt}"
REPO="${REPO:-https://github.com/fourtisf/robinfun.git}"

log(){ printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\n\033[1;33m!!\033[0m %s\n' "$*"; }
die(){ printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

: "${PRIVATE_KEY:?Set PRIVATE_KEY to a FRESH, funded mainnet admin key (never one you have pasted anywhere)}"

case "$PRIVATE_KEY" in
  *KUNCI_*|*WALLET_BARU*|*YOUR_*|*your-*|*ISI_*|*FRESH_*)
    die "PRIVATE_KEY is still a placeholder. Paste the REAL private key of your fresh, funded mainnet admin wallet." ;;
esac
printf '%s' "$PRIVATE_KEY" | grep -Eq '^0x[0-9a-fA-F]{64}$' \
  || die "PRIVATE_KEY must be 0x followed by 64 hex characters."

export PATH="$HOME/.foundry/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y git
command -v curl >/dev/null 2>&1 || apt-get -o DPkg::Lock::Timeout=300 install -y curl
if ! command -v forge >/dev/null 2>&1; then
    log "Installing Foundry"
    curl -L https://foundry.paradigm.xyz | bash
    "$HOME/.foundry/bin/foundryup"
    export PATH="$HOME/.foundry/bin:$PATH"
fi
forge --version >/dev/null || die "forge failed to install"

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

# NATIVE solc 0.8.26 + paris (mcopy-free) — same reasoning as the testnet script.
EVM_VERSION="${EVM_VERSION:-paris}"
SOLC_FLAGS="--use 0.8.26 --evm-version ${EVM_VERSION}"

log "Building contracts with native solc 0.8.26 (evm: ${EVM_VERSION})"
forge build $SOLC_FLAGS

# Admin / tester / treasury summary + funding sanity.
DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
TREASURY="${TREASURY:-$DEPLOYER}"; export TREASURY
BETA_TESTER="${BETA_TESTER:-0xA49dc277A65CCb35D94522cecDa19CA340AE991C}"; export BETA_TESTER
DEPLOY_FEE="${DEPLOY_FEE:-1000000000000000}"; export DEPLOY_FEE

BAL="$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null || echo 0)"
log "Admin/deployer : ${DEPLOYER}  (balance ${BAL} wei)"
log "Treasury/owner : ${TREASURY}"
log "Beta tester    : ${BETA_TESTER}  (the ONLY wallet that can create/trade)"
log "Deploy fee     : ${DEPLOY_FEE} wei"
[ "$BAL" != "0" ] || die "Admin wallet ${DEPLOYER} has 0 ETH on this RPC. Fund it with real ETH and re-run."

warn "This deploys to MAINNET and spends REAL ETH. betaMode ON — only ${BETA_TESTER} can create/trade."
warn "Ctrl-C now if the admin wallet is not a fresh, never-exposed key."
sleep 6

log "Deploying to ${RPC}"
GAS_MULT="${GAS_MULT:-600}"
forge script script/DeployMainnetBeta.s.sol $SOLC_FLAGS --rpc-url "$RPC" --broadcast \
    --slow --gas-estimate-multiplier "$GAS_MULT" -vvv 2>&1 | tee /tmp/robinfun-mainnet-deploy.log

log "Done. Addresses (also in broadcast/DeployMainnetBeta.s.sol/<chainId>/run-latest.json):"
grep -E "Factory|FeeRouter|WETH|DEX (factory|router)|tokenImpl|curveImpl|deployFee|graduation" /tmp/robinfun-mainnet-deploy.log || true
echo
echo "Send the Factory / FeeRouter / WETH / DEX addresses + the mainnet chainId,"
echo "RPC and explorer URL back so the frontend can be wired to mainnet."
