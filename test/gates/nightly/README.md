# G-NIGHTLY: a real wallet against Night Market's messages (AA 00060 P2)

The owner checks Nightly by hand with the dev-only wallet probe (`web/src/dev/WalletProbe.tsx`, route
`#wallet-probe`, only when `config.json` has `devProbe: true`). No Night Market stack is needed: a native
`solana-test-validator` and the built site, both on random free ports >= 10000 on 127.0.0.1.

| File | What it does |
|---|---|
| `run-probe.sh` | `up` starts the validator in a temp ledger (`~/.cache/aa-00060/probe`, mode 700), builds the site in the `scripts/docker-check.sh` container and serves it with `devProbe: true`, the local network and `solana: {rpcUrl, genesisHash, cluster: "solana:localnet"}`; `airdrop <address> [SOL]`; `status`; `down` removes everything. |
| `static-server.ts` | The static server for the built site, run in `oven/bun:1.3.11` (files only; `application/wasm`). |

The owner's step-by-step instructions, the pass criteria and what to send back are in the organizer
repository's `AA/plans/00060-night-market-bridge-wallet-g-nightly-owner-steps.md`.

The automated side: `test/e2e/mock-wallet.ts` (a Wallet Standard mock with a profile and the
transaction features; `NIGHTLY_PROFILE` is a placeholder until the owner's report) and
`test/e2e/wallet-probe.spec.ts` (the probe against the mock wallet and `test/mocks/solana-rpc.ts`).
