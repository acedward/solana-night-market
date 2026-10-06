# Night Market without Docker (systemd): the delta from MN Bank's guide

MN Bank's native guide (AA 00039, `plans/00039-passport-evm-dapp-systemd-guide.md` in the owner's
workspace) lays out a user, Bun, the runtime checkout, the proof server from its image, the key set,
the relay and nginx as systemd units. Night Market uses the same layout with these differences.
Names change from `mnbank` to `nightmarket` (user, units, `/etc/nightmarket`, `/srv/nightmarket`,
`/var/lib/nightmarket`, `/var/www/nightmarket`). Section 8 has the complete unit files. Not yet run on
a real systemd host; the units pass `systemd-analyze verify` (Debian 12). Before going live, go
through the production checklist at the top of `deploy/RUNBOOK.md`.

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
| `nightmarket-proof-contracts` | `midnightntwrk/proof-server:9.0.0-rc.8@sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf` | 6300 | `/var/lib/nightmarket/proof-params-rc8` | `14G` (a k=18 Ed25519 proof peaks near 9.4 GiB, and rc.8's memory grows across proofs: below) |
| `nightmarket-proof-dust` | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b` | 6301 | `/var/lib/nightmarket/proof-params-rc6` | `4G` |

Both binaries have the same name under different Nix store paths, so link each under its own name,
taking the path from its image's own file list (arm64: `--platform linux/arm64`):

```bash
crane export --platform linux/amd64 \
  midnightntwrk/proof-server:9.0.0-rc.8@sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf /tmp/ps-rc8.tar
crane export --platform linux/amd64 \
  midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b /tmp/ps-rc6.tar
for v in rc8 rc6; do
  sudo tar -xf "/tmp/ps-$v.tar" -C / nix
  sudo ln -sf "/$(tar -tf "/tmp/ps-$v.tar" | grep -m1 'bin/midnight-proof-server$')" "/usr/local/bin/midnight-proof-server-$v"
done
sudo install -d -o nightmarket -g nightmarket /var/lib/nightmarket/proof-params-rc8 \
  /var/lib/nightmarket/proof-params-rc6 /var/lib/nightmarket/zk-params
```

Neither binary has a bind option: **firewall 6300 and 6301**. `docker pull` of the rc.8 tag has been
seen to hang; `crane export` by the digest above does not use Docker.

**The port is a command-line flag.** Each unit passes it with `--port` (section 8). The binary also
reads `MIDNIGHT_PROOF_SERVER_PORT`, but it ignores `PORT`. `PORT` is read only by the images' own
start command (`midnight-proof-server --port $PORT`), which compose uses. A unit with
`Environment=PORT=6301` and no `--port` listens on the default, 6300, where the contract prover
already is. (Checked on both pinned versions, AA 00060 P16: `--help` prints
`-p, --port <PORT> [env: MIDNIGHT_PROOF_SERVER_PORT=] [default: 6300]`.)

**The first start downloads the public parameters.** Each server fetches them into its `MIDNIGHT_PP`
directory at its first start, so it needs outbound HTTPS then, and the first start is slower. Later
starts reuse the directory. (`--no-fetch-params` turns the download off.) The stack runs of this
repository keep 117 MB there for rc.6 and 138 MB for rc.8.

**The contract prover's memory grows across proofs** (AA 00047 plan risk R7: 11.94 GiB of a 12 GiB
cap within four proofs of a restart on a localnet; killed at 14 GB after about 25). Its unit has
`MemoryMax=14G` and `Restart=always` (section 8), and a timer restarts it every 6 hours when the relay
runs no job (a proof cut off anyway fails its job as `market-unavailable`, never charged to the
customer). The check is a small script, not an inline `sh -c` line in the unit, because systemd
itself processes backslash escapes and `$` in `ExecStart`:

```bash
sudo tee /usr/local/bin/nightmarket-prover-restart >/dev/null <<'SH'
#!/bin/sh
# Restart the contract prover (rc.8) only when the relay runs no job (deploy/RUNBOOK.md section 12.1).
h="$(curl -fs http://127.0.0.1:8080/health)" || exit 0
if printf '%s' "$h" | grep -q '"running":[1-9]'; then exit 0; fi
exec systemctl restart nightmarket-proof-contracts
SH
sudo chmod 755 /usr/local/bin/nightmarket-prover-restart
```

The relay's `/health` lists every queue lane under `queue.lanes`, each with its `running` count: the
script restarts only when none is above 0, and does nothing when `/health` does not answer. The
timer and its service are in section 8.

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
  PASSPORT_COMMIT=599327b918b55afc95d6c98a89bcd15f4e8b0d53
  ```

  The single-server `MIDNIGHT_PROOF_SERVER_URL` of MN Bank is refused by the relay (exit 78), and
  every `SEPOLIA_*`, `STALE_CLOSE_*` and `VAULT_GAS_*` line, and MN Bank's `BRIDGE_*` lines, are gone.
  (Night Market's `BRIDGE_REGISTRY_FILE` is a different setting: bridging, section 4.)

  The relay does not read `MIDNIGHT_PP` or `PASSPORT_COMMIT`. They are here for the key unit
  (section 4), which reads the same two files: `MIDNIGHT_PP` is its compile's parameter cache, and
  `PASSPORT_COMMIT` is the commit it records in its report (`.night-market-keys.json`).
- `/etc/nightmarket/relay.env` is a copy of `deploy/.env.example` with the operator's values, as
  in MN Bank's guide. The round-2 fix pass (AA 00047 P10) added settings to it; copy them over on an
  upgrade (their meaning and numbers: `deploy/RUNBOOK.md` section 9):

  ```ini
  JOBS_PER_ACCOUNT=1
  OFFERS_MAX_OPEN_PER_ACCOUNT=3
  MAKES_PER_ACCOUNT_PER_DAY=20
  CANCELS_PER_ACCOUNT_PER_DAY=5
  RESTORES_PER_ACCOUNT_PER_DAY=3
  CLIENT_IPV6_PREFIX=64
  CLIENT_IPV4_PREFIX=32
  AUTH_MAX_USED_NONCES=200000
  DEMO_TOKENS_PENDING_SETTLE_SECONDS=14400
  ```

  The round-3 fix pass (AA 00047 P11) adds two more (RUNBOOK section 9), and the relay now reads an
  account's history past 500 actions over the indexer's WebSocket (`MIDNIGHT_INDEXER_WS_URL`, the
  network profile's by default):

  ```ini
  WITHDRAWS_DAILY_CAP=100
  TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY=10
  ```

  The round-4 follow-up (AA 00047 P11.F) adds four more (RUNBOOK section 9: the prover lane's order
  and the pause after the exchange's 429); the defaults need no change:

  ```ini
  PROVER_USAGE_WINDOW_SECONDS=3600
  PROVER_PRIORITY_BURST=4
  PROVER_JOB_ESTIMATE_SECONDS=60
  BATCHER_BUSY_COOLDOWN_SECONDS=300
  ```

  The round-4b fix (AA 00047 P11.F2) adds one more (RUNBOOK section 9: the floor under the prover
  lane's hold estimate); the default needs no change on stagenet:

  ```ini
  PROVER_JOB_ESTIMATE_FLOOR_SECONDS=45
  ```

  `AUTH_MAX_NONCES` and `AUTH_MAX_NONCES_PER_CLIENT` are no longer read: remove them. Behind nginx,
  `RELAY_TRUST_PROXY=true` (as in MN Bank's guide) is what lets the per-client caps see the
  customer's address (an IPv6 customer is counted per /64). The new key set
  (`RELAY_KEYS_FINGERPRINT=21493588…5c5e`), the web build (its pinned account keys) and these
  settings deploy together (RUNBOOK section 12.2, "BREAKING: the round-2 security fix pass").
- `sudo install -d -m 700 -o nightmarket -g nightmarket /var/lib/nightmarket/data` (the demo-token
  claims; back it up). It must belong to the relay unit's `User=`. Compose does this with its
  `relay-data-init` service; a native host does it once here. If you change the unit's user later,
  run `sudo chown -R <user>:<group> /var/lib/nightmarket/data`.

## 4. The key set

MN Bank's oneshot unit (section 8), with `TimeoutStartSec=2h` and `MemoryMax=12G`. It now also compiles the
demo-token faucet (seconds) and checks its `mint` key against the deployed faucets. A good run ends
with `verdict VERIFIED (fingerprint 21493588…5c5e)`, and the set is 2.5 GB. To import a set built
elsewhere, put `KEYS_IMPORT_DIR=<dir holding account/>` in `native.env` for the first run (the job
copies only the kept prover keys).

**With bridging** (`BRIDGE_REGISTRY_FILE`, `deploy/RUNBOOK.md` section 17.3), install the bridge
bundle into the key set's directory once, after the key unit's first run. Copy it from a checkout of
the 00050 template at the pinned commit (with compose, the same files go into the key volume's
`bridge/`):

```bash
T=<the template checkout>/packages/contracts-midnight/contract-bridge/src/managed
B=/app/vendor/passport/contract/contracts/managed/bridge
sudo install -d -o nightmarket -g nightmarket "$B"
sudo cp -r "$T/." "$B/" && sudo chown -R nightmarket:nightmarket "$B"
sha256sum "$B/keys/lockForSolana.verifier"   # b54ed1f6aff46df16f9e3e132c3e4d5e3e7c3d51fd731049f5421f4848e3967f
sha256sum "$B/keys/mintFromSolana.verifier"  # 5f4fa8ace0ea0e47685532f67fcfbd460d826877b877b6dbfbf33bd7dd7e80f9
```

If either hash differs, stop: that compile is not the one the bridges were deployed with. The key
unit leaves `bridge/` in place when it re-verifies or rebuilds. The bundle is not part of the key set,
so the fingerprint does not change: the key unit still ends with `verdict VERIFIED (fingerprint
21493588…5c5e)`, and the relay starts with `RELAY_KEYS_FINGERPRINT` as shipped. Keep the bundle at
this path. Its `contract/index.js` loads the contract runtime from `/app/node_modules`, which does
not work from a directory outside `/app`. Then put `BRIDGE_REGISTRY_FILE=<a path the relay can
read>` in `relay.env`. `RELAY_DATA_DIR` is set already.

## 5. The relay

MN Bank's unit (section 8 has the whole file), with:

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
(`{"network":"stagenet","relayUrl":"/relay"}`). The nginx site is unchanged apart from the names and
the **Content-Security-Policy**, which the Docker web image writes from `WEB_CONTENT_SECURITY_POLICY`
and a native nginx must carry itself (`deploy/RUNBOOK.md` section 16). Its `connect-src` names the
public indexer with BOTH its `https://` and its `wss://` origin (since AA 00047 P11 the page reads an
account's history past 500 actions over the indexer's WebSocket), and `script-src` allows
`'wasm-unsafe-eval'` (the contract runtime and ledger-v9 run as WebAssembly in the page). Since AA 00062
it also allows the customer's own proof server (`http://localhost:* http://127.0.0.1:* https:`). The
tested value for stagenet with the same-origin `/relay`:

```nginx
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://indexer.stagenet.shielded.tools wss://indexer.stagenet.shielded.tools https://stagenet.api-zswap.zkdojo.com http://localhost:* http://127.0.0.1:* https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" always;
```

A relay on another origin and an indexer moved by `config.json` must be added to `connect-src` (the
indexer with both origins).

## 7. The sponsor wallet

A wallet DEDICATED to this server (`deploy/RUNBOOK.md` section 4.1): create a new one for production
(section 4.2), never the shared `.stagenet` wallet or one a test run used; its seed lives only in
`/srv/nightmarket/secrets/sponsor.seed` (mode 600, owned by the relay's user, backed up offline).
Register it for DUST with the relay's own tool, `relay/src/tools/sponsor-wallet.ts` (there is no
`nightmarket-tool`). Stop the relay first: the tool opens the same wallet, and refuses while the
relay holds it. It reads the relay's settings, so load both env files the way the unit does (each
`KEY=value` line taken as it is, never run as shell code: `. relay.env` would fail on a value such as
`<release commit>`):

```bash
sudo systemctl stop nightmarket-relay
sudo -u nightmarket -H bash -c 'for f in /etc/nightmarket/relay.env /etc/nightmarket/native.env; do
    while IFS= read -r l; do [[ $l =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && export "$l"; done < "$f"; done
  cd /app && exec /usr/local/bin/bun relay/src/tools/sponsor-wallet.ts register-dust'
sudo systemctl start nightmarket-relay
```

`status` (NIGHT, DUST and the registration) runs the same way. Run `register-dust` again after every
NIGHT top-up. `new` and `address` work offline and need no settings: run them without the env files,
or pass `--network stagenet`. (The env files set `MIDNIGHT_NETWORK_ID` to an empty value, and these
two take that as the network's name and fail.)

The DUST it needs, and the sponsor's worst case per day with Q46's allowance, are in
`deploy/RUNBOOK.md` sections 4.3 and 9. Opening a Night Market account costs about 41 DUST at the
default margin (not MN Bank's 60).

## 8. The unit files

Each goes in `/etc/systemd/system/`. Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nightmarket-proof-contracts nightmarket-proof-dust
sudo systemctl enable nightmarket-keys nightmarket-relay
sudo systemctl start nightmarket-keys          # first time 15–60 min: journalctl -fu nightmarket-keys
# fund the sponsor and run register-dust (section 7), then:
sudo systemctl start nightmarket-relay
sudo systemctl enable --now nightmarket-prover-restart.timer
curl -s http://127.0.0.1:8080/health
```

`nightmarket-proof-contracts.service`:

```ini
[Unit]
Description=Night Market contract prover (midnight-proof-server 9.0.0-rc.8)
Wants=network-online.target
After=network-online.target

[Service]
User=nightmarket
Group=nightmarket
Environment=MIDNIGHT_PP=/var/lib/nightmarket/proof-params-rc8
ExecStart=/usr/local/bin/midnight-proof-server-rc8 --port 6300
Restart=always
RestartSec=5
MemoryMax=14G
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`nightmarket-proof-dust.service`:

```ini
[Unit]
Description=Night Market DUST prover (midnight-proof-server 9.0.0-rc.6)
Wants=network-online.target
After=network-online.target

[Service]
User=nightmarket
Group=nightmarket
Environment=MIDNIGHT_PP=/var/lib/nightmarket/proof-params-rc6
ExecStart=/usr/local/bin/midnight-proof-server-rc6 --port 6301
Restart=on-failure
RestartSec=5
MemoryMax=4G
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`nightmarket-keys.service`:

```ini
[Unit]
Description=Night Market key set: build once, re-verify at every start (deploy/key-volume/build.sh)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=nightmarket
Group=nightmarket
WorkingDirectory=/app
EnvironmentFile=/etc/nightmarket/relay.env
EnvironmentFile=/etc/nightmarket/native.env
ExecStartPre=/usr/bin/mkdir -p /app/vendor/passport/contract/contracts/managed
ExecStart=/usr/bin/bash /app/deploy/key-volume/build.sh
TimeoutStartSec=2h
MemoryMax=12G

[Install]
WantedBy=multi-user.target
```

`nightmarket-relay.service`:

```ini
[Unit]
Description=Night Market relay
Wants=network-online.target nightmarket-proof-contracts.service nightmarket-proof-dust.service
Requires=nightmarket-keys.service
After=network-online.target nightmarket-proof-contracts.service nightmarket-proof-dust.service nightmarket-keys.service

[Service]
User=nightmarket
Group=nightmarket
WorkingDirectory=/app
EnvironmentFile=/etc/nightmarket/relay.env
EnvironmentFile=/etc/nightmarket/native.env
ExecStart=/usr/local/bin/bun relay/src/main.ts
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
TimeoutStopSec=30
MemoryMax=8G
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/nightmarket
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`nightmarket-prover-restart.service` and `nightmarket-prover-restart.timer` (the script is in
section 2):

```ini
[Unit]
Description=Night Market: restart the contract prover when the relay runs no job (plan risk R7)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/nightmarket-prover-restart
```

```ini
[Unit]
Description=Night Market: restart the contract prover every 6 hours when idle

[Timer]
OnCalendar=*-*-* 00/6:00:00

[Install]
WantedBy=timers.target
```
