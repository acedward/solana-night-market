# The relay's own flows on a ledger-9 localnet (AA 00047 lane B3)

| File | What it does |
|---|---|
| `compose.yml` | The localnet (Track A's recipe: node `caf93d6f…` = stagenet's build, indexer 4.4.0-rc.3, proof servers rc.6 for DUST and rc.8 for the account), the relay image with the key volume, and a mock kernel. |
| `deploy-faucets.ts` | Deploys mint-test-tokens v2 shielded faucets from the key volume's `faucet` bundle and prints the relay's `TOKENS_FILE` for them. |
| `relay-flows.ts` | The browser stand-in: a throwaway Ed25519 key signs in Phantom's scheme. Opens an account (the Solana envelope), claims demo tokens (and is refused a second time), reconciles the account's coins, withdraws to a third-party wallet (one F3 approval; its replay refused), files the change (append-inbox with the relay's entitlement), and makes an offer on the mock kernel. Writes the public outcome to `$OUT`. |
| `mock-kernel.ts` | Accepts every offer and reports it `live` (the real kernel's acceptance is the stagenet run's, plan P6.3). |
| `run-local.sh` | Brings it all up, runs the flows once per demo-token path (`direct`, `via-sponsor`), and tears everything down. |
| `stagenet-faucet-check.ts` | A tiny live check (about 1 DUST): a stagenet faucet's on-chain `mint` key against the key volume, then a mint to the funding wallet (the first half of `via-sponsor`). |

```sh
# The repository with node_modules and the light compile in a docker volume:
DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh up && DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh sync
DOCKER_CHECK_NAME=nm-check scripts/docker-check.sh run 'bun install --frozen-lockfile && bun run contracts'
# The key volume (deploy/RUNBOOK.md section 5) in a host directory, and the relay image:
docker build -f deploy/relay.Dockerfile -t nm-relay:local .
KEYS_DIR=<key volume dir> RELAY_IMAGE=nm-relay:local APP_VOLUME=nm-check-app OUT=<dir> \
PS_PARAMS=<writable dir> PS8_PARAMS=<writable dir> RELAY_KEYS_FINGERPRINT=<pin> \
  test/stack/b3/run-local.sh direct via-sponsor
```

The localnet's genesis development seed funds the faucets and is the relay's sponsor: a public test
seed, never a real wallet. One heavy stack at a time on a host (a k=18 proof peaks near 9.4 GiB).

The stagenet check uses the shared funding wallet: take `~/.stagenet-offer-ladders/funding.lock`
first (create it exclusively with a JSON line `{purpose, pid, host, at}`), mount the seed file
read-only, run the script on a network with an rc.8 and an rc.6 proof server, and remove the lock
after. The seed never leaves the process; the output holds public values only.
