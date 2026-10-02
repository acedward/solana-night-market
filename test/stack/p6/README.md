# The whole market for two accounts: localnet and stagenet (AA 00047 P6)

| File | What it does |
|---|---|
| `market-flows.ts` | The browser stand-in for TWO accounts, over the relay's HTTP API, with throwaway Ed25519 keys signing in Phantom's scheme (tweetnacl over the exact bytes). Steps: `open-a`, `open-b` (the Solana envelope, then the relay deploys and activates), `demo-a`, `demo-b` (the demo-token pack), `make` (A offers one token for another; the exchange's book must list it), `book` (the exchange's view of that offer again), `take` (B takes exactly that offer through the batcher; both accounts' balances must move by exactly the legs), `withdraw` (A withdraws the coin it received to a Midnight shielded key; the recipient's keys must open the output), `negatives` (the live relay refuses another key, another account, another network salt, an old nonce, a flipped bit, S+L, R = identity, a payload changed after signing, and identity/small-order owner keys; no transaction is sent). Secret state (the two device seeds, the inbox keys, the recipient's seed) lives in `$STATE_DIR/state.json` (mode 600); public results are merged into `$OUT/market-flows.json`. |
| `tamper-live.ts` | Spec SC-002 at the node: account B's honest `append_inbox_with_ed25519` approval and proof, then one byte of the disclosed entry flipped in the proven transaction. The node must answer `InvalidProof` (Custom error 115); nothing lands. `HONEST=1` submits the same call untampered (the control; it lands and pays its fee). Opens the sponsor wallet itself, so the relay must be stopped. |
| `mock-exchange.ts` | Localnet only: a kernel stand-in (stores and serves offers) and a batcher stand-in that adds DUST from its own development wallet (as `midnight-balancer` does) and submits, so a take settles on the localnet. |
| `compose.yml`, `run-local.sh` | The localnet (lane B3's recipe) with the relay image, the key volume and the mock exchange; runs every step of `market-flows.ts`, then `tamper-live.ts`, and tears everything down. |
| `fund-unshielded.ts`, `fund-keys.sh` | P9.I: an unshielded balance for account A. `fund-keys.sh` clones the relay's key volume and adds the account's `deposit_unshielded` prover key and its manifest entry from a full keyed build (the key job prunes both); `fund-unshielded.ts` mints a local unshielded test token (mint-test-tokens v2 `unshielded-token.compact`, deployed by `../b3/deploy-faucets.ts` with `PRIVACY=unshielded`) to a dev wallet and deposits it into A. NIGHT itself is refused by the ledger (`Custom error: 231`). |
| P10.I steps in `market-flows.ts` | Every signed step checks the wallet's first line is `Site: <label>` (F3 v3, Q36), and each new account is checked the way the site checks it (`web/src/chain/indexer.ts` on the public indexer, the web build's pinned verifier keys). `restore` (a page rotates A's key away; the site's check fails on `enc-key` alone; "Restore my encryption key"), `p10-negatives` (Q36 at the live relay), `fairness` (R2-1: A's burst and make/cancel loop against B's withdrawals, measured in the relay's stage times), `caps` / `caps-restore` (R2-1's per-account caps with the relay recreated under `CAPS`, then the defaults). `run-local.sh` runs them as phases 2–5, with a fresh contract prover before each. |
| `c2-live.ts` | P9.I, audit C2 at the circuit: a valid signature over the arm's own text for a withdrawal naming one token, with a malicious witness store handing the circuit another token's coin. The circuit must refuse it (`held coin colour does not match the withdrawn colour`); nothing is proven or sent. Runs with the relay stopped. P10.I adds Q36 at the circuit: an honest withdrawal signed over a bare first line (`invalid signature`) and over a leading-space label (the label-shape assert). |
| `page.ts` (P11.I) | The PAGE, headless: the web build's own operations (`web/src/passport/operations.ts` `syncAccount` and `withdrawToWallet`, `web/src/trade/operations.ts` `reconcileOffers`) over the site's chain reader (the origin check, the account's COMPLETE history decoded with ledger-v9: P11.A/P11.B), the page's store (an in-memory `Storage` kept in `$STATE_DIR/page-<A|B>.json`, mode 600, as a browser keeps localStorage) and the page's signing seam over the throwaway key. Since P11.I every coin, balance, pending record and "Filled"/"Cancelled" the flows check is the page's; the relay's `/zswap` report is never read (questions Q54). |
| `third-party.ts` (P11.I) | Anyone with a funded Midnight wallet (the localnet's development seed 3; questions Q55), in-process in `market-flows.ts`, proving with the relay's runtime on the stack's prover: deploys auditor A's `round` time bomb through the client's wave deploy (`deployBomb`, `forgeDeployRound`), mints and makes permissionless deposits with any note (`mintShielded`, `depositShielded`), and proves a key change with the device's signature (`rotateKey`: a hostile page that pays itself, since the relay lands only the opening key, Q50). |
| P11.I steps in `market-flows.ts` | `origin` (the localnet indexer serves P11.A's origin reads; the verdict), `history` (the page's and the relay's readers over the `contractActions` subscription equal the HTTP read), `make-x` + `coin-spent` (a take paid from a spent coin is refused before any proof), `plant` (a counterfeit note on a 1-unit deposit and X's real wanted coin: not Filled, the counterfeit counts nothing), `bomb` (the page refuses the time bomb: `provenance`, `counters`), `restore` (Q50: a non-opening key refused; the hostile rotation; the opening key restored), `omitted-spend` (the relay reports a landed withdrawal failed; a read without its spend keeps the change record; the chain confirms it), `withdraw-cap` (Q46 at `WITHDRAWS_DAILY_CAP=1`: `whole-coin-exit`, the exit, the refused record dropped, `whole-coin-exit-used`), `large-history` (a third party's deposits timed; past 500 actions only within `LARGE_HISTORY_BUDGET_S`). `run-local.sh` runs them in phases 1, 2a, 2b, 4 and 6, with a fresh contract prover before each. |
| P11.F step in `market-flows.ts` | `reconcile` (after `take`; audit round 4 R4-2): the relay's own reader on the localnet indexer, now with each call's entry point, and `judgeTake` over the transactions the take left: B's take is its own settlement (`settled`: a refused take that landed after all succeeds), and A's offer coin, spent by that swap, is a race for any other approval A had in flight (`raced`: never charged). |
| P11.F2 steps in `market-flows.ts` | `reconcile` gains auditor B's round-4b regression on the real indexer (a NEW take of B asking to be paid the coin W its take was paid, from another unspent coin, at B's current nonce, judged after the current tip: the counterparty's, not `settled`; the relay's pre-proof read refuses it `want-reused`, and accepts a fresh want). `want-reused` (after `reconcile`; audit round 4b R4b-1): A lists a second offer like the first, and B, signing as a script would (not the page), takes it asking to be paid W again: the real relay fails the job `want-reused` before any proof or exchange request; balances, nonces and the listing are unchanged. |
| `run-stagenet.sh` | One capped stagenet run: takes the shared funding-wallet lock (waits politely), starts rc.8 + rc.6 proof servers and the relay image against stagenet and the staging exchange, runs the chosen steps (`STEPS=open-a,demo-a`, …, `tamper`), stops the relay when the sponsor's DUST has dropped by `DUST_CAP_SPECKS` (default 100 DUST), and releases the lock. The relay's demo-token claims persist in a named volume between runs. |

```sh
# The repository with node_modules and the light compile in a docker volume:
DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh up && DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh sync
DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh run 'bun install --frozen-lockfile && bun run contracts'
sed 1d deploy/relay.Dockerfile | docker build -f - -t nm-relay:local .

# Localnet (one heavy stack per host). P9.I's full run adds an unshielded token and the funding key dir:
test/stack/p6/fund-keys.sh <key volume> <full keyed build> <fund key dir>
KEYS_DIR=<key volume> FUND_KEYS_DIR=<fund key dir> UFAUCET_DIR=<compiled unshielded-token bundle> \
RELAY_IMAGE=nm-relay:local APP_VOLUME=nm-check-app OUT=<dir> PS_PARAMS=<dir> PS8_PARAMS=<dir> \
RELAY_KEYS_FINGERPRINT=<pin> test/stack/p6/run-local.sh

# Stagenet, one run per account opening, then the trade (the seed file is read in-process only):
KEYS_DIR=… RELAY_IMAGE=… APP_VOLUME=… PS_PARAMS=… PS8_PARAMS=… SEED_FILE=<funding wallet file> \
STATE_DIR=~/.config/<project>/p6-stagenet OUT=<dir> STEPS=open-a,demo-a test/stack/p6/run-stagenet.sh
… STEPS=open-b,demo-b …
… STEPS=make,take,withdraw,negatives,tamper …
```

## Results (2026-09-30)

- **Localnet**: every step for two accounts, the take settled through the mock batcher, balances exact, the
  withdrawn coin opened by the recipient's keys, a tampered proof refused with `Custom error: 115`.
- **Stagenet** (the relay image built from this branch, margin 5, about 60 DUST over seven runs): accounts
  `453b2b8d…3751` and `57351491…412e`; demo tokens by the one-transaction path; A's offer
  `3d622fc9…4276` listed by the staging kernel; B's take settled by the staging batcher in
  `4464f3f4a8b35999350418c4741cc2c4aa4fce44913c8982e8bf137cb5b7620c` (block 685,773; the kernel marked
  the offer consumed; balances exact); A's withdrawal `002320179fcc…5334` arrived; a tampered proof
  refused by the stagenet node (`Custom error: 115`); eleven refusals by the live relay.

## Results after the security fix pass (P9.I, 2026-10-01)

Key set `efc52fbc…`, passport `b2f1847` (message format F3 v2).

- **Localnet** (local run 6, one run): every step passed with two new accounts:
  - open, demo tokens, then a make whose intent TTL equals its signed `validUntil`, listed and taken;
  - shielded and unshielded withdrawals;
  - **cancel**: "Cancel all open offers / Your key does not change", the nonce moves and the key does not. The node refuses the cancelled offer's settlement with `ReadMismatch` on the nonce.
  - an **expired offer**: the node refuses its settlement with `IntentTtlExpired`.
- **The relay refuses**: `validUntil` 0, too far, past or under the minimum; another site label for the same call (B′); a withdrawal naming another token than its coin's (C2); and a cancel naming another key.
- **At the node and the circuit**: a tampered proof gets `InvalidProof`. C2 at the circuit gets `failed assert: held coin colour does not match the withdrawn colour`.
- **The contract prover's memory grows across proofs**: after about 25 proofs a k=18 proof hit the 14 GB cap. `run-local.sh` restarts it before the relay-stopped phase.


## Results after the round-2 fix pass (P10.I, 2026-10-02)

Key set `21493588…`, passport `599327b` (message format F3 v3: the first line is `Site: <label>`). One local run, every phase, exit 0:

- **Flows**: two new accounts opened (the site's own check passes on each, with the web build's pinned keys), demo tokens, a make listed with its intent TTL equal to its signed expiry, a take settled with exact balances, shielded and unshielded withdrawals, a cancel (the nonce moves, the key stays), an expired offer refused by the node.
- **Key restore**: after a key change to another key, the site refuses the account on its encryption key alone; "Restore my encryption key" (one approval: "Rotate encryption key / New key …") puts the browser's key back, and the site accepts the account again.
- **Q36**: the relay refuses a signature over a label equal to an action title, a leading-space label, a bare first line, and "Site: Cancel all open offers" above a real key change. The circuit refuses the bare line (`invalid signature`) and the leading-space label (its label-shape assert).
- **R2-1 fairness**: one account bursts six makes (`202`, then `429 account-busy` ×5) and loops makes and cancels. Another account's withdrawal waits behind exactly one of its jobs: 21 s behind a make's proof, 30 s behind a cancel's.
- **R2-1 caps** (`CAPS=2,3,2,1`): `account-busy`, `open-offers-cap`, `makes-daily-cap`, `cancels-daily-cap` and `restores-daily-cap`, each exactly one request past its cap; a relay restart resets them.
- **SC-002**: a tampered proof gets `InvalidProof`; C2 is refused by the circuit; every P9 and P6 refusal holds.
- The contract prover peaked at 11.94 GiB under a 12 GiB cap (one-minute samples), with no OOM.

## Results after the round-3 fix pass (P11.I, 2026-10-02)

Key set `21493588…` and passport `599327b` unchanged (no rekey); the relay image built from the integration branch. One local run, every phase, exit 0. Every coin, balance, pending record and approval state below is the PAGE's own (`page.ts`: the web build's `syncAccount` and `reconcileOffers` decoding the account's history with ledger-v9); the relay's coin report is never read.

- **Flows**: two new accounts pass the page's opening check (now with the account's origin: the deploy's state equals the constructor's run in the page, nothing written before the authority retired). The localnet indexer serves the origin reads and the `contractActions` subscription (the page's and the relay's readers, pages forced to 2 actions, equal the HTTP read). A make taken through the mock exchange shows **Filled on both accounts from the decoded swap transaction**; withdrawals, cancel, expired offer as before.
- **R3-1**: auditor A's `round` time bomb, deployed for real through the client's wave deploy and activated by a third party, is refused by the page with `counters` and `provenance`.
- **R3-2 / Q46** (relay at `WITHDRAWS_DAILY_CAP=1`): the page's own withdrawals get `429 withdraws-daily-cap` with `whole-coin-exit`, the whole-coin exit of the same coin lands, the refused withdrawal's pending change drops, and the next try gets `whole-coin-exit-used`.
- **R3-3 / R3-6**: a counterfeit note on a 1-unit deposit claiming an offer's wanted coin counts in no balance; the offer's REAL wanted coin deposited by someone else counts exactly once and never makes the offer Filled; after the cancel the page says Cancelled.
- **R3-4**: a withdrawal the relay landed and reported failed keeps its pending change record, also through a read that leaves its spend out, until the chain confirms it.
- **R3-7**: a take paid from an already-spent coin fails `coin-spent` before any proof.
- **R3-9 / Q50**: a restore to a key that is not the opening key is refused (401 `malformed`); after a hostile page's own key change, "Restore my encryption key" lands the opening key.
- **R3-5**: 20 third-party deposits took 21.9 s each, so a live history past 500 actions would take about 3 hours; the subscription path ran live with small pages, and the lanes' fixtures cover 600 to 1,800 actions.
- Every P10, P9 and P6 refusal holds; a tampered proof gets `InvalidProof`; C2 and Q36 are refused by the circuit. The contract prover reached its 12 GiB cap twice without an OOM kill (deploy: 14g and a periodic restart).
