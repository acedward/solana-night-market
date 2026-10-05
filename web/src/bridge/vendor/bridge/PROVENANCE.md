# Vendored bridge contract (AA 00060 P6.2)

Copied byte for byte from the 00050 Solana ↔ Midnight bridge template,
`effectstream/effectstream` @ `f460da182a47d5f68a6afbf9ea81530f2be8dcfe`,
`templates/solana-midnight-bridge/packages/contracts-midnight/contract-bridge/src/managed/` (the prebuilt
artefacts P0.6 pinned; `evidence/00060-night-market-bridge-wallet/p0/pins.json`, `bridgeArtifacts`).
Compiled by compactc 0.35.0 (`debb05f9`), language 0.27.0, runtime 0.20.0, from `bridge.compact` sha256
`b6150529857a6ea8359057db21cf113827f5f2c0e174b785a2aca1fd38601079` (00058 keeps it byte-identical).

| File | SHA-256 |
|---|---|
| `contract/index.js` | `03292e89e99061bce7a2d1f0cd89d5ff68f19bd8815bb2dc4ca54c03a040e710` |
| `contract/index.js.map` | `e3f4b0d969de2b938f21effdf4ab9e2cbce03fdb786b02b35087393f900554ee` |
| `contract/index.d.ts` | `6277d33bc67d4aa7dc5b9a59567272c8b3fcb9bd8327a25f25db61cbcf3afb3e` |
| `compiler/contract-info.json` | `94779e6d1c2eb06206e5586cebdaac5217d49e22729b049a1c036fa04e8f3062` |

Only the JavaScript is vendored: the page BUILDS `lockForSolana` (no key material); the relay proves it
with the key volume's bridge bundle (`<managed>/bridge`, checked against the deployed verifier key at
start-up). `web/test/bridge-vendor.test.ts` re-checks these digests. Never reformat (`.prettierignore`).
