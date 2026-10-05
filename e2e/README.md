# The Solana ↔ Midnight journey, end to end (AA 00057)

This lane runs the spec's US5 journey on local stand-ins: two Solana-wallet users with Passport accounts on
Midnight, two classic SPL tokens X and Y, two bridge deployments (AA 00058) and the injector RPC (AA 00059),
driven through Night Market's own page code (AA 00060). It is the journey's runbook: the scripted run
(`run-local.sh run`), the stack for a by-hand session in a real wallet (`run-local.sh up`), and what each
check proves. The owner's live acceptance (00057 P5) ran by hand on these same local stand-ins (the owner's
decision of 2026-10-05: stagenet and devnet were dropped for now; deployment is a later project).

| Path | What |
|---|---|
| `registry/build.ts` | I-1: the journey token registry `journey-tokens.<net>.json`, generated from the bridges' deployment records (I-3), with the icons of the one table; and (`injector-tokens`) the injector's own token file from Night Market's full token list. Tests: `registry/build.test.ts`, `registry/icons.test.ts` |
| `registry/token-icons.json`, `registry/icons.ts` | the ONE icon table (public HTTPS for the wallet, the same files bundled by the site), and what is derived from it |
| `oracle.ts` | the US5 oracle table as data, and its exact comparison. Tests: `oracle.test.ts` |
| `prompt-log.ts` | the wallet-prompt ledger (SC-005) the page-code harnesses append to when `PROMPT_LOG` is set |
| `journey.ts` | the journey's own steps: the oracle at each checkpoint, the negatives (SC-004, SC-006), the prompt count |
| `compose.yml` | the injector service, an override of `test/stack/p6/compose.yml` |
| `run-local.sh` | `prep`, `up`, `journey`, `down`, `run` |
| `report.py` | one run's evidence table (`report.md`, `report.json`) |
| `template/` | runs inside the 00058 bridge template's environment: `entry.sh` (sync + install), `bridge-wallets.ts` (fresh bridge keys and funding), `solana-shim.ts` |

## Pinned set of the final runs (2026-10-05)

| Repository | Ref | SHA |
|---|---|---|
| acedward/solana-night-market (this lane; base #22) | `00057-solana-midnight-journey` | `cade844` = #22 @ `58610ac4a393b7fdf0972a968481630d4d333e6d` + `e2e/` |
| effectstream/effectstream (#937) | `00058-bridge-contract-delivery` | `1c9f4959db1a9f004820c01fb321225bb255916c` |
| acedward/solana-token-injector (#2) | `00059-injector-passport-accounts` | `459c904fc7f6e1180ad48bd4d3b8bc64971e1909` |
| Token icons | `https://midnight-solana-token-icons.ac-edward.workers.dev/v3/` | `registry/token-icons.json` (`SHA256SUMS-v3`; published versions are never overwritten) |

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
| AA 00059 injector | acedward/solana-token-injector `00059-injector-passport-accounts` @ `459c904fc7f6e1180ad48bd4d3b8bc64971e1909` (PR #2, with P7: the metadata fill-in, I-1 `image`/`splImage`, `TOKEN_REGISTRY`) | a clean local clone, `INJECTOR_REPO` |
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

What `up` builds, in order: the native validator; the Midnight node, indexer and both provers (rc.8 restarts on
failure under a 12 GiB cap); Night Market's demo-token faucets; for X and Y fresh bridge keys funded from dev
seed 3, the program (host Agave CLI), `deploy-devnet.ts` (the SPL mint; its operator is the mint authority),
`deploy.ts` (the bridge contract) and `bridge:record`; the journey registry (I-1) with icons and the site's
icon map; Night Market's lists (`bridge-tokens.ts --pairs X/Y`); the injector's token file; the relay's SPL
faucet keys (the operators' keypairs, mode 600, never in the evidence); the injector, the relay with the
mock exchange; the two bridge nodes (each must serve exactly its record at `GET /deployment`). Every
service's health is recorded against a 1500 s budget (the final runs: about 480–500 s).

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
| FR-021 | A bridges 100 X out of its 300 X coin: the change is saved in the inbox (one more approval), the release arrives; the injector equals the page, `unseenCoins` 0 (oracle `after-partial`) | 4 (not counted in SC-005) |
| P13 | the relay's test SPL faucet mints 1,000 X and 1,000 Y to a fresh wallet; a second claim is refused | 0 |
| 00059 P7 | the real SPL X's metadata through the injector's fill-in: name "X", its icon (`EXPECT_SPL_FILLIN=0` before P7: passed through) | 0 |
| Q10 | after A's demo claim: twBTC 8 decimals (0.1), twUSDC 6, names and icons through the injector, equal to the page; the published icons equal the site's copies | 2 (the claim, and the refused second claim) |

`$OUT/report.md` is the run's evidence table; `$OUT/report.json` the same as data.

## What a passing run shows (the final runs, 2026-10-05)

The oracle table, read EXACTLY at every checkpoint on every surface (A's wallet on the validator, accounts A
and B by the page's own code, A's wallet through the injector, the two vaults):

| After | Wallet A Solana | Account A | Wallet A through the injector | Account B | Vaults |
|---|---|---|---|---|---|
| start | X 600 | — | X 600 | Y 50 | X 0, Y 50 |
| II | X 100 | X 500 | X 100 (A not registered: byte-identical to the validator) | Y 50 | X 500, Y 50 |
| III | X 100 | X 500 | X 100, X (Midnight) 500 | Y 50 | X 500, Y 50 |
| IV | X 100 | X 300, Y 50 | X 100, X (Midnight) 300, Y (Midnight) 50 | X 200 | X 500, Y 50 |
| V | X 100, Y 50 | X 300 | X 100, Y 50, X (Midnight) 300 | X 200 | X 500, Y 0 |
| after the negatives | X 100, Y 50 | X 300 | X 100, Y 50, X (Midnight) 300 | X 200 | X 501, Y 0 (the non-account lock's 1 X stays locked) |
| after the partial Bridge out | X 200, Y 50 | X 200 | X 200, Y 50, X (Midnight) 200 | X 200 | X 401, Y 0 |

Bridge in reaches the account in about 80–90 s (SC-002: within 300 s); the injector shows a change within a
few seconds of the step (SC-003: within 60 s); a Bridge out's release arrives on Solana about 20–25 s after the
lock; user A signs 7 times (SC-005). The stack peaks near 16–17 GiB.

## Troubleshooting

- **`up` waits:** another project holds `~/.aa-00057-stack.lock` (its `holder` file says who). Never remove it;
  `LOCK_WAIT_S` bounds the wait.
- **`up` refuses at once:** a pinned clone is not at its pin or is dirty, or the template volume was built from
  another 00058 commit: run `prep` again.
- **A bridge node restart:** the node's database does not survive a container restart (Effectstream issue
  00063): it re-syncs from the deployment's start heights. Safe (exactly once holds), but slow; `up` never
  restarts a node.
- **The relay image build hangs on `docker/dockerfile:1`:** `prep` builds from a copy of the Dockerfile without
  its `# syntax=` line, so no frontend image is fetched.
- **The icons row fails:** the published icon set changed. Publish a new `/vN/` folder instead of overwriting
  one, then update `registry/token-icons.json` and Night Market's `web/public/token-icons/` together.
- **A failed run:** `run` always tears down (`$OUT/down-check.json` proves nothing is left); `up` + `journey`
  keeps a failed stack for inspection until `down`.

