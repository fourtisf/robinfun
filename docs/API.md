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

### `GET /api/v1/docs` — interactive docs
Human-friendly **Swagger UI** page to browse and try every endpoint in the browser.

### `GET /api/v1/openapi.json` — machine-readable spec
Full **OpenAPI 3.0** description. Import into Postman/Insomnia or generate a typed
client (`openapi-generator`, `swagger-codegen`, etc.).

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

### `GET /api/v1/tokens/{contractAddress}/trades` — recent trades
For activity feeds and live tickers. `?limit=` (default 100, max 1000). Newest first.
```json
{
  "chainId": 4663,
  "address": "0x…",
  "symbol": "TDOGE",
  "trades": [
    { "ts": 1752600000000, "side": "buy", "priceUsd": 0.00000123, "priceEth": 0.00000000065, "volumeUsd": 9.1, "volumeEth": 0.0048 }
  ]
}
```

### `GET /api/v1/tokens/{contractAddress}/ohlc` — price candles
For charts. `?resolution=` one of `1m 5m 15m 1h 4h 1d` (default `1h`), `?limit=` (default 200, max 1000). Prices are USD; `time` is unix **seconds** (bucket start).
```json
{
  "chainId": 4663,
  "address": "0x…",
  "symbol": "TDOGE",
  "resolutionSec": 3600,
  "quote": "USD",
  "candles": [
    { "time": 1752596400, "open": 0.0000011, "high": 0.0000013, "low": 0.0000010, "close": 0.0000012, "volumeUsd": 142.5 }
  ]
}
```

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

## Aggregator endpoints (GeckoTerminal / DexScreener shape)

For DEX aggregators and price trackers that ingest a **standard** feed. Mounted
under `/api/v1/dex/*`. Best-effort: our indexer stores block/price/side per trade
but **not** per-swap tx hashes, makers, or pool reserves — so `events` use a
synthetic `txnId` and omit `maker`/`reserves`. Enough to build price & volume.

### `GET /api/v1/dex/latest-block`
```json
{ "block": { "blockNumber": 123456, "blockTimestamp": 1752600000 } }
```

### `GET /api/v1/dex/asset?id={tokenAddress}`
`id` is a token contract address, or the literal `ETH` for the native gas token.
```json
{ "asset": { "id": "0x…", "name": "Test Doge", "symbol": "TDOGE", "decimals": 18, "totalSupply": "1000000000", "circulatingSupply": "1000000000", "coinGeckoId": null, "metadata": { "logoURI": "https://…" } } }
```

### `GET /api/v1/dex/pair?id={pairAddress}`
`id` accepts the Uniswap pair address, the bonding-curve address, **or** the token
address — all resolve to the same pair. `asset0Id` is the token; `asset1Id` is `ETH`.
```json
{ "pair": { "id": "0x…", "dexKey": "robinfun-curve", "asset0Id": "0x…", "asset1Id": "ETH", "createdAtBlockTimestamp": 1752600000, "feeBps": 100, "metadata": { "name": "Test Doge", "symbol": "TDOGE", "logoURI": "https://…" } } }
```
`dexKey` is `robinfun-curve` while bonding, `uniswap-v2` once listed.

### `GET /api/v1/dex/events?fromBlock={n}&toBlock={n}`
Swap events across **all** tokens in a block range (newest→oldest by block).
`?limit=` default 1000, max 5000.
```json
{ "events": [
  { "block": { "blockNumber": 123456, "blockTimestamp": 1752600000 },
    "eventType": "swap", "txnId": "123456-0", "pairId": "0x…",
    "priceNative": 0.00000000065, "priceUsd": 0.00000123,
    "amountNative": 0.0048, "volumeUsd": 9.1, "side": "buy" }
] }
```

---

## Webhooks (push feed)

Instead of polling, partners can register a URL that Robinfun **POSTs to** when
something happens. Fire-and-forget with an optional HMAC-SHA256 signature.

**Events:** `token.created` (a new token launched) · `token.graduated` (a token
listed on Uniswap).

Registration is **admin-gated** (operator-managed) — send us your URL, or if you
run the instance, call the admin endpoint with `x-admin-secret`:

```bash
# register
curl -X POST https://robinfun.io/api/v1/webhooks \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"url":"https://partner.example/hook","events":["token.created","token.graduated"],"secret":"your-shared-secret"}'

# list  →  { "webhooks": [ { "id", "url", "events", "createdAt" } ], "events": [...] }
curl -H "x-admin-secret: $ADMIN_SECRET" https://robinfun.io/api/v1/webhooks

# delete
curl -X DELETE -H "x-admin-secret: $ADMIN_SECRET" https://robinfun.io/api/v1/webhooks/{id}
```

**Delivery payload** (POST body):
```json
{ "event": "token.created", "ts": 1752600000000, "data": { /* Token object (created) or {address,symbol,name,marketCapUsd} (graduated) */ } }
```

**Verifying the signature** — if you set a `secret`, each request carries
`x-robinfun-signature: sha256=<hmac>` over the **raw body**:
```js
const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(req.headers['x-robinfun-signature']));
```
Also sent: `x-robinfun-event: token.created`. Respond `2xx` quickly; we don't retry.

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
