#!/usr/bin/env bash
# P6.2 (AA 00047): the whole market for two accounts on a ledger-9 localnet: lane B3's stack, the
# relay image with the key volume, and a mock exchange (kernel + a batcher with its own dev wallet).
# Runs test/stack/p6/market-flows.ts (open A and B, demo tokens for both, A makes, B takes, A
# withdraws, the relay's refusals), then stops the relay and runs test/stack/p6/tamper-live.ts (a
# tampered proof must be refused by the node). Tears everything down at the end, whatever happens.
#
# AA 00047 P9.I extends it (the security fix pass): the make signs MAKE_LIFETIME (default 900 s here,
# so the relay's TTL cap is visible); with UFAUCET_DIR (a compiled mint-test-tokens v2
# `unshielded-token.compact`) an unshielded utwUSDC is deployed and listed; fund-unshielded.ts mints it
# to a dev wallet (FUNDER_SEED_N, default 1 = genesis, the relay stopped meanwhile: one wallet process
# per seed) and deposits it into A (NIGHT itself cannot be deposited into the account: the node
# answers Custom error 231); FUND_KEYS_DIR must hold the account's deposit_unshielded prover key and
# its manifest entry, which the relay's key volume prunes (make it with test/stack/p6/fund-keys.sh).
# Then STEPS2 (an unshielded withdrawal, cancel, an expired offer, the P9 refusals, the P6 refusals),
# and with the relay stopped c2-live.ts (audit C2 at the circuit) after tamper-live.ts.
#
# AA 00047 P10.I extends it (the round-2 fix pass): STEPS2 adds the Q36 refusals (`p10-negatives`) and
# the key restore (`restore`); STEPS3 (`fairness`) runs the R2-1 probe on the real relay; STEPS4
# (`caps`) runs with the relay recreated under lowered per-account caps (CAPS=2,3,2,1: open offers,
# makes/day, cancels/day, restores/day) and STEPS5 (`caps-restore`) after recreating it with the
# defaults (the counters live in memory). The contract prover is restarted, relay stopped, before
# every phase (rc.8's memory grows across proofs, plan R7); c2-live.ts adds Q36 at the circuit. Every
# container has a memory cap (*_MEM_LIMIT, compose.yml); $OUT/mem.log samples the stack's use.
#
# AA 00047 P11.I extends it (the round-3 fix pass): every coin, balance and approval the flows check is
# the PAGE's own (test/stack/p6/page.ts: web/src/passport/operations.ts `syncAccount` decoding the
# account's whole history in the page); phase 1 adds `origin` and `history` (P11.A's origin reads and
# the indexer's contractActions subscription, page and relay readers); phase 2 is split in two (2a:
# `make-x`, `coin-spent`, `plant`, `cancel`, `bomb`; 2b: the refusals, `restore` with Q50, `omitted-spend`)
# with a fresh contract prover between; phase 4 runs the relay with WITHDRAWS_DAILY_CAP=1
# (CAP_WITHDRAWS_PER_DAY) for `withdraw-cap`; phase 6 (`large-history`) times a third party's deposits.
# A THIRD PARTY (test/stack/p6/third-party.ts) uses the localnet's development seed 3 (funded at
# genesis; neither the sponsor's 1 nor the mock batcher's 2), so the relay keeps running meanwhile.
# The flows' own container is capped too (FLOWS_MEM_LIMIT, default 4g).
#
# AA 00047 P11.F (the round-4 follow-up) adds `reconcile` to phase 1, after the take: the relay's
# reader (each call's entry point) and its refused-take judge (`judgeTake`, R4-2) on the real indexer.
# The smoke of record ran phase 1 alone (STEPS2..6 empty, SKIP_TAMPER=1) on the relay image built
# from the lane; an empty STEPS2 now skips phase 2 as the other phases' empty STEPS do (it used `:-`).
#
#   KEYS_DIR=~/.cache/aa-00047/b3-keys RELAY_IMAGE=aa00047-p6/relay:<sha> APP_VOLUME=<check volume> \
#   OUT=<dir> PS_PARAMS=<dir> PS8_PARAMS=<dir> RELAY_KEYS_FINGERPRINT=<pin> test/stack/p6/run-local.sh
#
# APP_VOLUME holds this repository with its node_modules and the light compile (scripts/docker-check.sh
# up + sync + install + contracts). The sponsor/funder is the localnet's genesis development seed and
# the mock batcher a second development seed: public test seeds, never real wallets. One heavy stack
# at a time on a host (a k=18 proof peaks near 9.4 GiB).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/test/stack/p6"
: "${KEYS_DIR:?}" "${RELAY_IMAGE:?}" "${APP_VOLUME:?}" "${OUT:?}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aa00047-p6-local-$RANDOM}"
export KEYS_DIR RELAY_IMAGE APP_VOLUME BUN_IMAGE
export PS_PARAMS="${PS_PARAMS:?writable proof-server params dir (rc.6)}"
export PS8_PARAMS="${PS8_PARAMS:?writable proof-server params dir (rc.8)}"
export INDEXER_IMAGE="${INDEXER_IMAGE:-midnightntwrk/indexer-standalone:4.4.0-rc.3}"
export RELAY_KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-}"
export DEMO_TOKENS_PATH="${DEMO_TOKENS_PATH:-direct}"
STEPS="${STEPS:-open-a,open-b,origin,history,demo-a,demo-b,make,take,reconcile,withdraw}"
STEPS2="${STEPS2-withdraw-unshielded,make-x,coin-spent,plant,cancel,bomb}"
STEPS2B="${STEPS2B-p10-negatives,restore,omitted-spend,expired,p9-negatives,negatives,history}"
STEPS3="${STEPS3-fairness}"
STEPS4="${STEPS4-caps,withdraw-cap}"
STEPS5="${STEPS5-caps-restore}"
STEPS6="${STEPS6-large-history}"
CAPS="${CAPS:-2,3,2,1}"
# P11.I: the relay's sponsored-withdrawal allowance in the caps phase (Q46; the default is 100).
CAP_WITHDRAWS_PER_DAY_LOW="${CAP_WITHDRAWS_PER_DAY_LOW:-1}"
export MAKE_LIFETIME="${MAKE_LIFETIME:-900}"
FUND_KEYS_DIR="${FUND_KEYS_DIR:-$KEYS_DIR}"

