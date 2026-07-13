# Robinfun — Internal Security Audit

**Date:** 2026-07-13
**Scope:** `contracts/src/*.sol` (BondingCurve, RobinfunFactory, RobinfunToken, FeeRouter, RobinStaking, ROBIN)
**Method:** multi-agent adversarial review — the system was mapped, then searched across 11 attack
dimensions in parallel, and each candidate finding was cross-checked against the actual source.
**Baseline:** 144/144 Foundry tests pass (unit + fuzz + invariant).

> ⚠️ **This is an INTERNAL review by the same party that wrote the contracts.** It is *not* a substitute
> for an independent third-party audit. Its purpose is to fix issues up front so an external audit is
> cheaper and faster. The contracts are **not mainnet-ready** until (a) the findings below are resolved
> and (b) an external audit signs off. "Zero bugs" was the hypothesis — this review disproves it.

## Severity summary & remediation status

| ID  | Severity | Title | Status |
|-----|----------|-------|--------|
| M-1 | Medium   | Pre-seeded Uniswap pair breaks the "liquidity locked forever" guarantee at graduation | ✅ **Fixed** — arb-toward-fair before deposit |
| M-2 | Medium   | FeeRouter owner can seize creators' harvested levy tokens via `setDexRouter` re-point | ✅ **Fixed** — `setDexRouter` one-shot |
| M-3 | Medium   | Permissionless `harvest` is sandwichable (caller-chosen `minEthOut`) | ⚙️ **Operational** — set `harvester` on mainnet |
| M-4 | Medium   | Creator levy + 0.5% protocol fee are avoidable on any non-canonical pair | 📄 **Accepted** — inherent design limitation, documented |
| M-5 | Medium   | Harvest split uses an average buy/sell rate → misattributes creator vs protocol revenue | ✅ **Fixed** — exact split via tracked composition |
| L-1 | Low      | Staking reward accounting: mid-stream empty-vault stranding, permissionless stream reset, dust floor | ✅ **Fixed** — park-on-empty, dust re-park, flush floor |
| L-2 | Low      | Post-graduation `addLiquidity`/`removeLiquidity` on the canonical pair is taxed as a swap | 📄 **Accepted** — inherent, documented |
| L-3 | Low      | `setDeployFee` front-run consumes the creator's dev-buy ETH | ✅ **Fixed** — `maxDeployFee` guard |
| I-1 | Info     | `_splitHarvest` division-before-multiplication truncates the creator share | ✅ **Fixed** — superseded by M-5 |

No **Critical** (attacker-drains-user-funds-permissionlessly) finding survived verification. The two
findings that finders initially rated *High* were **overstated** and are re-classified below.

**Remediation (2026-07-13):** 7 of 9 fixed in code with regression tests; full suite **154/154 green**
(144 prior + 10 new), incl. a 5,000-run fuzz proving graduation never bricks or strands funds for any
pre-seed. The two not code-changed are M-3 (operational: set a keeper) and M-4/L-2 (inherent to the
fee-on-transfer-on-one-pair model). **Contracts changed → any deployment (incl. the current testnet
factory) must be redeployed from this revision.**

---

## Findings

### M-1 — Pre-seeded pair breaks the locked-liquidity guarantee (re-classified from High)

**Where:** `BondingCurve._graduate()` L380-460, pre-seeded branch L417-457.

**What finders claimed:** an attacker "drains the ~2.6 ETH graduation liquidity" (theft, High).

**Verified reality:** **not theft.** When the token/WETH pair is pre-seeded at a skewed ratio, `_graduate`
deposits at the pool's *prevailing* ratio (L424) and routes any graduation ETH it cannot pair into burned
LP to the **protocol FeeRouter** (L456-457) — *never to the attacker*. The attacker cannot extract that ETH.

**What is real:** a griefer can, for the price of one early curve buy plus seeding the pair, force a token
to graduate with **almost no real locked liquidity** (the graduation ETH is diverted to the protocol
instead of being locked as burned LP). This **breaks the protocol's flagship "100% of liquidity locked
forever" promise for that specific token.** It is griefing, not profit — the attacker gains nothing and
pays for the attack — but it degrades a targeted launch.

**Design tension:** simply reverting on a pre-seeded pool is *worse* — it would let anyone permanently block
graduation (tokens stuck on the curve forever). The current code chose "graduate anyway." A proper fix needs
care.

