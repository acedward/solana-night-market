# Client-proof golden vectors (AA 00062, relay/test/client-proving.test.ts)

Real proof requests and a real proof, captured on 2026-10-06 from the relay's own proving path on a
ledger-9 localnet (AA 00062 P1.2: the p6 harness's phase 1, key set `21493588…`, proof server
`9.0.0-rc.8`). The node accepted every captured proof. The accounts are throwaway localnet accounts:
nothing here is a secret.

| File | What it is | SHA-256 |
|---|---|---|
| `open_swap_shielded_with_ed25519.maker.request.bin` | An I-62a `proofRequest`: the ledger's key-less `/prove` body `HEAD \| 0x00 \| TAIL` for a make (`keyMaterialOffset` 2585) | `4fa20f225578d27f699061b2eb6bb804026c26df24c067480850051703357a3e` |
| `open_swap_shielded_with_ed25519.maker.proof.bin` | The proof rc.8 returned for it (8,028 B), in a transaction the node accepted | `4c5b517736655ebc4cff34c7a1e26e81d2132ed0a0081129f29417b4b853de29` |
| `withdraw_shielded_with_ed25519.request.bin` | The same for a shielded withdrawal (`keyMaterialOffset` 1556) | `7876e77821f117af04ad14588910e227e9b701f110fcb6b517c183258e5bb063` |
| `open_swap_shielded_with_ed25519.verifier` | The PUBLIC verifier key of the circuit (key set `21493588…`; release `keys-21493588` of midnight-experiments/solana-proof-server) | `8ba4a638edd1e8b8bfb9c53b98740c61e8a3cf7c6eca461b22490f8a7b695b7e` |
| `withdraw_shielded_with_ed25519.verifier` | The same, for the withdrawal circuit | `0af6b9754da02f4b9dd919e5127de96b7d8a44ff318f23b3f4ed6429ad21ed91` |

Each request embeds its key location, `contract:<account>/<circuit>?vk=<sha256 of the .verifier>`, so a
bundle holding these verifier keys resolves it as the relay's key volume does. The test rebuilds the
serialized preimage and the binding input from a request and checks that the relay's hand-off hands
the page exactly this request.

Source: the AA 00062 P1.2 evidence (`p1/vectors/`), copied byte for byte.
