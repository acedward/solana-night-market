# The client-proof verifier (AA 00062 P3.5)

In `CLIENT_PROVING=required` mode the relay hands the customer's own prover the proof request of
each k≥18 account call, and gets a proof back (`relay/src/client-proving/desk.ts`, interface I-62a).
Before the ledger receives that proof, so before any fee proof, balancing, offer post or
submission, the relay checks it with this verifier (spec FR-002, SC-004).

The relay's own ledger cannot do this: the published `@midnightntwrk/ledger-v9` WASM is built
without the ledger's `proof-verifying` feature (research R3). This crate is a small verifier-only
WebAssembly module built from:

- **midnight-ledger tag `ledger-9.1.0.0-rc.3`**, the node's ledger, with its default features, so
  `proof-verifying` is ON;
- **midnight-zkir tag `zkir-3.1.0-rc.1`**, the ZKIR 3.1 evaluator that proof server `9.0.0-rc.8`
  proves with (the account's circuits are ZKIR 3.1, compactc 0.35.0).

`Cargo.lock` was seeded from proof server `9.0.0-rc.8`'s lock, so the proof-system crates are the
ones the proofs are made with: `midnight-proofs` 0.8.2, `midnight-circuits` 7.2.4 and
`midnight-zk-stdlib` 2.3.5.

## What it checks

`verifyClientProof(circuit, proofRequest, proof, verifierKey, ir)` (`src/lib.rs`):

1. It reads the relay's own inputs and checks that they belong together:
   - the proof request is the ledger's key-less `/prove` body, decoded as rc.8 decodes it. It must
     carry no key material and must carry a binding input;
   - its key location names `circuit`, and its `?vk=` is the SHA-256 of `verifierKey`, the PINNED
     key from the relay's key volume;
   - `ir` is the circuit's ZKIR 3.1.
2. It rebuilds the public inputs the node checks, as the ledger's `ContractCall::public_inputs` does:
   - the binding input;
   - the communications commitment;
   - the call's transcript, with a `noop` of zeros for each impact the circuit skipped. These come
     from the ZKIR's `check`, as in the ledger's `prove.rs`.
3. It decodes the proof as the ledger's WASM does: a `Proof`, or a `ProofVersioned::V2`. It versions
   the proof by the key's tag (`verifier-key[v7]` gives V3), and runs the ledger's own
   `ProofKind::proof_verify`.

The function returns `undefined` when the proof verifies. It returns a reason when the CLIENT's
proof fails (the requester's failure). It throws when the relay's own inputs do not belong together
(the market's failure).

The skipped impacts are why the verifier needs the circuit's ZKIR (questions Q8): the golden `open_swap`
calls skip 6 impacts and the `withdraw_shielded` call skips 12. Public inputs built from the request
alone do not verify their node-accepted proofs (`tests/golden.rs`
`the_ledger_public_inputs_need_the_zkir`).

## Build

```sh
relay/verifier/build.sh           # writes relay/src/client-proving/verifier-wasm/
relay/verifier/build.sh --check   # rebuilds and compares with the committed files
```

**Pinned:**
- Rust 1.95.0 with `wasm32-unknown-unknown` (`rust-toolchain.toml`);
- every crate (`Cargo.lock`, built with `--locked`);
- wasm-pack 0.14.0, which runs wasm-bindgen 0.2.104 and wasm-opt `version_117`.

Local paths are remapped out of the binary, so neither the build directory nor the home directory
changes the bytes. The Rust build directory is outside the repository: `CARGO_TARGET_DIR`, by
default `$TMPDIR/nightmarket-client-proof-verifier-target`.

**The relay pins the module.** `CLIENT_PROOF_VERIFIER_WASM_SHA256` in
`relay/src/client-proving/verifier.ts` must equal the SHA-256 that `verifier-wasm/SHA256SUMS`
lists. The relay checks the file against the pin before it compiles it. On a mismatch, or if the
module does not load, `CLIENT_PROVING=required` refuses to start (exit 78). A rebuild that changes
the bytes (a new ledger tag, a toolchain change, an edit to `src/lib.rs`) must update that constant.
The relay's tests check that the constant, `SHA256SUMS` and the files agree.

## Tests

- `cargo test --release` (native) runs `tests/golden.rs` over `relay/test/fixtures/client-proof/`.
  These are the P1.2 golden vectors: the node-accepted proofs and fresh re-proofs.
- The relay's `relay/test/client-proof-verifier.test.ts` tests the built module itself.