**Resolution (implemented):** `BondingCurve._graduate` now, in the pre-seeded branch, calls
`arbTowardFair` — a best-effort, try/catch-wrapped market swap that moves the mispriced pool toward the
curve's graduation price *before* depositing. Because it trades at market against a pool the attacker
mispriced *in the curve's favour*, it can only add value (the curve is levy-exempt so it's untaxed), and
the swap output is computed with the exact fee formula so the pair's K-check never reverts; any failure
falls back to the safe deposit-at-prevailing path, so graduation can never brick. After the arb the pool
sits at ~fair price, so the deposit locks the full graduation liquidity as burned LP. The seeder cannot
profit — arbitraging one's own mispriced pool to fair is zero-sum-at-best (AM-GM: pre-dilution LP value
`2·√(a·b) ≤ a+b` = their cost, and the curve's deposit dilutes them further). Verified by regression tests
(the extreme low- and high-price seeds) and a 5,000-run fuzz (never bricks/strands). **The external
auditor should still scrutinise this swap-in-graduation path specifically.**

### M-2 — FeeRouter owner can seize harvested creator levy

**Where:** `FeeRouter.setDexRouter` L137-142 (re-settable anytime), `harvest` L197-218 (approves the **entire**
token balance to `dexRouter` at L210).

**Verified:** real. `setDexRouter` is re-settable by the `Ownable2Step` owner at any time with no validation
beyond a non-zero check. `harvest` `forceApprove`s the router for the full accumulated levy inventory (90%
of which is owed to creators) and then calls a swap on it. A malicious/compromised owner can point
`dexRouter` at a contract whose "swap" simply `transferFrom`s the approved tokens away.

**Recommendation:** make `setDexRouter` one-shot (like `setFactory`, L128-133) or put it behind a timelock;
alternatively approve only a computed amount and pull ETH via a checked delta. This removes an owner rug path.

### M-3 — Permissionless `harvest` is sandwichable

**Where:** `FeeRouter.harvest` L197-218 — when `harvester == address(0)` (default/testnet), anyone can call it
with any `minEthOut`, market-selling the entire levy inventory in one swap.

**Verified:** real. The code comment (L191-193) acknowledges it: a random caller "can only reduce THIS
harvest's output, never touch principal." So it cannot steal principal, but a griefer can sandwich the swap
and realize a bad price, and the loss lands on creators (90%) / protocol (10%).

**Recommendation:** on mainnet, **set a trusted keeper via `setHarvester`** (the gate already exists) and/or
chunk large harvests. Document that permissionless harvest is testnet-only.

### M-4 — Levy avoidable on non-canonical pairs

**Where:** `RobinfunToken._update` L210-229 — the levy + always-on 0.5% protocol fee are charged **only** when
one side of a transfer is the single stored `ammPair`.

**Verified:** real, and **inherent to the design.** Anyone can create a second token/WETH pool on another
Uniswap-v2-compatible DEX and trade there completely untaxed; the creator levy and protocol fee are avoidable.

**Recommendation:** this is a known trade-off of the "tax one canonical pair" model (taxing all transfers
breaks composability and is itself risky). Document it honestly; if the protocol fee is load-bearing revenue,
reconsider the mechanism. Flag for the external auditor as accepted-by-design or to-be-changed.

### M-5 — Harvest split mis-attributes creator vs protocol

**Where:** `FeeRouter._splitHarvest` L310-326, fed by `RobinfunToken._update` L218-224.

**Verified:** real accounting imprecision. Post-graduation, buys skim at `buyLevyBps` and sells at `sellLevyBps`,
but `_splitHarvest` attributes the pooled proceeds using a single **average** rate. If realized buy/sell volume
is skewed (e.g. sell-dominated with `buyLevy≠sellLevy`), the creator can be credited protocol revenue or vice
versa. Bounded, not a drain, but wrong.

**Recommendation:** track buy-skim and sell-skim inventories separately (two counters in `_update`) so the split
uses the true composition, or harvest per-side.

### L-1 — Staking reward-stream accounting (three related issues)

**Where:** `RobinStaking.notifyReward` L196-226, `rewardPerToken` L236-240, `updateReward` L121-129;
`FeeRouter.flushProtocol` L244-259.

**Verified:** all real, all Low (affect reward *distribution*, never staked principal):
1. **Empty-vault stranding:** if every staker exits mid-stream (`totalStaked→0`) and `periodFinish` passes
   before the next `notifyReward`, the emissions for the empty window are permanently stranded (classic
   Synthetix behavior). No recovery function exists.
2. **Permissionless reset griefing:** `flushProtocol` is permissionless and `notifyReward` resets
   `periodFinish` to `now + duration` every call, so a griefer can repeatedly top up with dust to keep
   diluting/postponing the stream.
3. **Dust floor:** `rewardRate = amount / rewardsDuration` floors to 0 for `amount < rewardsDuration` wei,
   stranding the notified dust.

**Recommendation:** add a `recoverStranded`/sweep for empty-window emissions; gate `notifyReward` behind the
`FeeRouter` (or a keeper) rather than fully permissionless; and require a minimum notify amount.

### L-2 — Post-graduation LP operations are taxed

**Where:** `RobinfunToken._update` L212-226 — the gate keys on `from==ammPair || to==ammPair` and does not
distinguish swaps from liquidity add/remove.