free_port() {
  local p
  while :; do
    p=$((10000 + RANDOM % 50000))
    if ! (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "$p"; return; fi
  done
}
export NODE_PORT="$(free_port)" INDEXER_PORT="$(free_port)" RELAY_PORT="$(free_port)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nm-p6-run.XXXXXX")"
STATE_DIR="$RUN_DIR/state"
mkdir -p "$STATE_DIR" "$OUT" && chmod 700 "$STATE_DIR"
export RUN_DIR
# The localnet's development seeds (public): 1 = genesis (faucet deployer + the relay's sponsor),
# 2 = the mock batcher's wallet; FUNDER_SEED_N (default 1) funds A's unshielded balance (P9.I).
printf '%064x\n' 1 >"$RUN_DIR/sponsor.seed"
printf '%064x\n' 2 >"$RUN_DIR/batcher.seed"
printf '%064x\n' "${FUNDER_SEED_N:-1}" >"$RUN_DIR/funder.seed"
# P11.I: the third party's wallet (development seed 3: funded at genesis, used by nobody else here).
printf '%064x\n' "${THIRD_PARTY_SEED_N:-3}" >"$RUN_DIR/third.seed"
chmod 600 "$RUN_DIR/sponsor.seed" "$RUN_DIR/batcher.seed" "$RUN_DIR/funder.seed" "$RUN_DIR/third.seed"

