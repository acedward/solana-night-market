#!/usr/bin/env bash
# AA 00060 P3, gate G-LANDING, on a ledger-9 localnet: Night Market's p6 stack (test/stack/p6/compose.yml:
# node, indexer, proof servers rc.6 and rc.8, the relay; no mock exchange) and ./landing.ts, one STEP at a
# time, with the relay started and stopped around the steps that open the sponsor seed (dev seed 1: one
# wallet process per seed). Then everything is torn down, whatever happens, and the stack lock released.
#
#   KEYS_DIR=~/.cache/aa-00047/p10i-keys RELAY_IMAGE=nm-relay:aa00060 APP_VOLUME=aa00060-check-app \
#   PS_PARAMS=~/.cache/aa-00047/ps-params PS8_PARAMS=~/.cache/aa-00047/ps-params-rc8 \
#   BRIDGE_MANAGED=<the 00050 template's contract-bridge/src/managed> OUT=<dir> \
#   RELAY_KEYS_FINGERPRINT=<pin> test/gates/landing/run-local.sh
#
# The shared caches are never written: the key volume and both params directories are copied
# (copy-on-write, `cp -Rc`) into the run's temp directory. The harness proves with a COPY of the key
# volume that also holds the bridge bundle (`bridge/`: the P0.6 artefacts, so the relay's own proof
# provider can prove `mintFromSolana` and `lockForSolana`); the relay keeps the unchanged key volume.
#
# The stack lock ~/.aa-00057-stack.lock (shared with 00057-00059) is taken before `up` and removed after
# `down`; a held lock makes this script wait (LOCK_WAIT_S, default 3 h), it never removes another
# holder's lock. Every host port is a random free one >= 10000 on 127.0.0.1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/test/gates/landing"
P6="$ROOT/test/stack/p6"
: "${KEYS_DIR:?}" "${RELAY_IMAGE:?}" "${APP_VOLUME:?}" "${OUT:?}" "${BRIDGE_MANAGED:?}"
: "${PS_PARAMS:?}" "${PS8_PARAMS:?}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aa00060-landing-$RANDOM}"
export INDEXER_IMAGE="${INDEXER_IMAGE:-midnightntwrk/indexer-standalone:4.4.0-rc.1}"
export RELAY_IMAGE APP_VOLUME BUN_IMAGE
export RELAY_KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-}"
export DEMO_TOKENS_PATH="${DEMO_TOKENS_PATH:-direct}"
LOCK="$HOME/.aa-00057-stack.lock"
LOCK_WAIT_S="${LOCK_WAIT_S:-10800}"

