# Night Market: operator runbook (stagenet)

Night Market is a create-and-trade market on Midnight whose accounts are controlled by **Solana
wallets** (Phantom): each account is a Passport account contract with the Ed25519 arm, and every
account action is approved by ONE `signMessage` in the wallet. The relay proves, pays every DUST
fee from its sponsor wallet, and submits. There is no Sepolia. The tokens are native Midnight test
tokens from the mint-test-tokens faucets, plus, when bridging is configured (AA 00060, section 17),
SPL tokens bridged in from Solana.

This runbook deploys and runs the market on Midnight **stagenet**, a test network: nothing here
carries real value. Every command runs from the repository root unless it says otherwise.
`deploy/.env.example` documents every setting; `deploy/SYSTEMD.md` covers a host without Docker.
What the market cannot promise is in the README's "Known limitations". The site has no About page
(AA 00060 FR-029), so point customers to that list; the page's own warnings stay in the flows they
apply to.

## Production checklist

Go through it before the market goes on a production server; each item names its section.

- [ ] **A dedicated sponsor wallet** (4.1–4.4): a NEW wallet created for this server
  (`sponsor-wallet.ts new`), never the shared `.stagenet` wallet or one a test run used.
  `SPONSOR_DEDICATED_WALLET=true`, `SPONSOR_FUNDING_LOCK_FILE` empty. Seed file mode 600, readable
  by `RELAY_USER`, backed up offline. Fund it, run `register-dust` after every top-up, and size it
  (section 9): one account costs the sponsor at most about 125 DUST a day; at the default caps the
  whole market can be made to spend up to about 6,500 DUST a day (about 9,000 NIGHT registered for
  DUST sustains that). `REGISTER_DAILY_CAP` is the main lever.
- [ ] **Domain and TLS** (3, 15): the site only over https (WebCrypto and Phantom need a secure
  page), a TLS proxy in front of `127.0.0.1:18081` (`WEB_BIND_ADDRESS=127.0.0.1`), plain http
  redirected. One TLS site per domain.
- [ ] **The trusted proxy** (3): `WEB_TRUSTED_PROXIES` names your TLS proxy's address (the default
  fits a proxy on the same host); `RELAY_TRUST_PROXY=true`. After the first start, open accounts
  from two different networks: each must count against its own address. Wrong, every customer
  shares one rate-limit bucket and one per-address registration cap.
- [ ] **The Content-Security-Policy** (16): set `WEB_CONTENT_SECURITY_POLICY` to the tested value.
  Its `connect-src` names the indexer's `https://` AND `wss://` origins (and the kernel), and
  `script-src` allows `'wasm-unsafe-eval'`. Then open the Portfolio page with an account: the
  browser console shows no CSP violation.
- [ ] **Both proof servers** (1, 2, 12.1): `proof-server-contracts` is 9.0.0-rc.8 (pinned by
  digest) with `CONTRACT_PROOF_SERVER_MEM_LIMIT=14g` AND the periodic restart (the cron line in
  12.1); `proof-server-dust` is 9.0.0-rc.6 (4g). `/health` shows `proofServer.version`
  `9.0.0-rc.8` and `dustProofServer.version` `9.0.0-rc.6`. Neither is reachable from outside.
- [ ] **The key set** (5): `RELAY_KEYS_FINGERPRINT` as shipped in `deploy/.env.example`
  (`21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e`). `up keys` ends with `verdict VERIFIED (fingerprint 21493588…)`, and `/health` shows
  `proofServer.keys.matchesPin: true` and `complete: true`.
- [ ] **The web pin** (16): build the web and relay images from the same commit.
  `grep -o "keySet: '[0-9a-f]*'" packages/core/src/passport/pinned-account-keys.ts` must print the
  same fingerprint; the first account opened after the start must show as open, with no refusal.
- [ ] **The caps** (9): keep the defaults of `deploy/.env.example` unless a pattern shows:
  registrations 100 a day, 3 per client address, 1 at a time; per account 1 job at a time, 3 open
  offers, 20 makes, 3 key restores, 100 withdrawals (then one whole-coin exit per
  token), 20 change re-filings and 10 unsettled takes a day; 5 failures a day per key and per
  account; 100 demo-token claims a day; fee margin 20; low DUST at 10; the prover lane's order
  (takes, then makes, then the rest: `PROVER_PRIORITY_BURST` 4, `PROVER_USAGE_WINDOW_SECONDS` 3600,
  `PROVER_JOB_ESTIMATE_SECONDS` 60, `PROVER_JOB_ESTIMATE_FLOOR_SECONDS` 45) and the 5-minute pause after the exchange's 429
  (`BATCHER_BUSY_COOLDOWN_SECONDS` 300); `TAKE_MAX_LIFETIME_SECONDS` 600 (the page signs takes for
  600 s: never lower it). They live in memory: a relay restart resets them. Copy any setting a newer
  release adds to `.env.example`.
- [ ] **Backups** (7, 12.1): the sponsor seed file, and the `relay-data` volume (the demo-token
  claims). The key volume can be rebuilt. With the relay idle:

  ```sh
  docker run --rm -v nightmarket_relay-data:/data:ro -v "$PWD":/backup \
    busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e \
    tar czf "/backup/relay-data-$(date -u +%F).tgz" -C /data .
  ```

  (`nightmarket_` is `COMPOSE_PROJECT_NAME`.) To restore, stop the relay, extract the archive into
  the volume with `tar xzf … -C /data`, and start it: `relay-data-init` hands the files back to
  `RELAY_USER`, and the relay takes over the archived `demo-token-claims.json.lock` once it is two
  minutes old (section 7).
- [ ] **After the first start**: `/health` is `ok`; watch the contract prover's memory
  (`docker stats`) for the first days, and restart it more often if it climbs past 12 GiB.
- [ ] **Client proving, only if you require it** (18): `CLIENT_PROVING=required`, the CSP with
  `http://localhost:* http://127.0.0.1:* https:` in `connect-src` (16), and after the start
  `clientProving: {mode: "required"}` in `/health`. Then make an offer from a real browser with the
  package running: the popup, a passing Test, the offer listed. Watch `dustInFlightSpecks` (18.6).
- [ ] **Bridging, only if you bridge** (17): the journey registry generated once for the site and the
  relay (`scripts/bridge-tokens.ts`), `BRIDGE_REGISTRY_FILE` and `RELAY_DATA_DIR` on the relay, the
  bridge bundle in the key volume (keep `RELAY_KEYS_FINGERPRINT` as shipped: the bundle does not
  change it), the site's `solana` (and `injector`) settings, and every bridge's
  `GET /deployment` reachable from the browser. On any shared network, the test faucet holds a
  dedicated faucet key, never a bridge operator's (17.6).

## Contents

