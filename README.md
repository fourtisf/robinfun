# Robinfun

Fair-launch memecoin launchpad on **Robinhood Chain** (Arbitrum Orbit L2, gas in ETH) with one differentiator: the **creator levy** — a creator-configurable 0–10% transfer tax that lives **in the token contract**, so creators keep earning on Uniswap volume **after graduation**, unlike platform-level fees that stop at the curve.

- **Design/UX source of truth:** [`docs/robinfun-prototype.html`](docs/robinfun-prototype.html) (open it in a browser)
- **Product/mechanics brief:** [`docs/BUILD-BRIEF.md`](docs/BUILD-BRIEF.md)

## Status — Milestone 1 (contracts)

This repo currently contains **M1: the smart-contract core + full Foundry test suite** (see [`contracts/`](contracts/)). Per the brief's build order:

| Milestone | Status |
|---|---|
| **M1** Contracts: factory, token, curve, graduation + LP burn, fee router | ✅ implemented + tested |
| **M2** $ROBIN + staking | 🟡 contracts written & tested, **launch blocked on tokenomics (§10.1)** |
| **M3** Indexer + API | ⬜ not started |
| **M4** Frontend wired | ⬜ not started (prototype is fully functional as a simulation) |
| **M5** Audit + mainnet | ⬜ blocked on M1–M4 + third-party audit |

### What's wired

- `RobinfunFactory` — one-tx launches via EIP-1167 clones, 10%/0.5%-step levy caps enforced, deploy fee, atomic dev buy, rich `TokenCreated` events.
- `RobinfunToken` — fixed 1B supply, fee-on-transfer levy on canonical-pair trades only (wallet↔wallet never taxed), lower-only rates, `renounceRateControl`, optional halve-at-graduation decay, frozen exemption set, **no mint/pause/blacklist/max-wallet — honeypots structurally impossible**.
- `BondingCurve` — pump.fun-style virtual-reserve constant product (~$4k start → ~$44k graduation at ETH=$3850), 1% curve fee + ETH-denominated levy per trade, capped final buy w/ refund, atomic graduation: pool seeded at graduation price, **LP minted directly to `0xdead` (100% burned)**, leftover inventory burned, curve closed forever.
- `FeeRouter` — 90/10 levy split (creator/protocol), permissionless `harvest()` (token levies → ETH via DEX), pull-based creator claims (`claim`/`claimMany` = Treasury page), permissionless `flushProtocol()` streaming to stakers.
- `ROBIN` + `RobinStaking` — Synthetix-style ETH revenue share, instant unstake, checkpointed against retroactive/flash-stake capture. **Deployable but not launchable** until §10.1 is answered.

### What's still mocked / pending

- **DEX**: tests run against a faithful in-repo Uniswap-v2 mock; the real Robinhood Chain deployment (factory/router/WETH addresses) is open question **§10.2**.
- **Price oracle** (§10.4): USD figures are display-only; curve params are ETH-denominated and computed at ETH=$3850. Needs an oracle-informed config before mainnet.
- **$ROBIN tokenomics** (§10.1), **protocol multisig** (§10.5), **deploy-fee value/recipient** (§10.8), **testnet RPC/chainId** (§10.9) — all parameterized, ask ALFA.
- **Fee-on-transfer tradeoff** (§10.6): implemented as specified (levy applies to DEX trades — that's the pitch), which breaks most CEX listings and some aggregators. Frontend/router integrations MUST use `swapExact*SupportingFeeOnTransferTokens`.

## Development

```bash
cd contracts
npm install          # OpenZeppelin + the WASM solc used by the sandbox shim
forge build
forge test           # unit + fuzz + invariant suites
FOUNDRY_PROFILE=ci forge test   # deeper fuzz/invariant runs
```

> **Note on the compiler:** this repo pins `tools/solc`, a thin CLI shim around the npm `solc@0.8.26` (soljson) package, because the build sandbox cannot reach `binaries.soliditylang.org`. It is the byte-identical 0.8.26 release, just WASM. On a normal machine you can delete the `solc = "tools/solc"` line in `foundry.toml` and set `solc_version = "0.8.26"`.

### Deploy (testnet — §10.9 pending)

```bash
cd contracts
cp .env.example .env   # fill in PROTOCOL_MULTISIG, DEX_FACTORY, DEX_ROUTER, WETH, RPC_URL
forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
```

## Security posture (M1)

- Reentrancy guards + checks-effects-interactions on every ETH-moving path; pull-over-push for creator earnings.
- Tracked (not `balance`-derived) reserve accounting — force-sent ETH cannot poison the curve.
- Donation-griefing at graduation neutralized (`skim` before the LP mint).
- Fuzz + invariant coverage: curve monotonicity & solvency, x·y ≥ k, levy-split conservation, no-honeypot full-exit probe, staking reward conservation, graduation atomicity + LP burn.
- **No mainnet deploy without a third-party audit** (brief §11). Suggested extra pre-audit step: bug bounty.

## Repository layout

```
docs/                     prototype (design truth) + build brief
contracts/
  src/                    RobinfunFactory, RobinfunToken, BondingCurve,
                          FeeRouter, ROBIN, RobinStaking + interfaces
  test/                   BaseSetup fixture, unit/, fuzz-in-unit, invariant/, E2E
  test/mocks/             WETH9 + functional Uniswap-v2 (fee-on-transfer capable)
  script/Deploy.s.sol     parameterized testnet deploy
  tools/solc              WASM solc shim (sandbox-only convenience)
```