dc() { docker compose -f "$HERE/compose.yml" "$@"; }
MEM_PID=""
teardown() {
  set +e
  [[ -n "$MEM_PID" ]] && kill "$MEM_PID" 2>/dev/null
  dc --profile relay logs --no-color relay >"$OUT/relay.log" 2>&1
  dc --profile relay logs --no-color kernel >"$OUT/mock-exchange.log" 2>&1
  dc logs --no-color proof-server-rc8 2>&1 | tail -200 >"$OUT/proof-server-rc8.tail.log"
  dc logs --no-color proof-server 2>&1 | tail -100 >"$OUT/proof-server.tail.log"
  dc logs --no-color node 2>&1 | grep -i -E 'invalid|error|115' | tail -100 >"$OUT/node-errors.tail.log"
  dc logs --no-color node 2>&1 | grep -E 'Rejected transaction|Transaction malformed|Invalid Transaction' >"$OUT/node-rejections.log"
  dc --profile relay down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$RUN_DIR"
  echo "run-local: torn down $COMPOSE_PROJECT_NAME"
}
trap teardown EXIT

echo "run-local: $COMPOSE_PROJECT_NAME (node :$NODE_PORT, indexer :$INDEXER_PORT, relay :$RELAY_PORT)"
dc up -d node indexer proof-server proof-server-rc8
# The stack's memory, once a minute (the host is shared: plan "Docker").
(while :; do
  { date -u +%FT%TZ; docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' | grep "^$COMPOSE_PROJECT_NAME"; } >>"$OUT/mem.log" 2>&1
  sleep 60
done) &
MEM_PID=$!
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$INDEXER_PORT/api/v4/graphql" -H 'content-type: application/json' \
    -d '{"query":"{ block { height } }"}' | grep -q '"height"' && break
  sleep 3
done
echo "run-local: stack up"

bun_run() { # <extra docker args...> -- <script>
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --memory "${FLOWS_MEM_LIMIT:-4g}" \
    -v "$APP_VOLUME:/app:ro" -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" \
    -w /app "$@"
}
t0=$SECONDS
bun_run -v "$RUN_DIR:/run/nm" -e FUNDER_SEED_FILE=/run/nm/sponsor.seed "$BUN_IMAGE" \
  bun test/stack/b3/deploy-faucets.ts >"$RUN_DIR/tokens.json" 2>"$OUT/deploy-faucets.log"
# P9.I: an UNSHIELDED test token (mint-test-tokens v2 `unshielded-token.compact`, compiled into
# UFAUCET_DIR with compactc 0.34.0), listed beside the shielded ones, for the unshielded withdrawal.
# Mounted under /app so its module resolves the SDK's compact-runtime 0.19 (as the shielded faucet).
UCOLOUR="" UFAUCET_ADDR=""
if [[ -n "${UFAUCET_DIR:-}" ]]; then
  # The mountpoint, created once in the (scratch) app volume: a read-only /app cannot take a new one.
  docker run --rm --memory 512m -v "$APP_VOLUME:/app" "$BUN_IMAGE" mkdir -p /app/.ufaucet
  bun_run -v "$RUN_DIR:/run/nm" -v "$UFAUCET_DIR:/app/.ufaucet:ro" -e FUNDER_SEED_FILE=/run/nm/sponsor.seed \
    -e FAUCET_BUNDLE=/app/.ufaucet -e PRIVACY=unshielded -e FAUCETS=utwUSDC:6 "$BUN_IMAGE" \
    bun test/stack/b3/deploy-faucets.ts >"$RUN_DIR/utokens.json" 2>"$OUT/deploy-ufaucet.log"
  read -r UFAUCET_ADDR UCOLOUR < <(python3 - "$RUN_DIR/tokens.json" "$RUN_DIR/utokens.json" <<'PY'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
a["tokens"] += b["tokens"]
json.dump(a, open(sys.argv[1], "w"), indent=1)
print(b["tokens"][0]["contract"], b["tokens"][0]["midnightColour"])
PY
  )
fi
export UNSHIELDED_COLOUR="$UCOLOUR"
cp "$RUN_DIR/tokens.json" "$OUT/tokens.json"
echo "run-local: faucets deployed in $((SECONDS - t0)) s${UCOLOUR:+ (unshielded utwUSDC $UCOLOUR)}"

dc --profile relay up -d relay kernel
for i in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$RELAY_PORT/health" | grep -q '"synced":true' && break
  sleep 3
done
curl -s "http://127.0.0.1:$RELAY_PORT/health" >"$OUT/health.json" || true
echo "run-local: relay up (DEMO_TOKENS_PATH=$DEMO_TOKENS_PATH)"

relay_ready() {
  for i in $(seq 1 100); do
    curl -sf "http://127.0.0.1:$RELAY_PORT/health" | grep -q '"synced":true' && return 0
    sleep 3
  done
  echo "run-local: the relay is not ready"
  return 1
}
# A fresh contract prover (the relay stopped first: nothing in flight). rc.8's memory grows across
# proofs (P9.I local run 3: OOM-killed at 14 GB after about 25).
fresh_prover() {
  dc logs --no-color proof-server-rc8 2>&1 | tail -100 >"$OUT/proof-server-rc8.before-restart-$1.log"
  dc restart proof-server-rc8 >/dev/null
  for i in $(seq 1 30); do
    docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --memory 512m "$BUN_IMAGE" bun -e \
      "const r = await fetch('http://proof-server-rc8:6300/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)" \
      >/dev/null 2>&1 && break
    sleep 2
  done
  echo "run-local: fresh contract prover ($1)"
}
# Recreate the relay container (new settings); its log so far is kept first.
relay_recreate() { # <name>
  dc --profile relay logs --no-color relay >"$OUT/relay-$1.log" 2>&1 || true
  dc --profile relay up -d --no-deps --force-recreate relay >/dev/null
  relay_ready
  echo "run-local: relay recreated ($1)"
}

status=0
flows() { # <steps>
  bun_run -v "$RUN_DIR:/run/nm:ro" -v "$STATE_DIR:/state" -v "$OUT:/out" -e RELAY_URL=http://relay:8080 \
    -e NETWORK=undeployed -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out \
    -e KERNEL_URL=http://kernel:9999 -e INDEXER_URL=http://indexer:8088/api/v4/graphql -e STEPS="$1" \
    -e MAKE_LIFETIME="$MAKE_LIFETIME" -e CAPS="$CAPS" ${UNSHIELDED_COLOUR:+-e UNSHIELDED_COLOUR="$UNSHIELDED_COLOUR"} \
    -e THIRD_PARTY_SEED_FILE=/run/nm/third.seed -e CAP_WITHDRAWS_PER_DAY="${CAP_WITHDRAWS_PER_DAY:-100}" \
    ${LARGE_HISTORY_N:+-e LARGE_HISTORY_N="$LARGE_HISTORY_N"} ${LARGE_HISTORY_BUDGET_S:+-e LARGE_HISTORY_BUDGET_S="$LARGE_HISTORY_BUDGET_S"} \
    ${LARGE_HISTORY_TARGET:+-e LARGE_HISTORY_TARGET="$LARGE_HISTORY_TARGET"} \
    "$BUN_IMAGE" bun test/stack/p6/market-flows.ts 2>&1 | tee -a "$OUT/market-flows.log"
}
if flows "$STEPS"; then
  echo "run-local: market flows PASS ($STEPS)"
else
  echo "run-local: market flows FAILED ($STEPS)"
  status=1
fi

# P9.I: an unshielded balance for A (the demo pack is shielded only), from a THIRD dev wallet.
if [[ "$status" == 0 && -n "$STEPS2" ]]; then
  ACCOUNT_A="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["A"].get("account",""))' "$STATE_DIR/state.json")"
  if [[ "${FUND_UNSHIELDED:-1}" == 1 && -n "$ACCOUNT_A" ]]; then
    # The genesis seed is the relay's sponsor: stop the relay while another process opens it.
    [[ "${FUNDER_SEED_N:-1}" == 1 ]] && dc --profile relay stop relay >/dev/null
    if docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --memory "${FLOWS_MEM_LIMIT:-4g}" -v "$APP_VOLUME:/app:ro" \
      -v "$FUND_KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN_DIR:/run/nm:ro" -w /app \
      -e FUNDER_SEED_FILE=/run/nm/funder.seed -e FUND_ACCOUNT="$ACCOUNT_A" -e FUND_AMOUNT="${FUND_UNSHIELDED_AMOUNT:-5000000}" \
      ${UFAUCET_DIR:+-v "$UFAUCET_DIR:/app/.ufaucet:ro" -e MINT_BUNDLE=/app/.ufaucet -e MINT_FAUCET="$UFAUCET_ADDR"} \
      ${UCOLOUR:+-e FUND_COLOUR="$UCOLOUR"} \
      "$BUN_IMAGE" bun test/stack/p6/fund-unshielded.ts 2>&1 | tee "$OUT/fund-unshielded.log"; then
      echo "run-local: A funded (unshielded)"
    else
      echo "run-local: unshielded funding FAILED"
      status=1
    fi
    # P10.I: a fresh contract prover for the next phase, while the relay is stopped.
    [[ "${FUNDER_SEED_N:-1}" == 1 ]] && fresh_prover phase2
    if [[ "${FUNDER_SEED_N:-1}" == 1 ]]; then
      dc --profile relay start relay >/dev/null
      for i in $(seq 1 100); do
        curl -sf "http://127.0.0.1:$RELAY_PORT/health" | grep -q '"synced":true' && break
        sleep 3
      done
      echo "run-local: relay restarted"
    fi
  fi
  if [[ "$status" == 0 ]]; then
    if flows "$STEPS2"; then
      echo "run-local: market flows PASS ($STEPS2)"
    else
      echo "run-local: market flows FAILED ($STEPS2)"
      status=1
    fi
  fi
fi

# P11.I: phase 2b on a fresh contract prover (rc.8's memory grows across proofs, plan R7).
if [[ "$status" == 0 && -n "$STEPS2B" ]]; then
  dc --profile relay stop relay >/dev/null
  fresh_prover phase2b
  dc --profile relay start relay >/dev/null
  relay_ready
  if flows "$STEPS2B"; then
    echo "run-local: market flows PASS ($STEPS2B)"
  else
    echo "run-local: market flows FAILED ($STEPS2B)"
    status=1
  fi
fi

# P10.I, R2-1 on the real relay: the fairness probe on a fresh prover.
if [[ "$status" == 0 && -n "$STEPS3" ]]; then
  dc --profile relay stop relay >/dev/null
  fresh_prover phase3
  dc --profile relay start relay >/dev/null
  relay_ready
  if flows "$STEPS3"; then
    echo "run-local: market flows PASS ($STEPS3)"
  else
    echo "run-local: market flows FAILED ($STEPS3)"
    status=1
  fi
fi

# P10.I, R2-1's per-account caps: the relay recreated with lowered caps, then with the defaults (the
# counters live in memory: a restart resets them).
if [[ "$status" == 0 && -n "$STEPS4" ]]; then
  IFS=, read -r CAP_OFFERS_MAX_OPEN CAP_MAKES_PER_DAY CAP_CANCELS_PER_DAY CAP_RESTORES_PER_DAY <<<"$CAPS"
  dc --profile relay stop relay >/dev/null
  fresh_prover phase4
  CAP_OFFERS_MAX_OPEN=$CAP_OFFERS_MAX_OPEN CAP_MAKES_PER_DAY=$CAP_MAKES_PER_DAY \
    CAP_CANCELS_PER_DAY=$CAP_CANCELS_PER_DAY CAP_RESTORES_PER_DAY=$CAP_RESTORES_PER_DAY \
    CAP_WITHDRAWS_PER_DAY=$CAP_WITHDRAWS_PER_DAY_LOW relay_recreate phase3
  docker inspect "$(dc --profile relay ps -q relay)" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    grep -E '^(OFFERS_MAX_OPEN|MAKES|CANCELS|RESTORES|WITHDRAWS)_(PER|DAILY)' >"$OUT/caps-env.txt" || true
  if CAP_WITHDRAWS_PER_DAY=$CAP_WITHDRAWS_PER_DAY_LOW flows "$STEPS4"; then
    echo "run-local: market flows PASS ($STEPS4)"
  else
    echo "run-local: market flows FAILED ($STEPS4)"
    status=1
  fi
  if [[ -n "$STEPS5" ]]; then
    dc --profile relay stop relay >/dev/null
    relay_recreate phase4
    if flows "$STEPS5"; then
      echo "run-local: market flows PASS ($STEPS5)"
    else
      echo "run-local: market flows FAILED ($STEPS5)"
      status=1
    fi
  fi
fi

# P11.I, R3-5: the large-history phase on a fresh contract prover (a third party's deposits into B).
if [[ "$status" == 0 && -n "$STEPS6" ]]; then
  dc --profile relay stop relay >/dev/null
  fresh_prover phase6
  dc --profile relay start relay >/dev/null
  relay_ready
  if flows "$STEPS6"; then
    echo "run-local: market flows PASS ($STEPS6)"
  else
    echo "run-local: market flows FAILED ($STEPS6)"
    status=1
  fi
fi

# The tampered proof: the relay must be stopped first (the script opens the sponsor wallet itself).
if [[ "${SKIP_TAMPER:-0}" != 1 ]]; then
  dc --profile relay logs --no-color relay >"$OUT/relay.log" 2>&1 || true
  dc --profile relay stop relay >/dev/null
  # A fresh contract prover: rc.8's memory grows across proofs, and after a full run (about 25
  # proofs) a k=18 proof was OOM-killed at the 14 GB cap (P9.I local run 3).
  dc logs --no-color proof-server-rc8 2>&1 | tail -400 >"$OUT/proof-server-rc8.before-restart.log"
  dc restart proof-server-rc8 >/dev/null
  for i in $(seq 1 30); do
    docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" --memory 512m "$BUN_IMAGE" bun -e \
      "const r = await fetch('http://proof-server-rc8:6300/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)" \
      >/dev/null 2>&1 && break
    sleep 2
  done
  if bun_run -v "$RUN_DIR:/run/nm:ro" -v "$STATE_DIR:/state:ro" -v "$OUT:/out" -e NETWORK=undeployed \
    -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out -e WHO="${TAMPER_WHO:-B}" \
    -e SPONSOR_SEED_FILE=/run/nm/sponsor.seed -e SPONSOR_FEE_BLOCKS_MARGIN=20 \
    -e MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed \
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 \
    -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server:6300 \
    "$BUN_IMAGE" bun test/stack/p6/tamper-live.ts 2>&1 | tee "$OUT/tamper-live.log"; then
    echo "run-local: tampered proof refused (PASS)"
  else
    echo "run-local: tampered proof FAILED"
    status=1
  fi
  # P9.I, audit C2 at the circuit: a valid signature over a withdrawal naming another token than the
  # coin's must be refused by the account's circuit (the relay is still stopped).
  if [[ "${SKIP_C2:-0}" != 1 ]] && python3 -c 'import json,sys; sys.exit(0 if "c2Coin" in json.load(open(sys.argv[1])) else 1)' "$STATE_DIR/state.json"; then
    if bun_run -v "$RUN_DIR:/run/nm:ro" -v "$STATE_DIR:/state:ro" -v "$OUT:/out" -e NETWORK=undeployed \
      -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out \
      -e SPONSOR_SEED_FILE=/run/nm/sponsor.seed -e SPONSOR_FEE_BLOCKS_MARGIN=20 \
      -e MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed \
      -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 \
      -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server:6300 \
      "$BUN_IMAGE" bun test/stack/p6/c2-live.ts 2>&1 | tee "$OUT/c2-live.log"; then
      echo "run-local: C2 refused by the circuit (PASS)"
    else
      echo "run-local: C2 at the circuit FAILED"
      status=1
    fi
  fi
fi
exit $status