free_port() {
  local p
  while :; do
    p=$((10000 + RANDOM % 50000))
    if ! (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "$p"; return; fi
  done
}

# ── the stack lock ───────────────────────────────────────────────────────────
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  if (( waited == 0 )); then echo "run-local: the stack lock is held: $(cat "$LOCK/holder" 2>/dev/null || echo '?'); waiting"; fi
  if (( waited >= LOCK_WAIT_S )); then echo "run-local: gave up waiting for the stack lock" >&2; exit 75; fi
  sleep 60; waited=$((waited + 60))
done
printf '00060 %s %s compose project %s\n' "$(date -u +%FT%TZ)" "${GATE_NAME:-G-LANDING (P3)}" "$COMPOSE_PROJECT_NAME" >"$LOCK/holder"

mkdir -p "$OUT"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aa00060-landing.XXXXXX")"
STATE_DIR="$RUN_DIR/state"
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
export RUN_DIR
export NODE_PORT="$(free_port)" INDEXER_PORT="$(free_port)" RELAY_PORT="$(free_port)"
# Copies of the shared caches (copy-on-write): the relay's key volume, the harness's (+ bridge), params.
cp -Rc "$KEYS_DIR" "$RUN_DIR/keys-relay"
cp -Rc "$KEYS_DIR" "$RUN_DIR/keys-harness"
cp -Rc "$BRIDGE_MANAGED" "$RUN_DIR/keys-harness/bridge"
cp -Rc "$PS_PARAMS" "$RUN_DIR/ps-params"
cp -Rc "$PS8_PARAMS" "$RUN_DIR/ps8-params"
export KEYS_DIR="$RUN_DIR/keys-relay" PS_PARAMS="$RUN_DIR/ps-params" PS8_PARAMS="$RUN_DIR/ps8-params"
printf '%064x\n' 1 >"$RUN_DIR/sponsor.seed"
printf '%064x\n' 2 >"$RUN_DIR/batcher.seed"
printf '%064x\n' 3 >"$RUN_DIR/third.seed"
chmod 600 "$RUN_DIR"/*.seed

dc() { docker compose -f "$P6/compose.yml" "$@"; }
MEM_PID=""
teardown() {
  set +e
  [[ -n "$MEM_PID" ]] && kill "$MEM_PID" 2>/dev/null
  dc --profile relay logs --no-color relay >"$OUT/relay.log" 2>&1
  dc logs --no-color proof-server-rc8 2>&1 | tail -300 >"$OUT/proof-server-rc8.tail.log"
  dc logs --no-color proof-server 2>&1 | tail -100 >"$OUT/proof-server.tail.log"
  dc logs --no-color node 2>&1 | grep -E 'Rejected transaction|Transaction malformed|Invalid Transaction|InvalidProof|Custom error' | tail -100 >"$OUT/node-rejections.log"
  dc --profile relay down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$RUN_DIR"
  if [[ "$(cut -d' ' -f1 "$LOCK/holder" 2>/dev/null)" == 00060 ]]; then rm -rf "$LOCK"; fi
  echo "run-local: torn down $COMPOSE_PROJECT_NAME; lock released"
}
trap teardown EXIT

echo "run-local: $COMPOSE_PROJECT_NAME (node :$NODE_PORT, indexer :$INDEXER_PORT, relay :$RELAY_PORT; indexer $INDEXER_IMAGE)"
dc up -d node indexer proof-server proof-server-rc8
(while :; do
  { date -u +%FT%TZ; docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep "^$COMPOSE_PROJECT_NAME"; } >>"$OUT/mem.log" 2>&1
  sleep 30
done) &
MEM_PID=$!
for i in $(seq 1 160); do
  curl -sf "http://127.0.0.1:$INDEXER_PORT/api/v4/graphql" -H 'content-type: application/json' \
    -d '{"query":"{ block { height } }"}' | grep -q '"height"' && break
  sleep 3
done
curl -sf "http://127.0.0.1:$INDEXER_PORT/api/v4/graphql" -H 'content-type: application/json' -d '{"query":"{ block { height } }"}' \
  | grep -q '"height"' || { echo "run-local: the indexer never answered"; exit 1; }
echo "run-local: stack up"

bun_run() { # <extra docker args...> -- <image and command>
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --memory "${FLOWS_MEM_LIMIT:-6g}" \
    -v "$APP_VOLUME:/app:ro" "$@"
}
T0=$SECONDS
bun_run -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN_DIR:/run/nm" \
  -e FUNDER_SEED_FILE=/run/nm/sponsor.seed -w /app "$BUN_IMAGE" bun test/stack/b3/deploy-faucets.ts \
  >"$RUN_DIR/tokens.json" 2>"$OUT/deploy-faucets.log"
echo "run-local: faucets deployed ($((SECONDS - T0)) s)"

landing() { # STEP=… [VAR=…]…
  local args=()
  for kv in "$@"; do args+=(-e "$kv"); done
  bun_run -v "$RUN_DIR/keys-harness:/app/vendor/passport/contract/contracts/managed:ro" \
    -v "$RUN_DIR:/run/nm" -v "$STATE_DIR:/state" -v "$OUT:/out" -w /app \
    -e NETWORK=undeployed -e STATE_DIR=/state -e OUT=/out -e RUN_DIR_IN=/run/nm \
    -e RELAY_URL=http://relay:8080 -e INDEXER_URL=http://indexer:8088/api/v4/graphql -e NODE_WS_URL=ws://node:9944 \
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server:6300 \
    -e THIRD_PARTY_SEED_FILE=/run/nm/third.seed -e SPONSOR_SEED_FILE=/run/nm/sponsor.seed \
    "${args[@]}" "$BUN_IMAGE" bun test/gates/landing/landing.ts 2>&1 | tee -a "$OUT/landing.log"
  return "${PIPESTATUS[0]}"
}
relay_ready() {
  for i in $(seq 1 100); do
    curl -sf "http://127.0.0.1:$RELAY_PORT/health" | grep -q '"synced":true' && return 0
    sleep 3
  done
  echo "run-local: the relay is not ready"; return 1
}
relay_up() { dc --profile relay up -d relay >/dev/null; relay_ready; }
relay_stop() { dc --profile relay stop relay >/dev/null; }
fresh_prover() {
  dc restart proof-server-rc8 >/dev/null
  for i in $(seq 1 30); do
    docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --memory 256m "$BUN_IMAGE" bun -e \
      "const r = await fetch('http://proof-server-rc8:6300/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)" \
      >/dev/null 2>&1 && break
    sleep 2
  done
}
phase() { echo; echo "run-local: ==== $1 ($((SECONDS - T0)) s)"; }

status=0
# P6.0, the Q5 gate (GATE=q5): a coin sealed to ANOTHER encryption key is spent through the page's
# computed path, (i) to finish the lock and (ii) to return it to A; the honest path, by the SDK wallet and
# by the computed path, still lands.
run_q5() {
  phase 'bridge-deploy (third party, dev seed 3)'
  landing STEP=bridge-deploy || return 1
  local bridge
  bridge="$(grep -h '^BRIDGE ' "$OUT/landing.log" | tail -1 | sed 's/^BRIDGE //')"
  python3 - "$RUN_DIR/tokens.json" "$bridge" <<'PY'
import json, sys
t = json.load(open(sys.argv[1])); b = json.loads(sys.argv[2])
t["tokens"].append({"symbol": "Y", "name": "Bridged Y", "decimals": 6, "privacy": "shielded",
                    "midnightColour": b["colour"], "contract": b["contract"], "domainSeparator": ""})
json.dump(t, open(sys.argv[1], "w"), indent=1)
PY
  cp "$RUN_DIR/tokens.json" "$OUT/tokens.json"
  phase 'relay up; open account A (market-flows.ts STEPS=open-a)'
  relay_up || return 1
  bun_run -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN_DIR:/run/nm:ro" \
    -v "$STATE_DIR:/state" -v "$OUT:/out" -w /app -e RELAY_URL=http://relay:8080 -e NETWORK=undeployed \
    -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out -e OUT_NAME=market-flows-open-a.json \
    -e INDEXER_URL=http://indexer:8088/api/v4/graphql -e STEPS=open-a \
    "$BUN_IMAGE" bun test/stack/p6/market-flows.ts 2>&1 | tee -a "$OUT/market-flows.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || return 1

  phase 'honest, unchanged: 10 Y, tx1, tx2 by the SDK wallet'
  landing STEP=fund FUND_AMOUNT=10000000 LABEL=fund-h1 || return 1
  landing STEP=tx1 AMOUNT=10000000 LABEL=tx1-h1 || return 1
  relay_stop || return 1; fresh_prover
  landing STEP=tx2 TX1_LABEL=tx1-h1 LABEL=tx2-h1-sdk || return 1

  phase 'honest, computed path: 10 Y, tx1, tx2 by the computed coin'
  relay_up || return 1
  landing STEP=fund FUND_AMOUNT=10000000 LABEL=fund-h2 || return 1
  landing STEP=tx1 AMOUNT=10000000 LABEL=tx1-h2 || return 1
  relay_stop || return 1; fresh_prover
  landing STEP=tx2 TX1_LABEL=tx1-h2 LABEL=tx2-h2-computed COMPUTED=1 || return 1

  phase 'Q5 (i): 15 Y, tx1 SEALED TO ANOTHER KEY; the SDK misses it; the computed coin finishes the lock'
  relay_up || return 1
  landing STEP=fund FUND_AMOUNT=15000000 LABEL=fund-s1 || return 1
  landing STEP=tx1 AMOUNT=15000000 LABEL=tx1-s1 SEAL_TO=other || return 1
  relay_stop || return 1; fresh_prover
  landing STEP=neg-seal-check TX1_LABEL=tx1-s1 COMPUTED=1 || return 1
  landing STEP=tx2 TX1_LABEL=tx1-s1 LABEL=tx2-s1-computed COMPUTED=1 || return 1

  phase 'Q5 (ii): 10 Y, tx1 SEALED TO ANOTHER KEY; the computed coin returns it to A'
  relay_up || return 1
  landing STEP=fund FUND_AMOUNT=10000000 LABEL=fund-s2 || return 1
  landing STEP=tx1 AMOUNT=10000000 LABEL=tx1-s2 SEAL_TO=other || return 1
  relay_stop || return 1; fresh_prover
  landing STEP=neg-seal-check TX1_LABEL=tx1-s2 COMPUTED=1 || return 1
  landing STEP=return TX1_LABEL=tx1-s2 COMPUTED=1 || return 1
}
if [[ "${GATE:-}" == q5 ]]; then
  if run_q5; then echo "run-local: Q5 GATE PASS ($((SECONDS - T0)) s)"; else echo "run-local: Q5 GATE FAILED"; status=1; fi
  exit $status
fi
run_phases() {
  phase 'bridge-deploy (third party, dev seed 3)'
  landing STEP=bridge-deploy || return 1
  local bridge
  bridge="$(grep -h '^BRIDGE ' "$OUT/landing.log" | tail -1 | sed 's/^BRIDGE //')"
  python3 - "$RUN_DIR/tokens.json" "$bridge" <<'PY'
import json, sys
t = json.load(open(sys.argv[1])); b = json.loads(sys.argv[2])
t["tokens"].append({"symbol": "Y", "name": "Bridged Y", "decimals": 6, "privacy": "shielded",
                    "midnightColour": b["colour"], "contract": b["contract"], "domainSeparator": ""})
json.dump(t, open(sys.argv[1], "w"), indent=1)
PY
  cp "$RUN_DIR/tokens.json" "$OUT/tokens.json"

  phase 'relay up; L.3 open account A (market-flows.ts STEPS=open-a)'
  relay_up || return 1
  bun_run -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN_DIR:/run/nm:ro" \
    -v "$STATE_DIR:/state" -v "$OUT:/out" -w /app -e RELAY_URL=http://relay:8080 -e NETWORK=undeployed \
    -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out -e OUT_NAME=market-flows-open-a.json \
    -e INDEXER_URL=http://indexer:8088/api/v4/graphql -e STEPS=open-a \
    "$BUN_IMAGE" bun test/stack/p6/market-flows.ts 2>&1 | tee -a "$OUT/market-flows.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || return 1

  phase 'L.4 fund A with 50 Y (mintFromSolana + deposit_shielded, third party)'
  landing STEP=fund FUND_AMOUNT=50000000 LABEL=fund || return 1
  phase 'L.1 + L.5 tx1 (50 Y to keys_t) through the real relay'
  landing STEP=tx1 AMOUNT=50000000 LABEL=tx1 || return 1

  phase 'L.6 + L.7 tx2 lockForSolana (relay stopped; DUST-only sponsor = dev seed 1)'
  relay_stop || return 1; fresh_prover
  landing STEP=tx2 TX1_LABEL=tx1 LABEL=tx2 || return 1

  phase 'L.8 resume: 30 Y, tx1, then a new process finds the coin and finishes the lock'
  relay_up || return 1
  landing STEP=fund FUND_AMOUNT=30000000 LABEL=fund30 || return 1
  landing STEP=tx1 AMOUNT=30000000 LABEL=tx1-30 || return 1
  relay_stop || return 1
  landing STEP=resume-lock || return 1

  phase 'L.8 return: 20 Y, tx1, then a new process finds the coin and returns it to A'
  relay_up || return 1
  landing STEP=fund FUND_AMOUNT=20000000 LABEL=fund20 || return 1
  landing STEP=tx1 AMOUNT=20000000 LABEL=tx1-20 || return 1
  relay_stop || return 1; fresh_prover
  landing STEP=resume-return || return 1

  phase 'L.9 (a) a tampered recipient at the live relay'
  relay_up || return 1
  landing STEP=neg-relay || return 1
  phase 'L.9 (b) a tampered recipient at the circuit (relay stopped)'
  relay_stop || return 1
  landing STEP=neg-circuit || return 1

  phase 'L.9 (c) tx2 with the Solana recipient changed after proving; then the honest tx2 lands'
  relay_up || return 1
  landing STEP=tx1 AMOUNT=5000000 LABEL=tx1-5 || return 1
  relay_stop || return 1; fresh_prover
  landing STEP=tx2 TX1_LABEL=tx1-5 LABEL=negNode TAMPER=1 || true
  landing STEP=tx2 TX1_LABEL=tx1-5 LABEL=tx2-after-negNode || return 1

  phase 'L.9 (d) tx1 sealed to another encryption key: does the SDK wallet still see the coin?'
  relay_up || return 1
  landing STEP=tx1 AMOUNT=2000000 LABEL=tx1-seal SEAL_TO=other || true
  landing STEP=neg-seal-check TX1_LABEL=tx1-seal || true
}
if run_phases; then echo "run-local: G-LANDING phases PASS ($((SECONDS - T0)) s)"; else echo "run-local: G-LANDING FAILED"; status=1; fi
exit $status
