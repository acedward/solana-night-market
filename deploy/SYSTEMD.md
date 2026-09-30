# Night Market without Docker (systemd): the delta from MN Bank's guide

MN Bank's native guide (AA 00039, `plans/00039-passport-evm-dapp-systemd-guide.md` in the owner's
workspace) lays out a user, Bun, the runtime checkout, the proof server from its image, the key set,
the relay and nginx as systemd units. Night Market uses the same layout with these differences.
Names change from `mnbank` to `nightmarket` (user, units, `/etc/nightmarket`, `/srv/nightmarket`,
`/var/lib/nightmarket`, `/var/www/nightmarket`). Not yet run on a real systemd host.

## 1. Base

- Clone `https://github.com/acedward/solana-night-market.git` (the release commit) with
  `git submodule update --init`.
- **Two compilers**, at the paths `deploy/key-volume/build.sh` expects:

  ```bash
  sudo env COMPACTC_DIR=/opt/compactc-0.35.0 bash /app/scripts/fetch-compactc.sh 0.35.0
  sudo env COMPACTC_DIR=/opt/compactc-0.34.0 bash /app/scripts/fetch-compactc.sh 0.34.0
  ```

  (MN Bank had one, at `/opt/compactc`.)

## 2. Two proof servers

Take BOTH binaries from their images (the same `crane export` recipe; each is a Nix build that
unpacks under `/nix/store`):

| Unit | Image | Port | `MIDNIGHT_PP` | `MemoryMax` |
|---|---|---|---|---|
| `nightmarket-proof-contracts` | `midnightntwrk/proof-server:9.0.0-rc.8@sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf` | 6300 | `/var/lib/nightmarket/proof-params-rc8` | `12G` (a k=18 Ed25519 proof peaks near 9.4 GiB) |
| `nightmarket-proof-dust` | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b` | 6301 | `/var/lib/nightmarket/proof-params-rc6` | `4G` |

The two Nix trees have different store paths; link each binary under its own name
(`/usr/local/bin/midnight-proof-server-rc8`, `…-rc6`). Neither has a bind option: **firewall 6300
and 6301**. `docker pull` of the rc.8 tag has been seen to hang; `crane export` by the digest above
does not use Docker.

## 3. Secrets and settings

- ONE secret file: `/srv/nightmarket/secrets/sponsor.seed`. There is no Sepolia RPC file.
- `/etc/nightmarket/native.env` (read after `relay.env`, so it wins):

  ```ini
  RELAY_HOST=127.0.0.1
  RELAY_PORT=8080
  RELAY_VERSION=<release commit>
  NODE_ENV=production
  HOME=/var/lib/nightmarket
  MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://127.0.0.1:6300
  MIDNIGHT_DUST_PROOF_SERVER_URL=http://127.0.0.1:6301
  MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed
  RELAY_REQUIRE_KEYS=true
  SPONSOR_SEED_FILE=/srv/nightmarket/secrets/sponsor.seed
  SPONSOR_TOOL_RELAY_HEALTH_URL=http://127.0.0.1:8080/health
  RELAY_DATA_DIR=/var/lib/nightmarket/data
  MIDNIGHT_PP=/var/lib/nightmarket/zk-params
  PASSPORT_COMMIT=451f7610e90000e0c5550877418122a04b85d0e6
  ```

  The single-server `MIDNIGHT_PROOF_SERVER_URL` of MN Bank is refused by the relay (exit 78), and
  every `SEPOLIA_*`, `BRIDGE_*`, `STALE_CLOSE_*` and `VAULT_GAS_*` line is gone.
- `sudo install -d -m 700 -o nightmarket -g nightmarket /var/lib/nightmarket/data` (the demo-token
  claims; back it up). It must belong to the relay unit's `User=`. Compose does this with its
  `relay-data-init` service; a native host does it once here. If you change the unit's user later,
  run `sudo chown -R <user>:<group> /var/lib/nightmarket/data`.

## 4. The key set

The same oneshot unit, with `TimeoutStartSec=2h` and `MemoryMax=12G`. It now also compiles the
demo-token faucet (seconds) and checks its `mint` key against the deployed faucets. A good run ends
with `verdict VERIFIED (fingerprint a627edb1…da92)`, and the set is 2.2 GB. To import a set built
elsewhere, put `KEYS_IMPORT_DIR=<dir holding account/>` in `native.env` for the first run (the job
copies only the kept prover keys).

## 5. The relay

The same unit, with:

```ini
Wants=network-online.target nightmarket-proof-contracts.service nightmarket-proof-dust.service
After=network-online.target nightmarket-proof-contracts.service nightmarket-proof-dust.service nightmarket-keys.service
ReadWritePaths=/var/lib/nightmarket
```

Exit 78 also covers the demo-token claims store:

- **Held by another relay** (one relay per data dir). The message names the lock and its holder's
  pid. A lock left by a crash is taken over on its own.
- **A data dir the relay cannot use.** The message names the path, the error, the relay's uid and
  gid, the directory's owner and mode, and the fix:
  - `EACCES`: the directory belongs to another user. Fix it with the `chown -R` above.
  - `EROFS`: `ProtectSystem=strict` without `/var/lib/nightmarket` in `ReadWritePaths`.
  - `ENOSPC`: the disk is full.

## 6. The web

The web build compiles the account's JavaScript with BOTH compilers (the script fetches and checks
them): `bash scripts/compile-contracts.sh`, then `bun run build:web`. Write `config.json` with the
network, the relay URL and, for a partner domain, `assets` and `pairs`
(`{"network":"stagenet","relayUrl":"/relay"}`). The nginx site is unchanged apart from the names.

## 7. The sponsor wallet

As in MN Bank's guide (`nightmarket-tool register-dust` with the relay stopped); the DUST it needs
is in `deploy/RUNBOOK.md` section 4.3.
