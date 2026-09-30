# Local-stack tests

Night Market (AA 00047) is carried over from MN Bank. MN Bank's local-stack and live harnesses
(`run-e2e.sh`, `run-accounts.sh`, `run-trade-live.sh`, `run-bridge-live.sh`, the
`test/e2e/stack/*.stack.spec.ts` specs and `test/live/`) drove the page with injected EIP-1193
wallets and the Sepolia bridge. They were removed with the EVM arm and the bridge; they are in
`main`'s history (for example `git show main:test/stack/run-e2e.sh`).

The whole-market local-stack end-to-end with Solana (Ed25519) accounts is plan step P6.2 of
AA 00047; it rebuilds the harness on the Ed25519 arm.

| File | What it does |
|---|---|
| `fund-account.ts` | Funds a Passport account with a shielded coin the way any third party would, with `deposit_shielded(coin, entry)` (arm-agnostic). |

None of this runs in GitHub's hosted CI: a local ledger-9 stack needs far more memory and disk than
a hosted runner has.
