#!/usr/bin/env bash
# AA 00057 P5R.0: the stagenet rehearsal's GATE, bridge X only. Local services against REMOTE networks:
# Midnight stagenet (node, indexer), the Offer Files stagenet exchange (kernel, batcher) and Solana devnet.
#
#   e2e/stagenet/run-gate.sh prep   the shared prep (e2e/run-local.sh prep: the 00058 template volume at its pin,
#                                   the app volume, the relay image) and the site build (web/dist)
#   e2e/stagenet/run-gate.sh gate   OUT=<evidence dir>: the gate, then a full teardown (always)
#
# The gate, in order (STOPS on the first failure; the teardown still runs):
#   0. checks: pins, key files (modes), the funding lock (looked at once, never taken: Temporary 11-14 are not
#      the ladders' wallets), devnet balances; the stack lock ~/.aa-00057-stack.lock is taken (waits politely)
#   1. bridge X: the devnet program (x-program id; x-operator = payer, upgrade authority, operator), the test
#      mint X (classic SPL, 6 decimals, mint authority x-operator) and Initialize (00058 deploy-devnet.ts), the
#      Midnight contract on stagenet paid by Temporary 12 (00058 deploy.ts), the public record (bridge:record)
#   2. the journey registry (I-1) for stagenet, the relay's and the site's token lists (X/twUSDC)
#   3. local services: the provers (rc.6 DUST, rc.8 contract), Night Market's relay (sponsor Temporary 11) on
#      stagenet, bridge node X (Temporary 12 = its operator and delivery wallet) on stagenet + devnet, the site
#   4. two fresh Passport accounts A and B on stagenet (market-flows open-a, open-b)
#   5. A's Solana wallet on devnet: SOL (a devnet airdrop, else 0.05 SOL from the funder) and 2 X minted to it
#   6. (a) A's page bridges 1 X in (one composed delivery into A's account); the page's balance is exact
#   7. (b) A's page bridges 1 X out (a whole coin) back to A's wallet on devnet; the release arrives
#   8. (c) A bridges another 1 X in; B claims the demo pack (twUSDC); A makes "1 X for 1 twUSDC" on the
#      stagenet kernel; B takes it through the batcher; Filled; both balances move by exactly the legs
#   9. the costs (DUST per transaction from the indexer, the sponsor's settled DUST, SOL deltas), the timings
#      and the bridge node's Solana sync rate against devnet's tip, sampled every 15 s
#
# State that outlives a run (so a stopped gate resumes without redeploying or reopening accounts):
#   ~/.config/aa-00057/p5r0/deployments/  the deployment file and public record of bridge X (addresses only)
#   ~/.config/aa-00057/p5r0/state/        A's and B's test keys and the pages' stores (secret; mode 700)
# Secrets (the stagenet seeds, the devnet keypairs, the storage password) are copied into the run's temp
# directory (700/600), read in-process by the containers, never printed, and removed at the teardown.
# Everything written to $OUT is public.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E="$ROOT/e2e"
HERE="$E2E/stagenet"
CMD="${1:-gate}"

BRIDGE_WT="${BRIDGE_WT:-$(sed -n 's/^BRIDGE_WT="${BRIDGE_WT:-\(.*\)}"$/\1/p' "$E2E/run-local.sh")}"
BRIDGE_PIN="$(sed -n 's/^BRIDGE_PIN=//p' "$E2E/run-local.sh")"
TPL="$BRIDGE_WT/templates/solana-midnight-bridge"
TROOT=/work/repo/templates/solana-midnight-bridge
AGAVE="${AGAVE:-$HOME/.cache/aa-00058/agave/bin}"
SPL_TOKEN="${SPL_TOKEN:-$HOME/.local/share/solana/install/active_release/bin/spl-token}"
KEYS_SRC="${KEYS_SRC:-$HOME/.cache/aa-00047/p10i-keys}"
PS_PARAMS_SRC="${PS_PARAMS_SRC:-$HOME/.cache/aa-00047/ps-params}"
PS8_PARAMS_SRC="${PS8_PARAMS_SRC:-$HOME/.cache/aa-00047/ps-params-rc8}"
STATE_ROOT="${AA00057_STATE:-$HOME/.cache/aa-00057}"
CONF="$HOME/.config/aa-00057"
P5R="$CONF/p5r0"
LOCK="$HOME/.aa-00057-stack.lock"
FUNDING_LOCK="$HOME/.stagenet-offer-ladders/funding.lock"
STEP_IMAGE=e00050/unit:s4
BUN_IMAGE=oven/bun:1.3.11
PS6_IMAGE=midnightntwrk/proof-server@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b
PS8_IMAGE=midnightntwrk/proof-server:9.0.0-rc.8
TMPL_VOLUME=aa00057-tmpl
# The provers as the containers name them (ATTACH=preview: the preview's own, e2e/stagenet/preview.sh).
DUST_PS=http://proof-server:6300
CONTRACT_PS=http://proof-server-rc8:6300
PREVIEW_DIR="${AA00057_STATE:-$HOME/.cache/aa-00057}/preview"
APP_VOLUME=aa00057-check-app
LOCK_WAIT_S="${LOCK_WAIT_S:-14400}"

# The remote networks.
STG_NODE_HTTP=https://rpc.stagenet.shielded.tools
STG_NODE_WS=wss://rpc.stagenet.shielded.tools
STG_INDEXER=https://indexer.stagenet.shielded.tools/api/v4/graphql
STG_INDEXER_WS=wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws
# Solana devnet: the PRIVATE RPC URL in DEVNET_RPC_FILE (it carries an API key: read into this process only,
# handed to the CLIs through a config file and to containers through env files (600, in the run's temp dir);
# never printed; every file in $OUT is redacted at the teardown). Without the file: the public RPC (rate-limited).
DEVNET_RPC_FILE="${DEVNET_RPC_FILE:-$CONF/devnet/rpc-url}"
DEVNET=https://api.devnet.solana.com
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
DEPLOYMENT=p5r-x
UNIT=1000000
GATE_AMOUNT=1000000 # 1 X (6 decimals)

say() { echo "[gate $(date -u +%H:%M:%SZ)] $*"; }
fail() { say "STOPPED: $*"; echo "$*" >"$OUT/stopped.txt"; exit 1; }
mark() { printf '{"at":"%s","t":%s,"what":"%s","event":"%s"}\n' "$(date -u +%FT%TZ)" "$(date +%s)" "$1" "$2" >>"$OUT/timings.jsonl"; }
pub() { "$AGAVE/solana-keygen" pubkey "$1"; }
sol() { "$AGAVE/solana" -C "$RUN/solana-cli.yml" "$@"; }
spl() { "$SPL_TOKEN" -C "$RUN/solana-cli.yml" "$@"; }
sol_balance() { sol balance "$1" --lamports 2>/dev/null | awk '{print $1}'; }
free_port() {
  python3 - <<'PY'
import random, socket
for _ in range(5000):
    p = random.randint(10001, 59000)
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); print(p); break
    except OSError:
        pass
    finally:
        s.close()
PY
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
prep() {
  bash "$E2E/run-local.sh" prep || exit 1
  DOCKER_CHECK_NAME=aa00057-check "$ROOT/scripts/docker-check.sh" run 'bun run build:web >/dev/null' || { say "the site build failed"; exit 1; }
  rm -rf "$STATE_ROOT/site-dist" && mkdir -p "$STATE_ROOT/site-dist"
  docker run --rm --pull=never -v "$APP_VOLUME:/app:ro" "$BUN_IMAGE" tar -C /app/web/dist -cf - . | tar -C "$STATE_ROOT/site-dist" -xf - \
    || { say "copy the site build"; exit 1; }
  [[ -f "$STATE_ROOT/site-dist/index.html" ]] || { say "no index.html in the site build"; exit 1; }
  say "prep done: 00058 $BRIDGE_PIN, relay $(cat "$STATE_ROOT/relay-image"), site build in $STATE_ROOT/site-dist"
}

