# Verifier keys for offline call builds (AA 00060 P6, relay/test/bridge-out.test.ts)

PUBLIC verifier keys, so a contract state built offline (its constructor) carries real operations and
midnight-js can build calls on it (nothing is proven in the tests):

| File | Source | SHA-256 |
|---|---|---|
| `lockForSolana.verifier` | the 00050 bridge template @ `f460da1`, `contract-bridge/src/managed/keys/` (P0.6 pin `b54ed1f6…`) | see below |
| `mintFromSolana.verifier` | the same | see below |
| `deposit_shielded.verifier` | the Night Market key volume (`p10i-keys`, account bundle, Passport `599327b`) | see below |
- `deposit_shielded.verifier`: `6761a2e9cb905a115e7705b63b7df57b3c14dfa39fa48411ff6f512b8ff916b3`
- `lockForSolana.verifier`: `b54ed1f6aff46df16f9e3e132c3e4d5e3e7c3d51fd731049f5421f4848e3967f`
- `mintFromSolana.verifier`: `5f4fa8ace0ea0e47685532f67fcfbd460d826877b877b6dbfbf33bd7dd7e80f9`
