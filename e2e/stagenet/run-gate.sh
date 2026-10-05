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

BRIDGE_WT="${BRIDGE_WT:-/Users/edwardalvarado/todo/AA/experiments/00058-bridge-contract-delivery}"
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
APP_VOLUME=aa00057-check-app
LOCK_WAIT_S="${LOCK_WAIT_S:-14400}"

# The remote networks.
STG_NODE_HTTP=https://rpc.stagenet.shielded.tools
STG_NODE_WS=wss://rpc.stagenet.shielded.tools
STG_INDEXER=https://indexer.stagenet.shielded.tools/api/v4/graphql
STG_INDEXER_WS=wss://indexer.stagenet.shielded.tools/api/v4/graphql/ws
DEVNET="${DEVNET_RPC:-https://api.devnet.solana.com}"
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
DEPLOYMENT=p5r-x
UNIT=1000000
GATE_AMOUNT=1000000 # 1 X (6 decimals)

say() { echo "[gate $(date -u +%H:%M:%SZ)] $*"; }
fail() { say "STOPPED: $*"; echo "$*" >"$OUT/stopped.txt"; exit 1; }
mark() { printf '{"at":"%s","t":%s,"what":"%s","event":"%s"}\n' "$(date -u +%FT%TZ)" "$(date +%s)" "$1" "$2" >>"$OUT/timings.jsonl"; }
pub() { "$AGAVE/solana-keygen" pubkey "$1"; }
sol_balance() { "$AGAVE/solana" balance "$1" --url "$DEVNET" --lamports 2>/dev/null | awk '{print $1}'; }
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

