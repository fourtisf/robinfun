# Robinfun Public API v1

A read-only HTTP API that exposes every token launched on Robinfun with live
market data (price, market cap, volume, status). Partners use it to **auto-list**
Robinfun tokens, power aggregators/trackers, or feed wallets and bots.

- **Base URL:** `https://robinfun.io/api/v1`
- **Auth:** none — public, read-only. `CORS` is open (`Access-Control-Allow-Origin: *`), so it works from a browser too.
- **Format:** JSON. All money fields are USD unless the name ends in `Eth`/`Native`.
- **Freshness:** market data (price/mcap/volume) is indexed continuously from Robinhood Chain and cached ~15s. `updatedAt` is a ms epoch of the last index cycle.
- **Chain:** Robinhood Chain, `chainId` `4663`. Every token is fixed **1,000,000,000** supply, **18** decimals.
- **Stability:** field names are **stable within v1** — we add fields, never rename/remove without a v2.

---

## Endpoints

### `GET /api/v1` — discovery
Self-describing index listing the endpoints. Good for a health/version check.

### `GET /api/v1/stats` — platform aggregates
```json
{
  "chainId": 4663,
  "chain": "robinhood",
  "updatedAt": 1752600000000,
  "ethUsd": 1884.0,
  "tokensTracked": 99,
  "volume24hUsd": 1234.5,
  "volumeTotalUsd": 45678.9,
  "paidToCreatorsUsd": 77.3
}
```

### `GET /api/v1/tokens` — list tokens (newest first)
Query params:
| param | default | notes |
|-------|---------|-------|
| `limit` | `100` | max `500` |
| `offset` | `0` | for pagination |
| `status` | `all` | `bonding` (on the curve) or `listed` (on Uniswap) |

```json
{
  "chainId": 4663,
  "updatedAt": 1752600000000,
  "ethUsd": 1884.0,
  "count": 100,
  "total": 99,
  "offset": 0,
  "limit": 100,
  "tokens": [ /* Token objects — see below */ ]
}
```

### `GET /api/v1/tokens/{contractAddress}` — one token
Returns a single **Token object**, or `404 {"error":"token not found"}`.

---

## Token object

```json
{
  "chainId": 4663,
  "chain": "robinhood",
  "address": "0xd48A1Eed09696E389A3CC32E519224d6Bf4ffeEd",
  "name": "Test Doge",
  "symbol": "TDOGE",
  "decimals": 18,
  "totalSupply": "1000000000",
  "logoURI": "https://robinfun.io/uploads/x.png",
  "description": "a test token",
  "links": { "website": "https://…", "twitter": "https://x.com/…", "telegram": "https://t.me/…" },
  "creator": "0xABC…",
  "status": "bonding",          // "bonding" = on the curve · "listed" = trading on Uniswap
  "graduated": false,
  "priceUsd": 0.00000123,       // null until the indexer has read it
  "marketCapUsd": 46.0,
  "volume": { "h24Usd": 0.0, "totalUsd": 0.0 },
  "fees": { "buyPercent": 1, "sellPercent": 1 },
  "creatorFeesEarnedEth": 0.001,
  "curveAddress": "0x…",        // the bonding-curve contract
  "pairAddress": "0x…",         // Uniswap V2 pair — present once "listed", else null
  "createdAt": 1700000000000,
  "urls": {
    "robinfun": "https://robinfun.io/token/0x…",
    "explorer": "https://robinhoodchain.blockscout.com/token/0x…",
    "api": "https://robinfun.io/api/v1/tokens/0x…"
  }
}
```

**Notes for integrators**
- Market fields (`priceUsd`, `marketCapUsd`, `volume`) are `null` until the indexer has seen a freshly-launched token (usually within a minute). Treat `null` as "not yet indexed", not zero.
- `status: "bonding"` tokens trade on the Robinfun bonding curve (`curveAddress`); `status: "listed"` tokens trade on the Uniswap V2 `pairAddress`.
- To poll for new listings, request `GET /api/v1/tokens?status=listed&limit=100` on an interval and diff by `address`.

---

## Examples

```bash
# platform stats
curl https://robinfun.io/api/v1/stats

# newest 20 tokens
curl "https://robinfun.io/api/v1/tokens?limit=20"

# only tokens listed on Uniswap (ready for a DEX aggregator)
curl "https://robinfun.io/api/v1/tokens?status=listed"

# one token
curl https://robinfun.io/api/v1/tokens/0xd48A1Eed09696E389A3CC32E519224d6Bf4ffeEd
```

```js
// JS / partner integration
const r = await fetch('https://robinfun.io/api/v1/tokens?status=listed&limit=100');
const { tokens } = await r.json();
for (const t of tokens) {
  // auto-list: t.address, t.symbol, t.name, t.pairAddress, t.priceUsd, t.marketCapUsd, t.logoURI …
}
```

---

## Rate limits & caching
Responses carry `Cache-Control: public, max-age=15`. Please cache and poll no
faster than every ~15s. For a high-volume integration or a push feed, contact us
to arrange an API key / webhook.