# midnight-js's private-state password policy (validatePassword: >= 16 characters, >= 3 of upper/lower/
# digit/special, no long repeats, no sequences); run 2 stopped on a lowercase-hex password (2 classes).
gen_storage_password() {
  python3 - <<'PY'
import re, secrets, string
alphabet = string.ascii_letters + string.digits + "-_.!"
def ok(p):
    classes = sum(bool(re.search(r, p)) for r in (r"[A-Z]", r"[a-z]", r"[0-9]", r"[^A-Za-z0-9]"))
    seq = any(abs(ord(p[i + 1]) - ord(p[i])) == 1 and ord(p[i + 2]) - ord(p[i + 1]) == ord(p[i + 1]) - ord(p[i])
              for i in range(len(p) - 2))
    return len(p) >= 32 and classes == 4 and not re.search(r"(.)\1\1", p) and not seq
while True:
    p = "".join(secrets.choice(alphabet) for _ in range(40))
    if ok(p):
        print(p, end="")
        break
PY
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# helpers that need the run's variables
# ═════════════════════════════════════════════════════════════════════════════════════════════
tmpl() { # <name> <dir under the template> <cmd...>: the 00058 template's environment, live mode, bridge X
  # (P5R.1: TW=y and DEPLOYMENT=p5r-y for bridge Y, with its own secrets directory)
  local name=$1 wd=$2; shift 2
  docker run --rm --name "$CP-$name" --network "$NET" --memory "${TMPL_MEM:-4g}" --pull=never \
    -v "$TMPL_VOLUME:/work" -v "$RUN/secrets-${TW:-x}:/secrets-${TW:-x}:ro" -v "$OUT:/out" \
    -e BRIDGE_MODE=live -e "BRIDGE_DEPLOYMENT=$DEPLOYMENT" -e "BRIDGE_SECRETS_DIR=/secrets-${TW:-x}" \
    -e MIDNIGHT_NETWORK_ID=stagenet -e "MIDNIGHT_NODE_HTTP=$STG_NODE_WS" \
    -e "MIDNIGHT_INDEXER_HTTP=$STG_INDEXER" -e "MIDNIGHT_INDEXER_WS=$STG_INDEXER_WS" \
    -e "MIDNIGHT_PROOF_SERVER_URL=$DUST_PS" -e "MIDNIGHT_CONTRACT_PROOF_SERVER_URL=$CONTRACT_PS" \
    --env-file "$RUN/devnet.env" -e "SOLANA_EXPECTED_GENESIS_HASH=$DEVNET_GENESIS" \
    -e BRIDGE_DELIVERY_ADAPTERS=passport -e NODE_ENV=production -e OUT=/out \
    -w "$TROOT/$wd" "$STEP_IMAGE" bash -c '
      if [ -f "$BRIDGE_SECRETS_DIR/storage-password" ]; then export MIDNIGHT_STORAGE_PASSWORD="$(cat "$BRIDGE_SECRETS_DIR/storage-password")"; fi
      exec "$@"' _ "$@"
}
quiet() { grep -v -E 'polkadot|conflicting packages|^[[:space:]]+(cjs|esm) |Either remove|bigint: Failed'; }
bun_nm() { # Night Market's app volume, read only, on the run's network
  docker run --rm --name "$CP-step-$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')" --network "$NET" \
    --memory "${FLOWS_MEM_LIMIT:-6g}" --pull=never -v "$APP_VOLUME:/app:ro" -w /app "$@"
}
flows() { # <steps> [VAR=…]…  (test/stack/p6/market-flows.ts on stagenet, through the local relay)
  local steps=$1; shift
  local args=(); for kv in "$@"; do args+=(-e "$kv"); done
  bun_nm -v "$RUN/keys-relay:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm:ro" \
    -v "$P5R/state:/state" -v "$OUT:/out" -e RELAY_URL=http://relay:8080 -e NETWORK=stagenet \
    -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out -e "OUT_NAME=market-flows-${steps//,/-}.json" \
    -e "STEPS=$steps" -e PROMPT_LOG=/out/prompts.jsonl ${args[@]+"${args[@]}"} "$BUN_IMAGE" \
    bun test/stack/p6/market-flows.ts 2>&1 | tee -a "$OUT/market-flows.log"
  return "${PIPESTATUS[0]}"
}
landing() { # [VAR=…]…  (test/gates/landing/landing.ts: the page's own operations)
  local args=(); for kv in "$@"; do args+=(-e "$kv"); done
  bun_nm -v "$RUN/keys-harness:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm" \
    -v "$P5R/state:/state" -v "$OUT:/out" -e NETWORK=stagenet -e STATE_DIR=/state -e OUT=/out -e RUN_DIR_IN=/run/nm \
    -e JOURNEY_FILE=/run/nm/journey-tokens.stagenet.json -e PROMPT_LOG=/out/prompts.jsonl -e RELAY_URL=http://relay:8080 \
    -e "INDEXER_URL=$STG_INDEXER" -e "NODE_WS_URL=$STG_NODE_WS" \
    -e "MIDNIGHT_CONTRACT_PROOF_SERVER_URL=$CONTRACT_PS" -e "MIDNIGHT_DUST_PROOF_SERVER_URL=$DUST_PS" \
    -e "SOLANA_GENESIS=$DEVNET_GENESIS" --env-file "$RUN/devnet.env" -e SOLANA_CLUSTER=solana:devnet \
    -e "LANDING_ORIGIN=http://127.0.0.1:$WEB_PORT" -e BRIDGES=X -e BRIDGE_IN_TIMEOUT_MS=2700000 ${args[@]+"${args[@]}"} "$BUN_IMAGE" \
    bun test/gates/landing/landing.ts 2>&1 | tee -a "$OUT/landing.log"
  return "${PIPESTATUS[0]}"
}
# The sponsor's settled DUST (the relay's /health), only while its queue is idle (test/stack/p6/run-stagenet.sh).
dust_now() {
  [[ -n "$(docker ps -q -f "name=^$CP-relay\$" 2>/dev/null)" ]] || return 0
  curl -s -m 10 "http://127.0.0.1:$RELAY_PORT/health" | python3 -c '
import json, sys
h = json.load(sys.stdin)
s = h.get("sponsor", {})
lanes = h.get("queue", {}).get("lanes", {})
idle = all(l.get("running", 0) == 0 and l.get("waiting", 0) == 0 for l in lanes.values())
print(s["dustSpecks"] if s.get("synced") is True and s.get("dustSpecks") and idle else "")' 2>/dev/null
}
snapshot() { # <label>: the sponsor's DUST, the SOL balances, bridge X's transfers
  local d=""
  if [[ -n "$(docker ps -q -f "name=^$CP-relay\$" 2>/dev/null)" ]]; then
    for _ in 1 2 3 4 5 6; do d="$(dust_now)"; [[ -n "$d" ]] && break; sleep 10; done
  fi
  printf '{"label":"%s","at":"%s","sponsorDustSpecks":"%s","lamports":{"xOperator":"%s","funder":"%s","walletA":"%s"}}\n' \
    "$1" "$(date -u +%FT%TZ)" "$d" "$(sol_balance "$X_OPERATOR")" "$(sol_balance "$FUNDER")" \
    "$( [[ -n "${WALLET_A:-}" ]] && sol_balance "$WALLET_A")" >>"$OUT/snapshots.jsonl"
  curl -sf -m 10 "http://127.0.0.1:$X_API_PORT/transfers?limit=50" >"$OUT/transfers-$1.json" 2>/dev/null || rm -f "$OUT/transfers-$1.json"
}
# A Midnight transaction's fees and block from the stagenet indexer (by hash or identifier).
tx_fees() {
  python3 - "$STG_INDEXER" "$1" <<'PY'
import json, sys, time, urllib.request
url, tx = sys.argv[1], sys.argv[2].removeprefix("0x")
by = "hash" if len(tx) == 64 else "identifier"
q = '{ transactions(offset: {%s: "%s"}) { hash block { height timestamp } ... on RegularTransaction { fees { paidFees estimatedFees } transactionResult { status } } } }' % (by, tx)
for _ in range(40):
    try:
        req = urllib.request.Request(url, data=json.dumps({"query": q}).encode(), headers={"content-type": "application/json"})
        d = json.load(urllib.request.urlopen(req, timeout=20))
        t = (d.get("data") or {}).get("transactions") or []
        if t:
            print(json.dumps({"tx": tx, **t[0]})); sys.exit(0)
    except Exception:
        pass
    time.sleep(6)
print(json.dumps({"tx": tx, "found": False}))
PY
}
contract_deploy_tx() { # <contract address>: its deploy transaction (hash, fees) from the indexer
  python3 - "$STG_INDEXER" "$1" <<'PY'
import json, sys, urllib.request
url, addr = sys.argv[1], sys.argv[2].removeprefix("0x")
q = '{ contractAction(address: "%s") { __typename address transaction { hash block { height timestamp } ... on RegularTransaction { fees { paidFees estimatedFees } transactionResult { status } } } } }' % addr
req = urllib.request.Request(url, data=json.dumps({"query": q}).encode(), headers={"content-type": "application/json"})
try:
    print(json.dumps(json.load(urllib.request.urlopen(req, timeout=30))))
except Exception as e:
    print(json.dumps({"error": str(e)}))
PY
}
# The private devnet RPC (its URL, its API key) is replaced in every file under the given directory.
redact_rpc() {
  [[ -n "${DEVNET:-}" && "$DEVNET" != https://api.devnet.solana.com ]] || return 0
  DEVNET_URL="$DEVNET" python3 - "$1" <<'PY'
import os, sys, urllib.parse
url = os.environ["DEVNET_URL"]
parts = urllib.parse.urlsplit(url)
secrets = {url, url.rstrip("/")}
for _k, v in urllib.parse.parse_qsl(parts.query):
    if len(v) >= 8:
        secrets.add(v)
for seg in parts.path.split("/"):
    if len(seg) >= 16:
        secrets.add(seg)
secrets = sorted(secrets, key=len, reverse=True)
total = left = 0
for root, _dirs, files in os.walk(sys.argv[1]):
    for f in files:
        p = os.path.join(root, f)
        try:
            data = open(p, "rb").read()
        except Exception:
            continue
        new = data
        for x in secrets:
            total += new.count(x.encode())
            new = new.replace(x.encode(), b"[REDACTED devnet RPC]")
        if new != data:
            open(p, "wb").write(new)
        left += sum(new.count(x.encode()) for x in secrets)
print(f"redacted {total} occurrence(s) of the private devnet RPC under {sys.argv[1]}; left {left}")
PY
}
# The template volume's deployment files of this gate (addresses only) are kept in $P5R/deployments, so a
# stopped gate resumes from them (run 2 lost the Solana section when the teardown cleaned the volume).
save_deployments() {
  local f
  for f in "$DEPLOYMENT.json" "$DEPLOYMENT.record.json"; do
    docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" sh -c "cat $TROOT/deployments/$f 2>/dev/null" \
      >"$P5R/deployments/$f.tmp" && [[ -s "$P5R/deployments/$f.tmp" ]] && mv "$P5R/deployments/$f.tmp" "$P5R/deployments/$f"
    rm -f "$P5R/deployments/$f.tmp"
  done
}
# Any 12- or 24-word line a Solana CLI prints (a recovery phrase) is replaced in the given files.
redact_phrases() {
  python3 - "$@" <<'PY'
import re, sys
for f in sys.argv[1:]:
    try:
        lines = open(f).read().split("\n")
    except FileNotFoundError:
        continue
    out = ["[REDACTED: a recovery phrase]" if re.fullmatch(r"\s*([a-z]+ ){11}[a-z]+\s*|\s*([a-z]+ ){23}[a-z]+\s*", l) else l for l in lines]
    open(f, "w").write("\n".join(out))
PY
}
# The bridge node's Solana sync against devnet's tip, every 15 s (the node's /block-heights, devnet getSlot).
sync_sampler() {
  while :; do
    local bh tip
    bh="$(curl -s -m 10 "http://127.0.0.1:$X_API_PORT/block-heights" 2>/dev/null)"
    tip="$(DEVNET_URL="$DEVNET" python3 -c '
import json, os, urllib.request
req = urllib.request.Request(os.environ["DEVNET_URL"], data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getSlot", "params": [{"commitment": "confirmed"}]}).encode(), headers={"content-type": "application/json"})
try: print(urllib.request.urlopen(req, timeout=10).read().decode())
except Exception: print("{}")' 2>/dev/null)"
    python3 -c '
import json, sys, time
try: bh = json.loads(sys.argv[1])
except Exception: bh = None
try: tip = json.loads(sys.argv[2]).get("result")
except Exception: tip = None
print(json.dumps({"t": time.time(), "devnetSlot": tip, "blockHeights": bh}))' "$bh" "$tip" >>"$OUT/sync.jsonl"
    sleep 15
  done
}

# Night Market's relay on stagenet with bridge X (sponsor Temporary 11). It REPLACES any relay of the same name
# (ATTACH=preview: the preview's relay holds the same sponsor wallet, so the two never run side by side).
# With $RUN/nm/spl-faucet-keys.json present, the test SPL faucet is on (its RPC from the 600 env file).
start_relay() {
  local faucet=()
  if [[ -f "$RUN/nm/spl-faucet-keys.json" ]]; then
    faucet=(-e SPL_FAUCET_KEYS_FILE=/run/nm/spl-faucet-keys.json --env-file "$RUN/faucet.env")
  fi
  docker volume create "$CP-relay-data" >/dev/null
  docker rm -f "$CP-relay" >/dev/null 2>&1
  # The relay just removed was the only one using this data volume, so any lock left in it is stale (run 3: the
  # preview's relay left its demo-claims lock and the new relay refused to start). A fixed host name lets a
  # recreated relay take over its own locks; no restart policy (a restart kept its own container-local
  # funding lock and looped).
  docker run --rm --pull=never -v "$CP-relay-data:/d" "$BUN_IMAGE" sh -c 'rm -f /d/*.lock' >/dev/null 2>&1
  docker run -d --name "$CP-relay" --hostname relay --network "$NET" --network-alias relay -p "127.0.0.1:$RELAY_PORT:8080" \
    --memory 4g --pull=never -e HOME=/tmp -e RELAY_NETWORK=stagenet -e TOKENS_FILE=/run/nm/tokens.json \
    -e BRIDGE_REGISTRY_FILE=/run/nm/journey-tokens.stagenet.json \
    -e MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed \
    -e "MIDNIGHT_CONTRACT_PROOF_SERVER_URL=$CONTRACT_PS" -e "MIDNIGHT_DUST_PROOF_SERVER_URL=$DUST_PS" \
    -e RELAY_REQUIRE_KEYS=true -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/nm/sponsor.seed \
    -e SPONSOR_FUNDING_LOCK_FILE=/tmp/relay-funding.lock -e SPONSOR_FEE_BLOCKS_MARGIN=5 \
    -e DEMO_TOKENS_ENABLED=true -e "DEMO_TOKENS_PACK=${DEMO_PACK:-twUSDC:10}" -e DEMO_TOKENS_PATH=direct -e DEMO_TOKENS_DAILY_CAP=10 \
    -e RELAY_DATA_DIR=/var/lib/night-market -e RATE_LIMIT_ACTIONS_PER_MIN=100 -e RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN=100 \
    ${faucet[@]+"${faucet[@]}"} \
    -e LOG_LEVEL=info -v "$RUN/keys-relay:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm:ro" \
    -v "$CP-relay-data:/var/lib/night-market" "$RELAY_IMAGE" >/dev/null
}
relay_synced() { # waits for the relay's sponsor (through its published port); 0 when synced
  local h=""
  for _ in $(seq 1 200); do
    h="$(curl -s -m 10 "http://127.0.0.1:$RELAY_PORT/health" || true)"
    python3 -c 'import json,sys; s=json.loads(sys.argv[1]).get("sponsor",{}); sys.exit(0 if s.get("synced") is True and s.get("state")=="synced" else 1)' "$h" 2>/dev/null && { printf '%s\n' "$h"; return 0; }
    sleep 6
  done
  printf '%s\n' "$h"; return 1
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
teardown() {
  set +e
  [[ -z "${CP:-}" ]] && return 0
  if [[ "${ATTACH:-}" == preview ]]; then
    # The preview stays up for the owner (relay with X, node X, site): logs and evidence only.
    say "gate over: the preview keeps running (e2e/stagenet/preview.sh down ends it)"
    [[ -n "${SAMPLER_PID:-}" ]] && kill "$SAMPLER_PID" 2>/dev/null
    [[ -n "${MEM_PID:-}" ]] && kill "$MEM_PID" 2>/dev/null
    docker logs "$CP-relay" >"$OUT/relay.log" 2>&1
    docker logs "$CP-ps8" 2>&1 | tail -300 >"$OUT/proof-server-rc8.tail.log"
    if [[ -f "${RUN:-/nonexistent}/x.env" ]]; then
      docker compose -p "$CP-x" --env-file "$RUN/x.env" -f "$TPL/deploy/standin/compose.bridge.yml" logs --no-color >"$OUT/node-x-container.log" 2>&1
    fi
    save_deployments
    docker ps --format '{{.Names}} {{.Status}}' | grep -E "^$CP" >"$OUT/still-running.txt"
    redact_rpc "$OUT" | tee "$OUT/redaction.txt"
    python3 "$HERE/gate-report.py" "$OUT" || say "WARNING: no gate report"
    return 0
  fi
  say "teardown $CP"
  [[ -n "${SAMPLER_PID:-}" ]] && kill "$SAMPLER_PID" 2>/dev/null
  [[ -n "${MEM_PID:-}" ]] && kill "$MEM_PID" 2>/dev/null
  docker logs "$CP-relay" >"$OUT/relay.log" 2>&1
  docker logs "$CP-site" >"$OUT/site.log" 2>&1
  docker logs "$CP-ps8" 2>&1 | tail -300 >"$OUT/proof-server-rc8.tail.log"
  docker logs "$CP-ps6" 2>&1 | tail -100 >"$OUT/proof-server-rc6.tail.log"
  if [[ -f "${RUN:-/nonexistent}/x.env" ]]; then
    docker compose -p "$CP-x" --env-file "$RUN/x.env" -f "$TPL/deploy/standin/compose.bridge.yml" logs --no-color >"$OUT/node-x-container.log" 2>&1
    docker compose -p "$CP-x" --env-file "$RUN/x.env" -f "$TPL/deploy/standin/compose.bridge.yml" down -v --remove-orphans >/dev/null 2>&1
  fi
  docker ps -a --format '{{.Names}}' | grep -E "^$CP-" | xargs -r docker rm -f >/dev/null 2>&1
  docker volume ls --format '{{.Name}}' | grep -E "^$CP" | xargs -r docker volume rm >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  # The template volume keeps no run file of this gate: the deployment files live in $P5R/deployments.
  save_deployments
  docker run --rm --pull=never --memory 256m -v "$TMPL_VOLUME:/work" "$STEP_IMAGE" sh -c \
    "rm -rf $TROOT/deployments/$DEPLOYMENT.json $TROOT/deployments/$DEPLOYMENT.record.json $TROOT/packages/contracts-midnight/midnight-level-db-deploy" >/dev/null 2>&1
  [[ -n "${RUN:-}" ]] && rm -rf "$RUN"
  sleep 2
  local containers volumes net rundir lock
  containers=$(docker ps -a --format '{{.Names}}' | grep -cE "^$CP")
  volumes=$(docker volume ls --format '{{.Name}}' | grep -cE "^$CP")
  net=$(docker network ls --format '{{.Name}}' | grep -cE "^$NET\$")
  rundir=$([[ -n "${RUN:-}" && -e "$RUN" ]] && echo 1 || echo 0)
  if [[ "${LOCK_TAKEN:-0}" == 1 && "$(cut -d' ' -f1 "$LOCK/holder" 2>/dev/null)" == 00057 ]] && grep -q "$CP" "$LOCK/holder" 2>/dev/null; then
    rm -rf "$LOCK"
  fi
  lock=$([[ -d "$LOCK" ]] && grep -q "$CP" "$LOCK/holder" 2>/dev/null && echo 1 || echo 0)
  printf '{"project":"%s","containers":%s,"volumes":%s,"networks":%s,"runDirLeft":%s,"lockHeld":%s,"at":"%s"}\n' \
    "$CP" "$containers" "$volumes" "$net" "$rundir" "$lock" "$(date -u +%FT%TZ)" | tee "$OUT/down-check.json"
  redact_rpc "$OUT" | tee "$OUT/redaction.txt"
  python3 "$HERE/gate-report.py" "$OUT" || say "WARNING: no gate report"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
gate() {
  : "${OUT:?OUT (the evidence directory) is required}"
  mkdir -p "$OUT" "$P5R/deployments" "$P5R/state"; chmod 700 "$CONF" "$P5R" "$P5R/state"
  [[ "$(git -C "$BRIDGE_WT" rev-parse HEAD)" == "$BRIDGE_PIN" && -z "$(git -C "$BRIDGE_WT" status --porcelain)" ]] \
    || { echo "the 00058 clone is not clean at $BRIDGE_PIN" >&2; exit 1; }
  [[ "$(docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" cat /work/.aa00057-pin 2>/dev/null)" == "$BRIDGE_PIN" ]] \
    || { echo "the template volume is not at $BRIDGE_PIN (run prep)" >&2; exit 1; }
  RELAY_IMAGE="$(cat "$STATE_ROOT/relay-image" 2>/dev/null)"
  docker image inspect "$RELAY_IMAGE" >/dev/null 2>&1 || { echo "no relay image (run prep)" >&2; exit 1; }
  [[ -f "$STATE_ROOT/site-dist/index.html" ]] || { echo "no site build (run prep)" >&2; exit 1; }
  for f in stagenet/temporary-11.seed stagenet/temporary-12.seed devnet/x-operator.json devnet/x-program.json devnet/funder.json; do
    [[ -f "$CONF/$f" && "$(stat -f %Lp "$CONF/$f")" == 600 ]] || { echo "key file $CONF/$f missing or not 600" >&2; exit 1; }
  done
  # The funding lock: looked at once, never taken (Temporary 11-14 are not the ladders' wallets).
  if [[ -e "$FUNDING_LOCK" ]]; then echo "present (not ours; not touched)"; else echo "absent"; fi >"$OUT/funding-lock.txt"

  if [[ "${ATTACH:-}" == preview ]]; then
    # ATTACH=preview: the gate builds on the owner's running preview (e2e/stagenet/preview.sh): its network,
    # provers, relay name and site. The preview's lock is ours (00057); the gate's services stay up after it.
    [[ -f "$PREVIEW_DIR/web-port" ]] || { echo "no running preview" >&2; exit 1; }
    [[ "$(cut -d' ' -f1-4 "$LOCK/holder" 2>/dev/null)" == "00057 P5R preview for" ]] || { echo "the stack lock is not the preview's" >&2; exit 1; }
    CP=aa00057-preview; NET="$CP-net"; LOCK_TAKEN=0
    for c in ps6 ps8 site; do [[ -n "$(docker ps -q -f "name=^$CP-$c\$")" ]] || { echo "the preview's $c is not running" >&2; exit 1; }; done
    DUST_PS=http://proof-server-dust:6300; CONTRACT_PS=http://proof-server-contracts:6300
    DEMO_PACK="${DEMO_PACK:-twUSDC:1000,twBTC:0.1}"  # the preview's pack (the owner claims it too)
    printf '00057 P5R preview for the owner + P5R.0 gate bridge X %s (containers %s-*)\n' "$(date -u +%FT%TZ)" "$CP" >"$LOCK/holder"
    trap 'rc=$?; trap - EXIT; teardown; say "gate exit $rc"; exit $rc' EXIT
    T0=$(date +%s)
    mark gate start
    # A bridge node X already running on the preview keeps running (its Solana sync takes long to catch up
    # from Initialize, and a restart starts it over): its run directory, secrets and API port are reused.
    REUSE_NODE=0
    if [[ -f "$PREVIEW_DIR/gate/x.env" && -n "$(docker ps -q --filter "label=com.docker.compose.project=$CP-x")" ]]; then
      REUSE_NODE=1
      say "reusing the running bridge node X (its sync continues)"
    else
      rm -rf "$PREVIEW_DIR/gate"
    fi
    mkdir -p "$PREVIEW_DIR/gate"; RUN="$PREVIEW_DIR/gate"; chmod 700 "$RUN"
  else
  # The stack lock: wait politely; never remove another holder's lock.
  local waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    if (( waited % 600 == 0 )); then say "the stack lock is held: $(cat "$LOCK/holder" 2>/dev/null || echo '?'); waiting"; fi
    (( waited >= LOCK_WAIT_S )) && { echo "gave up waiting for the stack lock" >&2; exit 1; }
    sleep 60; waited=$((waited + 60))
  done
  CP="aa00057-p5r0-$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')"
  NET="$CP-net"
  LOCK_TAKEN=1
  printf '00057 %s W2 P5R.0 stagenet gate (containers %s-*)\n' "$(date -u +%FT%TZ)" "$CP" >"$LOCK/holder"
  trap 'rc=$?; trap - EXIT; teardown; say "gate exit $rc"; exit $rc' EXIT
  say "lock taken: $(cat "$LOCK/holder")"
  T0=$(date +%s)
  mark gate start

  RUN="$(mktemp -d "${TMPDIR:-/tmp}/aa00057-p5r0.XXXXXX")"; chmod 700 "$RUN"
  fi
  mkdir -p "$RUN"/{secrets-x,nm}; chmod 700 "$RUN/secrets-x" "$RUN/nm"
  # Bridge X's live secrets (00058 README "live mode"): copies, never printed.
  cp "$CONF/devnet/x-operator.json" "$RUN/secrets-x/solana-operator.json"
  cp "$CONF/devnet/x-program.json" "$RUN/secrets-x/solana-bridge-program.json"
  cp "$CONF/stagenet/temporary-12.seed" "$RUN/secrets-x/midnight-operator.seed"
  cp "$CONF/stagenet/temporary-12.seed" "$RUN/secrets-x/midnight-delivery.seed"
  [[ -s "$RUN/secrets-x/storage-password" ]] || gen_storage_password >"$RUN/secrets-x/storage-password"
  cp "$CONF/stagenet/temporary-11.seed" "$RUN/nm/sponsor.seed"
  chmod 600 "$RUN"/secrets-x/* "$RUN/nm/sponsor.seed"
  # The devnet RPC: into the Solana CLIs' config file and the containers' env file only (both 600).
  if [[ -f "$DEVNET_RPC_FILE" ]]; then
    [[ "$(stat -f %Lp "$DEVNET_RPC_FILE")" == 600 ]] || fail "$DEVNET_RPC_FILE must be mode 600"
    DEVNET="$(tr -d ' \r\n' <"$DEVNET_RPC_FILE")"
  fi
  ( umask 077
    printf 'json_rpc_url: "%s"\nwebsocket_url: ""\nkeypair_path: "%s"\naddress_labels:\n  "11111111111111111111111111111111": System Program\ncommitment: confirmed\n' \
      "$DEVNET" "$RUN/secrets-x/solana-operator.json" >"$RUN/solana-cli.yml"
    printf 'SOLANA_DEVNET_RPC_URL=%s\nSOLANA_RPC_URL=%s\n' "$DEVNET" "$DEVNET" >"$RUN/devnet.env"
    printf '%s\n' "$DEVNET" >"$RUN/secrets-x/solana-rpc-url" )
  rm -rf "$RUN/keys-relay" "$RUN/keys-harness" "$RUN/ps-params" "$RUN/ps8-params"
  cp -Rc "$KEYS_SRC" "$RUN/keys-relay"; cp -Rc "$STATE_ROOT/bridge-managed" "$RUN/keys-relay/bridge"
  cp -Rc "$KEYS_SRC" "$RUN/keys-harness"; cp -Rc "$STATE_ROOT/bridge-managed" "$RUN/keys-harness/bridge"
  cp -Rc "$PS_PARAMS_SRC" "$RUN/ps-params"; cp -Rc "$PS8_PARAMS_SRC" "$RUN/ps8-params"
  X_OPERATOR="$(pub "$RUN/secrets-x/solana-operator.json")"; X_PROGRAM="$(pub "$RUN/secrets-x/solana-bridge-program.json")"
  FUNDER="$(pub "$CONF/devnet/funder.json")"
  RELAY_PORT=$(free_port); X_API_PORT=$(free_port); WEB_PORT=$(free_port)
  [[ "${ATTACH:-}" == preview ]] && WEB_PORT="$(cat "$PREVIEW_DIR/web-port")"
  if [[ "${REUSE_NODE:-0}" == 1 ]]; then
    X_API_PORT="$(sed -n 's/^BRIDGE_API_PORT=//p' "$RUN/x.env")"
    RELAY_PORT="$(docker port "$CP-relay" 8080 2>/dev/null | sed -n 's/.*://p' | head -1)"; [[ -n "$RELAY_PORT" ]] || RELAY_PORT=$(free_port)
  fi
  { echo "night-market $(git -C "$ROOT" rev-parse HEAD)$( [[ -n "$(git -C "$ROOT" status --porcelain)" ]] && echo ' (dirty)')"
    echo "00058 $(git -C "$BRIDGE_WT" rev-parse HEAD)"; echo "relay-image $RELAY_IMAGE $(docker image inspect "$RELAY_IMAGE" --format '{{.Id}}')"
    echo "step-image $(docker image inspect "$STEP_IMAGE" --format '{{.Id}}')"
    for i in "$PS6_IMAGE" "$PS8_IMAGE" "$BUN_IMAGE"; do echo "$i $(docker image inspect "$i" --format '{{.Id}}')"; done
    echo "agave $("$AGAVE/solana" --version)"; echo "x-operator $X_OPERATOR"; echo "x-program $X_PROGRAM"; echo "funder $FUNDER"
    echo "ports relay $RELAY_PORT bridge-x $X_API_PORT site $WEB_PORT"
    echo "devnet-rpc $(DEVNET_URL="$DEVNET" python3 -c 'import os, urllib.parse as u; print(u.urlsplit(os.environ["DEVNET_URL"]).hostname)') ($([[ "$DEVNET" == https://api.devnet.solana.com ]] && echo public || echo 'private, key redacted'))"
  } >"$OUT/pins.txt"
  local genesis; genesis="$(sol genesis-hash 2>/dev/null)"
  [[ "$genesis" == "$DEVNET_GENESIS" ]] || fail "the Solana RPC is not devnet (genesis $genesis)"
  snapshot start

  # ── the provers, on the run's own network (ATTACH=preview: the preview's) ──
  if [[ "${ATTACH:-}" != preview ]]; then
  docker network create "$NET" >/dev/null || fail "network"
  docker run -d --name "$CP-ps6" --network "$NET" --network-alias proof-server --memory 4g --pull=never \
    -e PORT=6300 -e MIDNIGHT_PP=/params -v "$RUN/ps-params:/params" "$PS6_IMAGE" >/dev/null || fail "the rc.6 prover"
  docker run -d --name "$CP-ps8" --network "$NET" --network-alias proof-server-rc8 --memory 12g --memory-swap 12g \
    --restart on-failure:5 --pull=never -e PORT=6300 -e MIDNIGHT_PP=/params -v "$RUN/ps8-params:/params" "$PS8_IMAGE" >/dev/null \
    || fail "the rc.8 prover"
  fi
  for p in "$DUST_PS" "$CONTRACT_PS"; do
    local ok=""
    for _ in $(seq 1 60); do
      docker run --rm --network "$NET" --memory 256m --pull=never "$BUN_IMAGE" bun -e \
        "const r = await fetch('$p/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)" >/dev/null 2>&1 && { ok=1; break; }
      sleep 3
    done
    [[ -n "$ok" ]] || fail "$p is not ready"
  done
  nohup bash -c '
    while :; do
      ts=$(date -u +%FT%TZ)
      docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" 2>/dev/null | grep -E "^'"$CP"'" | sed "s/^/$ts /"
      sleep 20
    done' >>"$OUT/mem.log" 2>&1 &
  MEM_PID=$!; disown "$MEM_PID" 2>/dev/null || true

  # ── 1. bridge X: devnet program + mint + Initialize, the stagenet contract, the record ──
  say "==== 1. bridge X on devnet and stagenet"
  mark deploy start
  docker run --rm --pull=never --memory 256m -v "$TMPL_VOLUME:/work" -v "$P5R/deployments:/d:ro" "$STEP_IMAGE" sh -c \
    "mkdir -p $TROOT/deployments; for f in /d/$DEPLOYMENT.json /d/$DEPLOYMENT.record.json; do [ -f \"\$f\" ] && cp \"\$f\" $TROOT/deployments/; done; ls $TROOT/deployments" \
    >"$OUT/deployments-restored.txt" 2>&1 || fail "restore the deployment files"
  # The program account exists = deployed (`solana program show` needs a default signer on this host, so it
  # cannot tell; run 1 found that). deploy-devnet.ts then checks its upgrade authority is x-operator.
  if sol account "$X_PROGRAM" >"$OUT/program-account-before.txt" 2>&1; then
    say "program $X_PROGRAM already deployed (kept)"
  else
    # Q14 A (run 1: `--use-rpc` through the public devnet RPC failed, "Max retries exceeded"): the write
    # transactions go to the leaders' TPU ports (the CLI's default, QUIC), with a small priority fee, into a
    # buffer whose KEYPAIR FILE we hold (so the CLI never prints a recovery phrase; a failed deploy resumes
    # into the same buffer, writing only what is missing). Anything phrase-like it prints is redacted anyway.
    local l0 buf rc
    buf="$CONF/devnet/x-buffer.json"
    if [[ ! -f "$buf" ]]; then
      "$AGAVE/solana-keygen" new --no-bip39-passphrase --silent --outfile "$buf" >/dev/null 2>&1 || fail "the buffer keypair"
      chmod 600 "$buf"
    fi
    echo "buffer $(pub "$buf")" >>"$OUT/pins.txt"
    l0="$(sol_balance "$X_OPERATOR")"
    sol program deploy "$TPL/packages/contracts-solana/build/bridge.so" \
      --keypair "$RUN/secrets-x/solana-operator.json" --upgrade-authority "$RUN/secrets-x/solana-operator.json" \
      --program-id "$RUN/secrets-x/solana-bridge-program.json" --buffer "$buf" --commitment confirmed \
      --with-compute-unit-price "${CU_PRICE:-20000}" --max-sign-attempts "${MAX_SIGN_ATTEMPTS:-30}" --output json \
      >"$OUT/deploy-x-program.json" 2>"$OUT/deploy-x-program.err"
    rc=$?
    redact_phrases "$OUT/deploy-x-program.json" "$OUT/deploy-x-program.err"
    printf '{"lamportsBefore":%s,"lamportsAfter":%s,"exit":%s}\n' "$l0" "$(sol_balance "$X_OPERATOR")" "$rc" >"$OUT/deploy-x-program-cost.json"
    if [[ $rc != 0 ]]; then
      tail -20 "$OUT/deploy-x-program.err"
      # Q14: on a second failure, the buffer's SOL goes back to x-operator, and the gate stops.
      sol program close --buffers --keypair "$RUN/secrets-x/solana-operator.json" \
        --authority "$RUN/secrets-x/solana-operator.json" --recipient "$X_OPERATOR" \
        >"$OUT/close-buffers.log" 2>&1
      echo "close-buffers exit $? lamportsAfterClose $(sol_balance "$X_OPERATOR")" >>"$OUT/close-buffers.log"
      fail "the devnet program deploy (TPU path, buffer $(pub "$buf")); the buffers are closed"
    fi
  fi
  mark program end
  tmpl deploy-sol packages/contracts-solana bun run scripts/deploy-devnet.ts --out "$DEPLOYMENT" --user-tokens 0 2>&1 | tee "$OUT/deploy-x-solana.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "deploy-devnet.ts (mint X + Initialize)"
  save_deployments
  mark solana-deploy end
  TMPL_MEM=6g tmpl deploy-mn packages/contracts-midnight bun run deploy.ts --mode stagenet --out "$DEPLOYMENT" 2>&1 | quiet | tee "$OUT/deploy-x-midnight.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "deploy.ts (the stagenet contract, Temporary 12)"
  save_deployments
  mark midnight-deploy end
  local ok="" a
  for a in 1 2 3 4 5 6; do
    tmpl record . bun run bridge:record --mode live --api http://bridge-x:9999 --name X --symbol X 2>&1 | tee -a "$OUT/record-x.log"
    [[ "${PIPESTATUS[0]}" == 0 ]] && { ok=1; break; }
    sleep 20
  done
  [[ -n "$ok" ]] || fail "bridge:record X"
  for f in "$DEPLOYMENT.json" "$DEPLOYMENT.record.json"; do
    docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" cat "$TROOT/deployments/$f" >"$OUT/$f" || fail "read $f"
    cp "$OUT/$f" "$P5R/deployments/$f"
  done
  MINT_X="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['splMint'])" "$OUT/$DEPLOYMENT.record.json")"
  CONTRACT_X="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['midnight']['contractAddress'])" "$OUT/$DEPLOYMENT.json")"
  contract_deploy_tx "$CONTRACT_X" >"$OUT/deploy-x-midnight-tx.json"
  mark deploy end
  snapshot deployed

  # ── 2. I-1 for stagenet, the relay's and the site's lists ──
  say "==== 2. the journey registry and the token lists"
  bun_nm -v "$RUN/nm:/run/nm" -v "$OUT:/out:ro" --env-file "$RUN/devnet.env" "$BUN_IMAGE" sh -c \
    'exec bun e2e/registry/build.ts "$@" --solana-rpc "$SOLANA_RPC_URL"' _ --network stagenet \
    --genesis "$DEVNET_GENESIS" --out /run/nm/journey-tokens.stagenet.json \
    --site-icons-out /run/nm/site-icons.json "/out/$DEPLOYMENT.record.json" 2>&1 | tee "$OUT/registry-build.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "the journey registry"
  # Fresh lists every run (run 4: a reused run directory still held the relay's list with X, and bridge-tokens
  # refused the duplicate colour).
  rm -f "$RUN/nm/tokens.json"
  echo '{"network":"stagenet","relayUrl":"http://relay:8080"}' >"$RUN/nm/site-config.json"
  bun_nm -v "$RUN/nm:/run/nm" --env-file "$RUN/devnet.env" "$BUN_IMAGE" sh -c \
    'exec bun scripts/bridge-tokens.ts "$@" --solana-rpc "$SOLANA_RPC_URL"' _ /run/nm/journey-tokens.stagenet.json \
    --site-config /run/nm/site-config.json --relay-tokens /run/nm/tokens.json --pairs X/twUSDC --icons /run/nm/site-icons.json \
    2>&1 | tee "$OUT/bridge-tokens.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "bridge-tokens"
  cp "$RUN/nm/journey-tokens.stagenet.json" "$RUN/nm/tokens.json" "$RUN/nm/site-config.json" "$RUN/nm/site-icons.json" "$OUT/"

  # ── 3. the relay, bridge node X, the site ──
  say "==== 3. the relay (sponsor Temporary 11), bridge node X (Temporary 12), the site"
  mark services start
  start_relay || fail "relay start"
  cat >"$RUN/x.env" <<EOF
BRIDGE_HOST=bridge-x
BRIDGE_DEPLOYMENT=$DEPLOYMENT
BRIDGE_SECRETS_HOST_DIR=$RUN/secrets-x
BRIDGE_TEMPLATE_VOLUME=$TMPL_VOLUME
BRIDGE_STACK_NETWORK=$NET
BRIDGE_API_PORT=$X_API_PORT
BRIDGE_RECORD_NAME=X
BRIDGE_RECORD_SYMBOL=X
BRIDGE_MEM_LIMIT=4g
SOLANA_DEVNET_RPC_URL_FILE=/secrets/solana-rpc-url
MIDNIGHT_NETWORK_ID=stagenet
MIDNIGHT_NODE_HTTP=$STG_NODE_WS
MIDNIGHT_INDEXER_HTTP=$STG_INDEXER
MIDNIGHT_INDEXER_WS=$STG_INDEXER_WS
MIDNIGHT_PROOF_SERVER_URL=$DUST_PS
MIDNIGHT_CONTRACT_PROOF_SERVER_URL=$CONTRACT_PS
EOF
  chmod 600 "$RUN/x.env"
  docker compose -p "$CP-x" --env-file "$RUN/x.env" -f "$TPL/deploy/standin/compose.bridge.yml" up -d >/dev/null 2>&1 || fail "bridge node X up"
  local h=""
  for _ in $(seq 1 200); do
    h="$(curl -s -m 10 "http://127.0.0.1:$RELAY_PORT/health" || true)"
    python3 -c 'import json,sys; s=json.loads(sys.argv[1]).get("sponsor",{}); sys.exit(0 if s.get("synced") is True and s.get("state")=="synced" else 1)' "$h" 2>/dev/null && break
    sleep 6
  done
  printf '%s\n' "$h" >"$OUT/relay-health-start.json"
  python3 -c 'import json,sys; s=json.loads(sys.argv[1]).get("sponsor",{}); sys.exit(0 if s.get("synced") is True else 1)' "$h" 2>/dev/null \
    || { docker logs "$CP-relay" 2>&1 | tail -40; fail "the relay's sponsor never synced"; }
  curl -s "http://127.0.0.1:$RELAY_PORT/v1/config" >"$OUT/relay-config.json"
  mark relay ready
  for _ in $(seq 1 300); do curl -sf -m 5 "http://127.0.0.1:$X_API_PORT/deployment" >/dev/null && break; sleep 3; done
  curl -sf -m 5 "http://127.0.0.1:$X_API_PORT/deployment" >"$OUT/deployment-x.json" \
    || { docker compose -p "$CP-x" --env-file "$RUN/x.env" -f "$TPL/deploy/standin/compose.bridge.yml" logs --no-color | tail -40; fail "node X: no /deployment"; }
  python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))==json.load(open(sys.argv[2])) else 1)" \
    "$OUT/deployment-x.json" "$OUT/$DEPLOYMENT.record.json" || fail "node X serves another record than the one recorded"
  mark node ready
  sync_sampler & SAMPLER_PID=$!
  # The site: Night Market's build with a stagenet config.json (the relay behind it on /relay/).
  SITE_DIR="$RUN/site"
  if [[ "${ATTACH:-}" == preview ]]; then SITE_DIR="$PREVIEW_DIR/site"; else rm -rf "$RUN/site"; cp -Rc "$STATE_ROOT/site-dist" "$RUN/site"; fi
  # The site's `solana.rpcUrl` is the private RPC too, for this LOCAL rehearsal only (served on 127.0.0.1; the
  # evidence copy is redacted). A deployment must never ship an API-keyed URL in a public config.json.
  DEVNET_URL="$DEVNET" python3 - "$RUN/nm/site-config.json" "$RUN/nm/journey-tokens.stagenet.json" "$SITE_DIR/config.json.new" "$WEB_PORT" "$X_API_PORT" "$DEVNET_GENESIS" <<'PY'
import json, os, sys
site, journey = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
web = f"http://127.0.0.1:{sys.argv[4]}"
for t in journey["tokens"]:
    t["bridgeApi"] = f"http://127.0.0.1:{sys.argv[5]}"
config = {"network": "stagenet", "relayUrl": f"{web}/relay", "tokens": site.get("tokens"), "pairs": site.get("pairs"),
          "bridges": journey, "solana": {"rpcUrl": os.environ["DEVNET_URL"], "genesisHash": sys.argv[6], "cluster": "solana:devnet"},
          "walletTimeoutSeconds": 300}
json.dump({k: v for k, v in config.items() if v is not None}, open(sys.argv[3], "w"), indent=1)
PY
  chmod 600 "$SITE_DIR/config.json.new"; mv "$SITE_DIR/config.json.new" "$SITE_DIR/config.json"
  cp "$SITE_DIR/config.json" "$OUT/site-config.served.json"
  if [[ "${ATTACH:-}" != preview ]]; then
  docker run -d --name "$CP-site" --network "$NET" --memory 256m --pull=never -p "127.0.0.1:$WEB_PORT:8080" \
    -v "$RUN/site:/site:ro" -v "$HERE/site-server.ts:/srv/site-server.ts:ro" -e RELAY_UPSTREAM=http://relay:8080/ \
    -e KERNEL_UPSTREAM=https://stagenet.api-zswap.zkdojo.com/ -e BATCHER_UPSTREAM=https://stagenet.batcher-zswap.zkdojo.com/ \
    "$BUN_IMAGE" bun /srv/site-server.ts >/dev/null || fail "site server"
  fi
  for _ in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT/config.json" && break; sleep 1; done
  { echo "index $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")"
    echo "config $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/config.json")"
    echo "relay-health-through-site $(curl -s -m 10 "http://127.0.0.1:$WEB_PORT/relay/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sponsor",{}).get("synced"))' 2>/dev/null)"
  } | tee "$OUT/site-check.txt"
  grep -q '^index 200' "$OUT/site-check.txt" && grep -q '^config 200' "$OUT/site-check.txt" && grep -q 'through-site True' "$OUT/site-check.txt" \
    || fail "the site does not serve its page, its config or the relay"
  mark services end
  snapshot services

  # ── 4. accounts A and B ──
  say "==== 4. two fresh Passport accounts on stagenet"
  mark accounts start
  flows open-a JOURNEY_STEP=gate || fail "open A"
  flows open-b JOURNEY_STEP=gate || fail "open B"
  landing JOURNEY_STEP=gate STEP=adopt-bridges || fail "adopt-bridges"
  landing JOURNEY_STEP=gate STEP=wallets >"$RUN/wallets.txt" || fail "wallets"
  WALLET_A=$(awk '/^WALLET_A /{print $2}' "$RUN/wallets.txt")
  [[ -n "$WALLET_A" ]] || fail "no wallet A"
  grep -E '^(WALLET|ACCOUNT)_' "$RUN/wallets.txt" >"$OUT/parties.txt"
  mark accounts end
  snapshot accounts

  # ── 5. A's wallet on devnet: SOL and 2 X ──
  say "==== 5. A's Solana wallet $WALLET_A: SOL and 2 X"
  local lamA; lamA="$(sol_balance "$WALLET_A")"; lamA="${lamA:-0}"
  if (( lamA < 20000000 )); then
    if sol airdrop 0.1 "$WALLET_A" --commitment confirmed >"$OUT/airdrop-a.log" 2>&1; then
      say "devnet airdrop 0.1 SOL to A"
    else
      say "the devnet airdrop was refused ($(tail -1 "$OUT/airdrop-a.log")); 0.05 SOL from the funder"
      sol transfer "$WALLET_A" 0.05 --from "$CONF/devnet/funder.json" --fee-payer "$CONF/devnet/funder.json" \
        --allow-unfunded-recipient --commitment confirmed >"$OUT/transfer-sol-to-a.log" 2>&1 \
        || { cat "$OUT/transfer-sol-to-a.log"; fail "0.05 SOL to A"; }
    fi
  fi
  local ataA haveX
  ataA="$(spl address --token "$MINT_X" --owner "$WALLET_A" --verbose 2>/dev/null | awk '/Associated token address/{print $NF}')"
  [[ -n "$ataA" ]] || fail "no associated token address for A"
  if ! haveX="$(spl balance --address "$ataA" 2>/dev/null)"; then
    # A's token account for X, paid by x-operator (A's SOL is for its own lock fees).
    spl create-account "$MINT_X" --owner "$WALLET_A" --fee-payer "$RUN/secrets-x/solana-operator.json" \
      >"$OUT/create-ata-a.log" 2>&1 || { cat "$OUT/create-ata-a.log"; fail "A's token account for X"; }
    haveX=0
  fi
  if python3 -c "import sys; sys.exit(0 if float(sys.argv[1] or 0) < 2 else 1)" "$haveX"; then
    local auth authkey="$RUN/secrets-x/solana-operator.json"
    auth="$(spl display "$MINT_X" 2>/dev/null | awk '/Mint authority/{print $NF}')"
    [[ "$auth" == "$(pub "$CONF/devnet/faucet.json")" ]] && authkey="$CONF/devnet/faucet.json"
    spl mint "$MINT_X" 2 "$ataA" --mint-authority "$authkey" \
      --fee-payer "$RUN/secrets-x/solana-operator.json" >"$OUT/mint-x-to-a.log" 2>&1 \
      || { cat "$OUT/mint-x-to-a.log"; fail "mint 2 X to A"; }
  fi
  echo "X on A's wallet: $(spl balance --address "$ataA" 2>/dev/null)" | tee "$OUT/wallet-a-x.txt"
  snapshot funded

  # ── the node's Solana sync must be near devnet's tip before the lock (it started from Initialize) ──
  say "==== waiting for bridge node X's Solana sync to reach devnet's tip"
  mark node-catch-up start
  local waited_s=0 lag=""
  while :; do
    lag="$(DEVNET_URL="$DEVNET" python3 - "http://127.0.0.1:$X_API_PORT/block-heights" <<'PY'
import json, os, sys, urllib.request
try:
    bh = json.load(urllib.request.urlopen(sys.argv[1], timeout=10))
    node = next(int(r["synced_page"]) for r in bh if "olana" in r["protocol_name"])
    req = urllib.request.Request(os.environ["DEVNET_URL"], data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getSlot", "params": [{"commitment": "confirmed"}]}).encode(), headers={"content-type": "application/json"})
    tip = json.load(urllib.request.urlopen(req, timeout=10))["result"]
    print(tip - node)
except Exception:
    print("")
PY
)"
    printf '{"t":%s,"lagSlots":"%s"}\n' "$(date +%s)" "$lag" >>"$OUT/node-catch-up.jsonl"
    [[ -n "$lag" ]] && (( lag <= 150 )) && break
    (( waited_s >= ${NODE_SYNC_WAIT_S:-5400} )) && fail "bridge node X's Solana sync is still $lag slots behind devnet after $waited_s s"
    (( waited_s % 300 == 0 )) && say "node X is $lag slots behind devnet's tip"
    sleep 30; waited_s=$((waited_s + 30))
  done
  mark node-catch-up end

  # ── 6. (a) 1 X in ──
  say "==== 6. (a) A's page bridges 1 X in (delivered into account A)"
  mark a start
  landing JOURNEY_STEP=a WHO=A STEP=bridge-in SYMBOL=X "AMOUNT=$GATE_AMOUNT" LABEL=gate-a || fail "(a) the Bridge in of 1 X"
  mark a end
  snapshot a

  # ── 7. (b) 1 X out ──
  say "==== 7. (b) A's page bridges 1 X out to its wallet on devnet"
  mark b start
  landing JOURNEY_STEP=b STEP=out OUT_CASE=whole OUT_SYMBOL=X "OUT_AMOUNT=$GATE_AMOUNT" || fail "(b) the Bridge out of 1 X"
  mark b end
  snapshot b

  # ── 8. (c) 1 X in again; B's twUSDC; A makes, B takes ──
  say "==== 8. (c) A brings 1 X in again; B claims twUSDC; A offers 1 X for 1 twUSDC; B takes"
  mark c start
  landing JOURNEY_STEP=c WHO=A STEP=bridge-in SYMBOL=X "AMOUNT=$GATE_AMOUNT" LABEL=gate-c || fail "(c) the second Bridge in of 1 X"
  snapshot c-in
  flows demo-b JOURNEY_STEP=c || fail "(c) B's demo pack"
  snapshot c-demo
  flows make,take JOURNEY_STEP=c GIVE_SYMBOL=X "GIVE_AMOUNT=$GATE_AMOUNT" WANT_SYMBOL=twUSDC "WANT_AMOUNT=$UNIT" \
    || fail "(c) A's offer of 1 X for 1 twUSDC, B's take"
  mark c end
  snapshot c

  # ── 9. the transactions' fees ──
  python3 - "$OUT" <<'PY' >"$OUT/node-txs.txt"
import json, sys, glob
seen = set()
for f in sorted(glob.glob(f"{sys.argv[1]}/transfers-*.json")):
    try: body = json.load(open(f))
    except Exception: continue
    for t in body.get("transfers", body if isinstance(body, list) else []):
        for k in ("dstRef", "srcRef"):
            v = t.get(k)
            if v and t.get("direction") == "s2m" and k == "dstRef" and v not in seen: seen.add(v); print(v)
        d = t.get("delivery") or {}
        if d.get("tx") and d["tx"] not in seen: seen.add(d["tx"]); print(d["tx"])
PY
  : >"$OUT/node-tx-fees.jsonl"
  while read -r tx; do [[ -n "$tx" ]] && tx_fees "$tx" >>"$OUT/node-tx-fees.jsonl"; done <"$OUT/node-txs.txt"
  mark gate end
  say "GATE PASS in $(( $(date +%s) - T0 )) s"
  echo PASS >"$OUT/result.txt"
}

# rpc-check: the devnet RPC as the gate will use it (read only): the CLI config and env file, the genesis hash,
# a recent block with version-1 transactions, and the redaction of a file that holds the URL. Prints no secret.
rpc_check() {
  RUN="$(mktemp -d "${TMPDIR:-/tmp}/aa00057-rpccheck.XXXXXX")"; chmod 700 "$RUN"; mkdir -p "$RUN/secrets-x" "$RUN/out"
  trap 'rm -rf "$RUN"' EXIT
  cp "$CONF/devnet/x-operator.json" "$RUN/secrets-x/solana-operator.json"; chmod 600 "$RUN/secrets-x/solana-operator.json"
  if [[ -f "$DEVNET_RPC_FILE" ]]; then
    [[ "$(stat -f %Lp "$DEVNET_RPC_FILE")" == 600 ]] || { echo "$DEVNET_RPC_FILE must be mode 600" >&2; exit 1; }
    DEVNET="$(tr -d ' \r\n' <"$DEVNET_RPC_FILE")"
  fi
  ( umask 077
    printf 'json_rpc_url: "%s"\nwebsocket_url: ""\nkeypair_path: "%s"\naddress_labels:\n  "11111111111111111111111111111111": System Program\ncommitment: confirmed\n' \
      "$DEVNET" "$RUN/secrets-x/solana-operator.json" >"$RUN/solana-cli.yml" )
  local g; g="$(sol genesis-hash 2>/dev/null)"
  echo "genesis $([[ "$g" == "$DEVNET_GENESIS" ]] && echo devnet-ok || echo "MISMATCH")"
  echo "x-operator lamports $(sol_balance "$(pub "$RUN/secrets-x/solana-operator.json")")"
  DEVNET_URL="$DEVNET" python3 - <<'PY'
import json, os, time, urllib.request, urllib.error
url = os.environ["DEVNET_URL"]
def rpc(m, p):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(), headers={"content-type": "application/json"})
    try:
        return 200, json.load(urllib.request.urlopen(req, timeout=30))
    except urllib.error.HTTPError as e:
        return e.code, {}
_, b = rpc("getSlot", [{"commitment": "confirmed"}])
tip = b["result"]
t0 = time.time(); codes = {}; v1 = 0; errs = 0
for s in range(tip - 300, tip - 280):
    c, b = rpc("getBlock", [s, {"encoding": "json", "transactionDetails": "full", "rewards": False, "maxSupportedTransactionVersion": 1, "commitment": "confirmed"}])
    codes[c] = codes.get(c, 0) + 1
    if "error" in b: errs += 1
    for t in (b.get("result") or {}).get("transactions", []):
        if t.get("version") == 1: v1 += 1
print(json.dumps({"getBlock": 20, "seconds": round(time.time() - t0, 1), "httpCodes": codes, "rpcErrors": errs, "v1Transactions": v1}))
PY
  echo "a line with $DEVNET inside" >"$RUN/out/probe.txt"
  redact_rpc "$RUN/out"
  grep -c 'REDACTED devnet RPC' "$RUN/out/probe.txt" | sed 's/^/redaction marks: /'
}

# faucet-x (after a PASSING gate, ATTACH=preview): X's mint authority goes to the dedicated devnet faucet key
# (00060 Q7 A: `spl-token authorize <mint> mint <faucet>`, signed by x-operator), and the preview's relay
# restarts with its test SPL faucet ("Mint Solana tokens") holding that key. OUT=<evidence dir>.
faucet_x() {
  : "${OUT:?OUT (the evidence directory) is required}"
  mkdir -p "$OUT"
  RUN="$PREVIEW_DIR/gate"; CP=aa00057-preview; NET="$CP-net"
  [[ -f "$RUN/x.env" && -f "$RUN/solana-cli.yml" ]] || { echo "no gate state in $RUN (run ATTACH=preview gate first)" >&2; exit 1; }
  [[ "$(cut -d' ' -f1-4 "$LOCK/holder" 2>/dev/null)" == "00057 P5R preview for" ]] || { echo "the stack lock is not the preview's" >&2; exit 1; }
  [[ -f "$CONF/devnet/faucet.json" && "$(stat -f %Lp "$CONF/devnet/faucet.json")" == 600 ]] || { echo "no faucet key" >&2; exit 1; }
  DEVNET="$(tr -d ' \r\n' <"$DEVNET_RPC_FILE")"
  DUST_PS=http://proof-server-dust:6300; CONTRACT_PS=http://proof-server-contracts:6300
  DEMO_PACK="${DEMO_PACK:-twUSDC:1000,twBTC:0.1}"
  RELAY_IMAGE="$(cat "$STATE_ROOT/relay-image")"
  local mint faucet xop auth
  mint="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['splMint'])" "$P5R/deployments/$DEPLOYMENT.record.json")"
  faucet="$(pub "$CONF/devnet/faucet.json")"; xop="$(pub "$RUN/secrets-x/solana-operator.json")"
  auth="$(spl display "$mint" 2>/dev/null | awk '/Mint authority/{print $NF}')"
  echo "mint $mint authority before $auth" | tee "$OUT/faucet-x.txt"
  if [[ "$auth" == "$xop" ]]; then
    spl authorize "$mint" mint "$faucet" --authority "$RUN/secrets-x/solana-operator.json" \
      --fee-payer "$RUN/secrets-x/solana-operator.json" >"$OUT/authorize-x.log" 2>&1 || { cat "$OUT/authorize-x.log"; exit 1; }
  elif [[ "$auth" != "$faucet" ]]; then
    echo "mint authority $auth is neither x-operator nor the faucet key" >&2; exit 1
  fi
  auth="$(spl display "$mint" 2>/dev/null | awk '/Mint authority/{print $NF}')"
  echo "mint $mint authority after $auth (faucet $faucet)" | tee -a "$OUT/faucet-x.txt"
  [[ "$auth" == "$faucet" ]] || { echo "the handover did not take" >&2; exit 1; }
  ( umask 077; printf 'SPL_FAUCET_RPC_URL=%s\n' "$DEVNET" >"$RUN/faucet.env" )
  bun_nm -v "$RUN/nm:/run/nm" -v "$CONF/devnet/faucet.json:/keys/faucet.json:ro" --env-file "$RUN/devnet.env" "$BUN_IMAGE" sh -c \
    'exec bun relay/src/tools/spl-faucet-keys.ts --journey /run/nm/journey-tokens.stagenet.json --rpc "$SOLANA_RPC_URL" --out /run/nm/spl-faucet-keys.json /keys/faucet.json' \
    2>&1 | tee "$OUT/spl-faucet-keys.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { echo "spl-faucet-keys" >&2; exit 1; }
  chmod 600 "$RUN/nm/spl-faucet-keys.json"
  RELAY_PORT="$(docker port "$CP-relay" 8080 2>/dev/null | sed -n 's/.*://p' | head -1)"; [[ -n "$RELAY_PORT" ]] || RELAY_PORT=$(free_port)
  start_relay || { echo "relay restart" >&2; exit 1; }
  relay_synced >"$OUT/relay-health-faucet.json" || { docker logs "$CP-relay" 2>&1 | tail -30; echo "the relay did not come back" >&2; exit 1; }
  curl -s "http://127.0.0.1:$RELAY_PORT/v1/config" >"$OUT/relay-config-faucet.json"
  curl -s "http://127.0.0.1:$RELAY_PORT/v1/spl-faucet" >"$OUT/spl-faucet-info.json"
  redact_rpc "$OUT" >"$OUT/redaction-faucet.txt"
  echo "faucet: $(head -c 400 "$OUT/spl-faucet-info.json")"
}

# relay-restart (ATTACH=preview, after a gate ran on the preview): the preview's relay again, with the gate's
# configuration (bridge X; the SPL faucet if faucet-x ran). No transaction.
relay_restart() {
  RUN="$PREVIEW_DIR/gate"; CP=aa00057-preview; NET="$CP-net"
  [[ -f "$RUN/x.env" ]] || { echo "no gate state in $RUN" >&2; exit 1; }
  [[ "$(cut -d' ' -f1-4 "$LOCK/holder" 2>/dev/null)" == "00057 P5R preview for" ]] || { echo "the stack lock is not the preview's" >&2; exit 1; }
  DUST_PS=http://proof-server-dust:6300; CONTRACT_PS=http://proof-server-contracts:6300
  DEMO_PACK="${DEMO_PACK:-twUSDC:1000,twBTC:0.1}"
  RELAY_IMAGE="$(cat "$STATE_ROOT/relay-image")"
  RELAY_PORT="$(docker port "$CP-relay" 8080 2>/dev/null | sed -n 's/.*://p' | head -1)"; [[ -n "$RELAY_PORT" ]] || RELAY_PORT=$(free_port)
  start_relay || { echo "relay start" >&2; exit 1; }
  relay_synced >/dev/null || { docker logs "$CP-relay" 2>&1 | tail -5 | cut -c1-300; echo "the relay did not sync" >&2; exit 1; }
  echo "relay up (sponsor synced), 127.0.0.1:$RELAY_PORT"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# P5R.1 (the owner's video, 2026-10-05), on the owner's running preview after a passing ATTACH=preview gate.
# Every command takes OUT=<evidence dir> (public; the private RPC is redacted from it):
#   bridge-y          bridge Y like X: the devnet program (y-program; y-operator = payer, upgrade authority,
#                     operator; TPU path into a buffer whose keypair file we hold), mint Y + Initialize
#                     (deploy-devnet.ts), the stagenet contract paid by Temporary 13 (deploy.ts), the record;
#                     node Y starts at devnet's tip - 150 once the chain shows no transaction of the program,
#                     its config, authority or vault after Initialize (and an empty vault); then B's devnet
#                     wallet gets SOL and B_Y_MINT Y from y-operator (before the faucet hand-over)
#   faucet-handover   00060 Q7 A: X's and Y's mint authority -> the dedicated faucet key (spl-token authorize,
#                     signed by each operator); no service restarts
#   injector          (FIRST, the orchestrator ~22:10Z) the devnet RPC proxy (rpc-proxy.ts) and the 00059
#                     injector on stagenet (registry X [+Y], a token file with Night Market's tokens), and
#                     `injector.url` added to the site's served config.json in place: no relay or site restart
#   stage-update      (no restart) the registry X+Y, the relay's and the site's lists (X/twUSDC, Y/twUSDC, X/Y),
#                     the faucet keys file, staged in the run directory, and the site's next config.json staged
#                     outside the served directory; the injector's files refreshed (it reloads them)
#   preview-update    (COORDINATED: the owner uses the page) ONE relay restart with the staged files (only when
#                     its queue is idle and no bridge transfer is in flight), then the staged site config.json
#                     swapped in (the site server reads it per request: no site restart)
#   bridge-in-b       B bridges B_Y_IN (default 20) of Y in (the page's Bridge in); no relay restart needed
#   offer-b           B lists GIVE 10 Y for WANT 10 X (after preview-update: the relay must know Y)
#   relist-b          B lists the same offer again (an offer lives at most the relay's 3600 s)
#   inject-a          account A registers with the injector (the page's I-4 operations): its wallet must show
#                     A's Midnight holdings (Token-2022 accounts, names) through the injector's RPC
# ═════════════════════════════════════════════════════════════════════════════════════════════
INJECTOR_REPO="${INJECTOR_REPO:-$(sed -n 's/^INJECTOR_REPO="${INJECTOR_REPO:-\(.*\)}"$/\1/p' "$E2E/run-local.sh")}"
INJECTOR_PIN="$(sed -n 's/^INJECTOR_PIN=//p' "$E2E/run-local.sh")"
INJECTOR_IMAGE=s00059/service:aa00057-preview

preview_ctx() {
  : "${OUT:?OUT (the evidence directory) is required}"
  mkdir -p "$OUT"
  RUN="$PREVIEW_DIR/gate"; CP=aa00057-preview; NET="$CP-net"
  [[ -f "$RUN/x.env" && -f "$RUN/solana-cli.yml" && -f "$RUN/devnet.env" && -f "$RUN/wallets.txt" ]] \
    || { echo "no gate state in $RUN (a passing ATTACH=preview gate first)" >&2; exit 1; }
  [[ "$(cut -d' ' -f1-4 "$LOCK/holder" 2>/dev/null)" == "00057 P5R preview for" ]] || { echo "the stack lock is not the preview's" >&2; exit 1; }
  [[ "$(git -C "$BRIDGE_WT" rev-parse HEAD)" == "$BRIDGE_PIN" && -z "$(git -C "$BRIDGE_WT" status --porcelain)" ]] \
    || { echo "the 00058 clone is not clean at $BRIDGE_PIN" >&2; exit 1; }
  [[ "$(docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" cat /work/.aa00057-pin 2>/dev/null)" == "$BRIDGE_PIN" ]] \
    || { echo "the template volume is not at $BRIDGE_PIN" >&2; exit 1; }
  [[ -f "$DEVNET_RPC_FILE" && "$(stat -f %Lp "$DEVNET_RPC_FILE")" == 600 ]] || { echo "$DEVNET_RPC_FILE missing or not 600" >&2; exit 1; }
  DEVNET="$(tr -d ' \r\n' <"$DEVNET_RPC_FILE")"
  DUST_PS=http://proof-server-dust:6300; CONTRACT_PS=http://proof-server-contracts:6300
  DEMO_PACK="${DEMO_PACK:-twUSDC:1000,twBTC:0.1}"
  RELAY_IMAGE="$(cat "$STATE_ROOT/relay-image")"
  RELAY_PORT="$(docker port "$CP-relay" 8080 2>/dev/null | sed -n 's/.*://p' | head -1)"
  WEB_PORT="$(cat "$PREVIEW_DIR/web-port")"
  X_API_PORT="$(sed -n 's/^BRIDGE_API_PORT=//p' "$RUN/x.env")"
  Y_API_PORT="$( [[ -f "$RUN/y.env" ]] && sed -n 's/^BRIDGE_API_PORT=//p' "$RUN/y.env")"
  X_OPERATOR="$(pub "$RUN/secrets-x/solana-operator.json")"; FUNDER="$(pub "$CONF/devnet/funder.json")"
  FAUCET_PUB="$(pub "$CONF/devnet/faucet.json")"
  WALLET_A=$(awk '/^WALLET_A /{print $2}' "$RUN/wallets.txt"); WALLET_B=$(awk '/^WALLET_B /{print $2}' "$RUN/wallets.txt")
  MINT_X="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['splMint'])" "$P5R/deployments/p5r-x.record.json")"
  MINT_Y="$( [[ -f "$P5R/deployments/p5r-y.record.json" ]] && python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['splMint'])" "$P5R/deployments/p5r-y.record.json")"
  # Whatever happens, the evidence keeps no private RPC URL.
  trap 'rc=$?; redact_rpc "$OUT" >/dev/null 2>&1; exit $rc' EXIT
}
# The public SOL balances of the parties (lamports), one JSON line.
sol_snapshot() { # <label>
  local y=""; [[ -f "$RUN/secrets-y/solana-operator.json" ]] && y="$(sol_balance "$(pub "$RUN/secrets-y/solana-operator.json")")"
  printf '{"label":"%s","at":"%s","lamports":{"xOperator":"%s","yOperator":"%s","funder":"%s","faucet":"%s","walletA":"%s","walletB":"%s"}}\n' \
    "$1" "$(date -u +%FT%TZ)" "$(sol_balance "$X_OPERATOR")" "$y" "$(sol_balance "$FUNDER")" "$(sol_balance "$FAUCET_PUB")" \
    "$(sol_balance "$WALLET_A")" "$(sol_balance "$WALLET_B")" >>"$OUT/sol-snapshots.jsonl"
}
relay_dust() { # the sponsor's settled DUST (DUST, 3 decimals) and its queue, one JSON line
  curl -s -m 10 "http://127.0.0.1:$RELAY_PORT/health" | python3 -c '
import json, sys, time
h = json.load(sys.stdin); s = h.get("sponsor", {}); lanes = h.get("queue", {}).get("lanes", {})
print(json.dumps({"t": int(time.time()), "synced": s.get("synced"), "dust": round(int(s.get("dustSpecks") or 0) / 1e15, 6),
                  "busy": {k: [l.get("running", 0), l.get("waiting", 0)] for k, l in lanes.items()}}))' 2>/dev/null
}

bridge_y() {
  preview_ctx
  local f
  for f in stagenet/temporary-13.seed devnet/y-operator.json devnet/y-program.json devnet/funder.json; do
    [[ -f "$CONF/$f" && "$(stat -f %Lp "$CONF/$f")" == 600 ]] || { echo "key file $CONF/$f missing or not 600" >&2; exit 1; }
  done
  TW=y; DEPLOYMENT=p5r-y
  mkdir -p "$RUN/secrets-y"; chmod 700 "$RUN/secrets-y"
  cp "$CONF/devnet/y-operator.json" "$RUN/secrets-y/solana-operator.json"
  cp "$CONF/devnet/y-program.json" "$RUN/secrets-y/solana-bridge-program.json"
  cp "$CONF/stagenet/temporary-13.seed" "$RUN/secrets-y/midnight-operator.seed"
  cp "$CONF/stagenet/temporary-13.seed" "$RUN/secrets-y/midnight-delivery.seed"
  [[ -s "$RUN/secrets-y/storage-password" ]] || gen_storage_password >"$RUN/secrets-y/storage-password"
  ( umask 077; printf '%s\n' "$DEVNET" >"$RUN/secrets-y/solana-rpc-url" )
  chmod 600 "$RUN"/secrets-y/*
  local Y_OPERATOR Y_PROGRAM
  Y_OPERATOR="$(pub "$RUN/secrets-y/solana-operator.json")"; Y_PROGRAM="$(pub "$RUN/secrets-y/solana-bridge-program.json")"
  { echo "night-market $(git -C "$ROOT" rev-parse HEAD)$( [[ -n "$(git -C "$ROOT" status --porcelain)" ]] && echo ' (dirty)')"
    echo "00058 $(git -C "$BRIDGE_WT" rev-parse HEAD) (tree = 1826317, the #942 merge)"; echo "y-operator $Y_OPERATOR"; echo "y-program $Y_PROGRAM"
    echo "midnight payer Temporary 13"; echo "agave $("$AGAVE/solana" --version)"
  } >"$OUT/pins-y.txt"
  [[ "$(sol genesis-hash 2>/dev/null)" == "$DEVNET_GENESIS" ]] || { echo "the Solana RPC is not devnet" >&2; exit 1; }
  sol_snapshot y-start
  say "==== Y1. bridge Y: the devnet program $Y_PROGRAM"
  docker run --rm --pull=never --memory 256m -v "$TMPL_VOLUME:/work" -v "$P5R/deployments:/d:ro" "$STEP_IMAGE" sh -c \
    "mkdir -p $TROOT/deployments; for f in /d/$DEPLOYMENT.json /d/$DEPLOYMENT.record.json; do [ -f \"\$f\" ] && cp \"\$f\" $TROOT/deployments/; done; ls $TROOT/deployments" \
    >"$OUT/deployments-restored-y.txt" 2>&1 || { echo "restore the deployment files" >&2; exit 1; }
  if sol account "$Y_PROGRAM" >"$OUT/program-y-account-before.txt" 2>&1; then
    say "program $Y_PROGRAM already deployed (kept)"
  else
    local l0 buf rc
    buf="$CONF/devnet/y-buffer.json"
    if [[ ! -f "$buf" ]]; then
      "$AGAVE/solana-keygen" new --no-bip39-passphrase --silent --outfile "$buf" >/dev/null 2>&1 || { echo "the buffer keypair" >&2; exit 1; }
      chmod 600 "$buf"
    fi
    echo "buffer $(pub "$buf")" >>"$OUT/pins-y.txt"
    l0="$(sol_balance "$Y_OPERATOR")"
    # Q14 A: the TPU path (no --use-rpc), a buffer whose KEYPAIR FILE we hold (no recovery phrase printed).
    sol program deploy "$TPL/packages/contracts-solana/build/bridge.so" \
      --keypair "$RUN/secrets-y/solana-operator.json" --upgrade-authority "$RUN/secrets-y/solana-operator.json" \
      --program-id "$RUN/secrets-y/solana-bridge-program.json" --buffer "$buf" --commitment confirmed \
      --with-compute-unit-price "${CU_PRICE:-20000}" --max-sign-attempts "${MAX_SIGN_ATTEMPTS:-30}" --output json \
      >"$OUT/deploy-y-program.json" 2>"$OUT/deploy-y-program.err"
    rc=$?
    redact_phrases "$OUT/deploy-y-program.json" "$OUT/deploy-y-program.err"
    printf '{"lamportsBefore":%s,"lamportsAfter":%s,"exit":%s}\n' "$l0" "$(sol_balance "$Y_OPERATOR")" "$rc" >"$OUT/deploy-y-program-cost.json"
    if [[ $rc != 0 ]]; then
      tail -20 "$OUT/deploy-y-program.err"
      echo "STOPPED: the devnet program deploy of Y (TPU path, buffer $(pub "$buf")); the buffer is kept for a resume" >"$OUT/stopped.txt"
      redact_rpc "$OUT" >/dev/null; exit 1
    fi
  fi
  say "==== Y1. mint Y + Initialize (deploy-devnet.ts)"
  tmpl deploy-sol-y packages/contracts-solana bun run scripts/deploy-devnet.ts --out "$DEPLOYMENT" --user-tokens 0 2>&1 | tee "$OUT/deploy-y-solana.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { redact_rpc "$OUT" >/dev/null; echo "STOPPED: deploy-devnet.ts (mint Y + Initialize)" | tee "$OUT/stopped.txt"; exit 1; }
  save_deployments
  say "==== Y1. the stagenet contract (deploy.ts, Temporary 13)"
  # X's deploy run (gate run 3) left its private-state store in the deploy directory under X's storage password;
  # it is moved aside (kept) so Y's deploy opens a fresh store under Y's own password.
  docker run --rm --pull=never --memory 256m -v "$TMPL_VOLUME:/work" "$STEP_IMAGE" sh -c \
    "d=$TROOT/packages/contracts-midnight/midnight-level-db-deploy; if [ -d \$d ]; then mv \$d \$d.before-y-\$(date +%s); fi" \
    >/dev/null 2>&1
  TMPL_MEM=6g tmpl deploy-mn-y packages/contracts-midnight bun run deploy.ts --mode stagenet --out "$DEPLOYMENT" 2>&1 | quiet | tee "$OUT/deploy-y-midnight.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { save_deployments; redact_rpc "$OUT" >/dev/null; echo "STOPPED: deploy.ts (the stagenet contract of Y, Temporary 13)" | tee "$OUT/stopped.txt"; exit 1; }
  save_deployments
  local ok="" a
  for a in 1 2 3 4 5 6; do
    tmpl record-y . bun run bridge:record --mode live --api http://bridge-y:9999 --name Y --symbol Y 2>&1 | tee -a "$OUT/record-y.log"
    [[ "${PIPESTATUS[0]}" == 0 ]] && { ok=1; break; }
    sleep 20
  done
  [[ -n "$ok" ]] || { redact_rpc "$OUT" >/dev/null; echo "STOPPED: bridge:record Y" | tee "$OUT/stopped.txt"; exit 1; }
  save_deployments
  cp "$P5R/deployments/$DEPLOYMENT.json" "$OUT/$DEPLOYMENT.initialize.json"
  local contract; contract="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['midnight']['contractAddress'])" "$P5R/deployments/$DEPLOYMENT.json")"
  contract_deploy_tx "$contract" >"$OUT/deploy-y-midnight-tx.json"
  sol_snapshot y-deployed

  # ── node Y's Solana start: the tip - 150, once nothing happened on the bridge after Initialize ──
  say "==== Y1. node Y's start slot (verify: no transaction after Initialize; the vault is empty)"
  DEVNET_URL="$DEVNET" python3 - "$P5R/deployments/$DEPLOYMENT.json" >"$OUT/start-slot-verification-y.json" <<'PY'
import json, os, sys, time, urllib.request
url = os.environ["DEVNET_URL"]
def rpc(m, p):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(),
                                 headers={"content-type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=30))
    if "error" in r: raise RuntimeError(f"{m}: {r['error']}")
    return r["result"]
s = json.load(open(sys.argv[1]))["solana"]
checks, latest = {}, 0
for k in ("programId", "config", "authority", "vault"):
    sigs = rpc("getSignaturesForAddress", [s[k], {"limit": 1000, "commitment": "confirmed"}])
    slots = sorted({x["slot"] for x in sigs})
    checks[k] = {"address": s[k], "signatures": len(sigs), "slots": slots, "errors": [x["err"] for x in sigs if x.get("err")]}
    latest = max([latest] + slots)
init = checks["config"]["slots"]
vault = rpc("getTokenAccountBalance", [s["vault"], {"commitment": "confirmed"}])["value"]["amount"]
tip = rpc("getSlot", [{"commitment": "confirmed"}])
safe = len(init) == 1 and latest <= init[0] and vault == "0" and all(not c["errors"] for c in checks.values())
new = tip - 150
print(json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "checks": checks, "initializeSlot": init[0] if init else None,
                  "recordedStartSlot": s["startSlot"], "vaultBalance": vault, "tipSlot": tip, "newStartSlot": new if safe and new > s["startSlot"] else s["startSlot"],
                  "latestActivitySlot": latest, "safe": safe}, indent=1))
PY
  local verdict newslot
  verdict="$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d['safe'], d['newStartSlot'], d['recordedStartSlot'])" "$OUT/start-slot-verification-y.json")" \
    || { echo "STOPPED: the start-slot verification of Y" | tee "$OUT/stopped.txt"; exit 1; }
  say "start-slot verification: $verdict"
  newslot="$(echo "$verdict" | awk '{print $2}')"
  if [[ "$(echo "$verdict" | awk '{print $1}')" == True && "$newslot" != "$(echo "$verdict" | awk '{print $3}')" ]]; then
    python3 - "$P5R/deployments/$DEPLOYMENT.json" "$newslot" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["solana"]["startSlot"] = int(sys.argv[2])
json.dump(d, open(sys.argv[1], "w"), indent=2); open(sys.argv[1], "a").write("\n")
PY
    docker run --rm -i --pull=never --memory 256m -v "$TMPL_VOLUME:/work" "$STEP_IMAGE" sh -c "cat >$TROOT/deployments/$DEPLOYMENT.json" \
      <"$P5R/deployments/$DEPLOYMENT.json" || { echo "STOPPED: write the start slot" | tee "$OUT/stopped.txt"; exit 1; }
    ok=""
    for a in 1 2 3 4 5 6; do
      tmpl record-y . bun run bridge:record --mode live --api http://bridge-y:9999 --name Y --symbol Y 2>&1 | tee -a "$OUT/record-y.log"
      [[ "${PIPESTATUS[0]}" == 0 ]] && { ok=1; break; }
      sleep 20
    done
    [[ -n "$ok" ]] || { echo "STOPPED: bridge:record Y (start slot)" | tee "$OUT/stopped.txt"; exit 1; }
    save_deployments
  elif [[ "$(echo "$verdict" | awk '{print $1}')" != True ]]; then
    say "the chain shows activity after Initialize: node Y starts at its recorded slot"
  fi
  cp "$P5R/deployments/$DEPLOYMENT.json" "$P5R/deployments/$DEPLOYMENT.record.json" "$OUT/"

  # ── node Y (00058's compose.bridge.yml, its own project on the preview's network) ──
  say "==== Y1. bridge node Y (Temporary 13)"
  [[ -n "$Y_API_PORT" ]] || Y_API_PORT=$(free_port)
  cat >"$RUN/y.env" <<EOF
BRIDGE_HOST=bridge-y
BRIDGE_DEPLOYMENT=$DEPLOYMENT
BRIDGE_SECRETS_HOST_DIR=$RUN/secrets-y
BRIDGE_TEMPLATE_VOLUME=$TMPL_VOLUME
BRIDGE_STACK_NETWORK=$NET
BRIDGE_API_PORT=$Y_API_PORT
BRIDGE_RECORD_NAME=Y
BRIDGE_RECORD_SYMBOL=Y
BRIDGE_MEM_LIMIT=4g
SOLANA_DEVNET_RPC_URL_FILE=/secrets/solana-rpc-url
MIDNIGHT_NETWORK_ID=stagenet
MIDNIGHT_NODE_HTTP=$STG_NODE_WS
MIDNIGHT_INDEXER_HTTP=$STG_INDEXER
MIDNIGHT_INDEXER_WS=$STG_INDEXER_WS
MIDNIGHT_PROOF_SERVER_URL=$DUST_PS
MIDNIGHT_CONTRACT_PROOF_SERVER_URL=$CONTRACT_PS
EOF
  chmod 600 "$RUN/y.env"
  docker compose -p "$CP-y" --env-file "$RUN/y.env" -f "$TPL/deploy/standin/compose.bridge.yml" up -d >/dev/null 2>&1 \
    || { echo "STOPPED: bridge node Y up" | tee "$OUT/stopped.txt"; exit 1; }
  for _ in $(seq 1 300); do curl -sf -m 5 "http://127.0.0.1:$Y_API_PORT/deployment" >/dev/null && break; sleep 3; done
  curl -sf -m 5 "http://127.0.0.1:$Y_API_PORT/deployment" >"$OUT/deployment-y.json" \
    || { docker compose -p "$CP-y" --env-file "$RUN/y.env" -f "$TPL/deploy/standin/compose.bridge.yml" logs --no-color | tail -40; echo "STOPPED: node Y: no /deployment" | tee "$OUT/stopped.txt"; exit 1; }
  python3 -c "import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))==json.load(open(sys.argv[2])) else 1)" \
    "$OUT/deployment-y.json" "$P5R/deployments/$DEPLOYMENT.record.json" || { echo "STOPPED: node Y serves another record" | tee "$OUT/stopped.txt"; exit 1; }
  local waited_s=0 lag=""
  while :; do
    lag="$(DEVNET_URL="$DEVNET" python3 - "http://127.0.0.1:$Y_API_PORT/block-heights" <<'PY'
import json, os, sys, urllib.request
try:
    bh = json.load(urllib.request.urlopen(sys.argv[1], timeout=10))
    node = next(int(r["synced_page"]) for r in bh if "olana" in r["protocol_name"])
    req = urllib.request.Request(os.environ["DEVNET_URL"], data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getSlot", "params": [{"commitment": "confirmed"}]}).encode(), headers={"content-type": "application/json"})
    print(json.load(urllib.request.urlopen(req, timeout=10))["result"] - node)
except Exception:
    print("")
PY
)"
    printf '{"t":%s,"lagSlots":"%s"}\n' "$(date +%s)" "$lag" >>"$OUT/node-y-catch-up.jsonl"
    [[ -n "$lag" ]] && (( lag <= 150 )) && break
    (( waited_s >= ${NODE_SYNC_WAIT_S:-1800} )) && { echo "STOPPED: node Y is $lag slots behind devnet after $waited_s s" | tee "$OUT/stopped.txt"; exit 1; }
    (( waited_s % 120 == 0 )) && say "node Y is ${lag:-?} slots behind devnet's tip"
    sleep 15; waited_s=$((waited_s + 15))
  done
  say "node Y at devnet's tip (lag $lag slots)"

  # ── B's devnet wallet: SOL for its lock, and B_Y_MINT Y from y-operator (still the mint authority) ──
  MINT_Y="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['splMint'])" "$P5R/deployments/$DEPLOYMENT.record.json")"
  say "==== Y1. B's wallet $WALLET_B: SOL and ${B_Y_MINT:-30} Y"
  local lamB; lamB="$(sol_balance "$WALLET_B")"; lamB="${lamB:-0}"
  if (( lamB < 20000000 )); then
    if sol airdrop 0.1 "$WALLET_B" --commitment confirmed >"$OUT/airdrop-b.log" 2>&1; then
      say "devnet airdrop 0.1 SOL to B"
    else
      say "the devnet airdrop was refused; 0.05 SOL from the funder"
      sol transfer "$WALLET_B" 0.05 --from "$CONF/devnet/funder.json" --fee-payer "$CONF/devnet/funder.json" \
        --allow-unfunded-recipient --commitment confirmed >"$OUT/transfer-sol-to-b.log" 2>&1 \
        || { cat "$OUT/transfer-sol-to-b.log"; echo "STOPPED: 0.05 SOL to B" | tee "$OUT/stopped.txt"; exit 1; }
    fi
  fi
  local ataB haveY auth
  ataB="$(spl address --token "$MINT_Y" --owner "$WALLET_B" --verbose 2>/dev/null | awk '/Associated token address/{print $NF}')"
  [[ -n "$ataB" ]] || { echo "STOPPED: no associated token address for B" | tee "$OUT/stopped.txt"; exit 1; }
  if ! haveY="$(spl balance --address "$ataB" 2>/dev/null)"; then
    spl create-account "$MINT_Y" --owner "$WALLET_B" --fee-payer "$RUN/secrets-y/solana-operator.json" \
      >"$OUT/create-ata-b.log" 2>&1 || { cat "$OUT/create-ata-b.log"; echo "STOPPED: B's token account for Y" | tee "$OUT/stopped.txt"; exit 1; }
    haveY=0
  fi
  if python3 -c "import sys; sys.exit(0 if float(sys.argv[1] or 0) < float(sys.argv[2]) else 1)" "$haveY" "${B_Y_MINT:-30}"; then
    auth="$(spl display "$MINT_Y" 2>/dev/null | awk '/Mint authority/{print $NF}')"
    [[ "$auth" == "$Y_OPERATOR" ]] || { echo "STOPPED: Y's mint authority is $auth, not y-operator" | tee "$OUT/stopped.txt"; exit 1; }
    spl mint "$MINT_Y" "${B_Y_MINT:-30}" "$ataB" --mint-authority "$RUN/secrets-y/solana-operator.json" \
      --fee-payer "$RUN/secrets-y/solana-operator.json" >"$OUT/mint-y-to-b.log" 2>&1 \
      || { cat "$OUT/mint-y-to-b.log"; echo "STOPPED: mint Y to B" | tee "$OUT/stopped.txt"; exit 1; }
  fi
  echo "Y on B's wallet: $(spl balance --address "$ataB" 2>/dev/null)" | tee "$OUT/wallet-b-y.txt"
  sol_snapshot y-b-funded
  redact_rpc "$OUT" | tee "$OUT/redaction-y.txt"
  say "bridge Y DONE: mint $MINT_Y, contract $contract, node Y on 127.0.0.1:$Y_API_PORT"
}

faucet_handover() {
  preview_ctx
  [[ -f "$CONF/devnet/faucet.json" && "$(stat -f %Lp "$CONF/devnet/faucet.json")" == 600 ]] || { echo "no faucet key" >&2; exit 1; }
  [[ -n "$MINT_Y" && -f "$RUN/secrets-y/solana-operator.json" ]] || { echo "no bridge Y yet (bridge-y first)" >&2; exit 1; }
  local w mint op auth
  for w in x y; do
    mint=$MINT_X; [[ $w == y ]] && mint=$MINT_Y
    op="$(pub "$RUN/secrets-$w/solana-operator.json")"
    auth="$(spl display "$mint" 2>/dev/null | awk '/Mint authority/{print $NF}')"
    echo "$w mint $mint authority before $auth (operator $op)" | tee -a "$OUT/faucet-handover.txt"
    if [[ "$auth" == "$op" ]]; then
      spl authorize "$mint" mint "$FAUCET_PUB" --authority "$RUN/secrets-$w/solana-operator.json" \
        --fee-payer "$RUN/secrets-$w/solana-operator.json" >"$OUT/authorize-$w.log" 2>&1 || { cat "$OUT/authorize-$w.log"; exit 1; }
    elif [[ "$auth" != "$FAUCET_PUB" ]]; then
      echo "$w: mint authority $auth is neither the operator nor the faucet key" >&2; exit 1
    fi
    auth="$(spl display "$mint" 2>/dev/null | awk '/Mint authority/{print $NF}')"
    echo "$w mint $mint authority after $auth (faucet $FAUCET_PUB); supply $(spl supply "$mint" 2>/dev/null)" | tee -a "$OUT/faucet-handover.txt"
    [[ "$auth" == "$FAUCET_PUB" ]] || { echo "the hand-over of $w did not take" >&2; exit 1; }
  done
  sol_snapshot faucet-handover
  redact_rpc "$OUT" >/dev/null
}

# The registry (X, and Y once bridge-y ran), the relay's and the site's lists, Night Market's full stagenet list
# and the injector's token file, built into $RUN/injector-build; the injector's two files are then swapped into
# $RUN/injector (a directory mount: the injector's file watcher reloads them, no restart).
injector_files() {
  local b="$RUN/injector-build" recs=(/out/p5r-x.record.json) pairs=X/twUSDC
  rm -rf "$b"; mkdir -p "$b" "$RUN/injector"; chmod 700 "$b" "$RUN/injector"
  cp "$P5R/deployments/p5r-x.record.json" "$OUT/"
  if [[ -n "$MINT_Y" ]]; then
    cp "$P5R/deployments/p5r-y.record.json" "$OUT/"; recs+=(/out/p5r-y.record.json); pairs=X/twUSDC,Y/twUSDC,X/Y
  fi
  bun_nm -v "$b:/run/nm" -v "$OUT:/out:ro" --env-file "$RUN/devnet.env" "$BUN_IMAGE" sh -c \
    'exec bun e2e/registry/build.ts "$@" --solana-rpc "$SOLANA_RPC_URL"' _ --network stagenet \
    --genesis "$DEVNET_GENESIS" --out /run/nm/journey-tokens.stagenet.json \
    --site-icons-out /run/nm/site-icons.json "${recs[@]}" 2>&1 | tee "$OUT/registry-build.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { echo "the journey registry" >&2; return 1; }
  echo '{"network":"stagenet","relayUrl":"http://relay:8080"}' >"$b/site-config.json"
  bun_nm -v "$b:/run/nm" --env-file "$RUN/devnet.env" "$BUN_IMAGE" sh -c \
    'exec bun scripts/bridge-tokens.ts "$@" --solana-rpc "$SOLANA_RPC_URL"' _ /run/nm/journey-tokens.stagenet.json \
    --site-config /run/nm/site-config.json --relay-tokens /run/nm/tokens.json --pairs "$pairs" \
    --icons /run/nm/site-icons.json 2>&1 | tee "$OUT/bridge-tokens.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { echo "bridge-tokens" >&2; return 1; }
  # Night Market's FULL stagenet list (its built-in tokens + the bridged ones), then the injector's file from it.
  bun_nm -v "$b:/run/nm" "$BUN_IMAGE" bun -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { registryFor } from "@nightmarket/core";
    const r = registryFor("stagenet", JSON.parse(readFileSync("/run/nm/tokens.json", "utf8")));
    writeFileSync("/run/nm/nm-tokens-full.stagenet.json", JSON.stringify({ tokens: r.tokens }, null, 1) + "\n");
    console.log(r.tokens.map((t) => `${t.symbol} ${t.decimals} ${t.privacy}`).join("; "));' 2>&1 | tee "$OUT/nm-tokens-full.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { echo "the full token list" >&2; return 1; }
  bun_nm -v "$b:/run/nm" "$BUN_IMAGE" bun e2e/registry/build.ts injector-tokens --network stagenet \
    --journey /run/nm/journey-tokens.stagenet.json --nm-tokens /run/nm/nm-tokens-full.stagenet.json \
    --out /run/nm/injector-tokens.stagenet.json 2>&1 | tee "$OUT/injector-tokens.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { echo "the injector's token file" >&2; return 1; }
  cp "$b"/*.json "$OUT/"
  local f
  for f in journey-tokens.stagenet.json injector-tokens.stagenet.json; do
    cp "$b/$f" "$RUN/injector/.$f.new" && mv "$RUN/injector/.$f.new" "$RUN/injector/$f"
  done
}

# The devnet RPC proxy (the injector's upstream and the relay faucet's RPC; e2e/stagenet/rpc-proxy.ts).
rpc_proxy_up() {
  if [[ -z "$(docker ps -q -f "name=^$CP-devnet-rpc\$")" ]]; then
    docker rm -f "$CP-devnet-rpc" >/dev/null 2>&1
    docker run -d --name "$CP-devnet-rpc" --hostname devnet-rpc --network "$NET" --network-alias devnet-rpc --memory 256m \
      --pull=never --restart unless-stopped -v "$HERE/rpc-proxy.ts:/srv/rpc-proxy.ts:ro" \
      --mount "type=bind,source=$DEVNET_RPC_FILE,target=/run/secrets/rpc-url,readonly" -e RPC_URL_FILE=/run/secrets/rpc-url \
      "$BUN_IMAGE" bun /srv/rpc-proxy.ts >/dev/null || { echo "the RPC proxy" >&2; return 1; }
  fi
  local g=""
  for _ in $(seq 1 30); do
    g="$(docker run --rm --network "$NET" --memory 256m --pull=never "$BUN_IMAGE" bun -e \
      'const r = await fetch("http://devnet-rpc:8080", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method: "getGenesisHash"})}).then((r) => r.json()).catch(() => ({})); console.log(r.result ?? "")' 2>/dev/null)"
    [[ "$g" == "$DEVNET_GENESIS" ]] && break; sleep 2
  done
  echo "devnet-rpc proxy genesis $g" | tee "$OUT/rpc-proxy-check.txt"
  [[ "$g" == "$DEVNET_GENESIS" ]] || { echo "the RPC proxy does not reach devnet" >&2; return 1; }
}

# Y3 (the orchestrator, ~22:10Z: FIRST, the owner waits for "Show in my wallet"): the 00059 injector on the
# preview, and `injector.url` added to the site's served config.json in place (a backup kept outside the
# served directory). No relay or site restart. Re-running it refreshes the injector's files only.
injector_up() {
  preview_ctx
  [[ "$(git -C "$INJECTOR_REPO" rev-parse HEAD)" == "$INJECTOR_PIN" && -z "$(git -C "$INJECTOR_REPO" status --porcelain)" ]] \
    || { echo "the 00059 clone $INJECTOR_REPO is not clean at $INJECTOR_PIN" >&2; exit 1; }
  say "==== Y3. the injector's files (registry, token file)"
  injector_files || exit 1
  rpc_proxy_up || exit 1
  local inj; inj="$(docker port "$CP-injector" 8899 2>/dev/null | sed -n 's/.*://p' | head -1)"
  if [[ -n "$inj" ]]; then
    say "the injector is running on 127.0.0.1:$inj (its files were swapped; it reloads them)"
  else
    say "==== Y3. the 00059 injector image ($INJECTOR_PIN) and container"
    docker build --pull=false -q -t "$INJECTOR_IMAGE" "$INJECTOR_REPO" >"$OUT/injector-build.log" 2>&1 \
      || { tail -30 "$OUT/injector-build.log"; echo "the injector image" >&2; exit 1; }
    for _ in $(seq 1 50); do
      inj=$(free_port)
      python3 -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1', int(sys.argv[1]))); s.close()" "$((inj + 1))" 2>/dev/null && break
    done
    docker rm -f "$CP-injector" >/dev/null 2>&1
    docker volume create "$CP-injector-data" >/dev/null
    docker run -d --name "$CP-injector" --hostname injector --network "$NET" --network-alias injector --memory 1g --pull=never \
      --cap-drop ALL --security-opt no-new-privileges:true --restart unless-stopped \
      -p "127.0.0.1:$inj:8899" -p "127.0.0.1:$((inj + 1)):8900" -v "$CP-injector-data:/data" -v "$RUN/injector:/run/journey:ro" \
      -e HOST=0.0.0.0 -e PORT=8899 -e "PUBLIC_URL=http://127.0.0.1:$inj" -e UPSTREAM=http://devnet-rpc:8080 \
      -e UPSTREAM_WS=ws://devnet-rpc:8080 -e DATA_DIR=/data -e MIDNIGHT_NETWORK_ID=stagenet \
      -e "MIDNIGHT_INDEXER_HTTP=$STG_INDEXER" -e "MIDNIGHT_INDEXER_WS=$STG_INDEXER_WS" \
      -e DECRYPTOR_BIN=/usr/local/bin/midnight-esk-decrypt -e JOURNEY_REGISTRY=/run/journey/journey-tokens.stagenet.json \
      -e TOKEN_REGISTRY=/run/journey/injector-tokens.stagenet.json -e ACCOUNTS_ENABLED=1 -e ACCOUNTS_POLL_MS=5000 -e LOG=true \
      "$INJECTOR_IMAGE" >/dev/null || { echo "the injector" >&2; exit 1; }
  fi
  echo "$inj" >"$PREVIEW_DIR/injector-port"
  local up=""
  for _ in $(seq 1 90); do
    curl -s -m 10 "http://127.0.0.1:$inj/health" >"$OUT/injector-health.json" 2>/dev/null
    python3 -c 'import json,sys; h=json.load(open(sys.argv[1])); sys.exit(0 if h.get("ok") else 1)' "$OUT/injector-health.json" 2>/dev/null && { up=1; break; }
    sleep 2
  done
  [[ -n "$up" ]] || { docker logs "$CP-injector" 2>&1 | tail -30; echo "the injector is not healthy" >&2; exit 1; }
  say "==== Y3. injector.url in the site's config.json (in place; backup outside the served directory)"
  local bak; bak="$PREVIEW_DIR/config.json.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$PREVIEW_DIR/site/config.json" "$bak"; chmod 600 "$bak"
  python3 - "$PREVIEW_DIR/site/config.json" "$PREVIEW_DIR/site/.config.json.new" "$inj" <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
c["injector"] = {"url": f"http://127.0.0.1:{sys.argv[3]}"}
json.dump(c, open(sys.argv[2], "w"), indent=1)
PY
  chmod 600 "$PREVIEW_DIR/site/.config.json.new"; mv "$PREVIEW_DIR/site/.config.json.new" "$PREVIEW_DIR/site/config.json"
  cp "$PREVIEW_DIR/site/config.json" "$OUT/site-config.served.json"
  { echo "index $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")"
    echo "config $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/config.json") injector=$(curl -s "http://127.0.0.1:$WEB_PORT/config.json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("injector"))')"
    echo "relay-health-through-site $(curl -s -m 10 "http://127.0.0.1:$WEB_PORT/relay/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sponsor",{}).get("synced"))' 2>/dev/null)"
    echo "injector http://127.0.0.1:$inj health $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$inj/health")"
  } | tee "$OUT/site-check-injector.txt"
  docker logs "$CP-injector" >"$OUT/injector-start.log" 2>&1
  redact_rpc "$OUT" | tee "$OUT/redaction-injector.txt"
  say "injector up: http://127.0.0.1:$inj (Nightly's custom Solana RPC); site config has injector.url"
}

# Y4a (no restart, nothing the owner sees changes): the relay's next files (registry X+Y, lists, the faucet keys)
# in $RUN/nm-next, and the site's next config.json in $PREVIEW_DIR/config.json.staged (600, outside the served
# directory). The running relay keeps reading $RUN/nm until preview-update.
stage_update() {
  preview_ctx
  [[ -n "$MINT_Y" && -n "$Y_API_PORT" ]] || { echo "no bridge Y yet (bridge-y first)" >&2; exit 1; }
  local inj; inj="$(cat "$PREVIEW_DIR/injector-port" 2>/dev/null)"
  [[ -n "$inj" ]] || { echo "no injector (injector first)" >&2; exit 1; }
  say "==== Y4a. stage the relay's files (X+Y, the faucet) and the site's config.json; nothing is applied"
  injector_files || exit 1
  local n="$RUN/nm-next" f
  rm -rf "$n"; mkdir -p "$n"; chmod 700 "$n"
  for f in journey-tokens.stagenet.json tokens.json site-config.json site-icons.json; do cp "$RUN/injector-build/$f" "$n/$f"; done
  bun_nm -v "$n:/run/nm" -v "$CONF/devnet/faucet.json:/keys/faucet.json:ro" --env-file "$RUN/devnet.env" "$BUN_IMAGE" sh -c \
    'exec bun relay/src/tools/spl-faucet-keys.ts --journey /run/nm/journey-tokens.stagenet.json --rpc "$SOLANA_RPC_URL" --out /run/nm/spl-faucet-keys.json /keys/faucet.json' \
    2>&1 | tee "$OUT/spl-faucet-keys.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || { echo "spl-faucet-keys (hand the mints over first)" >&2; exit 1; }
  chmod 600 "$n/spl-faucet-keys.json"
  DEVNET_URL="$DEVNET" python3 - "$n/site-config.json" "$n/journey-tokens.stagenet.json" "$PREVIEW_DIR/config.json.staged" \
    "$WEB_PORT" "$X_API_PORT" "$Y_API_PORT" "$DEVNET_GENESIS" "$inj" <<'PY'
import json, os, sys
site, journey = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
web, apis = f"http://127.0.0.1:{sys.argv[4]}", {"X": sys.argv[5], "Y": sys.argv[6]}
for t in journey["tokens"]:
    t["bridgeApi"] = f"http://127.0.0.1:{apis[t['symbol']]}"
config = {"network": "stagenet", "relayUrl": f"{web}/relay", "tokens": site.get("tokens"), "pairs": site.get("pairs"),
          "bridges": journey, "solana": {"rpcUrl": os.environ["DEVNET_URL"], "genesisHash": sys.argv[7], "cluster": "solana:devnet"},
          "injector": {"url": f"http://127.0.0.1:{sys.argv[8]}"}, "walletTimeoutSeconds": 300}
json.dump({k: v for k, v in config.items() if v is not None}, open(sys.argv[3], "w"), indent=1)
PY
  chmod 600 "$PREVIEW_DIR/config.json.staged"
  cp "$PREVIEW_DIR/config.json.staged" "$OUT/site-config.staged.json"
  python3 - "$PREVIEW_DIR/site/config.json" "$PREVIEW_DIR/config.json.staged" <<'PY' | tee "$OUT/site-config.diff.txt"
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
for k in sorted(set(a) | set(b)):
    if a.get(k) != b.get(k):
        print(f"{k}: changes" + (f" (pairs {a.get(k)} -> {b.get(k)})" if k == "pairs" else ""))
PY
  say "staged: $n (relay) and $PREVIEW_DIR/config.json.staged (site); apply with preview-update"
}

# Y4b (COORDINATED with the orchestrator: the owner uses the page): ONE relay restart with the staged files, only
# when the relay's queue is idle and no bridge transfer is in flight; then the staged site config is swapped in
# (backup kept outside the served directory).
preview_update() {
  preview_ctx
  local n="$RUN/nm-next" inj f
  inj="$(cat "$PREVIEW_DIR/injector-port" 2>/dev/null)"
  [[ -f "$n/spl-faucet-keys.json" && -f "$PREVIEW_DIR/config.json.staged" && -n "$inj" ]] || { echo "nothing staged (stage-update first)" >&2; exit 1; }
  rpc_proxy_up || exit 1
  say "==== Y4b. ONE relay restart (registry X+Y, the faucet), once the relay and the bridges are idle"
  local idle="" i
  for i in $(seq 1 80); do
    relay_dust >>"$OUT/relay-before-restart.jsonl"
    idle="$(python3 - "http://127.0.0.1:$RELAY_PORT/health" "http://127.0.0.1:$X_API_PORT/transfers?limit=20" "http://127.0.0.1:$Y_API_PORT/transfers?limit=20" <<'PY'
import json, sys, urllib.request
h = json.load(urllib.request.urlopen(sys.argv[1], timeout=10))
lanes = h.get("queue", {}).get("lanes", {})
busy = any(l.get("running", 0) or l.get("waiting", 0) for l in lanes.values())
open_t = []
for u in sys.argv[2:]:
    t = json.load(urllib.request.urlopen(u, timeout=10))
    open_t += [(x.get("id"), x.get("status")) for x in t.get("transfers", [])
               if x.get("status") not in ("completed", "delivered", "released", "undeliverable", "failed")]
print("idle" if not busy and not open_t else f"busy relay={busy} transfers={open_t}")
PY
)"
    [[ "$idle" == idle ]] && break
    (( i % 4 == 1 )) && say "waiting: $idle"
    sleep 15
  done
  [[ "$idle" == idle ]] || { echo "the relay or a bridge stayed busy: $idle" >&2; exit 1; }
  for f in journey-tokens.stagenet.json tokens.json site-config.json site-icons.json spl-faucet-keys.json; do cp -p "$n/$f" "$RUN/nm/$f"; done
  chmod 600 "$RUN/nm/spl-faucet-keys.json"
  # The relay's faucet reaches devnet through the proxy (no API key in its environment).
  ( umask 077; printf 'SPL_FAUCET_RPC_URL=http://devnet-rpc:8080\n' >"$RUN/faucet.env" )
  mark relay-restart start
  start_relay || { echo "relay restart" >&2; exit 1; }
  relay_synced >"$OUT/relay-health-after-update.json" || { docker logs "$CP-relay" 2>&1 | tail -30; echo "the relay did not come back" >&2; exit 1; }
  mark relay-restart end
  curl -s "http://127.0.0.1:$RELAY_PORT/v1/config" >"$OUT/relay-config.json"
  curl -s "http://127.0.0.1:$RELAY_PORT/v1/spl-faucet" >"$OUT/spl-faucet-info.json"
  say "==== Y4b. the staged site config.json swapped in"
  local bak; bak="$PREVIEW_DIR/config.json.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$PREVIEW_DIR/site/config.json" "$bak"; chmod 600 "$bak"
  cp -p "$PREVIEW_DIR/config.json.staged" "$PREVIEW_DIR/site/.config.json.new"
  mv "$PREVIEW_DIR/site/.config.json.new" "$PREVIEW_DIR/site/config.json"
  cp "$PREVIEW_DIR/site/config.json" "$OUT/site-config.served.json"
  { echo "index $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/")"
    echo "config $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/config.json")"
    echo "relay-health-through-site $(curl -s -m 10 "http://127.0.0.1:$WEB_PORT/relay/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sponsor",{}).get("synced"))' 2>/dev/null)"
    echo "relay tokensDigest $(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("tokensDigest"))' "$OUT/relay-config.json" 2>/dev/null)"
    echo "injector http://127.0.0.1:$inj health $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$inj/health")"
    echo "bridge-x $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$X_API_PORT/deployment") bridge-y $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$Y_API_PORT/deployment")"
  } | tee "$OUT/site-check.txt"
  relay_dust >>"$OUT/relay-after-restart.jsonl"
  docker ps --format '{{.Names}} {{.Status}}' | grep -E "^$CP" >"$OUT/containers.txt"
  grep -q '^index 200' "$OUT/site-check.txt" && grep -q '^config 200' "$OUT/site-check.txt" && grep -q 'through-site True' "$OUT/site-check.txt" \
    || { echo "the site does not serve its page, its config or the relay" >&2; exit 1; }
  say "preview updated: site http://127.0.0.1:$WEB_PORT/, injector http://127.0.0.1:$inj"
}

offer_b_make() {
  flows make-b GIVE_SYMBOL=Y GIVE_AMOUNT="${OFFER_GIVE:-10000000}" WANT_SYMBOL=X WANT_AMOUNT="${OFFER_WANT:-10000000}" \
    ${MAKE_LIFETIME:+MAKE_LIFETIME=$MAKE_LIFETIME} >"$OUT/offer-b-$(date +%H%M%S).log" 2>&1
  local rc=$?
  local log; log="$(ls -t "$OUT"/offer-b-*.log | head -1)"
  tail -40 "$log"
  [[ $rc == 0 ]] || return 1
  local offer; offer="$(grep -h '^OFFER_B ' "$log" | tail -1 | sed 's/^OFFER_B //')"
  [[ -n "$offer" ]] || return 1
  echo "$offer" >>"$OUT/offers-b.jsonl"
  python3 - "$offer" <<'PY' | tee -a "$OUT/offers-b-kernel.jsonl"
import json, sys, time, urllib.request
o = json.loads(sys.argv[1])
until = int(o.get("validUntil") or 0)
listed, k = False, {}
for _ in range(20):
    try:
        k = json.load(urllib.request.urlopen(f"https://stagenet.api-zswap.zkdojo.com/v1/offers/{o['offerId']}", timeout=20))
        listed = k.get("offerId") == o["offerId"]
    except Exception as e:
        print("kernel read failed:", type(e).__name__)
    if listed: break
    time.sleep(6)
c = k.get("computed") or {}
print(json.dumps({"offerId": o["offerId"], "listedOnKernel": listed, "kernelStatus": c.get("status"),
                  "kernelExpiresAt": c.get("expiresAt"), "gives": c.get("gives"), "wants": c.get("wants"),
                  "validUntil": until, "expiresUtc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(until))}))
sys.exit(0 if listed else 2)
PY
  return "${PIPESTATUS[0]}"
}
# B's Bridge in of Y. It needs no relay restart: the page's own Bridge in (one lock, node Y delivers into account
# B) reads the X+Y registry from a separate file in the run directory (the relay keeps reading its own).
bridge_in_b() {
  preview_ctx
  [[ -f "$RUN/injector-build/journey-tokens.stagenet.json" ]] || { echo "no X+Y registry yet (run injector after bridge-y)" >&2; exit 1; }
  cp "$RUN/injector-build/journey-tokens.stagenet.json" "$RUN/nm/journey-tokens.xy.stagenet.json"
  landing JOURNEY_STEP=p5r1 STEP=adopt-bridges BRIDGES=X,Y JOURNEY_FILE=/run/nm/journey-tokens.xy.stagenet.json \
    || { echo "adopt-bridges X,Y" >&2; exit 1; }
  relay_dust >>"$OUT/relay-dust.jsonl"
  sol_snapshot b-in-start
  landing JOURNEY_STEP=p5r1 WHO=B STEP=bridge-in SYMBOL=Y "AMOUNT=${B_Y_IN:-20000000}" LABEL=p5r1-b-y \
    JOURNEY_FILE=/run/nm/journey-tokens.xy.stagenet.json BRIDGE_IN_TIMEOUT_MS=1800000 || { echo "B's Bridge in of Y" >&2; exit 1; }
  sol_snapshot b-in-end
  relay_dust >>"$OUT/relay-dust.jsonl"
}
# B lists GIVE 10 Y for WANT 10 X (after preview-update: the relay must know Y).
offer_b() {
  preview_ctx
  relay_dust >>"$OUT/relay-dust.jsonl"
  offer_b_make || { echo "B's offer" >&2; exit 1; }
  relay_dust >>"$OUT/relay-dust.jsonl"
}
relist_b() {
  preview_ctx
  offer_b_make || { echo "B's offer" >&2; exit 1; }
  redact_rpc "$OUT" >/dev/null
}
inject_a() {
  preview_ctx
  local inj; inj="$(cat "$PREVIEW_DIR/injector-port")"
  landing JOURNEY_STEP=p5r1 STEP=inject "INJECTOR_PUBLIC_URL=http://127.0.0.1:$inj" || { redact_rpc "$OUT" >/dev/null; echo "A's registration" >&2; exit 1; }
  # The real devnet mints (00059 P7): their missing Metaplex metadata is filled in by the injector (name, symbol,
  # its icon); the mint account's bytes are the upstream's.
  docker run --rm --network "$NET" --memory 512m --pull=never --entrypoint node -w /app \
    -e "MINTS=$MINT_X${MINT_Y:+,$MINT_Y}" -e "PUB=http://127.0.0.1:$inj" "$INJECTOR_IMAGE" -e '
const { PublicKey } = require("@solana/web3.js");
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const inj = "http://injector:8899", up = "http://devnet-rpc:8080";
const rpc = async (url, m, p) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) })).json()).result;
const str = (b, o) => { const n = b.readUInt32LE(o); return [b.subarray(o + 4, o + 4 + n).toString("utf8").replace(/\0+$/, ""), o + 4 + n]; };
(async () => {
  const out = {};
  for (const m of process.env.MINTS.split(",")) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL.toBuffer(), new PublicKey(m).toBuffer()], MPL);
    const a = await rpc(inj, "getAccountInfo", [pda.toBase58(), { encoding: "base64" }]);
    const u = await rpc(up, "getAccountInfo", [pda.toBase58(), { encoding: "base64" }]);
    let meta = null;
    if (a && a.value) { const b = Buffer.from(a.value.data[0], "base64"); let o = 65, name, symbol, uri; [name, o] = str(b, o); [symbol, o] = str(b, o); [uri, o] = str(b, o); meta = { name, symbol, uri }; }
    const mi = await rpc(inj, "getAccountInfo", [m, { encoding: "base64" }]);
    const mu = await rpc(up, "getAccountInfo", [m, { encoding: "base64" }]);
    let j = null;
    if (meta && meta.uri) j = await fetch(meta.uri.replace(process.env.PUB, inj)).then((r) => r.json()).catch(() => null);
    out[m] = { upstreamHasMetadata: !!(u && u.value), filled: meta, uriJson: j && { name: j.name, symbol: j.symbol, image: j.image },
               mintBytesEqual: !!(mi && mu && JSON.stringify(mi.value.data) === JSON.stringify(mu.value.data)) };
  }
  console.log(JSON.stringify(out, null, 1));
})();' | tee "$OUT/fill-in-check.json"
  redact_rpc "$OUT" >/dev/null
}

case "$CMD" in
  prep) prep ;;
  gate) gate ;;
  faucet-x) faucet_x ;;
  relay-restart) relay_restart ;;
  rpc-check) rpc_check ;;
  bridge-y) bridge_y ;;
  faucet-handover) faucet_handover ;;
  injector) injector_up ;;
  inject-a) inject_a ;;
  stage-update) stage_update ;;
  preview-update) preview_update ;;
  bridge-in-b) bridge_in_b ;;
  offer-b) offer_b ;;
  relist-b) relist_b ;;
  *) echo "usage: $0 prep|gate|faucet-x|relay-restart|rpc-check|bridge-y|faucet-handover|injector|inject-a|bridge-in-b|stage-update|preview-update|offer-b|relist-b" >&2; exit 64 ;;
esac
