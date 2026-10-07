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
| `open_swap_shielded_with_ed25519.maker.reproof.bin` | A fresh proof of the maker request (P1.2's re-proof: the I-62b splice proven by a plain rc.8) | `56c153f7ba52c81fe736a62ee8efe83dd324bd18e5a436f7a81cb8925aaf1663` |
| `open_swap_shielded_with_ed25519.taker.request.bin` | The taker's (a take's) proof request (`keyMaterialOffset` 2586) | `75b8e0259f8d430355dfa865d14423b27e1ed45084f6666d5d11eda72bc80413` |
| `open_swap_shielded_with_ed25519.taker.proof.bin` | The proof rc.8 returned for it, in the settlement the node accepted | `954362eefcbabbe8019fae1c93305128bc0fab94a52adf6ddb7e88bc28319861` |
| `open_swap_shielded_with_ed25519.taker.reproof.bin` | A fresh proof of the taker request | `35dbc32d2d8c5ba32b7f0e1b81d86f968bd6133a5e698e50c12b20844f12a6d6` |
| `withdraw_shielded_with_ed25519.proof.bin` | The proof rc.8 returned for the withdrawal request, in a transaction the node accepted | `0e233f3b340ea886366ed64aa338ec58215f4d61d8f3865755b7b7a02a912760` |
| `withdraw_shielded_with_ed25519.reproof.bin` | A fresh proof of the withdrawal request | `0be250a2b2059ee60d7162eb1159af0e4be14ddf4bd79a2279c15fec34586059` |
| `open_swap_shielded_with_ed25519.bzkir` | The circuit's PUBLIC ZKIR 3.1 (binary; key set `21493588…`, release `keys-21493588`): the verifier reads which impacts a call skipped from it (AA 00062 P3.5, questions Q8) | `97574dce813d642673a393eea3774832a985577e9b7e67bcc08117af3f1d0997` |
| `withdraw_shielded_with_ed25519.bzkir` | The same, for the withdrawal circuit | `456924009fd98c0e200cd87e1035dea6375fefb3ea38d045efbaec86731533d5` |

Each request embeds its key location, `contract:<account>/<circuit>?vk=<sha256 of the .verifier>`, so a
bundle holding these verifier keys resolves it as the relay's key volume does. The test rebuilds the
serialized preimage and the binding input from a request and checks that the relay's hand-off hands
the page exactly this request.

The relay's built-in verifier (AA 00062 P3.5, `relay/test/client-proof-verifier.test.ts`, and the
crate's native `relay/verifier/tests/golden.rs`) accepts all six proofs and refuses tampered ones.

Source: the AA 00062 P1.2 evidence (`p1/vectors/`), copied byte for byte; the two `.bzkir` files are
the VERIFIED key set's, byte for byte the `keys-21493588` release assets.
