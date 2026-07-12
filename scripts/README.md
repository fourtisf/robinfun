# Vanity address miner (`…feed`)

Robinfun tokens deploy via CREATE2, so their address can be ground to end in a
chosen hex suffix. Robinfun's signature is **`…feed`** (Robin Hood *feeds* the
poor; also `f-e-e-d` is valid hex).

## Usage

```bash
cd scripts && npm install
node mine-vanity.mjs \
  --factory 0xFACTORY --impl 0xTOKENIMPL --creator 0xYOURWALLET --suffix feed
```

It prints a `vanitySalt`. Pass it as `CreateParams.vanitySalt` to
`RobinfunFactory.createToken(...)` and the token deploys at the `…feed` address.
`--impl` is `factory.tokenImplementation()`.

- The salt is bound to the creator on-chain (`keccak256(creator, vanitySalt)`),
  so a salt seen in the mempool can't be front-run into another wallet.
- Speed: ~4 hex chars (`feed`) ≈ 65k tries avg, well under a second in Node.
  Each extra hex char is ~16× slower.
- Correctness is pinned by the Foundry test
  `test_vanity_formulaMatchesRawCreate2`, and this miner's `predict()` is
  verified to reproduce `factory.predictTokenAddress(...)` exactly.

At launch time the frontend runs this same logic (via viem's keccak) before
sending the deploy tx, so every Robinfun token is born at a `…feed` address.