# ═════════════════════════════════════════════════════════════════════════════════════════════
# helpers that need the run's variables
# ═════════════════════════════════════════════════════════════════════════════════════════════
tmpl() { # <name> <dir under the template> <cmd...>: the 00058 template's environment, live mode, bridge X
  local name=$1 wd=$2; shift 2
  docker run --rm --name "$CP-$name" --network "$NET" --memory "${TMPL_MEM:-4g}" --pull=never \
    -v "$TMPL_VOLUME:/work" -v "$RUN/secrets-x:/secrets-x:ro" -v "$OUT:/out" \
    -e BRIDGE_MODE=live -e "BRIDGE_DEPLOYMENT=$DEPLOYMENT" -e BRIDGE_SECRETS_DIR=/secrets-x \
    -e MIDNIGHT_NETWORK_ID=stagenet -e "MIDNIGHT_NODE_HTTP=$STG_NODE_WS" \
    -e "MIDNIGHT_INDEXER_HTTP=$STG_INDEXER" -e "MIDNIGHT_INDEXER_WS=$STG_INDEXER_WS" \
    -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300 -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 \
    -e "SOLANA_DEVNET_RPC_URL=$DEVNET" -e "SOLANA_EXPECTED_GENESIS_HASH=$DEVNET_GENESIS" \
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
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server:6300 \
    -e "SOLANA_GENESIS=$DEVNET_GENESIS" -e "SOLANA_RPC_URL=$DEVNET" -e SOLANA_CLUSTER=solana:devnet \
    -e "LANDING_ORIGIN=http://127.0.0.1:$WEB_PORT" -e BRIDGES=X -e BRIDGE_IN_TIMEOUT_MS=1800000 ${args[@]+"${args[@]}"} "$BUN_IMAGE" \
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
    tip="$(curl -s -m 10 "$DEVNET" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[{"commitment":"confirmed"}]}' 2>/dev/null)"
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

# ═════════════════════════════════════════════════════════════════════════════════════════════
teardown() {
  set +e
  [[ -z "${CP:-}" ]] && return 0
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
  mkdir -p "$RUN"/{secrets-x,nm}; chmod 700 "$RUN/secrets-x" "$RUN/nm"
  # Bridge X's live secrets (00058 README "live mode"): copies, never printed.
  cp "$CONF/devnet/x-operator.json" "$RUN/secrets-x/solana-operator.json"
  cp "$CONF/devnet/x-program.json" "$RUN/secrets-x/solana-bridge-program.json"
  cp "$CONF/stagenet/temporary-12.seed" "$RUN/secrets-x/midnight-operator.seed"
  cp "$CONF/stagenet/temporary-12.seed" "$RUN/secrets-x/midnight-delivery.seed"
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$RUN/secrets-x/storage-password"
  cp "$CONF/stagenet/temporary-11.seed" "$RUN/nm/sponsor.seed"
  chmod 600 "$RUN"/secrets-x/* "$RUN/nm/sponsor.seed"
  cp -Rc "$KEYS_SRC" "$RUN/keys-relay"; cp -Rc "$STATE_ROOT/bridge-managed" "$RUN/keys-relay/bridge"
  cp -Rc "$KEYS_SRC" "$RUN/keys-harness"; cp -Rc "$STATE_ROOT/bridge-managed" "$RUN/keys-harness/bridge"
  cp -Rc "$PS_PARAMS_SRC" "$RUN/ps-params"; cp -Rc "$PS8_PARAMS_SRC" "$RUN/ps8-params"
  X_OPERATOR="$(pub "$RUN/secrets-x/solana-operator.json")"; X_PROGRAM="$(pub "$RUN/secrets-x/solana-bridge-program.json")"
  FUNDER="$(pub "$CONF/devnet/funder.json")"
  RELAY_PORT=$(free_port); X_API_PORT=$(free_port); WEB_PORT=$(free_port)
  { echo "night-market $(git -C "$ROOT" rev-parse HEAD)$( [[ -n "$(git -C "$ROOT" status --porcelain)" ]] && echo ' (dirty)')"
    echo "00058 $(git -C "$BRIDGE_WT" rev-parse HEAD)"; echo "relay-image $RELAY_IMAGE $(docker image inspect "$RELAY_IMAGE" --format '{{.Id}}')"
    echo "step-image $(docker image inspect "$STEP_IMAGE" --format '{{.Id}}')"
    for i in "$PS6_IMAGE" "$PS8_IMAGE" "$BUN_IMAGE"; do echo "$i $(docker image inspect "$i" --format '{{.Id}}')"; done
    echo "agave $("$AGAVE/solana" --version)"; echo "x-operator $X_OPERATOR"; echo "x-program $X_PROGRAM"; echo "funder $FUNDER"
    echo "ports relay $RELAY_PORT bridge-x $X_API_PORT site $WEB_PORT"
  } >"$OUT/pins.txt"
  local genesis; genesis="$("$AGAVE/solana" genesis-hash --url "$DEVNET")"
  [[ "$genesis" == "$DEVNET_GENESIS" ]] || fail "the Solana RPC is not devnet (genesis $genesis)"
  snapshot start

  # ── the provers, on the run's own network ──
  docker network create "$NET" >/dev/null || fail "network"
  docker run -d --name "$CP-ps6" --network "$NET" --network-alias proof-server --memory 4g --pull=never \
    -e PORT=6300 -e MIDNIGHT_PP=/params -v "$RUN/ps-params:/params" "$PS6_IMAGE" >/dev/null || fail "the rc.6 prover"
  docker run -d --name "$CP-ps8" --network "$NET" --network-alias proof-server-rc8 --memory 12g --memory-swap 12g \
    --restart on-failure:5 --pull=never -e PORT=6300 -e MIDNIGHT_PP=/params -v "$RUN/ps8-params:/params" "$PS8_IMAGE" >/dev/null \
    || fail "the rc.8 prover"
  for p in proof-server proof-server-rc8; do
    local ok=""
    for _ in $(seq 1 60); do
      docker run --rm --network "$NET" --memory 256m --pull=never "$BUN_IMAGE" bun -e \
        "const r = await fetch('http://$p:6300/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)" >/dev/null 2>&1 && { ok=1; break; }
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
  if "$AGAVE/solana" account "$X_PROGRAM" --url "$DEVNET" >"$OUT/program-account-before.txt" 2>&1; then
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
    "$AGAVE/solana" program deploy "$TPL/packages/contracts-solana/build/bridge.so" --url "$DEVNET" \
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
      "$AGAVE/solana" program close --buffers --keypair "$RUN/secrets-x/solana-operator.json" \
        --authority "$RUN/secrets-x/solana-operator.json" --recipient "$X_OPERATOR" --url "$DEVNET" \
        >"$OUT/close-buffers.log" 2>&1
      echo "close-buffers exit $? lamportsAfterClose $(sol_balance "$X_OPERATOR")" >>"$OUT/close-buffers.log"
      fail "the devnet program deploy (TPU path, buffer $(pub "$buf")); the buffers are closed"
    fi
  fi
  mark program end
  tmpl deploy-sol packages/contracts-solana bun run scripts/deploy-devnet.ts --out "$DEPLOYMENT" --user-tokens 0 2>&1 | tee "$OUT/deploy-x-solana.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "deploy-devnet.ts (mint X + Initialize)"
  mark solana-deploy end
  TMPL_MEM=6g tmpl deploy-mn packages/contracts-midnight bun run deploy.ts --mode stagenet --out "$DEPLOYMENT" 2>&1 | quiet | tee "$OUT/deploy-x-midnight.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "deploy.ts (the stagenet contract, Temporary 12)"
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
  bun_nm -v "$RUN/nm:/run/nm" -v "$OUT:/out:ro" "$BUN_IMAGE" bun e2e/registry/build.ts --network stagenet \
    --genesis "$DEVNET_GENESIS" --solana-rpc "$DEVNET" --out /run/nm/journey-tokens.stagenet.json \
    --site-icons-out /run/nm/site-icons.json "/out/$DEPLOYMENT.record.json" 2>&1 | tee "$OUT/registry-build.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "the journey registry"
  echo '{"network":"stagenet","relayUrl":"http://relay:8080"}' >"$RUN/nm/site-config.json"
  bun_nm -v "$RUN/nm:/run/nm" "$BUN_IMAGE" bun scripts/bridge-tokens.ts /run/nm/journey-tokens.stagenet.json \
    --site-config /run/nm/site-config.json --relay-tokens /run/nm/tokens.json --pairs X/twUSDC --icons /run/nm/site-icons.json \
    --solana-rpc "$DEVNET" 2>&1 | tee "$OUT/bridge-tokens.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "bridge-tokens"
  cp "$RUN/nm/journey-tokens.stagenet.json" "$RUN/nm/tokens.json" "$RUN/nm/site-config.json" "$RUN/nm/site-icons.json" "$OUT/"

  # ── 3. the relay, bridge node X, the site ──
  say "==== 3. the relay (sponsor Temporary 11), bridge node X (Temporary 12), the site"
  mark services start
  docker volume create "$CP-relay-data" >/dev/null
  docker run -d --name "$CP-relay" --network "$NET" --network-alias relay -p "127.0.0.1:$RELAY_PORT:8080" \
    --memory 4g --pull=never -e HOME=/tmp -e RELAY_NETWORK=stagenet -e TOKENS_FILE=/run/nm/tokens.json \
    -e BRIDGE_REGISTRY_FILE=/run/nm/journey-tokens.stagenet.json \
    -e MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed \
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server:6300 \
    -e RELAY_REQUIRE_KEYS=true -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/nm/sponsor.seed \
    -e SPONSOR_FUNDING_LOCK_FILE=/tmp/relay-funding.lock -e SPONSOR_FEE_BLOCKS_MARGIN=5 \
    -e DEMO_TOKENS_ENABLED=true -e DEMO_TOKENS_PACK=twUSDC:10 -e DEMO_TOKENS_PATH=direct -e DEMO_TOKENS_DAILY_CAP=10 \
    -e RELAY_DATA_DIR=/var/lib/night-market -e RATE_LIMIT_ACTIONS_PER_MIN=100 -e RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN=100 \
    -e LOG_LEVEL=info -v "$RUN/keys-relay:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm:ro" \
    -v "$CP-relay-data:/var/lib/night-market" "$RELAY_IMAGE" >/dev/null || fail "relay start"
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
SOLANA_DEVNET_RPC_URL=$DEVNET
MIDNIGHT_NETWORK_ID=stagenet
MIDNIGHT_NODE_HTTP=$STG_NODE_WS
MIDNIGHT_INDEXER_HTTP=$STG_INDEXER
MIDNIGHT_INDEXER_WS=$STG_INDEXER_WS
MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300
MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300
EOF
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
  rm -rf "$RUN/site"; cp -Rc "$STATE_ROOT/site-dist" "$RUN/site"
  python3 - "$RUN/nm/site-config.json" "$RUN/nm/journey-tokens.stagenet.json" "$RUN/site/config.json" "$WEB_PORT" "$X_API_PORT" "$DEVNET" "$DEVNET_GENESIS" <<'PY'
import json, sys
site, journey = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
web = f"http://127.0.0.1:{sys.argv[4]}"
for t in journey["tokens"]:
    t["bridgeApi"] = f"http://127.0.0.1:{sys.argv[5]}"
config = {"network": "stagenet", "relayUrl": f"{web}/relay", "tokens": site.get("tokens"), "pairs": site.get("pairs"),
          "bridges": journey, "solana": {"rpcUrl": sys.argv[6], "genesisHash": sys.argv[7], "cluster": "solana:devnet"},
          "walletTimeoutSeconds": 300}
json.dump({k: v for k, v in config.items() if v is not None}, open(sys.argv[3], "w"), indent=1)
PY
  cp "$RUN/site/config.json" "$OUT/site-config.served.json"
  docker run -d --name "$CP-site" --network "$NET" --memory 256m --pull=never -p "127.0.0.1:$WEB_PORT:8080" \
    -v "$RUN/site:/site:ro" -v "$HERE/site-server.ts:/srv/site-server.ts:ro" -e RELAY_UPSTREAM=http://relay:8080/ \
    -e KERNEL_UPSTREAM=https://stagenet.api-zswap.zkdojo.com/ -e BATCHER_UPSTREAM=https://stagenet.batcher-zswap.zkdojo.com/ \
    "$BUN_IMAGE" bun /srv/site-server.ts >/dev/null || fail "site server"
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
    if "$AGAVE/solana" airdrop 0.1 "$WALLET_A" --url "$DEVNET" --commitment confirmed >"$OUT/airdrop-a.log" 2>&1; then
      say "devnet airdrop 0.1 SOL to A"
    else
      say "the devnet airdrop was refused ($(tail -1 "$OUT/airdrop-a.log")); 0.05 SOL from the funder"
      "$AGAVE/solana" transfer "$WALLET_A" 0.05 --from "$CONF/devnet/funder.json" --fee-payer "$CONF/devnet/funder.json" \
        --allow-unfunded-recipient --url "$DEVNET" --commitment confirmed >"$OUT/transfer-sol-to-a.log" 2>&1 \
        || { cat "$OUT/transfer-sol-to-a.log"; fail "0.05 SOL to A"; }
    fi
  fi
  local ataA haveX
  ataA="$("$SPL_TOKEN" address --token "$MINT_X" --owner "$WALLET_A" --verbose --url "$DEVNET" 2>/dev/null | awk '/Associated token address/{print $NF}')"
  [[ -n "$ataA" ]] || fail "no associated token address for A"
  if ! haveX="$("$SPL_TOKEN" balance --address "$ataA" --url "$DEVNET" 2>/dev/null)"; then
    # A's token account for X, paid by x-operator (A's SOL is for its own lock fees).
    "$SPL_TOKEN" create-account "$MINT_X" --owner "$WALLET_A" --fee-payer "$RUN/secrets-x/solana-operator.json" \
      --url "$DEVNET" >"$OUT/create-ata-a.log" 2>&1 || { cat "$OUT/create-ata-a.log"; fail "A's token account for X"; }
    haveX=0
  fi
  if python3 -c "import sys; sys.exit(0 if float(sys.argv[1] or 0) < 2 else 1)" "$haveX"; then
    "$SPL_TOKEN" mint "$MINT_X" 2 "$ataA" --mint-authority "$RUN/secrets-x/solana-operator.json" \
      --fee-payer "$RUN/secrets-x/solana-operator.json" --url "$DEVNET" >"$OUT/mint-x-to-a.log" 2>&1 \
      || { cat "$OUT/mint-x-to-a.log"; fail "mint 2 X to A"; }
  fi
  echo "X on A's wallet: $("$SPL_TOKEN" balance --address "$ataA" --url "$DEVNET" 2>/dev/null)" | tee "$OUT/wallet-a-x.txt"
  snapshot funded

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

case "$CMD" in
  prep) prep ;;
  gate) gate ;;
  *) echo "usage: $0 prep|gate" >&2; exit 64 ;;
esac
