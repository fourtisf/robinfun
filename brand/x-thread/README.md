# Robinfun — X (Twitter) thread banners

Six matching 16:9 banners for a launch thread. One design system throughout:
the real feather mark, volt-lime on near-black, Space Grotesk + IBM Plex Mono,
a numbered index (`01 / 06 … 06 / 06`), and the same ascending-candle motif +
footer on every frame — so posted in order they read as one connected thread.

- **Size:** 3200 × 1800 px (2× retina, exact 16:9 — X displays it crisp and never crops).
- **Files:** `robinfun-x-01-cover.png` … `robinfun-x-06-cta.png` — post in that order.

## Suggested post copy (one tweet per image)

**1 · Cover**
> Introducing Robinfun 🪶
> A fair-launch memecoin launchpad on Robinhood Chain — where the creator fee is written into the token itself.
> Launch a token. Collect the fee — forever. 🧵👇

**2 · The problem**
> On pump.fun, four.meme, bonk.fun… you deploy, they take the fees, and the second your coin graduates your income stops.
> The creator earns nothing after launch. We think that's backwards.

**3 · The edge**
> On Robinfun you set a creator fee up to 10%. Every buy & sell pays your wallet — on the curve AND after graduation.
> It lives in the contract, not the platform, so it never switches off. 90% you / 10% $ROBIN stakers.

**4 · Fair by design**
> No presale. No team bags.
> 1B supply all on the curve · graduates to Uniswap once ~2.6 ETH is raised · LP 100% burned.
> Deterministic price, flat 1% curve fee — no snipers' edge.

**5 · Safety**
> Honeypots are structurally impossible on Robinfun:
> ✓ Hard cap 10/10 ✓ rates only go down ✓ no blacklist / pause / mint ✓ mandatory dev buy so the creator holds a position.
> It's all enforced by the contract.

**6 · CTA**
> Fair curves. A fee that pays you forever.
> Launch on Robinfun → robinfun.io
> X @robinfunio · TG t.me/robinfunio

## Testnet disclaimer (pin under the thread / put in bio)

> ⚠️ Robinfun is live on **Robinhood Chain Testnet** right now. Tokens and ETH
> here have no real value and the contracts are unaudited — it's for testing the
> product, not for real trades. Mainnet comes after a third-party audit.

## How they were generated

`gen_banners.py` builds self-contained HTML (embedded fonts + inline SVG), and
`shoot.js` renders each at a pixel-exact 1600×900 viewport @2× via Playwright
(the pre-installed Chromium). Fonts are pulled from Google Fonts and base64-inlined
at build time. Re-run to tweak copy — no external assets at render time.
