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

- `RobinfunFactory` — one-tx launches via EIP-1167 clones, 10%/0.5%-step levy caps enforced, deploy fee, atomic dev buy, rich `TokenCreated` events. Optional **vanity address**: tokens deploy via CREATE2 with a creator-bound salt, so an off-chain miner (`scripts/mine-vanity.mjs`) can grind every token address to end in Robinfun's signature suffix **`…feed`**.
- `RobinfunToken` — fixed 1B supply, fee-on-transfer levy on canonical-pair trades only (wallet↔wallet never taxed), lower-only rates, `renounceRateControl`, optional halve-at-graduation decay, frozen exemption set, **no mint/pause/blacklist/max-wallet — honeypots structurally impossible**. Plus an always-on **0.5% protocol fee** on post-graduation DEX trades (`PROTOCOL_FEE_BPS`), so Robinfun keeps earning on every token — even 0/0 launches — forever.
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
- Fuzz + invariant coverage: curve monotonicity & solvency, x·y ≥ k, levy-split conservation, no-honeypot full-exit probe, staking reward conservation, graduation atomicity + LP burn.
- **No mainnet deploy without a third-party audit** (brief §11). Suggested extra pre-audit step: bug bounty.

### Internal adversarial review — findings addressed

An 8-lens adversarial review (each finding cross-checked by a 3-verifier panel) surfaced and drove fixes for:

- **Graduation front-running (critical).** An attacker could pre-create the token/WETH pair and mint real LP into it before graduation, skipping the old `totalSupply()==0` skim guard so Uniswap's `mint()` socialized the curve's liquidity to them. `_graduate` now deposits at the pool's prevailing ratio when it is pre-seeded, so 100% of the curve's contribution is captured as LP and burned to `0xdead` and nothing is donated to the attacker; unpairable ETH is routed to the protocol. The attacker keeps only their own seed, which arbitrage corrects at their expense.
- **JIT / flash-stake capture of staking rewards (medium).** `flushProtocol` is permissionless, so an attacker could time a distribution and seize it with a one-block stake. `RobinStaking` now streams each reward linearly over `rewardsDuration` (Synthetix `StakingRewards`), so a one-block stake earns a negligible slice while honest long-term stakers keep their full share. "Instant unstake, claimable anytime" is preserved.
- **Graduation-boundary buy revert (low).** A buy sized one wei below the exact gross needed to graduate underflowed the refund and reverted; `_splitBuy` now only caps when there is real surplus and lets the ≤2-wei rounding overshoot ride.
- **Harvest sandwich (low/medium).** `harvest` market-sells the whole levy inventory with a caller-set slippage floor. Added an optional `harvester` keeper gate: mainnet sets a keeper that quotes off-chain and submits privately; a robust on-chain floor needs the price oracle that is still open question **§10.4**. Testnet can leave it permissionless.

### Known residual limitations (for audit / ALFA)

- **Levy scope is one canonical pool.** The fee-on-transfer levy taxes trades against the single `ammPair` set at graduation. Volume routed through a *different* pool (a second V2 pair, a V3 pool, another DEX) is untaxed, so a determined actor can migrate liquidity to dodge the levy. Taxing arbitrary pools would need an owner/creator-controlled taxable-address registry, which is itself a honeypot / transfer-gate risk that would violate the "a holder can always sell" guarantee — intentionally omitted pending a decision on **§10.6**.
- **Staking dead-time.** If every staker unstakes mid-stream, rewards for the empty window are stranded in the vault (standard Synthetix behavior) — not lost to anyone, but not auto-redistributed.

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
