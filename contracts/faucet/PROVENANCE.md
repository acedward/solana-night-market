# The demo-token faucet contract (vendored)

`shielded-token.compact` is a byte-for-byte copy of the mint-test-tokens v2 shielded faucet, the
contract every stagenet test token in the market's registry is minted from (`twUSDC`, `twUSDM`,
`twBTC`, `twETH`). The relay's demo-token endpoint (spec FR-007, `relay/src/demo/`) proves its
`mint` circuit, so the key job compiles this file into the key volume's `faucet` bundle.

| What | Value |
|---|---|
| Upstream | `effectstream/mint-test-tokens`, `contracts/v2/shielded-token.compact` |
| Commit | `a51cf3ad46520d1ded938fb86db8b7b99373ce56` (last change to the file: `6bc656d`, "Align v2 contracts with compiler 0.34", which changed only the `pragma` line) |
| SHA-256 | `1dca131a6721e0bbbd60c136a9c2a35c02729d9afaa7f42fe29726df4b8889bd` |
| Licence | Apache-2.0 (the file's SPDX header) |
| The stagenet deployments | built from `418cce5` with compactc 0.33.0-rc.2 (`metadata/metadata.stagenet.json`); the circuits are identical, only the pragma differs |
| Compiler | compactc **0.34.0**, WITHOUT `--feature-zkir-v3` (ZKIR v2, verifier key format v6, as deployed); the module imports compact-runtime 0.19.0, the relay SDK's |
| `mint` verifier key | SHA-256 `4bbbb047b2f10bc57e4fafd9537b2dcac9290d9a2f7560a9e670f96a8452794a` (upstream's committed 0.34.0 build; the key job refuses any other, and the relay compares it with each faucet's on-chain `mint` operation before its first use) |

The circuit the relay proves:

```
export circuit mint(recipient: Either<ZswapCoinPublicKey, ContractAddress>, amount: Uint<64>,
                    nonce: Bytes<32>): ShieldedCoinInfo
```

Permissionless: anyone may mint any amount to a wallet key or a contract address. A mint to a
contract address creates an output that contract must receive in the same transaction.
