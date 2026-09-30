#!/usr/bin/env bash
# P6.3 (AA 00047): one capped stagenet run of the market, through the REAL relay (the image built from
# this branch, the pinned key set), with local proof servers (rc.8 for the account's circuits, rc.6
# for the sponsor's DUST) and the staging exchange (kernel + batcher, the stagenet profile's URLs).
#
#   KEYS_DIR=… RELAY_IMAGE=… APP_VOLUME=… OUT=… STATE_DIR=~/.config/aa-00047/p6-stagenet \
#   PS_PARAMS=… PS8_PARAMS=… SEED_FILE=<the shared funding wallet's file> STEPS=open-a,demo-a \
#   test/stack/p6/run-stagenet.sh
#
# The funding wallet is shared with other projects: the run takes FUNDING_LOCK first (created
# exclusively, one JSON line {purpose, pid, host, at}; if another process holds it, the run waits
# politely, up to LOCK_WAIT_MINUTES), holds it while the relay (or tamper-live.ts) has the wallet
# open, and removes it at the end. The relay itself is given a container-local lock path (the shared
# lock is this script's). The seed file is mounted read-only into the relay (and tamper-live.ts) and
# read in-process only; nothing here prints it.
#
# Cap: the sponsor's DUST is read from the relay's /health before the run and every 20 s; when the
# drop reaches DUST_CAP (default 100 DUST) the relay is stopped. SPONSOR_FEE_BLOCKS_MARGIN defaults
# to 5 (the declared fee is the estimate x 1.046^margin, and the ledger consumes all of it).
# STEPS=tamper stops the relay and runs tamper-live.ts (a tampered proof; nothing lands; HONEST=1
# submits the same call untampered as the control, which lands and pays its fee).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
: "${KEYS_DIR:?}" "${RELAY_IMAGE:?}" "${APP_VOLUME:?}" "${OUT:?}" "${STATE_DIR:?}" "${SEED_FILE:?}"
: "${PS_PARAMS:?}" "${PS8_PARAMS:?}"
STEPS="${STEPS:?e.g. open-a,demo-a}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
FUNDING_LOCK="${FUNDING_LOCK:-$HOME/.stagenet-offer-ladders/funding.lock}"
LOCK_WAIT_MINUTES="${LOCK_WAIT_MINUTES:-90}"
DUST_CAP_SPECKS="${DUST_CAP_SPECKS:-100000000000000000}" # 100 DUST
MARGIN="${SPONSOR_FEE_BLOCKS_MARGIN:-5}"
PREFIX="${PREFIX:-aa00047-p6-stg-$RANDOM}"
NET="$PREFIX-net"
RELAY_DATA_VOLUME="${RELAY_DATA_VOLUME:-aa00047-p6-relay-data}"
KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-a627edb18f6aa54c48194ee9fb38b89140887cfc56b0efb377c9504b79edda92}"
mkdir -p "$OUT" "$STATE_DIR" && chmod 700 "$STATE_DIR"
say() { printf '== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

free_port() {
  local p
  while :; do
    p=$((10000 + RANDOM % 50000))
    if ! (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "$p"; return; fi
  done
}
RELAY_PORT="$(free_port)"

# ── the shared funding lock ──────────────────────────────────────────────────
LOCK_TAKEN=0
take_lock() {
  local line deadline
  line="{\"purpose\":\"AA 00047 P6.3 night-market relay stagenet acceptance ($STEPS)\",\"pid\":$$,\"host\":\"$(hostname)\",\"at\":\"$(date -u +%FT%TZ)\"}"
  deadline=$((SECONDS + LOCK_WAIT_MINUTES * 60))
  while :; do
    if (set -o noclobber; printf '%s' "$line" >"$FUNDING_LOCK") 2>/dev/null; then
      chmod 600 "$FUNDING_LOCK"
      LOCK_TAKEN=1
      say "funding lock taken ($FUNDING_LOCK)"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      say "the funding lock is still held after $LOCK_WAIT_MINUTES min: $(cat "$FUNDING_LOCK" 2>/dev/null | head -c 300)"
      return 1
    fi
    say "the funding lock is held by another process; waiting: $(cat "$FUNDING_LOCK" 2>/dev/null | head -c 300)"
    sleep 60
  done
}
release_lock() {
  if [[ "$LOCK_TAKEN" == 1 ]] && grep -q "\"pid\":$$," "$FUNDING_LOCK" 2>/dev/null; then
    rm -f "$FUNDING_LOCK"
    say "funding lock released"
  fi
  LOCK_TAKEN=0
}

WATCH_PID=""
MEM_PID=""
teardown() {
  set +e
  [[ -n "$WATCH_PID" ]] && kill "$WATCH_PID" 2>/dev/null
  [[ -n "$MEM_PID" ]] && kill "$MEM_PID" 2>/dev/null
  docker logs "$PREFIX-relay" >"$OUT/relay.log" 2>&1
  # The contract prover's request log: every /prove with its duration (SC-004).
  docker logs "$PREFIX-ps8" >"$OUT/proof-server-rc8.log" 2>&1
  docker logs "$PREFIX-ps6" 2>&1 | tail -100 >"$OUT/proof-server-rc6.tail.log"
  docker rm -f "$PREFIX-relay" "$PREFIX-ps8" "$PREFIX-ps6" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  release_lock
  say "torn down $PREFIX"
}
trap teardown EXIT

take_lock

docker network create "$NET" >/dev/null
docker run -d --name "$PREFIX-ps8" --network "$NET" --network-alias proof-server-contracts --memory 14g \
  -e PORT=6300 -e MIDNIGHT_PP=/params -v "$PS8_PARAMS:/params" midnightntwrk/proof-server:9.0.0-rc.8 >/dev/null
docker run -d --name "$PREFIX-ps6" --network "$NET" --network-alias proof-server-dust --memory 6g \
  -e PORT=6300 -e MIDNIGHT_PP=/params -v "$PS_PARAMS:/params" \
  midnightntwrk/proof-server@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b >/dev/null
docker volume create "$RELAY_DATA_VOLUME" >/dev/null
# Memory of the contract prover and the relay, every few seconds (SC-004).
(
  set +e
  while sleep 3; do
    docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' "$PREFIX-ps8" "$PREFIX-relay" 2>/dev/null |
      awk -v t="$(date -u +%FT%TZ)" '{ print t "\t" $0 }' >>"$OUT/mem.tsv"
  done
) &
MEM_PID=$!

relay_up() {
  docker rm -f "$PREFIX-relay" >/dev/null 2>&1 || true
  docker run -d --name "$PREFIX-relay" --network "$NET" --network-alias relay \
    -p "127.0.0.1:$RELAY_PORT:8080" \
    -e RELAY_NETWORK=stagenet \
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-contracts:6300 \
    -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server-dust:6300 \
    -e RELAY_REQUIRE_KEYS=true -e RELAY_KEYS_FINGERPRINT="$KEYS_FINGERPRINT" \
    -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/secrets/sponsor-seed \
    -e SPONSOR_FUNDING_LOCK_FILE=/tmp/relay-funding.lock \
    -e SPONSOR_FEE_BLOCKS_MARGIN="$MARGIN" \
    -e DEMO_TOKENS_ENABLED=true -e DEMO_TOKENS_PACK="${DEMO_TOKENS_PACK:-twUSDC:1000,twBTC:0.1}" \
    -e DEMO_TOKENS_PATH="${DEMO_TOKENS_PATH:-direct}" -e DEMO_TOKENS_DAILY_CAP=10 \
    -e RELAY_DATA_DIR=/var/lib/night-market \
    -e RATE_LIMIT_ACTIONS_PER_MIN=100 -e RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN=100 \
    -e LOG_LEVEL=info \
    -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" \
    --mount "type=bind,source=$SEED_FILE,target=/run/secrets/sponsor-seed,readonly" \
    -v "$RELAY_DATA_VOLUME:/var/lib/night-market" \
    --memory 8g "$RELAY_IMAGE" >/dev/null
  say "relay starting on 127.0.0.1:$RELAY_PORT"
  local h=""
  for _ in $(seq 1 200); do
    h="$(curl -s "http://127.0.0.1:$RELAY_PORT/health" || true)"
    if python3 -c 'import json,sys; s=json.loads(sys.argv[1]).get("sponsor",{}); sys.exit(0 if s.get("synced") is True and s.get("state")=="synced" else 1)' "$h" 2>/dev/null; then break; fi
    sleep 6
  done
  printf '%s\n' "$h" >"$OUT/health-start-$(date -u +%H%M%S).json"
  say "relay health: $(head -c 900 <<<"$h")"
}
# The sponsor's DUST, only while the relay is idle: while a transaction is in flight the wallet
# counts the whole DUST output it spends as gone until the change comes back (a drop of thousands of
# DUST for a fee of a few), so a reading mid-job is not a spend.
dust_now() {
  curl -s "http://127.0.0.1:$RELAY_PORT/health" |
    python3 -c '
import json, sys
h = json.load(sys.stdin)
s = h.get("sponsor", {})
lanes = h.get("queue", {}).get("lanes", {})
idle = all(l.get("running", 0) == 0 and l.get("waiting", 0) == 0 for l in lanes.values())
print(s["dustSpecks"] if s.get("synced") is True and s.get("dustSpecks") and idle else "")' 2>/dev/null
}
# DUST amounts in specks exceed bash's 64-bit integers: compare and subtract in Python.
drop() { python3 -c 'import sys; print(int(sys.argv[1]) - int(sys.argv[2]))' "$1" "$2"; }
capped() { python3 -c 'import sys; sys.exit(0 if int(sys.argv[1]) - int(sys.argv[2]) >= int(sys.argv[3]) else 1)' "$1" "$2" "$3"; }

status=0
IFS=',' read -r -a STEP_LIST <<<"$STEPS"
FLOW_STEPS=()
TAMPER=0
for s in "${STEP_LIST[@]}"; do
  if [[ "$s" == tamper ]]; then TAMPER=1; else FLOW_STEPS+=("$s"); fi
done

if ((${#FLOW_STEPS[@]} > 0)); then
  relay_up
  START_DUST="$(dust_now)"
  [[ -n "$START_DUST" ]] || { say "the relay's sponsor is not ready; stopping"; exit 1; }
  printf '%s\n' "$START_DUST" >"$OUT/dust-start.txt"
  say "sponsor DUST at start: $START_DUST specks (cap: a drop of $DUST_CAP_SPECKS)"
  # The cap guard: stop the relay when the sponsor's DUST has dropped by the cap.
  (
    set +e
    over=0
    while sleep 20; do
      d="$(dust_now)"
      if [[ -z "$d" ]]; then over=0; continue; fi
      if capped "$START_DUST" "$d" "$DUST_CAP_SPECKS"; then over=$((over + 1)); else over=0; fi
      # Three idle readings in a row (a minute) below the cap: the change has had time to return.
      if ((over >= 3)); then
        echo "== cap reached: sponsor DUST $d (start $START_DUST); stopping the relay" >>"$OUT/cap.log"
        docker stop "$PREFIX-relay" >/dev/null 2>&1
        break
      fi
    done
  ) &
  WATCH_PID=$!
  flow_steps="$(IFS=,; echo "${FLOW_STEPS[*]}")"
  if docker run --rm --network "$NET" -v "$APP_VOLUME:/app:ro" \
    -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" -v "$STATE_DIR:/state" -v "$OUT:/out" \
    -e RELAY_URL=http://relay:8080 -e NETWORK=stagenet -e STATE_DIR=/state -e OUT=/out -e STEPS="$flow_steps" \
    ${GIVE_AMOUNT:+-e GIVE_AMOUNT="$GIVE_AMOUNT"} ${WANT_AMOUNT:+-e WANT_AMOUNT="$WANT_AMOUNT"} \
    -w /app "$BUN_IMAGE" bun test/stack/p6/market-flows.ts 2>&1 | tee -a "$OUT/market-flows.log"; then
    say "flows PASS ($flow_steps)"
  else
    say "flows FAILED ($flow_steps)"
    status=1
  fi
  # The settled balance: idle readings 20 s apart until two agree (the last change has returned).
  END_DUST=""
  prev=""
  for _ in $(seq 1 15); do
    sleep 20
    cur="$(dust_now)"
    [[ -n "$cur" ]] || continue
    if [[ "$cur" == "$prev" ]]; then END_DUST="$cur"; break; fi
    prev="$cur"
  done
  END_DUST="${END_DUST:-$prev}"
  printf '%s\n' "$END_DUST" >"$OUT/dust-end.txt"
  say "sponsor DUST at end: ${END_DUST:-unknown} specks (drop $(drop "$START_DUST" "${END_DUST:-$START_DUST}"))"
  kill "$WATCH_PID" 2>/dev/null || true
  WATCH_PID=""
  docker logs "$PREFIX-relay" >"$OUT/relay-$(date -u +%H%M%S).log" 2>&1 || true
  docker stop "$PREFIX-relay" >/dev/null 2>&1 || true
fi

if [[ "$TAMPER" == 1 ]]; then
  docker stop "$PREFIX-relay" >/dev/null 2>&1 || true
  if docker run --rm --network "$NET" -v "$APP_VOLUME:/app:ro" \
    -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" -v "$STATE_DIR:/state:ro" -v "$OUT:/out" \
    --mount "type=bind,source=$SEED_FILE,target=/run/secrets/sponsor-seed,readonly" \
    -e NETWORK=stagenet -e STATE_DIR=/state -e OUT=/out -e WHO="${TAMPER_WHO:-B}" \
    ${HONEST:+-e HONEST="$HONEST"} ${TAMPER_OUT_NAME:+-e OUT_NAME="$TAMPER_OUT_NAME"} \
    -e SPONSOR_SEED_FILE=/run/secrets/sponsor-seed -e SPONSOR_FEE_BLOCKS_MARGIN="$MARGIN" \
    -e MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed \
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-contracts:6300 \
    -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server-dust:6300 \
    -w /app "$BUN_IMAGE" bun test/stack/p6/tamper-live.ts 2>&1 | tee -a "$OUT/tamper-live.log"; then
    say "tampered proof refused (PASS)"
  else
    say "tampered proof: FAILED"
    status=1
  fi
fi
exit $status