**Verified:** real. `addLiquidity`/`removeLiquidity` via a standard router hit the pair (`to==pair` / `from==pair`)
and are taxed at the sell/buy rate, silently reducing LP value and breaking naive `addLiquidity`.

**Recommendation:** low impact (initial LP is burned; little post-grad LPing expected), but document it, or
exempt the router's known LP paths if that revenue is unintended.

### L-3 — Factory setter front-running

**Where:** `RobinfunFactory.createToken` L168-232 reads mutable `deployFee` (L169/219/221) and `curveParams`
(L197); `setDeployFee` L271-274 and `setCurveParams` L258-260 take effect immediately.

**Verified:** real. The owner can front-run a pending `createToken` to raise the deploy fee (consuming more of
the sender's `msg.value`, since `devBuy = msg.value − deployFee`) or reshape the curve/graduation target. There
is no user-supplied `maxDeployFee` / expected-params guard.

**Recommendation:** add an optional `maxDeployFee` (and/or expected curve-params hash) parameter to
`createToken` that reverts on mismatch; or timelock the setters.

### I-1 — `_splitHarvest` rounding

**Where:** `FeeRouter._splitHarvest` L316 — `amount * ((levyRate * CREATOR_SHARE_BPS) / BPS) / totalRate`
truncates the inner factor before multiplying, short-changing the creator by a few bps at low levy rates.

**Recommendation:** reorder to `amount * levyRate * CREATOR_SHARE_BPS / (BPS * totalRate)` (multiply before divide).

---

## Static analysis (Slither)

Slither (crytic) was run across all `src/` contracts. **No real vulnerability was reported.** Every result
falls into a known false-positive / by-design class: `arbitrary-send-eth` (the seller receiving their own
ETH + trusted FeeRouter calls, all `nonReentrant` + CEI), `divide-before-multiply` (the standard AMM
`fee = %·gross` order, wei-level), `incorrect-equality` (`== 0` skip-guards), `uninitialized-local`
(zero-defaulted accumulators), `unused-return` (`mint(DEAD)` LP amount intentionally discarded),
`missing-zero-check` (owner-only setters where `address(0)` is an intentional sentinel). Notably Slither did
**not** flag the M-1 griefing that the manual review caught — automated tools find known patterns, not novel
logic/economic bugs, which is why they complement but never replace human review.

## Mainnet-beta guardrails (defence-in-depth for launching pre-external-audit)

To bound residual risk on a private mainnet beta before a third-party audit, two owner-controlled guardrails
were added (both removable to go fully permissionless):

- **Per-token cap (0.05 ETH).** `graduationEth` is the max real ETH a curve ever holds
  (`invariant_reserveNeverExceedsGraduation`) before graduating and burning 100% of the LP, so setting it to
  0.05 ETH bounds the at-risk funds per token. `virtualEth` is scaled 1/52 to keep the exact production curve
  shape. Verified: a 100-ETH whale buy is capped and refunded.
- **Private allowlist (`betaMode`).** While on, only `betaAllowed` wallets may create tokens or trade on any
  curve (the curve captures its factory at init and consults `tradeAllowed` in buy/sell). So no unwitting
  third party can be exposed to a bug — only the team's own capped test funds. `setBetaMode(false)` re-opens
  everything permissionlessly for the public launch. Verified: non-allowlisted create/buy/sell revert;
  flipping beta off re-opens a live curve.

These make a bounded, consenting-participants-only mainnet beta reasonable, but they do **not** replace the
external audit before a public, uncapped, permissionless launch.

## Verdict & path to mainnet

- **Positive:** the core value-conservation invariants hold (144 tests incl. fuzz/invariant pass), the
  curve can always pay out sells, CEI/reentrancy is respected, and the graduation pre-seed *theft* vector is
  **not** real — the ETH goes to the protocol, not an attacker. There is **no permissionless fund-drain critical.**
- **But not zero-bug:** five Medium and several Low findings are real. M-1 (locked-liquidity griefing) and M-2
  (owner rug path on creator fees) in particular should be fixed before any mainnet exposure.

**Required before mainnet, in order:**
1. ✅ **Done (2026-07-13):** fixed M-1, M-2, M-5, L-1, L-3, I-1 in code with regression tests + a
   5,000-run graduation fuzz; suite **154/154 green**.
2. Freeze the contracts (tag a release candidate).
3. **Independent third-party audit** (Sherlock / Code4rena / Cantina / Spearbit). This internal review is the
   input to that, not a replacement — the new swap-in-graduation path (M-1) especially warrants their eyes.
4. Confirm Robinhood Chain **mainnet** is public and has a canonical Uniswap-v2 deployment (M-4/graduation depend on it).
5. Owner → multisig; **set `harvester`** (closes M-3); operational runbook; redeploy the fixed contracts.

Only after 1–5 does mainnet deployment become responsible. We are at step 1→2 (all code findings resolved;
external audit is the gate that remains).
