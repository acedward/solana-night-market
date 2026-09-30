#!/usr/bin/env bash
# Local-stack run of the relay's own flows (AA 00047 B3): a ledger-9 localnet (Track A's recipe),
# mint-test-tokens v2 faucets deployed from the key volume's faucet bundle, the relay image with the
# key volume, a mock kernel, and the browser stand-in (relay-flows.ts). Tears everything down at the
# end, whatever happens.
#
#   KEYS_DIR=~/.cache/aa-00047/b3-keys RELAY_IMAGE=aa00047-relay/relay:b3 \
#   APP_VOLUME=aa00047-relay-check-app OUT=<dir> test/stack/b3/run-local.sh [direct|via-sponsor ...]
#
# APP_VOLUME is a docker volume holding this repository with its node_modules and the light
# compile (scripts/docker-check.sh's, synced). The funder/sponsor seed is the localnet's genesis
# development seed (public, never a real wallet). Only one heavy stack at a time on a host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/test/stack/b3"
: "${KEYS_DIR:?}" "${RELAY_IMAGE:?}" "${APP_VOLUME:?}" "${OUT:?}"
PATHS=("$@")
[[ ${#PATHS[@]} -gt 0 ]] || PATHS=(direct via-sponsor)
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-aa00047-relay-e2e-$RANDOM}"
export KEYS_DIR RELAY_IMAGE APP_VOLUME BUN_IMAGE
export PS_PARAMS="${PS_PARAMS:?writable proof-server params dir (rc.6)}"
export PS8_PARAMS="${PS8_PARAMS:?writable proof-server params dir (rc.8)}"
export INDEXER_IMAGE="${INDEXER_IMAGE:-midnightntwrk/indexer-standalone:4.4.0-rc.3}"
export RELAY_KEYS_FINGERPRINT="${RELAY_KEYS_FINGERPRINT:-}"

free_port() {
  local p
  while :; do
    p=$((10000 + RANDOM % 50000))
    if ! (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "$p"; return; fi
  done
}
export NODE_PORT="$(free_port)" INDEXER_PORT="$(free_port)" RELAY_PORT="$(free_port)"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nm-b3-run.XXXXXX")"
export RUN_DIR
mkdir -p "$OUT"
# The localnet's genesis development seed (public).
printf '%064x\n' 1 >"$RUN_DIR/sponsor.seed"
chmod 600 "$RUN_DIR/sponsor.seed"

dc() { docker compose -f "$HERE/compose.yml" "$@"; }
teardown() {
  set +e
  dc --profile relay logs --no-color relay >"$OUT/relay.log" 2>&1
  dc --profile relay logs --no-color kernel >"$OUT/kernel.log" 2>&1
  dc logs --no-color proof-server-rc8 2>&1 | tail -200 >"$OUT/proof-server-rc8.tail.log"
  dc logs --no-color proof-server 2>&1 | tail -100 >"$OUT/proof-server.tail.log"
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

status=0
for path in "${PATHS[@]}"; do
  export DEMO_TOKENS_PATH="$path"
  dc --profile relay up -d --force-recreate relay kernel
  for i in $(seq 1 100); do
    curl -sf "http://127.0.0.1:$RELAY_PORT/health" | grep -q '"synced":true' && break
    sleep 3
  done
  curl -s "http://127.0.0.1:$RELAY_PORT/health" >"$OUT/health-$path.json" || true
  echo "run-local: relay up (DEMO_TOKENS_PATH=$path)"
  if bun_run -v "$RUN_DIR:/run/nm:ro" -v "$OUT:/out" -e RELAY_URL=http://relay:8080 \
    -e TOKENS_FILE=/run/nm/tokens.json -e OUT=/out -e OUT_NAME="relay-flows-$path.json" \
    -e SKIP_OFFER="${SKIP_OFFER:-0}" "$BUN_IMAGE" bun test/stack/b3/relay-flows.ts 2>&1 | tee "$OUT/relay-flows-$path.log"; then
    echo "run-local: $path PASS"
    # The offer is proved once, in the first path that passes; later paths test the demo tokens
    # and withdrawals only.
    export SKIP_OFFER=1
  else
    echo "run-local: $path FAILED"
    status=1
  fi
  dc --profile relay logs --no-color relay >"$OUT/relay-$path.log" 2>&1 || true
done
exit $status
