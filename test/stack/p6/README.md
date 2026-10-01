# The whole market for two accounts: localnet and stagenet (AA 00047 P6)

| File | What it does |
|---|---|
| `market-flows.ts` | The browser stand-in for TWO accounts, over the relay's HTTP API, with throwaway Ed25519 keys signing in Phantom's scheme (tweetnacl over the exact bytes). Steps: `open-a`, `open-b` (the Solana envelope, then the relay deploys and activates), `demo-a`, `demo-b` (the demo-token pack), `make` (A offers one token for another; the exchange's book must list it), `book` (the exchange's view of that offer again), `take` (B takes exactly that offer through the batcher; both accounts' balances must move by exactly the legs), `withdraw` (A withdraws the coin it received to a Midnight shielded key; the recipient's keys must open the output), `negatives` (the live relay refuses another key, another account, another network salt, an old nonce, a flipped bit, S+L, R = identity, a payload changed after signing, and identity/small-order owner keys; no transaction is sent). Secret state (the two device seeds, the inbox keys, the recipient's seed) lives in `$STATE_DIR/state.json` (mode 600); public results are merged into `$OUT/market-flows.json`. |
| `tamper-live.ts` | Spec SC-002 at the node: account B's honest `append_inbox_with_ed25519` approval and proof, then one byte of the disclosed entry flipped in the proven transaction. The node must answer `InvalidProof` (Custom error 115); nothing lands. `HONEST=1` submits the same call untampered (the control; it lands and pays its fee). Opens the sponsor wallet itself, so the relay must be stopped. |
| `mock-exchange.ts` | Localnet only: a kernel stand-in (stores and serves offers) and a batcher stand-in that adds DUST from its own development wallet (as `midnight-balancer` does) and submits, so a take settles on the localnet. |
| `compose.yml`, `run-local.sh` | The localnet (lane B3's recipe) with the relay image, the key volume and the mock exchange; runs every step of `market-flows.ts`, then `tamper-live.ts`, and tears everything down. |
| `fund-unshielded.ts`, `fund-keys.sh` | P9.I: an unshielded balance for account A. `fund-keys.sh` clones the relay's key volume and adds the account's `deposit_unshielded` prover key and its manifest entry from a full keyed build (the key job prunes both); `fund-unshielded.ts` mints a local unshielded test token (mint-test-tokens v2 `unshielded-token.compact`, deployed by `../b3/deploy-faucets.ts` with `PRIVACY=unshielded`) to a dev wallet and deposits it into A. NIGHT itself is refused by the ledger (`Custom error: 231`). |
| `c2-live.ts` | P9.I, audit C2 at the circuit: a valid signature over the arm's own text for a withdrawal naming one token, with a malicious witness store handing the circuit another token's coin. The circuit must refuse it (`held coin colour does not match the withdrawn colour`); nothing is proven or sent. Runs with the relay stopped. |
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

