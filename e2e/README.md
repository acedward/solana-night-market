# The Solana ↔ Midnight journey, end to end (AA 00057)

This lane runs the spec's US5 journey on local stand-ins: two Solana-wallet users with Passport accounts on
Midnight, two classic SPL tokens X and Y, two bridge deployments (AA 00058) and the injector RPC (AA 00059),
driven through Night Market's own page code (AA 00060). P6 turns this file into the full runbook (local and
live); for now it documents the local harness.

| Path | What |
|---|---|
| `registry/build.ts` | I-1: the journey token registry `journey-tokens.<net>.json`, generated from the bridges' deployment records (I-3). Tests: `registry/build.test.ts` |
| `oracle.ts` | the US5 oracle table as data, and its exact comparison. Tests: `oracle.test.ts` |
| `prompt-log.ts` | the wallet-prompt ledger (SC-005) the page-code harnesses append to when `PROMPT_LOG` is set |
| `journey.ts` | the journey's own steps: the oracle at each checkpoint, the negatives (SC-004, SC-006), the prompt count |
| `compose.yml` | the injector service, an override of `test/stack/p6/compose.yml` |
| `run-local.sh` | `prep`, `up`, `journey`, `down`, `run` |
| `report.py` | one run's evidence table (`report.md`, `report.json`) |
| `template/` | runs inside the 00058 bridge template's environment: `entry.sh` (sync + install), `bridge-wallets.ts` (fresh bridge keys and funding), `solana-shim.ts` |

## The registry generator

```sh
bun e2e/registry/build.ts --network undeployed [--genesis <base58>] [--solana-rpc <url>] \
  --out-dir <dir> deployments/standin-x.record.json http://bridge-y:9999
```

Each source is a deployment record file or a bridge node origin (read as `GET <origin>/deployment`). It writes
`journey-tokens.<net>.json` and refuses, naming the reason, two records for one SPL mint, a record for another
network or Solana cluster, a symbol that is not 1–8 printable ASCII characters without a space, a colour that is
not `tokenType(domainSep(splMint), bridgeContract)`, and (with `--solana-rpc`) a mint that is missing, Token-2022
or of other decimals. Exit 0 written, 65 refused, 64 usage.

## The local journey

Pinned inputs, checked before anything starts (the script refuses when they differ):

| Input | Pin | Where |
|---|---|---|
| AA 00058 bridge (deploy tooling, nodes, CLI) | effectstream `00058-bridge-contract-delivery` @ `1c9f4959db1a9f004820c01fb321225bb255916c` (PR #937) | a clean local clone, `BRIDGE_WT` |
| AA 00059 injector | acedward/solana-token-injector `00059-injector-passport-accounts` @ `b358a19f4b5fbcf7dd2b7d664a939a29c2472451` (PR #2) | a clean local clone, `INJECTOR_REPO` |
| Passport key volume | fingerprint `21493588…`, `VERIFIED` | `~/.cache/aa-00047/p10i-keys` (copied per run) |
| Images | node 2.0.0-rc.4 by digest, indexer 4.4.0-rc.1, proof servers rc.6 and rc.8, `oven/bun:1.3.11`, `e00050/unit:s4` | local (nothing is pulled) |
| Solana | native Agave 3.0.14 `solana-test-validator` and CLI, `spl-token` | `~/.cache/aa-00058/agave/bin` |

The two clones are used as they are at those commits (no fetch at run time): the template volume is synced from
the 00058 clone (`prep`), and the injector image is built from the 00059 clone per run (`--pull=false`, a
per-run tag removed at `down`).

```sh
e2e/run-local.sh prep                       # template volume, app volume, relay image (after any code change)
OUT=<evidence dir> e2e/run-local.sh run     # up, the journey, down (down always)
OUT=<evidence dir> e2e/run-local.sh up      # or: bring the stack up and leave it running (by hand: P4)
e2e/run-local.sh journey                    #     the journey on the running stack
e2e/run-local.sh down                       #     everything goes, and that is checked
```

Every host port is a random free one of 10000 and above on 127.0.0.1; compose projects are `aa00057-<n>`. The
stack lock `~/.aa-00057-stack.lock` is taken before anything starts and released at `down`; a held lock makes
`up` wait (at most `LOCK_WAIT_S`), and another holder's lock is never removed. At most one such stack runs on
a host (it peaks near 16 GiB).

The journey, with the oracle table checked exactly after each step on every surface (A's wallet on the
validator, accounts A and B by the page's own code, A's wallet through the injector's
`getTokenAccountsByOwner`, and both bridge vaults):

| Step | What runs | User A's prompts |
|---|---|---|
| I | A and B open their accounts (`market-flows.ts open-a, open-b`) | 1 |
| pre-funding | A's wallet gets 600 X; B's wallet gets 50 Y and B's page Bridges them in | 0 |
| II | A's page Bridges in 500 X (one Solana transaction) | 1 |
| III | A's page registers with the injector (Show in my wallet) | 1 |
| IV | A makes "200 X for 50 Y"; B takes it | 1 |
| V | A's page Bridges out 50 Y through the landing key; the release arrives on Solana | 3 |
| negatives | a forged registration, a registration for another key's account, an unregistered address (byte-identical answers), a tampered landing-key recipient, a non-deterministic signer, a lock to a contract that is not an account | — |

`$OUT/report.md` is the run's evidence table; `$OUT/report.json` the same as data.
