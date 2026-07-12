# Robinfun — Production Build Brief (paste into Claude Code)

> **How to use this:** Put the prototype HTML file in the repo (e.g. `docs/robinfun-prototype.html`) and paste this whole document as your first message to Claude Code. Work **phase by phase** (Contracts → Indexer → API → Frontend). Do not skip ahead. Ask before guessing on anything in §10.

---

## 0. Read this first

You are productionizing **Robinfun**, a fair-launch memecoin launchpad on **Robinhood Chain** (an **Arbitrum Orbit L2**; gas is paid in **ETH**). A complete, high-fidelity front-end prototype already exists as a single HTML file: **`docs/robinfun-prototype.html`**.

**That prototype is the design + UX source of truth.** Every page, layout, component, color, animation, and copy string in it is intentional and should be preserved. It currently runs on a **100% client-side simulation** — fake tokens, fake trades, fake balances. Your job is to replace that simulation with **real smart contracts, an indexer, a backend API, and a wired-up frontend**, without changing the look and feel.

**Rules of engagement:**
- Do **not** redesign anything. When unsure about a layout or interaction, open the prototype and match it exactly.
- Do **not** invent tokenomics, addresses, or parameters that aren't specified here. If something is missing, it's in §10 (Open Questions) — stop and ask.
- Keep the two front-end features that are easy to lose in a rewrite: the **light/dark theme toggle** and the **EN / 中文 language toggle**.
- Testnet first. Nothing touches mainnet until contracts are audited (§11).

---

## 1. What Robinfun is (product in one paragraph)

Anyone can launch an ERC-20 in one transaction. Each token starts life on a **bonding curve** (starting market cap ~$4,000, 1B fixed supply, no presale, no team allocation). Buys push the price up deterministically, sells push it down. When a token's market cap reaches **~$44,000** it **"graduates"**: the curve closes, liquidity is deployed to a **Uniswap-v2-style pool**, and the **LP tokens are 100% burned**. On top of the standard pump.fun/RobinFun model, Robinfun adds one differentiator: the **creator levy** (§2). There is also a platform token, **$ROBIN**, which can be **staked** to earn a share of all protocol revenue in real ETH (§3).

The prototype has these pages/surfaces, all of which must exist in production: **Tokens** (the board/home), **Create**, **Staking**, **Whitepaper** (docs), a per-token **detail page** (chart + trade panel + holders + thread), a **Treasury** page (creator earnings, reached via the wallet button), a top **utility bar** (language toggle, theme toggle, X + Telegram links, + Launch Token, Connect Wallet), and a live **ticker tape**.

---

## 2. The differentiator: the creator levy

The **levy** is a **creator-configurable transfer tax** baked into each launched token's contract.

- At deploy, the creator sets a **buy levy (0–10%)** and a **sell levy (0–10%)**, in 0.5% steps.
- On every trade, that percentage is skimmed and routed to the **creator's dev wallet** (auto-converted to ETH).
- **Split:** of each levy collected, **90% goes to the creator**, **10% goes to the Robinfun protocol** (which streams to $ROBIN stakers — see §3).
- **The levy lives in the token contract, not the platform.** This is the whole pitch: because it's a fee-on-transfer mechanic, the creator **keeps earning after graduation** on Uniswap volume too — unlike platform-level creator fees (pump.fun / RobinFun) that stop at graduation. **This must be implemented correctly** — see the fee-on-transfer note in §5.

**Anti-rug guarantees (enforce at the contract/factory level — these are advertised to users and must be true):**
- Hard cap **10% buy / 10% sell**, enforced by the factory. No token can exceed it.
- Rates can only ever be **lowered**, **never raised**, after deploy.
- Optional **"renounce rate control"** — creator can permanently lock rates.
- Optional **"halve levy at graduation"** decay flag (set at deploy).
- **No blacklist, no pause, no mint, no transfer gates, no max-wallet traps.** A holder can always sell. Honeypots must be **structurally impossible**.
- A flat **1% curve fee** on every bonding-curve trade goes to the protocol (separate from the levy).

---

## 3. $ROBIN staking (protocol revenue share)