1. [What runs](#1-what-runs)
2. [Prerequisites and sizing](#2-prerequisites-and-sizing)
3. [First deployment](#3-first-deployment)
4. [The sponsor wallet](#4-the-sponsor-wallet)
5. [The key volume](#5-the-key-volume)
6. [How the relay authorises actions](#6-how-the-relay-authorises-actions)
7. [Demo tokens](#7-demo-tokens)
8. [Health monitoring](#8-health-monitoring)
9. [Capacity and limits](#9-capacity-and-limits)
10. [What customers must know](#10-what-customers-must-know)
11. [Known limits](#11-known-limits)
12. [Start, stop, upgrade and re-pin](#12-start-stop-upgrade-and-re-pin)
13. [Incidents](#13-incidents)
14. [Reference: pins and addresses](#14-reference-pins-and-addresses)
15. [Several domains: one build, one relay](#15-several-domains-one-build-one-relay)
16. [The browser reads the chain itself; the Content-Security-Policy](#16-the-browser-reads-the-chain-itself-the-content-security-policy)
17. [Bridging and the Solana side (AA 00060)](#17-bridging-and-the-solana-side-aa-00060)
18. [Client proving: the customer's own prover (AA 00062)](#18-client-proving-the-customers-own-prover-aa-00062)

## 1. What runs

`deploy/compose.yml` runs six services. They start in this order.

| Service | What it does | Public? | Holds a secret? |
|---|---|---|---|
| `keys` | A one-shot job. It compiles the Passport account (compactc **0.35.0**; its declared callees with 0.34.0, as compile-time inputs only) and the demo-token faucet (compactc 0.34.0), keeps the prover keys the relay needs, checks them, and writes them to the `keys` volume. Then it exits. Later starts only re-check the volume (a few seconds). | No | No |
| `proof-server-contracts` | `midnightntwrk/proof-server:9.0.0-rc.8`, pinned by digest: proves the account's circuits (ZKIR 3.1, which rc.6 cannot read) and the faucet's `mint`. | No | No |
| `proof-server-dust` | `midnightntwrk/proof-server:9.0.0-rc.6`, pinned by digest: proves the sponsor wallet's DUST spends (stagenet requires dust/9; rc.8 proves dust/10). One server will do both once stagenet moves to dust/10. | No | No |
| `relay-data-init` | A one-shot job before every relay start. It hands the `relay-data` volume to the relay's user (`RELAY_USER`), mode 700, then exits. `busybox` pinned by digest, run as root with no capability except `CHOWN`, no network and a read-only root. | No | No |
| `relay` | Proves, pays every DUST fee from the sponsor wallet, submits, publishes offers to the exchange and settles takes through its batcher. Keeps no customer data; its only state is the demo-token claims file. | Only through `web`, under `/relay/` | The sponsor seed, as a file |
| `web` | The static site on an unprivileged nginx. It also passes `/relay/` to the relay, so the site and the relay share one origin. | Yes, behind your TLS proxy | No |

Volumes:

| Volume | Size | Content |
|---|---|---|
| `<project>_keys` | 2.2 GB | The compiled account and faucet with the relay's prover keys, and the check report `.night-market-keys.json`. Public artefacts. |
| `<project>_zk-params` | about 0.2 GB | The public parameters the key compile downloads. |
| `<project>_contract-proof-params`, `<project>_dust-proof-params` | about 0.3 GB each | Each proof server's public parameters and zswap keys, fetched at its first start. |
| `<project>_relay-data` | kilobytes | `demo-token-claims.json`: which Solana keys received demo tokens, and when. Owned by `RELAY_USER`, mode 700 (`relay-data-init`). Back it up (section 7). |

Services you do not run here: the stagenet ZSwap kernel (`https://stagenet.api-zswap.zkdojo.com`)
and batcher (`https://stagenet.batcher-zswap.zkdojo.com`). They must run with
`ALLOW_CONTRACT_MAKER_OFFERS=true` and `BATCHER_ALLOW_CONTRACT_TX=true`, or every account offer and
take is refused. The mint-test-tokens faucets are live contracts on stagenet (section 14).

## 2. Prerequisites and sizing

**Software**: Linux with Docker Engine 25 or newer and the Compose plugin (v2.24 or newer), git,
and `curl`. A TLS reverse proxy (Caddy, nginx, a tunnel) for the public site.

**Memory**:

| What | Memory |
|---|---|
| Contract prover (rc.8), during a k=18 proof (withdrawals, inbox appends, offers) | one proof peaks near 9.4 GiB, but its memory **grows across proofs** (below); limit `CONTRACT_PROOF_SERVER_MEM_LIMIT=14g`, and restart it periodically (section 12.1) |
| DUST prover (rc.6) | small; limit `DUST_PROOF_SERVER_MEM_LIMIT=4g` |
| Relay | 1 to 2 GB idle; a proof adds about 0.15 GB (it streams the prover key); limit `RELAY_MEM_LIMIT=8g` |
| Web | under 50 MB; limit 256 MB |
| Key job, once | an import needs little; a full compile of the account's 40 circuits up to `KEYS_JOB_MEM_LIMIT=12g` |

Plan for about **22 GB of RAM**. The relay proves one call at a time, but rc.8 does not give all of a
proof's memory back (AA 00047 plan risk R7): on a localnet it reached **11.94 GiB of a 12 GiB cap
within four proofs of a restart** (P10.I), and a 14 GB cap was hit after about 25 proofs (P9.I). A
P11.I's run of record reached the 12 GiB cap twice (during the fairness and the caps phases, each a
dozen proofs after a restart), held there by the kernel's reclaim without a kill. A proof the kernel
kills fails its job as `market-unavailable` (never charged to the customer, who can
retry), and Docker restarts the prover. So: **14g, plus a periodic restart when no proof runs**
(section 12.1). A busy production relay should watch the prover's memory (`docker stats`) for its
first days and restart more often if it climbs past 12 GiB.

**With client proving `required`** (section 18), the k=18 rows above no longer apply: offers, takes,
withdrawals, change filings and Bridge out's first transaction are proven on the customer's machine. The
contract prover still proves the **k=17 key restore** (AA 00062 P5: rc.8 peaked at **6.4–6.5 GiB**, during
key restores with a bridge's delivery on the same rc.8) and the bridges' mints (about 4 GiB each), and its
memory still grows across proofs. So keep that headroom: keep `CONTRACT_PROOF_SERVER_MEM_LIMIT` and the
periodic restart, and on a host with 8 GB of RAM keep swap (the stagenet production server runs 8 GB plus
24 GB of swap). The relay, its proof verifier loaded, stayed under 0.5 GiB in that run.

**Disk**: about 20 GB free before the first start. The key volume is 2.2 GB; a full compile needs
about 12 GB more while it runs (an import of a set built elsewhere, section 5.4, about 2.3 GB).

**CPU**: 4 cores or more. On rc.8, a k=17 Ed25519 circuit proves in about 9 s and a k=18 one in
about 17 s on the proof server alone (Track A's measurements); a whole action, with the relay's
key streaming and the DUST proof, takes 30 to 60 s.

**Network**: the host needs outbound HTTPS and WSS to:

- `rpc.stagenet.shielded.tools` (node) and `indexer.stagenet.shielded.tools` (indexer);
- `stagenet.api-zswap.zkdojo.com` (kernel) and `stagenet.batcher-zswap.zkdojo.com` (batcher);
- `srs.midnight.network` (public parameters for the key job and the proof servers);
- at build time only: `registry.npmjs.org`, `github.com` (both compilers) and Docker Hub.

Customers' browsers talk to your site, to the kernel (prices), and to their own Phantom wallet.
Phantom needs no SOL: it only signs messages.

## 3. First deployment

Do these steps in order. Sections 4 to 7 explain each one.

```sh
# 1. The code, with the pinned Passport sources (the Ed25519 arm), in /srv/nightmarket/app (the
#    path the prover-restart line of section 12.1 uses).
sudo install -d -m 755 -o "$(id -u)" -g "$(id -g)" /srv/nightmarket
git clone https://github.com/acedward/solana-night-market.git /srv/nightmarket/app
cd /srv/nightmarket/app
git checkout <release branch or commit>
git submodule update --init

# 2. A private directory for the secret file (section 4 fills it).
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /srv/nightmarket/secrets

# 3. The settings.
cp deploy/.env.example deploy/.env
# Edit deploy/.env: at least SPONSOR_SEED_HOST_FILE and RELAY_USER="$(id -u):$(id -g)"
# (numbers, not a name). Keep RELAY_KEYS_FINGERPRINT as shipped. Keep comments on their own lines.

# 4. Build the three images (about 5 minutes).
docker compose -f deploy/compose.yml build

# 5. The sponsor wallet (section 4).

# 6. The key volume (section 5): about 15 to 60 minutes the first time. Watch it finish.
docker compose -f deploy/compose.yml up keys

# 7. Start everything (relay-data-init runs first and exits 0; see below).
docker compose -f deploy/compose.yml up -d
docker compose -f deploy/compose.yml ps     # relay and web must show "healthy"
curl -s http://127.0.0.1:18080/health       # section 8
curl -s http://127.0.0.1:18080/v1/demo-tokens   # section 7: enabled, the pack, the day's room
```

**The relay's user.** The relay runs as `RELAY_USER`, the host user whose uid can read the seed
file (mode 600). Its only writable state is the `relay-data` volume. A new volume would take the
image's directory (uid 1000, mode 700), and a relay of any other uid could not write it. So the
one-shot `relay-data-init` service runs before every relay start: it hands the volume and
everything in it to `RELAY_USER`, mode 700. The relay mounts the volume with `nocopy`, so Docker
never copies the image's ownership back. Changing `RELAY_USER` later needs nothing else: the next
`up` hands the volume to the new user.

- `docker compose -f deploy/compose.yml logs relay-data-init` shows the result, for example
  `the relay's data dir now belongs to 1001:1001`.
- If it exits 64, `RELAY_USER` is not a numeric `uid:gid`.
- If the relay exits 78 with `the demo-token claims store cannot create its lock file (…): EACCES`,
  the data dir is not writable by the relay's user. The line names the path, the relay's uid and
  gid, the directory's owner and the fix. Check that `relay-data-init` ran (`ps -a`), and do not
  start the relay with `--no-deps` on a new volume.

Then put your TLS proxy in front of `127.0.0.1:18081`. With Caddy:

```
market.example.com {
    reverse_proxy 127.0.0.1:18081
}
```

The web container believes the `X-Forwarded-For` header only from the addresses in
`WEB_TRUSTED_PROXIES`. The default (loopback and the private ranges) fits a proxy on the same host.
If your proxy runs elsewhere, put its address there. If this is wrong, every customer shares one
rate-limit bucket, and one per-address daily cap on opening accounts (section 9: 3 a day for the
whole market). After the first deployment, open accounts from two different networks: each must
count against its own address, not a shared one.

The site must be served over **https**: the page derives and encrypts the account's keys with
WebCrypto, which browsers only offer on a secure origin (https, or `localhost`), and Phantom only
talks to secure pages.

## 4. The sponsor wallet

The relay pays every Midnight fee (DUST) for every customer from one wallet: the sponsor wallet.
Customers never need DUST, NIGHT or SOL.

### 4.1 Use a dedicated wallet, not the shared `.stagenet` wallet

Create a new wallet that only this relay uses, and fund it from the owner's `.stagenet` wallet.
Do not give the relay the `.stagenet` seed itself:

- **One wallet process per seed.** The relay keeps its wallet open all the time. If another tool
  opens the same seed, the second connection knocks the first one off.
- **The shared wallet has a lock.** Other tools take `funding.lock` before they use `.stagenet`. A
  relay holding that lock forever would block them all.
- **Coin clashes.** Two processes spending from one wallet pick the same DUST and fail each
  other's transactions. The demo-token path that mints to the sponsor (section 7) also needs the
  wallet's shielded coins to be its own.
- **A smaller blast radius**, and **clear accounting**: the dedicated wallet's balance is exactly
  what the market has spent.

**For the production server**, create a NEW wallet for it (section 4.2): not the `.stagenet` wallet,
and not a wallet a test run or another deployment has used. Size its NIGHT for the DUST section 4.3
describes and the sponsor's worst case in section 9 (with Q46's allowance, about 125 DUST per account
per day at margin 20; market-wide, at the default caps, up to about 6,500 DUST a day: the
registrations up to about 4,100, the demo-token packs about 400 and the rest of the prover lane's
day up to about 2,000), and keep its seed file only on that server (mode 600, backed up offline).

### 4.2 Create it

The relay image carries the tool. It writes a new 24-word mnemonic to a file, with mode 600, and
never overwrites an existing file. It prints only the public NIGHT address.

```sh
docker run --rm --user "$(id -u):$(id -g)" -v /srv/nightmarket/secrets:/out \
  nightmarket/relay:local bun relay/src/tools/sponsor-wallet.ts new --out /out/sponsor.seed --network stagenet
```

Back up `sponsor.seed` like any wallet seed: it is the market's only secret. To print the address
again: `sponsor-wallet.ts address --seed-file <file> --network stagenet`.

### 4.3 How DUST is generated

DUST is not transferred; it is **generated** by NIGHT registered for DUST generation. On stagenet
(read 2026-09-27): a cap of 5 DUST per NIGHT, about 0.714 DUST per NIGHT per day while under it
(7 days from empty to the cap). `sponsor-wallet status` prints the live parameters.

What the market spends, measured on stagenet by AA 00047 P6 (2026-09-30, the Ed25519 arm, this relay):
the required fee is what the indexer reports as `paidFees`, and the sponsor pays that times
1.046^`SPONSOR_FEE_BLOCKS_MARGIN` (the ledger keeps the whole declared fee).

| Action | Transactions | Required fee (DUST) | Paid at margin 5 | Paid at margin 20 (default) |
|---|---|---|---|---|
| Open an account | deploy wave 1, wave 2 (maintenance update), activation | 16.5–17.1 (11.7–12.1 + 4.5–4.7 + 0.26) | about 21 | about 41 |
| Demo tokens (`direct`) | one per token | 0.49–0.57 each | about 0.65 each | about 1.3 each |
| Withdrawal (shielded) | one | 0.34 | 0.42 | 0.83 |
| Change re-filing (append inbox) | one | 0.60 | 0.75 | 1.5 |
| Make an offer; take an offer | none from the sponsor | 0 (the batcher pays the settlement: 0.32) | 0 | 0 |

Margin 5 was enough for every call in P6: the wallet estimates the fee on a proof-erased copy, and for
the arm's k=18 calls that estimate is only about 4% below the real fee. Registration dominates: 1,000
NIGHT gives about 714 DUST a day, about 17 new accounts a day at margin 20 or 34 at margin 5.

### 4.4 Fund and register it

1. **Send NIGHT** to the sponsor's `nightAddress` from `.stagenet` (take
   `~/.stagenet-offer-ladders/funding.lock` first, as usual).
2. **Register the NIGHT for DUST generation** (one transaction; the tool waits until the NIGHT has
   generated enough DUST for its own fee). The relay must be stopped, because the tool opens the
   same wallet:

   ```sh
   docker compose -f deploy/compose.yml stop relay
   docker compose -f deploy/compose.yml up -d proof-server-dust
   docker compose -f deploy/compose.yml run --rm --no-deps relay \
     bun relay/src/tools/sponsor-wallet.ts register-dust
   docker compose -f deploy/compose.yml start relay
   ```

   Run `register-dust` again after every new NIGHT top-up.
3. **Check it** with `sponsor-wallet.ts status` the same way (relay stopped), or read `/health`
   `sponsor.dustSpecks` while the relay runs.

### 4.5 Low DUST

Below `SPONSOR_DUST_LOW_SPECKS` (default 10 DUST) the relay refuses new actions with a clear
message and `/health` shows `sponsor.dustLow: true`. Opening one account costs about 41 DUST at
the default margin (section 4.3): keep the balance well above that.

The balance the relay reports and checks does not dip while a transaction is in flight (section 8,
`sponsor.dustSpecks`), so `dustLow` only turns on when the DUST is really low, and it turns on at
once.

`sponsor-wallet.ts status` prints the wallet's own balance. That tool runs with the relay stopped,
so nothing is in flight and the two agree.

## 5. The key volume

The relay proves with a key set that must match what the accounts are deployed with. The `keys`
job builds that set once and proves it is the right one before anything else starts.

### 5.1 What the job does

1. Checks its pinned inputs: compactc 0.35.0 and 0.34.0 (release archives, SHA-256 checked when
   the image is built), compact-runtime 0.20.0 (the account module's only runtime),
   `@sig-net/midnight` 0.23.0, `account.compact` with SHA-256
   `03bbd3d8ad978d6c49a573ad84d27325be95115b81a1b2d4ab829f2ecb50e6fe` (acedward/passport @
   `599327b`, the Ed25519 arm with the P9.C and P10.C fix passes), and the vendored faucet `contracts/faucet/shielded-token.compact`
   with SHA-256 `1dca131a…89bd` (effectstream/mint-test-tokens @ `a51cf3a`,
   `contracts/faucet/PROVENANCE.md`).
2. Compiles the account's callees (compile-time inputs, never installed), then the account with
   keys (40 circuits, compactc 0.35.0 `--feature-zkir-v3`). This is the slow step. Or imports a set
   built elsewhere (5.4).
3. Compiles the demo-token faucet with compactc 0.34.0 **without** `--feature-zkir-v3` and requires
   its `mint` verifier key to be the one the stagenet faucets were deployed with (SHA-256
   `4bbbb047…794a`; read from all four faucets' on-chain state on 2026-09-30).
4. Points the account module at compact-runtime 0.20.0, deletes every prover key the relay does
   not use, and removes them from each bundle's manifest.
5. Verifies the set:
   - every verifier key equals its compiled `expectedVk` table (account 40, faucet 5);
   - the 8 kept prover keys are present: `activate_initial_device_with_ed25519`,
     `withdraw_shielded_with_ed25519`, `withdraw_unshielded_with_ed25519`,
     `append_inbox_with_ed25519`, `rotate_enc_key_with_ed25519` (the "Cancel all open offers"
     call), `open_swap_shielded_with_ed25519`, `deposit_shielded`, and `faucet/mint`;
   - the fingerprint over the key set's verifier keys (the account's 40 and the faucet's 5) equals
     `RELAY_KEYS_FINGERPRINT` (**`21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e`**).
     A bridge bundle installed beside them (`<key volume>/bridge/`, section 17.3) is not part of the
     key set and does not change the fingerprint.
6. Installs the set into the volume and writes the report `.night-market-keys.json`.

Any failure exits non-zero, and Compose then does not start the relay or the web site. On later
starts the job sees the report, finds the same inputs, and only re-verifies.

The relay checks the volume again when it starts, and refuses to start (exit code 78, with the
list of problems in its first log line) when a circuit it proves lacks its prover key, verifier key
or ZKIR, when the fingerprint is not `RELAY_KEYS_FINGERPRINT`, or when no volume is mounted
(compose sets `RELAY_REQUIRE_KEYS=true`). The account's keys are also checked against the loaded
code, and every account the relay acts on is checked against the set on chain (section 6).

The key job, the relay's start-up check and `/health` (`proofServer.keys`) compute the fingerprint
the same way, over the key set only. The bridge bundle has its own checks at start (section 17.3),
so with bridging the pin stays the shipped one.

### 5.2 Run it

```sh
docker compose -f deploy/compose.yml up keys      # attached: you see the progress, it exits when done
```

The end of a good run:

```
key-volume: faucet done in … s (mint verifier key = the deployed one)
key-volume: verdict VERIFIED (fingerprint 21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e)
key-volume: OK: key volume installed and verified in … s (2.5G)
```

Read the report: `docker compose -f deploy/compose.yml run --rm --entrypoint cat keys
/app/vendor/passport/contract/contracts/managed/.night-market-keys.json`.

### 5.3 If it fails

| Message | Meaning | Action |
|---|---|---|
| `account.compact is …, not the pinned …` or `the faucet source is …` | The sources are not the pinned ones. | Check the submodule and the checkout. Re-pin only on a new release (section 12.3). |
| `the faucet's mint verifier key is …, not the deployed …` | The faucet compile does not reproduce the stagenet faucets. | Do not start the relay. Check the compactc 0.34.0 archive and that the job compiles without zkir-v3. |
| `fingerprint … differs from RELAY_KEYS_FINGERPRINT` | The set is not the pinned one. | As above. Never "fix" this by changing the pin without reading the report. |
| `…a build needs 16 GB` | Not enough disk for the compile. | Free disk, or build elsewhere and import (5.4). |
| Exit 137 | The compile ran out of memory. | Raise `KEYS_JOB_MEM_LIMIT`, or import (5.4). |

### 5.4 Import a set built elsewhere

On a small server, build the account bundle on a bigger machine (any keyed compactc 0.35.0 build
of the pinned `account.compact`, for example the Passport repository's
`npm run compile:account`) and import it. The job copies only the prover keys it keeps (about
2.3 GB instead of 12), compiles the faucet itself, and runs exactly the same checks: an imported
set is **not trusted**. The pinned fingerprint was produced this way (2026-10-02, in 13 s, from the
Passport repository's full keyed build of `b4964e3`, whose `account.compact` is `599327b`'s).

```sh
cat > deploy/compose.import.yml <<'EOF'
services:
  keys:
    environment:
      KEYS_IMPORT_DIR: /import
    volumes:
      - /path/to/managed:/import:ro      # holds account/{contract,compiler,keys,zkir}
EOF
docker compose -f deploy/compose.yml -f deploy/compose.import.yml up keys
```

## 6. How the relay authorises actions

**One wallet prompt per action.** Every account call (a withdrawal, an unshielded withdrawal, an
inbox append, an offer, a take, a cancel) is authorised by the Solana wallet's signature over the
call's readable message (format F3 v3, questions Q25 B′, Q32 and Q36: the site line "Site: " + the
market's label (the circuit fixes the "Site: ", so a label can never pose as one of the lines below), the operation,
each amount's exact base units and full 64-hex token id, then the site's name and decimals on a
line that says they are only the site's label, the recipient's fingerprint, an offer's expiry as a
UTC date and time, the account and its nonce, and the digest). It is the same
signature the account's circuit verifies. The relay rebuilds that message from the call's arguments
and the account's live state (its auth nonce and network salt), with its own label and token list,
and verifies the signature (tweetnacl, strict R, s below L) before it spends any proving time. So:

- a signature by another key, over other bytes, for another account, for another network, or for
  an older account state (an approval replayed after its call landed) is refused with `401`;
- the same approval sent twice while the first is queued is refused (`replayed`);
- the page and the relay must render with the **same token list**: a token added to one side only
  makes every message with it differ, and the relay refuses it with a reason. Configure tokens on
  the relay (`TOKENS_FILE`) and let the site take the same list.

Two actions have no account call to sign: **opening an account** and **claiming demo tokens**.
The wallet signs Track A's proof-of-possession message instead:

```
Night Market - stagenet
Prove you hold this key
Key <the Solana address>
For Open a Night Market account
Nonce <64 hex: the digest of the request, the relay's single-use nonce and its expiry>
This signature authorises nothing and moves no funds.
```

The relay issues the nonce (`GET /v1/auth/nonce`), accepts it once, and forgets all nonces on a
restart (the page asks for a new one). Nonces are **stateless** (audit round 2 R2-8, questions
Q40): a nonce carries its expiry and an HMAC under a key the relay draws at every start, so issuing
one stores nothing and no flood of requests, from any number of addresses, can fill a store and
lock other customers out. Issuance is bounded by the per-client rate limit (`RATE_LIMIT_NONCES_PER_MIN`,
an IPv6 client counted per /64). Used nonces are remembered until they expire, so a replay is refused.
Ledger-backed Phantom accounts sign a different, wrapped message and are refused.

**Offers and takes expire when the wallet says** (audit C6). Every offer and take signs a real
expiry (`validUntil`, Unix seconds, shown in the wallet's message), which the account's circuit
enforces on chain (`blockTimeLt`). The relay follows it everywhere:

- it refuses a call with no expiry, with less than `EXPIRY_MIN_REMAINING_SECONDS` (60 s) left, or
  further ahead than `OFFER_MAX_LIFETIME_SECONDS` (3,600 s, a make) or `TAKE_MAX_LIFETIME_SECONDS`
  (600 s, a take) plus `EXPIRY_CLOCK_SKEW_SECONDS` (120 s): `400 no-expiry`, `approval-expired`,
  `expiry-too-far`. It checks again when the job starts, before any proof;
- the transaction's TTL is capped at the expiry (midnight-js gives a call one hour), so the
  exchange's listing ends with it;
- an approval it accepted is remembered at least until its expiry, so it is never queued twice.

After the expiry nobody (this relay, another relay, or someone holding the request) can settle the
offer: the chain refuses it.

**Accounts must be market accounts (spec FR-005).** Before any work on an account, the relay reads
its on-chain state: every operation must carry exactly the verifier key of the pinned set for the
market's account shape (the deposits, the Ed25519 activation, five gated circuits and the offer
circuit: nine in all, with no device management, questions Q27), and its maintenance authority must
be retired. An account deployed from another build,
with another arm or an extra operation, or whose deployer kept an authority, is refused as "not a
Night Market account". Accounts the relay opens always pass (it deploys them from the pinned set
and retires the authority in the same second wave).

**Cancel offer** (questions Q30) is the arm's `rotate_enc_key_with_ed25519` with the account's
CURRENT encryption key: it changes nothing but the account's auth nonce, so every approval signed
before (its open offers included, wherever a copy is kept) can never be used again. The wallet reads
"Cancel all open offers / Your key does not change". The relay refuses any other key (`401`,
`malformed`), so a cancel can never change the account's key.

**Restore my encryption key** (`restore-enc-key`, audit round 2 R2-3, questions Q36): when a page
got the wallet to sign a real key change, the account's on-chain key is no longer the one the
customer's browser holds, and the site (which checks that key on the chain) refuses the account. The
site then offers to put the browser's key back: the same circuit, to the BROWSER's key, one wallet
approval that reads "Rotate encryption key / New key <fingerprint>". The relay refuses the on-chain
key itself (that would only be a cancel) and an all-zero key; a restore has its own daily cap
(`RESTORES_PER_ACCOUNT_PER_DAY`, 3), never uses up the cancels, and is never refused by the failure
budget. **Only the account's opening key** (audit round 3 R3-9, questions Q50): the relay lands a
restore only to the key the account was OPENED with (the `enc_key` in the state its deploy transaction
created, which the browser chose and checks at opening), and refuses any other key (`401`,
`malformed`). A page that talked a wallet into "Rotate encryption key" for the page's own key can
therefore not have the market land it for free. A proof of possession of the new key would not have
helped: that page holds its own key's secret.

**F-B6: a withdrawal's recipient encryption key.** A withdrawal to a Midnight wallet carries the
wallet's encryption key (so the wallet can find the coin), which the signed message does not cover.
With `RELAY_WITHDRAW_RECIPIENT_ENVELOPE=false` (the default, plan question Q13) it rides the TLS
request unsigned: the coin can only ever go to the signed recipient, but a request rewritten in
transit could hide it from the recipient's wallet. `true` restores MN Bank's second signature (two
prompts per withdrawal; the page must support it).

## 7. Demo tokens

The "Get demo tokens" button mints a pack from the mint-test-tokens faucets into the customer's
account. The faucets are permissionless and the tokens cost nothing; the sponsor pays the DUST.

| Setting | Default | Meaning |
|---|---|---|
| `DEMO_TOKENS_ENABLED` | `true` (in `.env.example`) | Off: `GET /v1/demo-tokens` says `enabled: false` and the action is refused. |
| `DEMO_TOKENS_PACK` | `twUSDC:1000,twBTC:0.1,twETH:1` | Whole-token amounts. Every symbol must be a **shielded** registry token with a faucet contract (the stagenet registry has four). |
| `DEMO_TOKENS_DAILY_CAP` | `100` | Claims admitted in any rolling 24 hours, across all keys. |
| `DEMO_TOKENS_PATH` | `direct` | How the pack reaches the account (below). |
| `RELAY_DATA_DIR` | `/var/lib/night-market` (compose) | Where the claims file lives. |

**Limits.** Once per Solana key, ever (whatever the account), within the daily cap, and the
relay's rate limits. The claim is admitted only for a live device of an active market account: the
claim names the device's current use counter (the page reads it from the chain), and the relay checks
the one device entry at that counter. A claim is reserved before it is queued (that is the day's
charge, kept whatever happens next), each token is recorded as it lands, and the claim is confirmed
with its transaction ids when every token landed. When a delivery fails part-way, the claim stays as
**partial**: the same key may claim again, to the same account, and gets only the tokens still
missing, with no second daily charge. After `DEMO_TOKENS_MAX_ATTEMPTS` (3) failed deliveries the key
is refused (`attempts-exhausted`). Only a claim refused before its job ran (a full queue) is undone.

**A token is never minted twice** (audit round 2 R2-7, questions Q39). Before a token's transaction is
submitted, the claim records it as **pending** in the claims file, with the 192-byte inbox entry the
transaction files into the account and the time after which it can no longer land (`direct`: its
TTL, one hour; `via-sponsor`: `DEMO_TOKENS_PENDING_SETTLE_SECONDS`, 4 h). When the claim is resumed
(after a failure, a lost response, or a relay that stopped mid-job), every pending token is first
looked up in the account's on-chain inbox: there → delivered; not there and past its time (plus five
minutes) → minted again; not there yet but it could still land → the claim stops with
`demo-tokens-settling` (not counted as a failed delivery; try later) and nothing is minted. A pending
token with nothing to look for (a `via-sponsor` mint to the sponsor wallet cut off before the wallet
saw the coin) is **quarantined**: the relay never mints it again, the claim completes with the rest,
and the job's result lists it as `held`. An operator decides: check the sponsor wallet for a coin of
that colour and deposit it to the account by hand, or remove the token from the record's
`quarantined` (with the relay stopped) to let the key claim it again. The log says `a demo token was
held back (quarantined)`.

**`via-sponsor` keeps its two stages apart** (audit round 3 R3-8). Once the sponsor wallet holds the
minted coin, the claim records the mint as **minted** (with its transaction id), before the deposit is
built; the deposit is then pending with its own entry and keeps the mint's id. A resumed claim after
a confirmed mint **deposits only**, from the sponsor's balance of that token, and never mints again:
also when the deposit could no longer land. When the sponsor no longer holds enough of the token to
deposit, the state is unclear and the token is **quarantined** (`its deposit could not be resumed`).
`direct` has one transaction per token and is unchanged.

**The claims store** is `<RELAY_DATA_DIR>/demo-token-claims.json`, rewritten atomically on every
change, next to a lock file that keeps a second relay off it: **one relay per data dir**. The lock
names its holder's pid, host name and a random token, and the live relay touches it every 30 s
(audit round 2 R2-9, questions Q41). A lock is taken over when it is older than two minutes, or when
it was written on the same host by a process that is gone or by this very process number with
another token (a restarted container); a fresh lock of another host (a second container on the same
volume, even as pid 1) means "in use by another relay". A relay whose lock was taken over stops
writing claims at once (`503 store-unavailable`, and the log says so). A container recreated after a
crash may wait up to two minutes for its old lock to go stale. A data dir the relay cannot write is
reported as that (section 3, "The relay's user"). It holds public values only (the Solana key, the account, times, transaction ids, the
tokens delivered so far). Back it up with the deployment; losing it lets every key claim once more.
To let one key claim again, stop the relay, remove that key's record from the file, and start it.
The relay reads the file only after it holds the lock, so a second relay refused the lock never
touches it. Every change is written to the file before the relay acts on it; if the file cannot be
written, the claim is refused (`503 store-unavailable`) and the log says why. A reservation found at
start (the relay stopped mid-job) is kept as a partial claim (charged, resumable), with a warning in
the log.

**The two paths.** `direct` (the default): each token is ONE transaction, the faucet's `mint` to the
account's contract address composed with the account's `deposit_shielded` that receives it, as two
calls of one intent (no issuer-call claim is needed). `via-sponsor`: the faucet mints to the sponsor
wallet, which then deposits a coin of that colour into the account (two transactions per token; the
way any third party funds an account). Both passed on a ledger-9 localnet on 2026-09-30 (a
two-token pack: `direct` 2 transactions in 36 s, `via-sponsor` 4 in 82 s). If stagenet ever refuses
the composed transaction, set `DEMO_TOKENS_PATH=via-sponsor`: no code change. Either way the account's
inbox gets an entry sealed to its own key, so its owner finds the coins. Before a faucet's first
use the relay checks that its on-chain `mint` verifier key is the key volume's.

## 8. Health monitoring

`GET /health` on the relay. From the host: `curl -s http://127.0.0.1:18080/health`; through the
site at `/relay/health`. Probes are cached for `HEALTH_CACHE_SECONDS` (15 s), one refresh at a time;
the key volume is re-scanned hourly; the route is rate-limited per client (60 a minute).

The HTTP status is 200 for `ok` and `degraded`, and 503 for `down`. Docker marks the relay
unhealthy only when `/health` answers 503.

| Field | Meaning | What to do |
|---|---|---|
| `status` | `ok`; `degraded` (something needs attention; the market works for what it can); `down` (a proof server unreachable, the sponsor wallet in error, or a key set other than the pinned one). | Alert on `down` at once; on `degraded` for more than 10 minutes. |
| `sponsor.state`, `synced` | The wallet's state; spending needs `synced`. | `syncing` for a few minutes after a start is normal. `error`: restart the relay, check the node and indexer. |
| `sponsor.dustSpecks`, `dustLow` | DUST in specks (10^15 per DUST): the settled balance, see below. Below the low level, `dustLow` is `true` and new actions are refused. | Section 4. |
| `sponsor.dustInFlightSpecks` | The part of `dustSpecks` held by the sponsor's transactions in flight: `"0"` when idle. | Nothing: it returns to `"0"` when the transactions land. If it stays above 0 for more than an hour while every lane is idle, a transaction never landed (for example one the node refused, section 18.6); the lock ends after the ledger's 3-hour grace period. |
| `clientProving.mode` | Present only with `CLIENT_PROVING=required` (section 18): `"required"`. | Absent means `off`. |
| `proofServer.reachable`, `version` | The CONTRACT prover: must be `9.0.0-rc.8` (`CONTRACT_PROOF_SERVER_EXPECTED_VERSION`). | Unreachable: `docker compose logs proof-server-contracts` (an out-of-memory kill shows as a restart). |
| `dustProofServer.reachable`, `version` | The DUST prover: must be `9.0.0-rc.6`. | As above for `proof-server-dust`. |
| `proofServer.keys.fingerprint`, `pinned`, `matchesPin`, `complete`, `problems` | The key set's identity (the account and faucet keys only; not the bridge bundle) and completeness. | Always pinned and complete on a running relay (it refuses to start otherwise). |
| `queue.lanes.prover` | Proofs running (at most 1) and waiting. | A `waiting` above 5 for long: customers wait minutes (section 9). |
| `kernel.reachable`, `synced` | The ZSwap kernel. | `false`: offers cannot be made or taken; tell the kernel operator. |
| `batcher.reachable`, `lastRefusal` | The batcher, and its last refusal of a take (429 = its daily cap). | Section 13.2. |

**How `sponsor.dustSpecks` is counted** (issue 00049):
- When the wallet pays a fee, the ledger locks the **whole** DUST output it spends until the
  transaction lands. The wallet's own balance does not count a locked output, so a 9,700-DUST output
  paying a 12-DUST fee would read as 9,700 DUST gone for about a minute.
- The relay counts each locked output at its value minus that transaction's fee, which is the change
  it will get back. The reported balance therefore stays level through a transaction, and drops by
  exactly the fee.
- In the first seconds of a transaction, before the fee is known, a locked output counts in full.
- A lock ends when the change arrives, when the spend is dropped, or after the ledger's grace period
  (3 hours).
- The log line `sponsor DUST outputs locked by transactions in flight` records each lock and each
  release, with the amounts.

To measure what a run spent, compare two readings with `dustInFlightSpecks` at `"0"`, or add up the
indexer's `paidFees` (section 4.3).

The key set's fields are under `proofServer.keys`, not at the top level. The token list's digest is
not in `/health`: it is `tokensDigest` in `GET /v1/config` (section 17.1).

`GET /v1/demo-tokens` shows the pack, `remainingToday`, and (with `?owner=<key>`) whether a key
has claimed, and whether it may finish a pack that failed part-way (`resumable`).

Also watch `docker compose ps` (`relay` and `web` `(healthy)`; the proof servers have no Docker
health check) and `docker compose logs -f relay` (JSON lines; secrets are redacted by key and by
value; request bodies are never logged).

## 9. Capacity and limits

| Limit | Value | Effect |
|---|---|---|
| Proofs | one at a time, market-wide: **takes first, then makes, then the rest**; within each, the least recent users first, in turns per account | Every signed action proves on the one prover lane; others queue, and the page shows the position. Since AA 00047 P11.F (audit round 4 R4-1, questions Q59) the lane serves the jobs that carry a signed deadline first: takes, then makes; then withdrawals, change filings, cancels, key restores, registrations and demo tokens. A lower rank with work waiting still gets a turn after `PROVER_PRIORITY_BURST` (4) grants in a row to higher ranks. Within a rank the account with the fewest lane jobs in the last `PROVER_USAGE_WINDOW_SECONDS` (3,600) goes first, and a job is passed by each other account of its rank at most once (so it waits behind at most one job of each other account with work waiting, as with round-robin). Each account has at most `JOBS_PER_ACCOUNT` (1) job queued or running (`429 account-busy`, Retry-After 30). **A take or a make that the queue would only reach after its signed expiry leaves too little time (60 s) is refused at once**, before any proof or DUST (`503 prover-busy`, Retry-After): the relay runs the lane's order over the waiting jobs with each action's average hold (`PROVER_JOB_ESTIMATE_SECONDS`, 60, until measured), never less than `PROVER_JOB_ESTIMATE_FLOOR_SECONDS` (45: a stagenet take or withdrawal holds the lane about 44–45 s; audit round 4b R4b-3, questions Q64), so a few very short holds (a take refused before its proof) cannot make a crowd of takes look short. On a faster prover, lower the floor to its measured take hold. A make holds the prover only while it proves: it waits for the exchange to list it (up to 90 s) on its own account's lane. A demo-token pack holds the prover for all its tokens (about 20 s per token on `direct`, 40 s on `via-sponsor`, measured locally). |
| Batcher | 1,000 requests per 24 hours per IP per target, and 1,000 for all clients together | Every take the relay settles is one request, so at most 1,000 takes a day. The "all clients" allowance is shared with everyone who calls the staging batcher, not only this relay: once anyone uses it up, takes pause market-wide until it resets (a known limitation, audit round 4b R4b-4; recorded for the batcher's owner). |
| Kernel | 600 requests per minute per IP | Browsers read prices directly; the relay posts offers. |
| Relay, per client address | reads 240/min, `/health` 60/min, nonces 30/min, actions 10/min; actions per Solana key 5/min | `RATE_LIMIT_*`. A client address is an IPv4 address (`CLIENT_IPV4_PREFIX` 32) or an IPv6 address's **/64** (`CLIENT_IPV6_PREFIX` 64): one customer line usually owns a whole /64, so every per-client cap (these, the nonces, the registration caps) counts it once. |
| Nonces | stateless (nothing stored when issued); used ones remembered until they expire, at most `AUTH_MAX_USED_NONCES` (200,000, about 30 MB) | Section 6. Past the bound the oldest used nonce is forgotten (never a refusal); questions Q40. |
| Opening accounts | 100 a day in all (`REGISTER_DAILY_CAP`), 3 a day per client address (`REGISTER_PER_CLIENT_DAILY_CAP`), 1 queued or running at once (`REGISTER_MAX_IN_FLIGHT`) | Rolling 24 hours, counted when admitted (a failed registration still spent its proofs). Past a cap: `429 registration-daily-cap` / `registration-client-cap`; while one is in flight: `503 registration-busy`, Retry-After 60. See the numbers below. |
| Failed jobs | 5 per Solana key and 5 per account a day (`FAILURE_BUDGET_PER_OWNER_PER_DAY`, `FAILURE_BUDGET_PER_ACCOUNT_PER_DAY`) | A job that fails after it started proving FOR A REASON THE REQUESTER CAUSED counts (a circuit refusal, the node refusing the transaction). Not counted: the market's own failures (no keys, the exchange unreachable or at its cap), a counterparty's (a take of an offer its maker cancelled or let expire: `exchange-error`, `take-refused`, `take-*`, `offer-gone`) and the infrastructure's (the proof server, the node or the indexer failed: the customer sees `market-unavailable`). Past the budget: `429 failure-budget` until the oldest failure is a day old. It is checked at admission, when the job reaches its lane and when it first reaches the prover; a job refused there proves nothing and gives back what its request claimed. **Withdrawals, unshielded withdrawals, cancels and key restores are never refused by it.** Questions Q38. |
| Per account | 1 job queued or running (`JOBS_PER_ACCOUNT`); 3 offers that may still settle (`OFFERS_MAX_OPEN_PER_ACCOUNT`); 20 makes (`MAKES_PER_ACCOUNT_PER_DAY`), 5 cancels (`CANCELS_PER_ACCOUNT_PER_DAY`) and 3 key restores (`RESTORES_PER_ACCOUNT_PER_DAY`) in any rolling 24 hours | `429 account-busy`, `open-offers-cap`, `makes-daily-cap`, `cancels-daily-cap`, `restores-daily-cap`, with Retry-After. An offer stops counting at its signed expiry, when the account's nonce moves past it (a cancel, a withdrawal), when its job fails, or when the exchange says it was taken or ended. A daily charge is given back when the job failed before proving or not by the requester. See the numbers below; questions Q37. |
| Withdrawals per account (owner decision Q46 A at 100; audit round 3 R3-2) | 100 sponsored withdrawals in any rolling 24 hours (`WITHDRAWS_DAILY_CAP`), shielded and unshielded together; past it, **one whole-coin withdrawal per listed token** in any rolling 24 hours | `429 withdraws-daily-cap`, Retry-After, `detail` `whole-coin-exit` (this token's exit is still open: a shielded withdrawal of a whole coin, `amount` = the coin's value, no change; or any unshielded withdrawal of the token, which never makes change) or `whole-coin-exit-used` (used in the last 24 hours, or the market does not list the token). The page says nothing about the allowance until it sees this code (Q46). Charges are given back like the other caps. See the numbers below; questions Q49. |
| Unsettled takes per account (audit round 3 R3-7) | 10 takes in any rolling 24 hours (`TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY`) that were proven and then refused for a reason the relay could not pin on the taker (the maker's or the exchange's, or the taker's own offer taken at the same moment: `take-raced`) | `429 takes-unsettled-cap`, Retry-After; only takes wait, never charged to the failure budget. Before proving, a make's, take's or shielded withdrawal's coin is checked unspent on chain (`coin-spent`, nothing proven); when the account's history cannot be read, a trade waits (`chain-unavailable`, not charged) but a **withdrawal goes ahead unchecked** (the ledger refuses a double spend anyway; audit round 4 R4-5). A take that asks to be paid a coin its account **already received** can never settle (the ledger never inserts the same coin twice): it is refused before its proof (`want-reused`, audit round 4b R4b-1, questions Q63) and, unlike the other refusals before a proof, **charged** to the failure budget (no honest page sends one). A refused take is **reconciled against the chain** (audit round 4 R4-2, questions Q60): its own settlement there (since round 4b: a transaction after the job's pre-proof read that spends the take's coin AND pays its wanted coin) → it succeeded after all; its coin spent, or its nonce moved, by another swap of the account (its own offer taken meanwhile) → `take-raced`, not charged; by a withdrawal, a cancel or a key change of the account → `coin-spent` / `stale-authorisation`, the taker's, charged; nothing that explains it yet → never the taker's. Each unsettled take costs a proof and one of the batcher's 1,000 settlements a day. |
| The exchange's 429 (audit round 4 R4-3) | after the settlement service answers HTTP 429, no take is proven for `BATCHER_BUSY_COOLDOWN_SECONDS` (300), or for the service's own Retry-After when longer (at most a day) | `503 exchange-busy`, Retry-After, at admission and when a queued take starts, before any proof; never charged. At most one proof per pause is spent against the exchange's cap, market-wide (questions Q61). |
| Offer and take expiry | a make at most 3,600 s ahead, a take 600 s, at least 60 s left | Section 6. |
| Demo tokens | once per key; `DEMO_TOKENS_DAILY_CAP` a day; 3 failed deliveries | Section 7. |
| Change re-filing (`append-inbox`) | only against the relay's single-use entitlement for that change, at most `APPEND_INBOX_MAX_PER_ACCOUNT_PER_DAY` (20) a day per account | The entitlement key derives from the sponsor seed: a new sponsor seed voids entitlements already issued. |
| Jobs | kept `JOB_TTL_SECONDS` (24 h), at most `JOB_MAX` (10,000), in memory | A relay restart forgets running jobs. |

**Why these registration numbers** (audit C4). One registration deploys two waves and activates the
device: it held the prover lane about 60 s on stagenet and cost the sponsor about 41 DUST at the
default margin 20 (about 21 at margin 5: plan P6 measured 22 DUST at margin 5 for an account plus
its demo pack, the pack about 1 DUST; section 4.3). Without caps one client opening accounts with
fresh Solana keys (they cost nothing) could stall every customer's action and drain the sponsor in
under two days. With the defaults:

- at most 100 accounts a day: about 4,100 DUST (2,100 at margin 5) and 100 minutes of prover time
  a day, at worst;
- one client address opens at most 3 a day, so reaching the global cap takes 34 addresses;
- registrations never queue behind each other: any other action waits behind at most one (about a
  minute);
- a key or account whose calls keep failing at proving time is stopped after 5 failures a day.

Size the sponsor for the global cap: `REGISTER_DAILY_CAP` × 41 DUST a day at margin 20, plus the
actions (the whole market's worst case is at the end of this section). The counters live in
memory: a relay restart resets them.

**Why these per-account numbers** (audit round 2 R2-1, questions Q37). One registered account used to
be able to hold the prover lane: a make held it for its proof and the exchange's listing wait (about
54 s on stagenet), makes were unlimited, and a cancel is a free, sponsor-paid transaction. Auditor A's
probe: five makes of one account queued ahead of a customer's withdrawal, which waited about 314 s.
With the defaults:

- a customer's job waits behind at most one job of each other account with work waiting (one job per
  account, turns per account); the probe's withdrawal waits behind at most one of the looping
  account's jobs (`relay/test/fairness.test.ts`);
- a make no longer holds the prover while the exchange lists it, which roughly doubles the lane's
  throughput on its own;
- one account lists at most 3 offers at once (the page keeps one live offer: room for a taken offer
  the exchange has not reported yet) and makes at most 20 a day (about 18 minutes of prover time);
- the sponsor pays for at most 5 cancels and 3 key restores per account a day. Accounts accumulate
  (at most 100 new ones a day, 3 per client address), so the worst case is (accounts) × 8 small
  transactions a day: watch the sponsor's DUST (section 4.5) and lower the caps if a pattern shows.

**Why the prover lane serves takes first** (audit round 4 R4-1: F-A4-1, MAJOR for a public site;
questions Q59). A take must start with 60 s of its signed expiry left, and round-robin turns put it
behind one job of every other account with work waiting: auditor A's probe showed six accounts, each
with one 44 s withdrawal queued (well under every per-account cap; accounts are free to open), made
every customer's take expire before it started, so no trade could settle. With the defaults (the
probe adapted to the new lane, `evidence/00047-mn-bank-solana/p11f/probe/`):

- a take is signed for 600 s (it was 300 s: `TAKE_LIFETIME_SECONDS`, the relay's maximum) and goes
  ahead of every withdrawal: behind 10 or 20 accounts' queued withdrawals it starts after about 43 s,
  the withdrawal that held the prover (before: 440 s and 880 s, expired); every withdrawal is still
  served;
- a customer's withdrawal goes ahead of accounts that keep the lane busy: with 10 or 20 accounts
  looping withdrawals for a while, it starts after about one job (44 s; before: up to 10 or 20 jobs);
- a flood of makes (deadline-bound) never starves withdrawals: one gets a turn after 4 makes (the
  probe: about 80 s);
- a signed deadline never jumps the queue on its own (a requester chooses it): recent use decides
  first within a rank;
- a take the queue cannot reach in time is refused at once (`prover-busy`) instead of expiring.

**Why the withdrawal numbers, and the sponsor's worst case per day** (audit round 3 R3-2: F-B3-1
MAJOR, F-A3-4; owner decision Q46 A at 100; questions Q49). A withdrawal is the one sponsor-paid action
a customer must always be able to repeat, so it had no cap: one account could withdraw 1 base unit to
itself, reuse the change, and repeat (auditor A's probe: 30 of 30 admitted), each time on the
sponsor's DUST, until `sponsor-low` stopped the site for everyone. Now, per account and per rolling 24
hours, the sponsor pays at most (stagenet fees of section 4.3; the unshielded withdrawal's fee is not
measured on stagenet and is taken as the shielded one's):

| What the sponsor pays for, per account per day | Count | DUST at margin 20 (default) | DUST at margin 5 |
|---|---|---|---|
| Withdrawals (`WITHDRAWS_DAILY_CAP`) | 100 | 100 × 0.83 = 83 | 100 × 0.42 = 42 |
| Change re-filings (`APPEND_INBOX_MAX_PER_ACCOUNT_PER_DAY`, one per withdrawal with change) | 20 | 20 × 1.5 = 30 | 20 × 0.75 = 15 |
| Whole-coin exits past the allowance (one per listed token; 6 on stagenet) | 6 | 6 × 0.83 ≈ 5 | 6 × 0.42 ≈ 2.5 |
| Cancels and key restores (above) | 5 + 3 | ≈ 8 × 0.83 ≈ 7 | ≈ 8 × 0.42 ≈ 3.5 |
| **One account's worst case a day** | | **≈ 125 DUST** | **≈ 63 DUST** |

Makes and takes cost the sponsor nothing (the batcher pays a settlement); demo tokens are once per
key (section 7). One account can therefore use at most about 125 DUST a day, about a sixth of what
1,000 registered NIGHT generates (714 DUST a day, section 4.3). Several accounts are bounded by the
registration caps (100 new accounts a day, each costing the sponsor about 41 DUST to open at margin
20) and, market-wide, by the one prover lane: a withdrawal holds it about 40–45 s, so the lane can run
at most about 2,000 sponsored transactions a day, about 1,700 DUST at margin 20 if they are all
withdrawals (with the registrations, the demo packs and the change re-filings, the whole market's
worst case is below). Size the sponsor for the traffic you expect, watch `sponsor.dustSpecks`
(section 8), and lower `WITHDRAWS_DAILY_CAP` if a pattern shows; the page explains the allowance only
once a customer reaches it. An honest customer withdraws a handful of times a day; past the allowance, one whole
coin of each listed token still leaves every day, so funds never get stuck.

**The whole market's worst case per day** (at margin 20, from the fees of section 4.3). Many
accounts, each within its own caps, are bounded by the market-wide caps and the one prover lane:

- registrations: at most `REGISTER_DAILY_CAP` (100) × about 41 DUST = about 4,100 DUST, using about
  100 minutes of the lane;
- demo-token packs: at most `DEMO_TOKENS_DAILY_CAP` (100) × 3 tokens × about 1.3 DUST = about 400
  DUST, using about 100 minutes of the lane;
- the rest of the lane's day (about 21 hours at 40–45 s per sponsored transaction, about 1,750
  transactions): withdrawals at 0.83 DUST and their change re-filings at 1.5 DUST, up to about
  2,000 DUST.

So up to about **6,500 DUST a day**, which about 9,000 NIGHT registered for DUST sustains (0.714 DUST
per NIGHT a day); about half at margin 5. `REGISTER_DAILY_CAP` is the main lever: each new account a
day is about 41 DUST.

## 10. What customers must know

- **Phantom approves every action, and shows what it approves.** The message is readable: the
  operation, the amounts, the recipient's fingerprint, the account and its nonce. Hardware
  (Ledger) accounts in Phantom are not supported yet.
- **Your data lives only in your browser.** The market keeps no copy: your account's encryption
  secret, your coins and your offers are in this browser's storage. Export after every change;
  clearing the browser without an export loses the ability to find your coins (the account and its
  coins stay on Midnight, but only the secret can read them).
- **One live offer at a time**, and **one coin per payment**.
- **A withdrawal that leaves change** asks for a second approval, to record the change in your
  account. The page computes the change itself; a market that reports another one is named.
- **Your browser checks your account on Midnight itself** (section 16): an account that is not this
  market's own, or that has any device besides your wallet, is refused, and nothing is signed for it.
- **Offers expire, and cannot be cancelled** (AA 00060 FR-028): an offer can be taken for one hour
  after you approve it (a take for ten minutes), whoever holds the approval. Any other approval of
  the account (a take, a withdrawal, a Bridge out, saving a change, restoring the key) ends it
  sooner; the page asks first. A future Offer Files feature will provide cancellation for every
  client.
- **Bridging** (when configured, section 17): Bridge in is one Solana transaction; Bridge out asks
  for the landing-key text twice in a fresh tab, then one withdrawal approval, plus one more to save
  the change when only part of a coin goes out. The landing-key signature is a key: sign it only on
  this site.
- **Demo tokens**: once per wallet. These are test networks and test tokens.
- **There is no About page** (AA 00060 FR-029): the site does not list the known limitations, and
  `/#about` opens Markets. The README's "Known limitations" is the list to give customers. The
  page's in-flow warnings are unchanged: the signing panels, the landing-key text, and the Bridge
  out and Show in my wallet notices.

## 11. Known limits

The README's "Known limitations" is the complete list, for customers and operators; this section
adds the operator's side.

- One live offer per account; one coin per payment, with no merging of coins.
- All customer data in the browser, with Export and Import as the only backup.
- The relay's jobs live in memory: a relay restart forgets running jobs (restart when `/health`
  `queue.lanes` shows nothing running or waiting).
- Proofs one at a time (section 9).
- An account's history is read in full (audit round 3 R3-5): past the indexer's 500-action page the
  relay reads the rest through the indexer's `contractActions` subscription, so the relay needs
  `MIDNIGHT_INDEXER_WS_URL` (the network profile's default on stagenet) and a WebSocket path to the
  indexer. Only an account past 100,000 actions answers `501 history-too-long`.
- A withdrawal's recipient encryption key is unsigned by default (section 6, F-B6; questions Q28:
  the one accepted exception to the trustless relay: a relay could hide a withdrawn coin from its
  recipient's wallet scan, not take it).
- The page reads its account from the public indexer, which of its coins exist and which are spent
  included: it decodes the account's whole history itself with ledger-v9 (section 16; questions Q47
  A). It trusts that indexer to serve the chain faithfully (it runs no light client). Without the
  indexer's WebSocket (a `connect-src` without its `wss:` origin, a proxy), an account with more than
  500 actions cannot be read in full: the page then says so and counts only the coins it could
  confirm.
- The registration caps, the per-account caps (the withdrawal allowance included) and the failure
  budget are counted in memory: a relay restart resets them (section 9).
- The withdrawal allowance is per account (questions Q49): many accounts can each use theirs; the
  registration caps and the prover lane bound the total (section 9, the sponsor's worst case).
- One request per account at a time: a second one is refused (`429 account-busy`) until the first
  finishes (section 9).
- Ledger-backed Phantom accounts are refused (they sign a wrapped message).
- **A new account the page refuses at opening stays refused** (audit R4-6; questions Q42, Q51), and
  that wallet cannot open another account on this site. A deposit by anyone in the few blocks
  between the deploy and the maintenance update that retires the setup key causes it, and so does
  an update that lands more than 100 blocks after the deploy (a relay restarted between the two):
  restart the relay only when `/health` shows nothing running.
- **`via-sponsor` demo tokens** (audit R4-7; not the default): a resumed deposit takes any coin of
  that colour from the sponsor's balance, possibly one minted for another pending claim, which is
  then quarantined (section 7). Keep `DEMO_TOKENS_PATH=direct` unless stagenet refuses it.
- **The used-nonce bound** (questions Q40): past `AUTH_MAX_USED_NONCES` the oldest used nonce is
  forgotten, so its signed envelope could be accepted again until its own expiry (at most
  `AUTH_MAX_TTL_SECONDS`, 10 minutes); every cap still applies.
- **A page that proves and pays for itself can rotate an account's encryption key** with one
  approval (audit R3-9; questions Q50): the relay lands only a restore to the opening key, but the
  circuit accepts any key, so such a page reads the sealed notes filed after it (privacy, not funds).
- **The contract prover's memory grows** (plan risk R7): 14g and the periodic restart (sections 2
  and 12.1). With bridging, a bridge-out proves two transactions; the AA 00060 owner session hit a
  12 GiB cap after several proofs. Give the container `restart: on-failure` as well.
- **Bridging** (section 17): the README's "Bridging (AA 00060)" limitations, and for the operator:
  the relay's landing entitlements live in `RELAY_DATA_DIR` (keep it with the backups), and the site
  trusts its Solana RPC (17.3).

## 12. Start, stop, upgrade and re-pin

All commands take `-f deploy/compose.yml`; add `--env-file` if your settings are not in
`deploy/.env`.

### 12.1 Everyday commands

| Task | Command |
|---|---|
| Start (or apply changed settings) | `docker compose -f deploy/compose.yml up -d` |
| Status | `docker compose -f deploy/compose.yml ps` |
| Logs | `docker compose -f deploy/compose.yml logs -f relay` (or `web`, `proof-server-contracts`, `proof-server-dust`, `keys`) |
| Restart the relay | `docker compose -f deploy/compose.yml restart relay` (the sponsor wallet re-syncs) |
| Restart the contract prover (periodically, R7) | when `/health` shows no lane running a job: `docker compose -f deploy/compose.yml restart proof-server-contracts` |
| Stop (keeps volumes) | `docker compose -f deploy/compose.yml stop` |
| Remove everything, keys and claims included | `docker compose -f deploy/compose.yml down -v` |

**Back up** the sponsor seed file and the `relay-data` volume. The key volume can be rebuilt.

**Restart the contract prover periodically** (plan risk R7: rc.8's memory grows across proofs). Do it
at a quiet hour, for example every 6 hours from cron, and only when the relay is idle (in `/health`,
every lane under `queue.lanes` has `running` 0), so no customer's proof is cut off; a cut-off proof fails its job as
`market-unavailable`, which the failure budget never charges, and the customer can try again:

```sh
# /etc/cron.d/nightmarket-prover: every 6 h, when no lane under /health queue.lanes runs a job
0 */6 * * * root cd /srv/nightmarket/app && h="$(curl -fs http://127.0.0.1:18080/health)" && ! echo "$h" | grep -q '"running":[1-9]' && docker compose -f deploy/compose.yml restart proof-server-contracts
```

The line does nothing when `/health` does not answer. `/srv/nightmarket/app` is the checkout of
section 3; a line in `/etc/cron.d` names its user (`root`, or a user in the `docker` group) and may
not contain `%`.

### 12.2 Upgrade to a new version of this repository

```sh
git fetch && git checkout <new release> && git submodule update --init
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
```

The `keys` job re-verifies. If the new version changed a key input (the Passport commit, a
compiler, the faucet source, the kept keys), it builds again first: stop the relay before, keep the
disk free (section 2), and run `up keys` attached. Rebuild and restart the web and the relay
**together** when the token list or the message format changes.

**Round 3 (AA 00047 P11): no rekey; one BREAKING change for a deployment with a
Content-Security-Policy.** The key set (`21493588…5c5e`), `vendor/passport` (`599327b`) and the web
build's pinned keys are unchanged, so existing accounts keep working. Deploy together:
- **BREAKING if you set `WEB_CONTENT_SECURITY_POLICY`**: its `connect-src` must now also name the
  indexer's **`wss://`** origin (section 16). The page reads an account's history past 500 actions
  over the indexer's WebSocket; a policy with only the `https://` origin makes such an account's
  history incomplete (the page says so and counts only what it could confirm). `script-src` keeps
  `'wasm-unsafe-eval'`.
- the new relay settings (section 9; `deploy/.env.example`): `WITHDRAWS_DAILY_CAP=100` (owner
  decision Q46) and `TAKES_UNSETTLED_PER_ACCOUNT_PER_DAY=10`; the relay also reads histories past
  500 actions over `MIDNIGHT_INDEXER_WS_URL` (the profile's by default: no change unless you moved
  the indexer);
- `CONTRACT_PROOF_SERVER_MEM_LIMIT=14g` and the periodic prover restart (section 12.1).

**Round 4 follow-up (AA 00047 P11.F): no rekey, nothing breaking.** The relay's prover lane serves
takes, then makes, then the rest (section 9), refuses a take the queue cannot reach in time
(`503 prover-busy`), pauses takes after the exchange's 429 (`503 exchange-busy`), reconciles a refused
take against the chain (`take-raced`), and lets a withdrawal through when the account's history cannot
be read; the page signs takes for 600 s (it was 300 s) and shows "Ended", not "Cancelled", while a
possible fill's transaction could not be read. Deploy the relay and the web together. The new relay
settings (section 9; `deploy/.env.example`; the defaults need no change): `PROVER_USAGE_WINDOW_SECONDS=3600`,
`PROVER_PRIORITY_BURST=4`, `PROVER_JOB_ESTIMATE_SECONDS=60`, `BATCHER_BUSY_COOLDOWN_SECONDS=300`. If you
lowered `TAKE_MAX_LIFETIME_SECONDS` below 600, raise it back: the page now signs takes for 600 s.

**Round 4b fix (AA 00047 P11.F2): no rekey, nothing breaking.** A refused take counts as settled only by
its own transaction (after the attempt, spending its coin, paying its wanted coin); a take that asks to
be paid a coin the account already received is refused before its proof (`want-reused`, charged to the
failure budget); the prover lane's hold estimate has a floor. One new relay setting (section 9;
`deploy/.env.example`; the default needs no change on stagenet): `PROVER_JOB_ESTIMATE_FLOOR_SECONDS=45`.
Deploy the relay and the web together (the page words `want-reused`).

**BREAKING: the round-2 security fix pass** (AA 00047 P10; `vendor/passport` `b2f1847` → `599327b`).
Every account message's first line is now `Site: <label>` (message format F3 v3, questions Q36), so
the six signed circuits (the five gated calls and the offer) were rekeyed: the key set is now
`21493588…5c5e` (was `efc52fbc…ef7f`), and six of the nine digests the web build pins changed (the
activation and both deposits kept theirs). Deploy together, in one step: the relay's key volume
(`up keys` with the new `RELAY_KEYS_FINGERPRINT`), the web image (its pinned account keys) and the
relay settings this release adds to `deploy/.env.example` (`JOBS_PER_ACCOUNT`,
`OFFERS_MAX_OPEN_PER_ACCOUNT`, `MAKES_PER_ACCOUNT_PER_DAY`, `CANCELS_PER_ACCOUNT_PER_DAY`,
`RESTORES_PER_ACCOUNT_PER_DAY`, `CLIENT_IPV6_PREFIX`, `CLIENT_IPV4_PREFIX`, `AUTH_MAX_USED_NONCES`,
`DEMO_TOKENS_PENDING_SETTLE_SECONDS`; section 9; `AUTH_MAX_NONCES` and `AUTH_MAX_NONCES_PER_CLIENT`
are no longer read). Accounts opened under the P9 set (`b2f1847`) cannot be used with it (the relay
and the page refuse them as "not a Night Market account"); withdraw from them with the previous
release first.

**BREAKING: the P9 security fix pass** (AA 00047 P9; `vendor/passport` `451f761` → `b2f1847`). The
message format (F3 v2), the account's circuits (no device management) and so every verifier key
changed: the key set is now `efc52fbc…ef7f` (was `a627edb1…da92`). Deploy together, in one step:
the relay's key volume (`up keys` with the new `RELAY_KEYS_FINGERPRINT`), the web image (its pinned
account keys, section 16) and the web's Content-Security-Policy (`connect-src` must name the
indexer, section 16). Accounts opened before it cannot be used with it (the relay and the page
refuse them as "not a Night Market account"); withdraw from them with the previous release first.

### 12.3 Re-pin when something upstream moves

| What moved | What to do |
|---|---|
| **acedward/passport** (the Ed25519 arm's branch) | A new `account.compact` is a new contract: existing accounts keep theirs (and the relay's FR-005 check refuses them under a new pin), so this is a new market, not an upgrade. Bump `vendor/passport`, set `KEYS_ACCOUNT_SOURCE_SHA256`, run `up keys` with `RELAY_KEYS_FINGERPRINT` empty, read the report, then pin the fingerprint it printed. |
| **mint-test-tokens** (a faucet redeployed or a token added) | Re-vendor `packages/core/src/tokens/mint-test-tokens/metadata.stagenet.json` (its `PROVENANCE.md`). A new faucet CODE also needs `contracts/faucet/` re-vendored and `KEYS_FAUCET_MINT_VK_SHA256`. |
| **The Midnight SDK set** | A new release of this repository with the whole set moved together. |
| **Stagenet moves to dust/10** | One proof server (rc.8 or later) can serve both: point `MIDNIGHT_DUST_PROOF_SERVER_URL` at it in a release that says so. |
| **The kernel or batcher URL** | `ZSWAP_KERNEL_URL` / `ZSWAP_BATCHER_URL`, then `up -d`. |

Check stagenet's node before and after any change:

```sh
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' https://rpc.stagenet.shielded.tools
# pinned: "2.0.0-d9729c13" (ledger crate-ledger-9.1.0.0-rc.3)
```

## 13. Incidents

### 13.1 Proofs fail

| Symptom | Likely cause | Action |
|---|---|---|
| `proofServer.reachable: false`, `proof-server-contracts` restarting | Out of memory during a k=18 proof (rc.8's memory grows across proofs, plan R7) | `CONTRACT_PROOF_SERVER_MEM_LIMIT` at least 14g, and restart the prover periodically (section 12.1). |
| A job fails with "unrecognised discriminant" | A contract proof went to rc.6 | Check `MIDNIGHT_CONTRACT_PROOF_SERVER_URL` (compose sets it to the rc.8 service). |
| Fees refused after a stagenet upgrade | The ledger or DUST version moved | Section 12.3. |

### 13.2 The kernel (or the batcher) is down

The site shows "exchange unavailable" and never shows stale prices; offers cannot be made or
taken; accounts, demo tokens and withdrawals still work. `/health` shows it. Tell the kernel
operator. A batcher that answers 429 means its daily cap: takes resume when the window moves. That
cap is shared by every client of the staging batcher (1,000 a day for all together), so anyone calling
it directly can use it up; the relay then pauses takes for everyone (`BATCHER_BUSY_COOLDOWN_SECONDS`, or
the batcher's Retry-After, up to a day). Nothing in the relay can prevent it: tell the batcher's owner
(audit round 4b R4b-4).

### 13.3 Other failures

| Symptom | Likely cause | Action |
|---|---|---|
| Actions refused, `sponsor.dustLow: true` | Out of DUST | Section 4.4. |
| Relay exits with code 78 | A configuration error, a key volume missing, incomplete or not the pinned one, the demo-token claims file in use by another relay, or a data dir the relay's user cannot write (`EACCES`, `EROFS`, `ENOSPC`) | Read the first error line: it names the path, the error, the relay's uid and gid, and the fix (section 3, "The relay's user"). |
| Relay exits with code 75 | The sponsor wallet could not be opened | Check the seed file. |
| Every signed action refused "the signature does not approve this call" | The page and the relay render with different token lists or labels | Section 6: one token list for both. |
| A customer's account refused "not a Night Market account" | An account not opened by this market's key set (FR-005) | Expected: the relay only acts on market accounts. |

## 14. Reference: pins and addresses

| Item | Pin |
|---|---|
| Stagenet node / ledger | `2.0.0-d9729c13` / `crate-ledger-9.1.0.0-rc.3` |
| Contract prover | `midnightntwrk/proof-server:9.0.0-rc.8@sha256:2666c7bd7b4517f8ad135565387f98d14347a9ac715c6c466d4a8a852b545ecf` |
| DUST prover | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b` |
| Data-volume init | `busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e` |
| Compact compilers | compactc 0.35.0 (`0.35.0 (debb05f94 2026-09-29)`, the account, `--feature-zkir-v3`) and 0.34.0 (the account's callees and the faucet); archive SHA-256s in `scripts/fetch-compactc.sh` |
| Passport sources | `vendor/passport` = acedward/passport @ `599327b918b55afc95d6c98a89bcd15f4e8b0d53` (branch `00047-solana-ed25519-arm`); `account.compact` SHA-256 `03bbd3d8ad978d6c49a573ad84d27325be95115b81a1b2d4ab829f2ecb50e6fe` |
| Key set fingerprint | `21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e` (account 40 + faucet 5 verifier keys; the web build pins the same set; the bridge bundle is not part of it) |
| Faucet | mint-test-tokens v2 `shielded-token.compact` @ `a51cf3a` (SHA-256 `1dca131a…89bd`); `mint` verifier key SHA-256 `4bbbb047b2f10bc57e4fafd9537b2dcac9290d9a2f7560a9e670f96a8452794a` |
| SDK set | `@midnightntwrk/ledger-v9` 1.0.0-rc.3, midnight-js 5.0.0-beta.7, compact-js 2.5.5-rc.8, wallet-sdk-facade 5.0.0-beta.2, compact-runtime 0.19.0 (the SDK) and 0.20.0 (the account module only) |
| Tokens (stagenet, mint-test-tokens registry @ `a51cf3a`) | shielded twUSDC (6) faucet `11e406f1…`, twUSDM (6) `6f6dacef…`, twBTC (8) `a112d24a…`, twETH (18) `a9ea4f52…`; unshielded utwUSDC (6) `473e8354…`, utwBTC (8) `2e962ef4…` (`packages/core/src/tokens/mint-test-tokens/`) |
| Default pairs | twBTC/twUSDC, twETH/twUSDC, twUSDM/twUSDC, twETH/twBTC |
| Endpoints | node `https://rpc.stagenet.shielded.tools`; indexer `https://indexer.stagenet.shielded.tools/api/v4/graphql`; kernel `https://stagenet.api-zswap.zkdojo.com`; batcher `https://stagenet.batcher-zswap.zkdojo.com` (target `midnight-balancer`) |

For development and tests, `deploy/compose.dev.yml` runs the relay alone against a local stack,
and `test/stack/b3/` runs the relay's own flows on a ledger-9 localnet (`run-local.sh`).

## 15. Several domains: one build, one relay

One web image and one relay can serve several domains, each with its own asset set and markets:
the web container writes `config.json` from `WEB_ASSETS` (comma-separated symbols, or `all`) and
`WEB_PAIRS` (`BASE/QUOTE`, comma-separated). A second web service on the same image, in front of
the same relay, as a Compose override:

```yaml
services:
  web-eth:
    extends:
      file: compose.yml
      service: web
    environment:
      WEB_ASSETS: twETH,twBTC
      WEB_PAIRS: twETH/twBTC
    ports: !override
      - ${WEB_BIND_ADDRESS:-127.0.0.1}:${WEB_ETH_HOST_PORT:-18082}:8080
```

Give each domain its own TLS site in your proxy. https is required on every domain. The relay
needs no setting per domain: it knows every registry token.

## 16. The browser reads the chain itself; the Content-Security-Policy

The relay is trustless (AA 00047 questions Q26): it relays signatures, proves and pays, but what the
page believes about an account it reads from Midnight's **public indexer**, straight from the
browser:

- **Before any deposit, trade, withdrawal or sealed note**, the page reads the account's contract
  state and refuses it unless it carries exactly the market's circuits with the verifier keys pinned
  in the web build (`packages/core/src/passport/pinned-account-keys.ts`, written by
  `bun scripts/pin-account-keys.ts <key volume>` from the same key set as `RELAY_KEYS_FINGERPRINT`),
  its maintenance authority is retired, it has ONE device and that device is the connected wallet,
  its encryption key is the one the browser holds, and its network salt is this network's. A new
  account is checked as soon as the relay reports it open (at its first entry, nothing signed yet).
- **The auth nonce, the device counter, the inbox and the public (unshielded) balances** every
  signature and every balance rests on come from the same read, not from the relay.
- **Which coins exist and which are spent** the page decodes ITSELF (AA 00047 P11.B, questions Q47 A,
  which supersedes Q31): it reads the account's complete history from the indexer (the newest 500
  actions over HTTP, anything older through the indexer's `contractActions` subscription over its
  WebSocket) and decodes every transaction's ledger events with ledger-v9's own WebAssembly
  (`@midnightntwrk/ledger-v9` 1.0.0-rc.3). A coin counts only when a decoded leaf carries its full
  commitment; a withdrawal's pending change is dropped only on positive evidence; an offer is
  "Filled" only by its decoded swap transaction. The relay's Zswap report is no longer read.

**What the page still takes from others** (AA 00047 P11.B, plan P11.B (3)):
- **From the relay: nothing about coins.** The relay's `GET /v1/accounts/:a/zswap` is not read by the
  page (it stays for other clients). What the relay can still do is unchanged: refuse or delay a
  request (liveness), choose the recipient encryption key of a withdrawal (questions Q28, the one
  accepted exception: it can hide a withdrawn coin from its recipient's wallet scan, not take it), and
  issue the change's inbox entitlement. Its job results (a transaction id, "succeeded", "failed") end
  nothing: the page decides from the chain.
- **From the public indexer: the chain itself.** The page checks what it can: every event names its
  own transaction, a leaf must lie in its transaction's range of the Zswap tree, and a transaction's
  raw bytes must hash (ledger-v9's own `transactionHash`) to the one asked for. It does not verify the
  indexer against block headers. A wrong position would only make a proof fail: the circuit checks
  the Merkle path.
- **Completeness**: the page concludes from what is ABSENT (a spend that never happened, a fill that
  never came) only when its read of the history is complete through the height the account's state
  was read at; otherwise it waits ("Ended" for an approval it cannot place yet).

**ledger-v9 in the page, loaded lazily** (measured on the production build, `vite build`, 2026-10-02):
the decoder is its own chunk, `assets/ledger-decode-<hash>.js` (173 KB, 27 KB gzipped), with
`assets/midnight_ledger_wasm_v9_bg-<hash>.wasm` (10.3 MB, 4.7 MB gzipped; nginx gzips
`application/wasm` and caches `/assets/` for 30 days). Only the Portfolio and Trade pages fetch them,
on their first walk of the account; the Markets page never does (`test/e2e/zswap-decode.spec.ts`).
The main bundle is unchanged in kind (1.27 MB, 285 KB gzipped, with the contract runtime's 1.4 MB
WebAssembly). A visitor who opens the Portfolio downloads about 5 MB more, once.

**Re-pin the web build with the key set.** When the relay's key set changes (a new `vendor/passport`
pin), regenerate the pinned digests from the new key volume and rebuild the web image, or the page
refuses every new account (`relay/test/pinned-account-keys.test.ts` fails while the pinned circuits
differ from the market shape).

**Which indexer.** The site's network profile (`indexer.stagenet.shielded.tools` on stagenet). A
deployment can point it elsewhere with a mounted `config.json`:
`{"network": "stagenet", "relayUrl": "/relay", "overrides": {"midnight": {"indexerUrl": "https://…/api/v4/graphql"}}}`.
The stagenet indexer answers any origin (CORS `*`).

**The Content-Security-Policy** (`WEB_CONTENT_SECURITY_POLICY`). Its `connect-src` must name the
indexer, or the page cannot check any account (it then says so and signs nothing), AND, since AA 00047
P11.B, the indexer's WebSocket endpoint (`wss://…`): a browser does not let an `https://` source
cover a `wss://` connection (checked in Chromium), and without it an account with more than 500
actions cannot be read in full (the page then says "could not read your account's whole history" and
counts only what it could confirm). AA 00062 (spec FR-013, owner Q2 "any URL is OK"): it also allows
the customer's own proof server, `http://localhost:*` and `http://127.0.0.1:*` (the package on their
computer) and `https:` (an online proof server at any https URL); only the page calls it, never the
relay. The value below is tested (`test/e2e/chain.spec.ts`, `test/e2e/zswap-decode.spec.ts` and
`test/e2e/prover.spec.ts`, with the tests' own origins in place of these; `web/test/csp-docs.test.ts`
checks that this file, `.env.example` and `SYSTEMD.md` carry the same value):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://indexer.stagenet.shielded.tools wss://indexer.stagenet.shielded.tools https://stagenet.api-zswap.zkdojo.com http://localhost:* http://127.0.0.1:* https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
```

`'wasm-unsafe-eval'` is for WebAssembly: the contract runtime's (the arm's message builder and the
account decoder) and ledger-v9's (the history decoder, AA 00047 P11.B; no new directive was needed
for it). `https:` lets the page reach any https origin (the indexer's and the kernel's among them, still
listed), but not a `wss:` one: the indexer's WebSocket stays listed. A policy without the three proof-server
sources still works for every action the market proves itself; only the customer's own proof server is
then refused (the page says the site's security policy blocks it). The relay is the same-origin `/relay` here; a relay on another origin (`WEB_RELAY_URL`) and an
indexer set in `config.json` must be added to `connect-src` (the indexer with both its `https:` and
its `wss:` endpoint; a `config.json` that moves only `indexerUrl` gets the WebSocket at the same host
and path plus `/ws`).

## 17. Bridging and the Solana side (AA 00060)

Optional. Without a journey registry the market runs exactly as before. With one, customers can:
- **Bridge in** an SPL token from Solana (one Solana transaction, a lock in that token's bridge);
- **Bridge out** to Solana (a landing key derived from the wallet's signature, then two Midnight
  transactions the market proves and pays for);
- use **Show in my wallet** (the account's Midnight tokens in Nightly, through an RPC injector);
- use **Mint Solana tokens** (a test faucet for the bridged SPL tokens).

What follows states what each part needs. A packaged deployment is a later step (the owner,
2026-10-05: "we will start working on the deployment once all is working 100% locally"); the local
stacks in `test/stack/p6` and the AA 00060 / 00057 harnesses run all of it today.

### 17.1 The journey registry, and the generator

One file, the **journey registry** (I-1, `journey-tokens.<network>.json`, made by the 00057
journey's tooling), lists every bridged token: its Midnight colour, SPL mint, bridge program, bridge
contract, bridge API, name, symbol (1–8 printable characters, no space) and decimals. The site and
the relay must agree on the token lists, so generate both from it with:

```sh
bun scripts/bridge-tokens.ts journey-tokens.json \
  --site-config web/public/config.json --relay-tokens tokens.json \
  --pairs X/Y --solana-rpc https://api.devnet.solana.com
```

It writes the site's `tokens`, `pairs` and `bridges` into the site's `config.json`, and the relay's
token list (`TOKENS_FILE`). With `--solana-rpc` it also checks each mint on that RPC (a classic SPL
Token mint with the registry's decimals) and the RPC's genesis hash. It prints the lists' digest,
which `GET /v1/config` reports as `tokensDigest`. Exit codes: 0 written, 65 refused (the reason is
named), 64 usage. `--icons none` leaves the icons out; by default the bundled set
(`scripts/token-icons.json`) is used.

### 17.2 The site

`config.json` (README, Configuration):
- `solana`: the site's Solana RPC and cluster. The page refuses to bridge when its genesis hash
  differs from the registry's.
- `bridges`: the generated registry.
- `injector`: Show in my wallet's RPC injector, if offered.

The Content-Security-Policy's `connect-src` must also name:
- the Solana RPC's origin;
- each bridge API's origin (the page reads `GET /transfers/:id` and, before every Bridge in,
  `GET /deployment`: a bridge that does not answer gets no lock);
- the injector's origin.

### 17.3 The relay

- `BRIDGE_REGISTRY_FILE`: the same journey registry, mounted read-only (compose: add the variable
  and the file mount to the `relay` service in an override file). Every bridged token must be in
  `TOKENS_FILE` with the same colour, symbol and decimals, or the relay refuses to start.
- **The key volume holds the bridge bundle** as `<key volume>/bridge/`: the 00050 template's
  compiled bridge (`packages/contracts-midnight/contract-bridge/src/managed`, unchanged, `bridge.compact`
  sha256 `b6150529…`). Copy that directory's contents into `<key volume>/bridge/` and check two
  hashes: `bridge/keys/lockForSolana.verifier` sha256 `b54ed1f6aff46df16f9e3e132c3e4d5e3e7c3d51fd731049f5421f4848e3967f`
  and `bridge/keys/mintFromSolana.verifier` `5f4fa8ace0ea0e47685532f67fcfbd460d826877b877b6dbfbf33bd7dd7e80f9`.
  The key job never builds it, and its install step leaves it in place. At start the relay checks:
  - each bridge's deployed `lockForSolana` verifier key against `bridge/keys/lockForSolana.verifier`;
  - each bridge's sealed SPL mint against the registry, through `bridge/contract/index.js`.

  It refuses to start (exit 78) on a mismatch, or when the module or its ledger decoder does not
  load.
- **The bridge bundle is not part of the key set's fingerprint.** `RELAY_KEYS_FINGERPRINT` covers the
  account and faucet keys only (section 5), so it stays `21493588…` with the bundle installed: in the
  key job's `verdict VERIFIED` line, in the relay's start-up check, and in `/health`
  (`proofServer.keys`). The checks above are the bundle's own. (Before AA 00060 P16 the bundle changed
  the fingerprint, to `e66737eb…` with the stagenet bridges' bundle, so a pinned relay with bridging
  exited 78 and the key job reported `MISMATCH`.)
- **Why the bundle has no path setting of its own:** it must stay inside the key volume, at
  `MIDNIGHT_MANAGED_PATH/bridge`.
  - Its `contract/index.js` imports `@midnight-ntwrk/compact-runtime-0.20`, which resolves only from a
    directory under `/app`, the checkout with its `node_modules`. That is also why the key volume is
    mounted under `/app`. A copy outside `/app` fails to load ("Cannot find module").
  - The relay's prover finds the bundle it proves `lockForSolana` with only under
    `MIDNIGHT_MANAGED_PATH`.
- `RELAY_DATA_DIR` is required with bridges: `landing-entitlements.json` there remembers every
  landing coin locked or returned (so a coin cannot be sponsored twice) and the failed attempts.
  Back it up with the rest of `relay-data`.
- The landing entitlements' MAC key is derived from the sponsor seed: there is no separate secret.
- `RATE_LIMIT_UNAUTHENTICATED_PER_MIN` (default 6): the per-client budget for the unsigned actions
  (`bridge-out`, `bridge-out-entitle`, `spl-faucet`). A re-issue's history reads run at most 2 at once
  (8 more wait; then `503 busy`).
- **DUST per bridge-out** (P9.6, local stack): about 0.70–0.75 DUST (tx1 0.34–0.36, the lock
  0.33–0.41). The stack's peak memory was 15.9 GiB. A bridge-out takes about 45 s for tx1, 25 s for
  the lock, and 20–25 s more to arrive on Solana.

### 17.4 The bridges and the injector

Each bridge (the 00058 bridge node) and the injector (00059) are separate services with their own
runbooks. Night Market only reads them. It never sends their operators' keys anywhere, and it never
reads a Solana balance through the injector: a `solana.rpcUrl` on the injector's origin is refused.

### 17.5 What the market cannot do with bridging

The README's "Bridging (AA 00060)" limitations, in short:
- the market's prover sees one transfer's landing key while it proves;
- the landing-key signature is a permanent key for that site, network and wallet;
- one coin per Bridge out;
- the site's Solana RPC is trusted to report honestly and to honour `minContextSlot`;
- finding a landing coin replays the chain's Zswap history.

### 17.6 Mint Solana tokens: the test SPL faucet

Off unless `SPL_FAUCET_KEYS_FILE` is set (`deploy/.env.example` lists every `SPL_FAUCET_*` setting).
It mints each registry mint's configured amount (default 1,000) to the requesting wallet, once per
wallet per period (default 24 h, kept in `<RELAY_DATA_DIR>/spl-faucet-claims.json`). It creates the
wallet's token accounts if needed and pays the fee itself; the wallet is asked for nothing. It is
refused on Solana mainnet-beta, and whenever a mint's on-chain mint authority is not the key held
(checked at start and before every claim).

**Which key it holds (00060 Q7, owner decision A):**
- On a **local** chain thrown away after the run, the bridges' operator keys (each mint's authority
  in the 00050 template's deploy) may be used as they are.
- On **any shared network**, first hand each test mint's authority to a dedicated faucet key, once,
  signed by the operator: `spl-token authorize <mint> mint <faucet pubkey>`. Then give the relay only
  that key. Never give the relay a bridge operator's key there: that key also signs the bridge's
  releases and upgrades its program.

`relay/src/tools/spl-faucet-keys.ts` writes the keys file (mode 600) from the keypair that the
chain names as each mint's authority.

### 17.7 Nightly, for support

- Nightly joins the lines of the text it shows; the amounts in base units and the token ids stay
  visible.
- Nightly loads a new token's name only when it is reopened: after Show in my wallet, close and
  reopen Nightly.
- The page asks the wallet for one approval at a time, with a short pause between them. If no window
  appears, open the wallet from the browser's toolbar.

### 17.8 Breaking changes (AA 00060)

The README's "Breaking changes in AA 00060" lists them for deployments and for page-driving scripts.
For the operator:
- `RELAY_DATA_DIR` is required with `BRIDGE_REGISTRY_FILE`.
- The relay refuses to start (exit 78) when the bridge module or its ledger decoder does not load.
- Offers cannot be cancelled: `cancel-offers` answers `403 offers-cannot-be-cancelled`, and
  `CANCELS_PER_ACCOUNT_PER_DAY` is unused.

## 18. Client proving: the customer's own prover (AA 00062)

`CLIENT_PROVING=required` moves the four k≥18 account circuits off the relay's contract prover:
`open_swap_shielded_with_ed25519` (offers and takes), `withdraw_shielded_with_ed25519` (shielded
withdrawals and Bridge out's first transaction), `withdraw_unshielded_with_ed25519` and
`append_inbox_with_ed25519` (change filings). The customer's own prover proves them: the Night Market
prover package, which the page asks for in a popup or under Local Data. Everything else stays proven by
the relay: account openings, key restores, demo tokens, Bridge out's second transaction, and every DUST
fee. The default, `off`, is today's relay.

**Prove first.** For each of those actions:

1. **Prepare.** The action's route runs every check it runs today. The job then builds the call with
   the sponsor wallet's public keys only, captures its proof request (proving nothing), and waits.
   While it waits it holds only its account's slot (one job per account). It holds **no prover lane and
   no sponsor wallet**, so a customer who proves slowly, or never, delays nobody else.
2. **The customer proves.** The page fetches the request (`GET /v1/jobs/:id/client-proof`), its prover
   proves it, and the page posts the proof back (`POST /v1/jobs/:id/client-proof`).
3. **Finalize.** The relay checks the proof with its pinned verifier, then checks that the account's
   state (`round` and `auth_nonce`, one indexer read) has not changed since prepare. For a take it also
   checks that the maker's offer is still live. It then takes the prover lane for a few seconds (the
   call's two or three Zswap proofs), checks the account once more, and posts the offer, hands the take
   to the batcher, or balances and submits the withdrawal or filing under the sponsor wallet.

**Deadlines.** A prepared call waits at most `CLIENT_PROOF_TIMEOUT_SECONDS` (default 600, range
60–3000), and never past a make's or a take's signed expiry minus 60 s, or its intent's TTL (one hour)
minus 60 s. With less than 30 s left at prepare, the job fails `client-proof-late` at once. A request
never fetched ends `client-proof-missing`; a proof that comes too late ends `client-proof-late`.

**Stale calls.** A call reads its account's state, so it goes stale when the account changes while the
customer proves: a deposit, demo tokens, a Bridge in delivery, a take of the account's own offer, or
another approval. The relay then answers `409 client-proof-stale`. Nothing was sent, no DUST was spent,
and it does not count against the customer. The page sends the same signed request again once, and the
prover proves it once more. If the account's `auth_nonce` moved, the customer signs again. A stale call
that slips past the check is refused by the node at the mempool (code 104, `ReadMismatch`). That costs
nothing either, and the relay reports it as `client-proof-stale`, never as a DUST race.

**DUST races.** When a submission meets a DUST race, the relay balances the call again with the same
proof (up to three times, 10 s apart). The customer is never asked for a second proof.

**What counts against the customer.** A missing, late or invalid proof counts against the requester's
failure budget (section 9). A stale call never counts, and neither does a proof the relay could not
check (`market-unavailable`).

**Restarts.** Waiting calls live in memory only. A relay restart drops them. Both client-proof routes
then answer `404 not-found`, saying that the relay restarted, that nothing was sent and that no fee
was spent. The page tells the customer to send the action again.

**The page's side.** The site's Content-Security-Policy must let the page reach the customer's prover
(section 16: `http://localhost:* http://127.0.0.1:* https:` in `connect-src`). `/v1/config` advertises
`clientProving` (the circuits, the key-set fingerprint, the proof-server version and the timeout), and
`/health` shows `clientProving: {mode: "required"}`. In `off` mode neither carries the field.

### 18.1 Turn it on

1. **The relay's checkout** must be a commit with client proving (AA 00062). The relay's proof verifier ships
   in the repository as a pinned WebAssembly module,
   `relay/src/client-proving/verifier-wasm/client_proof_verifier_bg.wasm` (8,031,787 bytes, sha256
   `600e74044a3a9824af4cd809f999c5e1aee9c7ac11673dc2e896d835b396baf3`; its source and reproducible build are
   `relay/verifier/`). The relay checks that hash before it loads the module. Nothing is downloaded or built
   on the server.
2. **The key volume stays as it is.** The verifier reads each circuit's `keys/<circuit>.verifier` and
   `zkir/<circuit>.bzkir` from the account bundle, which the key job already writes (a build or an import,
   section 5). `RELAY_KEYS_FINGERPRINT` does not change.
3. **Set** `CLIENT_PROVING=required` in the relay's settings, and `CLIENT_PROOF_TIMEOUT_SECONDS` if 600 s
   does not suit you (60–3000).
4. **The site's Content-Security-Policy** must allow the customer's prover (section 16): set the tested
   value, or add `http://localhost:* http://127.0.0.1:* https:` to your own `connect-src`. Without them the
   page tells the customer that the site's security policy blocks their prover, and nothing else works
   for the k≥18 actions.
5. **Restart the relay** (`docker compose -f deploy/compose.yml up -d relay`; native: `systemctl restart
   nightmarket-relay`). The two proof servers, the key job and the web service are unchanged. A rebuilt web
   is needed only when the web image comes from an older commit.
6. **Check.** The relay's log shows `client-proof verifier loaded` (with the sha256) and then
   `client proving required` with the four circuits and the timeout. `/health` shows
   `clientProving: {mode: "required"}`. `/v1/config` `clientProving` shows `mode` `required`, the four
   circuits, `keySet` (the pinned fingerprint), `proofServer` `9.0.0-rc.8` and `timeoutSeconds`.

**When the relay refuses to start** (exit 78, so systemd and compose do not restart it in a loop):
- `NO_CLIENT_PROOF_VERIFIER: …`: the verifier module is missing, its SHA-256 differs from the pinned one,
  or it does not load. Check out the release commit again; never replace the file by hand.
- `CLIENT_PROVING=required needs the key volume (MIDNIGHT_MANAGED_PATH) …`: `required` checks every proof
  against the key volume's pinned verifier keys. Run the key job (section 5).
- `CLIENT_PROVING must be one of off, required`, or a timeout outside 60–3000: a typo in the settings.

**Turn it off** by setting `CLIENT_PROVING=off` (or removing it) and restarting the relay. The relay then
proves the k≥18 circuits itself again, with the memory section 2 lists, and the page never shows the
popup. The CSP's extra sources do no harm.

### 18.2 The customer's prover: the package

The package is ONE public Docker image, **`ghcr.io/midnight-experiments/solana-proof-server:0.1.0-21493588@sha256:952555ca9d057883c161033245587ca37301f2b8e3da4559ec51774be90c10d9`**
(amd64 and arm64). Its source is
[midnight-experiments/solana-proof-server](https://github.com/midnight-experiments/solana-proof-server)
(Apache-2.0), whose CI built and pushed it from tag `v0.1.0`. It holds:
- the official proof server `midnightntwrk/proof-server:9.0.0-rc.8` (pinned by digest);
- the four circuits' prover keys, verifier keys and ZKIR from the key set `21493588…` (the repo's release
  `keys-21493588`, checked by SHA-256 and by the fingerprint at build time and again at every start);
- a small front that the page talks to (`GET /version`, `POST /prove-circuit`). It proves one request at a
  time (a second gets 429 `busy`), restarts the proof server after every proof so its memory goes back
  down, and never logs a request or a proof.

The page shows the command, with a copy button, in its popup and under **Local Data → Proof server**:

```sh
docker run --rm -p 127.0.0.1:6300:6300 --memory 12g ghcr.io/midnight-experiments/solana-proof-server:0.1.0-21493588@sha256:952555ca9d057883c161033245587ca37301f2b8e3da4559ec51774be90c10d9
```

`-p 127.0.0.1:6300:6300` publishes it on the customer's own loopback only. The first start downloads about
**0.65 GB** (about 2.7 GB on disk). A proof needs about **8 GB of memory** (7.5–7.7 GiB measured), so the
command caps it at 12 GB: on a Mac or Windows, Docker Desktop's own memory limit must be at least that.
One proof takes about 25–40 s on a recent laptop (AA 00062 P5: median 28.6 s on 12 cores). Customers
then enter `http://localhost:6300`, press **Test** (it checks the proof-server version, the key set and
the circuits against `/v1/config`), and **Continue**.

A newer key set or proof server means a new image: the page's Test then fails with "Update the package"
and the new command. Re-pin `PROVER_IMAGE` (`web/src/prover/constants.ts`) in the same release that moves
the pins.

### 18.3 Browsers

The page is https, and the package is `http://localhost`. What each browser does:

| Browser | What the customer sees |
|---|---|
| Chrome (142 and newer), Edge | A one-time prompt asking to let the site reach apps on this device. Allow it. If it was blocked, the page says so; re-allow it in the site's settings. |
| Firefox (153 and newer) | The same kind of prompt ("Device apps and services"). Allow it. |
| Brave | Blocked until the customer allows it by hand: `brave://settings/content/localhostAccess`. The page names that setting. |
| Safari (every version) | Blocked: Safari never lets an https page call `http://localhost`. Use Chrome or Firefox, or an online prover (`https://`). The page says so. |
| Phones and tablets | No local Docker: an online prover only. |

The page checks the browser's permission before it calls the prover, so a refusal gets its own
message instead of a generic "did not answer".

### 18.4 Online provers and privacy

A customer may enter an online prover instead: any `https://` URL (an `http://` URL is refused unless it is
`localhost` or `127.0.0.1`). The page then warns that **the prover sees the transaction's private details**
(the coins and the amounts) and asks for a confirmation before the first Test. The proof
request carries exactly what the call proves; the relay never sends it anywhere itself, and **only the
page calls the prover URL** (the relay never fetches a customer's URL).

To run an online prover for your own customers, put the same image behind a TLS proxy (the front listens
on port 6300 inside the container and answers CORS for any origin). It has **no authentication** and
proves one request at a time: restrict who can reach it if it should serve only some people, and give it
the same 12 GB. The setting is per browser and never leaves it (it is not part of an Export).

### 18.5 Sizing with client proving

With `required`, the contract prover proves no k≥18 circuit. It still proves the k=17 key restore, the
small circuits (account openings, demo-token mints, Bridge out's second transaction), each action's two
or three Zswap proofs at finalize, and (on a host that shares it) the bridges' deliveries. Section 2 has
the numbers. Every k≥18 action holds the prover lane only for its finalize (seconds), so the queue in
section 9 moves much faster than with server proofs.

### 18.6 A refused sponsored submission can lock a DUST output (questions Q9)

When the node refuses a sponsored transaction after the relay balanced it (for example a call that went
stale at the last moment, code 104, or an intent that expired), the sponsor's DUST output that paid the
fee can stay **locked for up to the ledger's grace period, 3 hours**. Nothing is spent on chain. It was
seen on a local stack (AA 00062 P5) when the submission came long after the balance; the same can happen
to a server-proven action. AA issue 00063 (the owner's workspace) tracks a fix.

- **The sign:** `/health` `sponsor.dustInFlightSpecks` stays above `"0"` while every entry under
  `queue.lanes` shows `running` 0, and the log line `sponsor DUST outputs locked by transactions in flight`
  never comes back down.
- **The effect:** fewer DUST outputs to pay with. A few at once can stall sponsored actions ("timed out
  waiting for enough DUST for the fee").
- **The remedy:** wait out the 3 hours, or restart the relay while it is idle: the sponsor wallet re-syncs
  from the chain, which has no record of the refused spend. That a restart frees the output is expected
  but not yet verified. A restart also drops calls waiting for a client proof (the page tells their
  customers to send again).
- **Prevention:** a lock takes a whole DUST output, so size the sponsor with spare NIGHT-backed outputs
  (several NIGHT coins registered, section 4.4) rather than one, so one locked output does not stop the
  market.
