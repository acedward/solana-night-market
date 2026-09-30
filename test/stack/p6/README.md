# The whole market for two accounts: localnet and stagenet (AA 00047 P6)

| File | What it does |
|---|---|
| `market-flows.ts` | The browser stand-in for TWO accounts, over the relay's HTTP API, with throwaway Ed25519 keys signing in Phantom's scheme (tweetnacl over the exact bytes). Steps: `open-a`, `open-b` (the Solana envelope, then the relay deploys and activates), `demo-a`, `demo-b` (the demo-token pack), `make` (A offers one token for another; the exchange's book must list it), `take` (B takes exactly that offer through the batcher; both accounts' balances must move by exactly the legs), `withdraw` (A withdraws the coin it received to a Midnight shielded key; the recipient's keys must open the output), `negatives` (the live relay refuses another key, another account, another network salt, an old nonce, a flipped bit, S+L, R = identity, a payload changed after signing, and identity/small-order owner keys; no transaction is sent). Secret state (the two device seeds, the inbox keys, the recipient's seed) lives in `$STATE_DIR/state.json` (mode 600); public results are merged into `$OUT/market-flows.json`. |
| `tamper-live.ts` | Spec SC-002 at the node: account B's honest `append_inbox_with_ed25519` approval and proof, then one byte of the disclosed entry flipped in the proven transaction. The node must answer `InvalidProof` (Custom error 115); nothing lands. Opens the sponsor wallet itself, so the relay must be stopped. |
| `mock-exchange.ts` | Localnet only: a kernel stand-in (stores and serves offers) and a batcher stand-in that adds DUST from its own development wallet (as `midnight-balancer` does) and submits, so a take settles on the localnet. |
| `compose.yml`, `run-local.sh` | The localnet (lane B3's recipe) with the relay image, the key volume and the mock exchange; runs every step of `market-flows.ts`, then `tamper-live.ts`, and tears everything down. |
| `run-stagenet.sh` | One capped stagenet run: takes the shared funding-wallet lock (waits politely), starts rc.8 + rc.6 proof servers and the relay image against stagenet and the staging exchange, runs the chosen steps (`STEPS=open-a,demo-a`, …, `tamper`), stops the relay when the sponsor's DUST has dropped by `DUST_CAP_SPECKS` (default 100 DUST), and releases the lock. The relay's demo-token claims persist in a named volume between runs. |

```sh
# The repository with node_modules and the light compile in a docker volume:
DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh up && DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh sync
DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh run 'bun install --frozen-lockfile && bun run contracts'
sed 1d deploy/relay.Dockerfile | docker build -f - -t nm-relay:local .

# Localnet (one heavy stack per host):
KEYS_DIR=<key volume> RELAY_IMAGE=nm-relay:local APP_VOLUME=nm-check-app OUT=<dir> \
PS_PARAMS=<dir> PS8_PARAMS=<dir> RELAY_KEYS_FINGERPRINT=<pin> test/stack/p6/run-local.sh

# Stagenet, one run per account opening, then the trade (the seed file is read in-process only):
KEYS_DIR=… RELAY_IMAGE=… APP_VOLUME=… PS_PARAMS=… PS8_PARAMS=… SEED_FILE=<funding wallet file> \
STATE_DIR=~/.config/<project>/p6-stagenet OUT=<dir> STEPS=open-a,demo-a test/stack/p6/run-stagenet.sh
… STEPS=open-b,demo-b …
… STEPS=make,take,withdraw,negatives,tamper …
```