- **$ROBIN** is the platform token. Stake it to earn a **pro-rata share of all protocol revenue**, paid in **ETH**.
- Protocol revenue = **1% curve fee on every trade** + **10% of every creator levy**, platform-wide.
- All of it is swapped to ETH and distributed to stakers proportionally to stake. The protocol keeps nothing extra.
- **Instant unstake, no cooldown.** Rewards are claimable at any time.
- ⚠️ **$ROBIN's supply, distribution, and launch mechanism are NOT defined by the prototype** (it just assumes ~1B supply and ~284M staked for display). This is a blocking open question — see §10. Staking cannot ship until $ROBIN's launch is decided.

---

## 4. Exact constants (do not change without team sign-off)

| Parameter | Value | Notes |
|---|---|---|
| Token supply | **1,000,000,000** (1B) | Fixed, all on the curve. No presale/team. |
| Starting market cap | **~$4,000** | Curve initial state |
| Graduation market cap | **~$44,000** | Triggers migration to DEX |
| Curve trade fee | **1%** flat, per trade | → protocol |
| Creator levy range | **0–10% buy / 0–10% sell** | 0.5% steps, set at deploy |
| Levy split | **90% creator / 10% protocol** | protocol cut → stakers |
| Levy rate mutability | **lower-only** | never raise; optional renounce lock |
| Optional decay | **halve buy+sell at graduation** | opt-in flag |
| Graduation venue | **Uniswap v2 (or fork) on Robinhood Chain** | LP **100% burned** |
| Gas / quote asset | **ETH** | Arbitrum Orbit |
| Deploy cost (prototype) | ~0.002 ETH + optional dev buy | confirm real gas |
| Harvest cadence (prototype copy) | auto every ~$500 accrued | implement as a real keeper/trigger |
| ETH/USD (prototype) | hardcoded 3850 | **replace with a price feed** for USD displays |

USD figures everywhere (market cap, volume, "paid to creators") are **display conversions** off an ETH/USD oracle. On-chain accounting is in ETH/wei.

---

## 5. Smart contracts — **Phase 1, start here**

Recommended stack: **Foundry** (or Hardhat), Solidity ^0.8.24, OpenZeppelin. Solady is fine for gas-critical paths. Everything upgradeable-or-not per team preference (default: **immutable core, minimal proxies for tokens**).

Contracts to build:

1. **`RobinfunFactory`**
   - Deploys new tokens via a **minimal-proxy (EIP-1167) clone** of `RobinfunToken` to keep deploy gas low.
   - Enforces the levy hard cap (≤10/10) and step (0.5%) at creation.
   - Wires each new token to its `BondingCurve` and records it for the indexer (emit rich events).
   - Collects the deploy fee; supports an optional first "dev buy" atomically.
   - Emits `TokenCreated(token, creator, name, symbol, buyLevy, sellLevy, decay, renounced, ...)`.

