#!/usr/bin/env bash
# P6.2 (AA 00047): the whole market for two accounts on a ledger-9 localnet: lane B3's stack, the
# relay image with the key volume, and a mock exchange (kernel + a batcher with its own dev wallet).
# Runs test/stack/p6/market-flows.ts (open A and B, demo tokens for both, A makes, B takes, A
# withdraws, the relay's refusals), then stops the relay and runs test/stack/p6/tamper-live.ts (a
# tampered proof must be refused by the node). Tears everything down at the end, whatever happens.
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
STEPS="${STEPS:-open-a,open-b,demo-a,demo-b,make,take,withdraw,negatives}"

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
# 2 = the mock batcher's wallet.
printf '%064x\n' 1 >"$RUN_DIR/sponsor.seed"
printf '%064x\n' 2 >"$RUN_DIR/batcher.seed"
chmod 600 "$RUN_DIR/sponsor.seed" "$RUN_DIR/batcher.seed"

dc() { docker compose -f "$HERE/compose.yml" "$@"; }
teardown() {
  set +e
  dc --profile relay logs --no-color relay >"$OUT/relay.log" 2>&1
  dc --profile relay logs --no-color kernel >"$OUT/mock-exchange.log" 2>&1
  dc logs --no-color proof-server-rc8 2>&1 | tail -200 >"$OUT/proof-server-rc8.tail.log"
  dc logs --no-color proof-server 2>&1 | tail -100 >"$OUT/proof-server.tail.log"
  dc logs --no-color node 2>&1 | grep -i -E 'invalid|error|115' | tail -100 >"$OUT/node-errors.tail.log"
  dc --profile relay down -v --remove-orphans >/dev/null 2>&1
  rm -rf "$RUN_DIR"
  echo "run-local: torn down $COMPOSE_PROJECT_NAME"
}
trap teardown EXIT

echo "run-local: $COMPOSE_PROJECT_NAME (node :$NODE_PORT, indexer :$INDEXER_PORT, relay :$RELAY_PORT)"
dc up -d node indexer proof-server proof-server-rc8
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$INDEXER_PORT/api/v4/graphql" -H 'content-type: application/json' \
    -d '{"query":"{ block { height } }"}' | grep -q '"height"' && break
  sleep 3
done
echo "run-local: stack up"

bun_run() { # <extra docker args...> -- <script>
  docker run --rm --network "${COMPOSE_PROJECT_NAME}_default" \
    -v "$APP_VOLUME:/app:ro" -v "$KEYS_DIR:/app/vendor/passport/contract/contracts/managed:ro" \
    -w /app "$@"
}
t0=$SECONDS
bun_run -v "$RUN_DIR:/run/nm" -e FUNDER_SEED_FILE=/run/nm/sponsor.seed "$BUN_IMAGE" \
  bun test/stack/b3/deploy-faucets.ts >"$RUN_DIR/tokens.json" 2>"$OUT/deploy-faucets.log"
cp "$RUN_DIR/tokens.json" "$OUT/tokens.json"
echo "run-local: faucets deployed in $((SECONDS - t0)) s"

dc --profile relay up -d relay kernel
for i in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$RELAY_PORT/health" | grep -q '"synced":true' && break
  sleep 3
done
curl -s "http://127.0.0.1:$RELAY_PORT/health" >"$OUT/health.json" || true
echo "run-local: relay up (DEMO_TOKENS_PATH=$DEMO_TOKENS_PATH)"

status=0
if bun_run -v "$RUN_DIR:/run/nm:ro" -v "$STATE_DIR:/state" -v "$OUT:/out" -e RELAY_URL=http://relay:8080 \
  -e NETWORK=undeployed -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out \
  -e KERNEL_URL=http://kernel:9999 -e INDEXER_URL=http://indexer:8088/api/v4/graphql -e STEPS="$STEPS" \
  "$BUN_IMAGE" bun test/stack/p6/market-flows.ts 2>&1 | tee "$OUT/market-flows.log"; then
  echo "run-local: market flows PASS"
else
  echo "run-local: market flows FAILED"
  status=1
fi

# The tampered proof: the relay must be stopped first (the script opens the sponsor wallet itself).
if [[ "${SKIP_TAMPER:-0}" != 1 ]]; then
  dc --profile relay logs --no-color relay >"$OUT/relay.log" 2>&1 || true
  dc --profile relay stop relay >/dev/null
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
fi
exit $status
