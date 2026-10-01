# Night Market: operator runbook (stagenet)

Night Market is a create-and-trade market on Midnight whose accounts are controlled by **Solana
wallets** (Phantom): each account is a Passport account contract with the Ed25519 arm, and every
account action is approved by ONE `signMessage` in the wallet. The relay proves, pays every DUST
fee from its sponsor wallet, and submits. There is no bridge and no Sepolia. The tokens are native
Midnight test tokens from the mint-test-tokens faucets.

This runbook deploys and runs the market on Midnight **stagenet**, a test network: nothing here
carries real value. Every command runs from the repository root unless it says otherwise.
`deploy/.env.example` documents every setting; `deploy/SYSTEMD.md` covers a host without Docker.

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
| Contract prover (rc.8), during a k=18 proof (withdrawals, inbox appends, offers) | peaks near 9.4 GiB; limit `CONTRACT_PROOF_SERVER_MEM_LIMIT=12g` |
| DUST prover (rc.6) | small; limit `DUST_PROOF_SERVER_MEM_LIMIT=4g` |
| Relay | 1 to 2 GB idle; a proof adds about 0.15 GB (it streams the prover key); limit `RELAY_MEM_LIMIT=8g` |
| Web | under 50 MB; limit 256 MB |
| Key job, once | an import needs little; a full compile of the account's 42 circuits up to `KEYS_JOB_MEM_LIMIT=12g` |

Plan for about **20 GB of RAM**. The relay proves one call at a time, so the contract prover never
needs more than one k=18 proof's memory.

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
# 1. The code, with the pinned Passport sources (the Ed25519 arm).
git clone https://github.com/acedward/solana-night-market.git nightmarket
cd nightmarket
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
message and `/health` shows `sponsor.dustLow: true`. Registration needs about 60 DUST: keep the
balance well above that.

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
   `800dd4a38f2d25228d4732fdb39b3f5f0cbe42d792eef020914b8532c85f6f26` (acedward/passport @
   `451f761`, the Ed25519 arm), and the vendored faucet `contracts/faucet/shielded-token.compact`
   with SHA-256 `1dca131a…89bd` (effectstream/mint-test-tokens @ `a51cf3a`,
   `contracts/faucet/PROVENANCE.md`).
2. Compiles the account's callees (compile-time inputs, never installed), then the account with
   keys (42 circuits, compactc 0.35.0 `--feature-zkir-v3`). This is the slow step. Or imports a set
   built elsewhere (5.4).