2. **`RobinfunToken`** (ERC-20, fee-on-transfer)
   - 1B fixed supply minted to the curve at init. **No mint function afterward. No pause, no blacklist, no max-wallet.**
   - **Fee-on-transfer levy** applied on transfers, with an **exclusions map** so the following are levy-exempt: the bonding-curve contract, the factory, the graduation LP-add path, and the fee router. (Otherwise minting to the curve and adding liquidity would get taxed.)
   - Levy setter is **lower-only**; `renounceRateControl()` locks it permanently; supports the graduation-decay flag.
   - Routes skimmed levy to the `FeeRouter` (see #5), which handles the 90/10 split + ETH conversion.
   - **CRITICAL — Uniswap compatibility:** because the levy is fee-on-transfer, post-graduation swaps must go through the fee-supporting router functions (`swapExact*SupportingFeeOnTransferTokens`). The frontend/router must use these. The levy **intentionally applies to Uniswap trades** (that's how the creator keeps earning) — do **not** exempt the DEX pair from the levy. Confirm the front-end swap path handles slippage for fee-on-transfer correctly.

3. **`BondingCurve`**
   - Holds the token's full supply pre-graduation; implements the deterministic price curve (constant-product or a linear/exponential curve — **match the price behavior the prototype charts**: start ~$4k cap, monotonic with buys/sells).
   - Takes ETH in on buys, pays ETH out on sells; charges the **1% curve fee** to the protocol on every trade.
   - Tracks progress to the **$44k** graduation threshold; on crossing, calls `graduate()`.
   - `graduate()`: withdraws remaining reserves, creates the Uniswap-v2 pool, adds liquidity, **burns 100% of LP** (send to `0xdead`), and permanently disables curve trading for that token.
   - Reentrancy-guarded; slippage/again-protected; no admin backdoors.

4. **`FeeRouter` / `RevenueSplitter`**
   - Receives curve fees (ETH) and token levies; swaps token levies to ETH (via the DEX) in batches (the "~$500 harvest" — implement as a permissionless `harvest()` anyone/keeper can call, or accumulate-and-pull).
   - Splits **levy 90% → creator wallet, 10% → protocol**; routes **curve fee 100% → protocol**.
   - Forwards the protocol's cut to the `RobinStaking` vault as the reward stream.

5. **`ROBIN`** (ERC-20) + **`RobinStaking`** vault
   - `ROBIN`: standard ERC-20 (params pending §10).
   - `RobinStaking`: stake $ROBIN, earn ETH pro-rata from the protocol revenue stream. Use a **`rewardPerTokenStored` accumulator** pattern (Synthetix/MasterChef-style) fed by the `FeeRouter`. **Instant unstake, no lockup.** Rewards in ETH (or WETH — decide, keep consistent). Precise, non-manipulable accounting; guard against flash-stake reward theft (checkpoint on stake/unstake/claim).

**Contract-level requirements:** full NatSpec, 100% of the invariants above covered by Foundry tests (fuzz + invariant tests for the curve math, levy accounting, and staking reward distribution), reentrancy protection everywhere ETH moves, no `selfdestruct`, no unbounded loops, events for everything the indexer needs.

---

## 6. Indexer / subgraph — Phase 2

Index all on-chain state the UI reads. A **subgraph** (if Robinhood Chain has Graph support) or a **custom indexer** (viem + a Postgres) — confirm availability (§10).

Entities to index: **Token** (address, creator, name, symbol, emoji/metadata URI, buy/sell levy, decay, renounced, graduated flag, created-at), **Trade** (token, side, ETH, tokens, levy paid, trader, ts), **Holder** (token, address, balance), rolling **volume/mcap/price**, **CreatorEarnings** (levy accrued/claimed per creator per token), and **Staking** (total staked, per-user stake, rewards accrued/claimed, protocol revenue 24h/all-time).

Off-chain token metadata (description, emoji, socials, thread/comments) → store in the backend DB keyed by token address; the thread in the prototype is a social feature, not on-chain.

---

## 7. Backend API — Phase 3

Thin API over the indexer + a small DB for social/metadata. Endpoints the frontend needs (names indicative):

- `GET /tokens?filter=trending|new|lastTrade|mcap|soon|graduated|watch&q=` → the board
- `GET /tokens/:address` → detail (stats, levy, creator, status)
- `GET /tokens/:address/candles` → OHLC for the chart (with the $44k graduation line data)
- `GET /tokens/:address/trades`, `/holders`, `/thread` (+ `POST /thread` for comments)
- `POST /tokens` metadata on create (desc/emoji/socials) — **must be tied to the on-chain deploy tx**, not trusted blindly
- `GET /treasury/:wallet` → creator claimable/earned per token
- `GET /staking` and `GET /staking/:wallet` → APR, total staked, protocol revenue (24h/all-time), user position + pending rewards
- `GET /ticker` and `GET /stats` → tape + hero stats

Add a **WebSocket / SSE** channel pushing live trades so the board can flash + re-sort and the ticker can scroll, exactly like the prototype's sim loop.

---

## 8. Frontend integration — Phase 4

Port the prototype to a real app **without changing the design**. Recommended: **Next.js + React + TypeScript + Tailwind** (or lift the prototype's CSS variables verbatim — the whole thing is token-driven and theme-able already), **wagmi + viem + RainbowKit/ConnectKit** for wallet + chain, **TanStack Query** for the API, and a WS/SSE hook for live trades.

Wiring checklist:
- Replace the client-side `TOKENS`/sim engine with API + WS data.
- Wallet connect (real), Robinhood Chain network add/switch, balances.
- **Create flow** → `RobinfunFactory.createToken(...)` with the levy config, decay/renounce flags, optional dev buy; the "LEVIED" success stamp fires on tx confirmation.
- **Trade panel** (Buy/Sell) → curve contract pre-graduation, DEX router post-graduation (**fee-on-transfer-safe swaps**, correct slippage). Keep the transparent fee breakdown (1% curve fee + X% levy → dev wallet + net) — now computed from real quotes.
- **Staking page** → `RobinStaking` stake/unstake/claim; live APR + rewards from the API.
- **Treasury page** → creator `claim` / `sweep all`.
- **Preserve:** the light/dark theme toggle, the **EN / 中文** i18n (extend the existing dictionary; keep both languages in sync), the watchlist (persist per wallet/localStorage), the candlestick chart (theme-aware colors + graduation line), the levy stamps, and the ticker tape.

---

## 9. Build order / milestones

1. **M1 — Contracts on testnet:** factory, token, curve, graduation + LP burn, fee router. Full Foundry test suite. Deploy to Robinhood Chain testnet.
2. **M2 — $ROBIN + staking:** once §10 tokenomics are answered. Revenue stream wired from the fee router.
3. **M3 — Indexer + API:** all entities and endpoints, live WS feed.
4. **M4 — Frontend wired:** create + trade + stake + treasury on testnet, end to end.
5. **M5 — Audit + fixes** (§11), then mainnet + $ROBIN launch.

Deliver each milestone as its own PR with a short README of what's wired and what's still mocked.

---

## 10. Open questions — **DO NOT guess, ask the team (ALFA)**

1. **$ROBIN tokenomics:** total supply, distribution, and launch mechanism (fair launch on its own curve? LBP? airdrop to early creators?). **Blocks staking (M2).**
2. **DEX on Robinhood Chain:** is there a canonical **Uniswap v2 (or fork)** deployment? What are the factory/router addresses? If none, what's the graduation venue?
3. **Indexer infra:** does Robinhood Chain have **The Graph** support, or do we run a custom viem indexer?
4. **Price oracle:** what ETH/USD feed is available on Robinhood Chain (Chainlink? Pyth?) for USD displays?
5. **Protocol treasury:** which multisig receives/controls protocol funds before they hit the staking stream?
6. **Levy = fee-on-transfer confirmed?** This is the design intent (creator keeps earning post-graduation) but it **breaks most CEX listings and some aggregators**. Confirm the team accepts this tradeoff, or we move the levy enforcement into a custom router (loses post-graduation earning). **This is the single most important decision.**
7. **Metadata/comments storage** and **image/emoji** handling — plain DB, or IPFS for anything?
8. **Deploy fee + dev-buy** real values, and who receives the deploy fee.
9. **Testnet target** on Robinhood Chain (RPC, chainId, faucet).

---

## 11. Security & audit requirements

- No mainnet deploy without a **third-party audit** of all contracts (curve math, fee-on-transfer accounting, graduation/LP-burn, staking reward distribution).
- Foundry **fuzz + invariant tests** for: curve monotonicity & solvency, levy split correctness, no honeypot path (a holder can always sell), staking reward conservation (sum of claims ≤ revenue in), and graduation atomicity (LP always burned).
- Reentrancy guards on every ETH-moving function; checks-effects-interactions; pull-over-push where practical.
- Verify the **anti-rug advertised guarantees** are literally enforced in code (cap, lower-only rates, no mint/pause/blacklist) — these are user promises.
- Consider a **bug bounty** before mainnet.

---

*Prototype (design + UX truth): `docs/robinfun-prototype.html`. This brief defines the target; the prototype defines the look. When they seem to disagree, the prototype wins on UX and this brief wins on mechanics — and if it's neither, ask ALFA.*