3. Compiles the demo-token faucet with compactc 0.34.0 **without** `--feature-zkir-v3` and requires
   its `mint` verifier key to be the one the stagenet faucets were deployed with (SHA-256
   `4bbbb047…794a`; read from all four faucets' on-chain state on 2026-09-30).
4. Points the account module at compact-runtime 0.20.0, deletes every prover key the relay does
   not use, and removes them from each bundle's manifest.
5. Verifies the set:
   - every verifier key equals its compiled `expectedVk` table (account 42, faucet 5);
   - the 7 kept prover keys are present: `activate_initial_device_with_ed25519`,
     `withdraw_shielded_with_ed25519`, `withdraw_unshielded_with_ed25519`,
     `append_inbox_with_ed25519`, `open_swap_shielded_with_ed25519`, `deposit_shielded`, and
     `faucet/mint`;
   - the fingerprint over all verifier keys equals `RELAY_KEYS_FINGERPRINT`
     (**`a627edb18f6aa54c48194ee9fb38b89140887cfc56b0efb377c9504b79edda92`**).
6. Installs the set into the volume and writes the report `.night-market-keys.json`.

Any failure exits non-zero, and Compose then does not start the relay or the web site. On later
starts the job sees the report, finds the same inputs, and only re-verifies.

The relay checks the volume again when it starts, and refuses to start (exit code 78, with the
list of problems in its first log line) when a circuit it proves lacks its prover key, verifier key
or ZKIR, when the fingerprint is not `RELAY_KEYS_FINGERPRINT`, or when no volume is mounted
(compose sets `RELAY_REQUIRE_KEYS=true`). The account's keys are also checked against the loaded
code, and every account the relay acts on is checked against the set on chain (section 6).

### 5.2 Run it

```sh
docker compose -f deploy/compose.yml up keys      # attached: you see the progress, it exits when done
```

The end of a good run:

```
key-volume: faucet done in … s (mint verifier key = the deployed one)
key-volume: verdict VERIFIED (fingerprint a627edb18f6aa54c48194ee9fb38b89140887cfc56b0efb377c9504b79edda92)
key-volume: OK: key volume installed and verified in … s (2.2G)
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
set is **not trusted**. The pinned fingerprint was produced this way (2026-09-30, in 11 s).

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
inbox append, an offer, a take) is authorised by the Solana wallet's signature over the call's
readable message (format F3: the market's label, the operation, the amounts with their decimals and
symbols, the recipient's fingerprint, the account and its nonce, and the digest). It is the same
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
restart (the page asks for a new one). An unused nonce is never pushed out early by other clients'
requests: each client address holds at most `AUTH_MAX_NONCES_PER_CLIENT` (30) unused nonces and is
refused (`429`) past that, until they are used or expire. Ledger-backed Phantom accounts sign a
different, wrapped message and are refused.

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
market's account shape (the deposits, the Ed25519 activation and seven gated circuits, the offer
circuit), and its maintenance authority must be retired. An account deployed from another build,
with another arm or an extra operation, or whose deployer kept an authority, is refused as "not a
Night Market account". Accounts the relay opens always pass (it deploys them from the pinned set
and retires the authority in the same second wave).

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
missing, with no second daily charge (a token is minted twice only if it landed while the claims
file could not be written; faucet tokens cost nothing). After `DEMO_TOKENS_MAX_ATTEMPTS` (3)
failed deliveries the key is refused (`attempts-exhausted`). Only a claim refused before its job ran
(a full queue) is undone.

**The claims store** is `<RELAY_DATA_DIR>/demo-token-claims.json`, rewritten atomically on every
change, next to a lock file that keeps a second relay off it: **one relay per data dir**. Only an
existing lock held by a live process means "in use by another relay"; a lock left by a crash is
taken over, and a data dir the relay cannot write is reported as that (section 3, "The relay's
user"). It holds public values only (the Solana key, the account, times, transaction ids, the
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
| `sponsor.dustInFlightSpecks` | The part of `dustSpecks` held by the sponsor's transactions in flight: `"0"` when idle. | Nothing: it returns to `"0"` when the transactions land. If it stays above 0 for more than an hour, a transaction never landed; the lock ends after the ledger's 3-hour grace period. |
| `proofServer.reachable`, `version` | The CONTRACT prover: must be `9.0.0-rc.8` (`CONTRACT_PROOF_SERVER_EXPECTED_VERSION`). | Unreachable: `docker compose logs proof-server-contracts` (an out-of-memory kill shows as a restart). |
| `dustProofServer.reachable`, `version` | The DUST prover: must be `9.0.0-rc.6`. | As above for `proof-server-dust`. |
| `proofServer.keys.fingerprint`, `matchesPin`, `complete`, `problems` | The key set's identity and completeness. | Always pinned and complete on a running relay (it refuses to start otherwise). |
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

`GET /v1/demo-tokens` shows the pack, `remainingToday`, and (with `?owner=<key>`) whether a key
has claimed, and whether it may finish a pack that failed part-way (`resumable`).

Also watch `docker compose ps` (`relay` and `web` `(healthy)`; the proof servers have no Docker
health check) and `docker compose logs -f relay` (JSON lines; secrets are redacted by key and by
value; request bodies are never logged).

## 9. Capacity and limits

| Limit | Value | Effect |
|---|---|---|
| Proofs | one at a time, market-wide | Every signed action holds the prover lane; others queue, and the page shows the position. A demo-token pack holds it for all its tokens (about 20 s per token on `direct`, 40 s on `via-sponsor`, measured locally). |
| Batcher | 1,000 requests per 24 hours per IP per target, and 1,000 for all clients together | Every take the relay settles is one request, so at most 1,000 takes a day. |
| Kernel | 600 requests per minute per IP | Browsers read prices directly; the relay posts offers. |
| Relay, per client address | reads 240/min, `/health` 60/min, nonces 30/min, actions 10/min; actions per Solana key 5/min | `RATE_LIMIT_*`. |
| Unused nonces | 30 per client address (`AUTH_MAX_NONCES_PER_CLIENT`), 50,000 in all (`AUTH_MAX_NONCES`) | Never evicted early: past either cap new nonces are refused (`429` for the client, `503 busy` for all) until some are used or expire (10 minutes). |
| Opening accounts | 100 a day in all (`REGISTER_DAILY_CAP`), 3 a day per client address (`REGISTER_PER_CLIENT_DAILY_CAP`), 1 queued or running at once (`REGISTER_MAX_IN_FLIGHT`) | Rolling 24 hours, counted when admitted (a failed registration still spent its proofs). Past a cap: `429 registration-daily-cap` / `registration-client-cap`; while one is in flight: `503 registration-busy`, Retry-After 60. See the numbers below. |
| Failed jobs | 5 per Solana key and 5 per account a day (`FAILURE_BUDGET_PER_OWNER_PER_DAY`, `FAILURE_BUDGET_PER_ACCOUNT_PER_DAY`) | A job that fails after it started proving counts (the market's own failures do not: no keys, the exchange unreachable or at its cap). Past the budget: `429 failure-budget` until the oldest failure is a day old. |
| Offer and take expiry | a make at most 3,600 s ahead, a take 600 s, at least 60 s left | Section 6. |
| Demo tokens | once per key; `DEMO_TOKENS_DAILY_CAP` a day; 3 failed deliveries | Section 7. |
| Change re-filing (`append-inbox`) | only against the relay's single-use entitlement for that change, at most `APPEND_INBOX_MAX_PER_ACCOUNT_PER_DAY` (20) a day per account | The entitlement key derives from the sponsor seed: a new sponsor seed voids entitlements already issued. |
| Jobs | kept `JOB_TTL_SECONDS` (24 h), at most `JOB_MAX` (10,000), in memory | A relay restart forgets running jobs. |

**Why these registration numbers** (audit C4). One registration deploys two waves and activates the
device: it held the prover lane about 60 s on stagenet and cost the sponsor about 21 DUST (plan P6:
22 DUST for an account plus its demo pack, the pack about 1 DUST). Without caps one client opening
accounts with fresh Solana keys (they cost nothing) could stall every customer's action and drain the
sponsor in under two days. With the defaults:

- at most 100 accounts a day: about 2,100 DUST and 100 minutes of prover time a day, at worst;
- one client address opens at most 3 a day, so reaching the global cap takes 34 addresses;
- registrations never queue behind each other: any other action waits behind at most one (about a
  minute);
- a key or account whose calls keep failing at proving time is stopped after 5 failures a day.

Size the sponsor for the global cap: `REGISTER_DAILY_CAP` × 21 DUST a day, plus the actions. The
counters live in memory: a relay restart resets them.
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
- **Offers expire**: an offer can be taken for one hour after you approve it (a take for five
  minutes), whoever holds the approval. **Cancel offer** ends it sooner (one approval, one
  transaction).
- **Demo tokens**: once per wallet. These are test networks and test tokens.

## 11. Known limits

- One live offer per account; one coin per payment, with no merging of coins.
- All customer data in the browser, with Export and Import as the only backup.
- The relay's jobs live in memory: a relay restart forgets running jobs (restart when `/health`
  `queue.lanes` shows nothing running or waiting).
- Proofs one at a time (section 9).
- An account with 500 or more contract actions cannot be reconciled until the relay pages
  through the indexer (`/v1/accounts/<account>/zswap` answers `501 history-too-long`).
- A withdrawal's recipient encryption key is unsigned by default (section 6, F-B6; questions Q28:
  the one accepted exception to the trustless relay: a relay could hide a withdrawn coin from its
  recipient's wallet scan, not take it).
- The page reads its account from the public indexer, except which of its coins exist and which are
  spent: the relay decodes those events, and the page keeps only what the indexer's own events carry
  (section 16; questions Q31). A relay can still leave a coin out (hide it), never invent one.
- The registration caps and the failure budget are counted in memory: a relay restart resets them
  (section 9).
- Ledger-backed Phantom accounts are refused (they sign a wrapped message).

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
| Stop (keeps volumes) | `docker compose -f deploy/compose.yml stop` |
| Remove everything, keys and claims included | `docker compose -f deploy/compose.yml down -v` |

**Back up** the sponsor seed file and the `relay-data` volume. The key volume can be rebuilt.

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
| `proofServer.reachable: false`, `proof-server-contracts` restarting | Out of memory during a k=18 proof | Raise `CONTRACT_PROOF_SERVER_MEM_LIMIT` (at least 12g). |
| A job fails with "unrecognised discriminant" | A contract proof went to rc.6 | Check `MIDNIGHT_CONTRACT_PROOF_SERVER_URL` (compose sets it to the rc.8 service). |
| Fees refused after a stagenet upgrade | The ledger or DUST version moved | Section 12.3. |

### 13.2 The kernel (or the batcher) is down

The site shows "exchange unavailable" and never shows stale prices; offers cannot be made or
taken; accounts, demo tokens and withdrawals still work. `/health` shows it. Tell the kernel
operator. A batcher that answers 429 means its daily cap: takes resume when the window moves.

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
| Passport sources | `vendor/passport` = acedward/passport @ `451f7610e90000e0c5550877418122a04b85d0e6` (branch `00047-solana-ed25519-arm`); `account.compact` SHA-256 `800dd4a38f2d25228d4732fdb39b3f5f0cbe42d792eef020914b8532c85f6f26` |
| Key set fingerprint | `a627edb18f6aa54c48194ee9fb38b89140887cfc56b0efb377c9504b79edda92` |
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
- **Which coins exist and which are spent** come from the ledger's Zswap events, which only the relay
  decodes (the browser bundle carries no ledger-v9); the page keeps a reported coin or spend only when
  one of the account's transactions, as the indexer lists it, carries it (questions Q31).

**Re-pin the web build with the key set.** When the relay's key set changes (a new `vendor/passport`
pin), regenerate the pinned digests from the new key volume and rebuild the web image, or the page
refuses every new account (`relay/test/pinned-account-keys.test.ts` fails while the pinned circuits
differ from the market shape).

**Which indexer.** The site's network profile (`indexer.stagenet.shielded.tools` on stagenet). A
deployment can point it elsewhere with a mounted `config.json`:
`{"network": "stagenet", "relayUrl": "/relay", "overrides": {"midnight": {"indexerUrl": "https://…/api/v4/graphql"}}}`.
The stagenet indexer answers any origin (CORS `*`).

**The Content-Security-Policy** (`WEB_CONTENT_SECURITY_POLICY`). Its `connect-src` must name the
indexer, or the page cannot check any account (it then says so and signs nothing). The value below is
tested (`test/e2e/chain.spec.ts`, with the test's own origins in place of these):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://indexer.stagenet.shielded.tools https://stagenet.api-zswap.zkdojo.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
```

`'wasm-unsafe-eval'` is for the contract runtime's WebAssembly (the arm's message builder and the
account decoder). The relay is the same-origin `/relay` here; a relay on another origin
(`WEB_RELAY_URL`) and an indexer set in `config.json` must be added to `connect-src`.
