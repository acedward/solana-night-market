#!/usr/bin/env bash
# AA 00060 P2 (G-NIGHTLY part A): the wallet probe (web/src/dev/WalletProbe.tsx) for the owner's check of
# a real wallet (Nightly) by hand. No Night Market stack, no relay, no Midnight node: a native
# solana-test-validator and the built site, both on random free ports >= 10000 on 127.0.0.1.
#
#   test/gates/nightly/run-probe.sh up               build the site (in the scripts/docker-check.sh
#                                                    container), start the validator in a temp ledger,
#                                                    serve the site with devProbe: true, print the URLs
#   test/gates/nightly/run-probe.sh airdrop <address> [SOL]
#                                                    airdrop local SOL (default 2) to a wallet address
#   test/gates/nightly/run-probe.sh status           the URLs, and whether both answer
#   test/gates/nightly/run-probe.sh down             stop both and delete the state directory
#
# State (the validator's ledger, the built site, the ports) lives in $STATE_DIR (default
# ~/.cache/aa-00060/probe, mode 700), never in the repository. The site's config.json there sets
# `devProbe: true`, the local network `undeployed` and `solana: {rpcUrl, genesisHash, cluster:
# "solana:localnet"}`. Environment: DOCKER_CHECK_NAME (default aa00060-check), PROBE_CONTAINER
# (default aa00060-probe), BUN_IMAGE (default oven/bun:1.3.11).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HERE="$ROOT/test/gates/nightly"
STATE_DIR="${STATE_DIR:-$HOME/.cache/aa-00060/probe}"
NAME="${PROBE_CONTAINER:-aa00060-probe}"
CHECK="${DOCKER_CHECK_NAME:-aa00060-check}"
BUN_IMAGE="${BUN_IMAGE:-oven/bun:1.3.11}"

free_port() {
  local p
  while :; do
    p=$((10000 + RANDOM % 50000))
    if ! (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then echo "$p"; return; fi
  done
}

# A free range of 30 ports for the validator's dynamic ports.
free_range() {
  local base ok p
  while :; do
    base=$((20000 + RANDOM % 40000)); ok=1
    for p in $(seq "$base" $((base + 29))); do
      if (echo >/dev/tcp/127.0.0.1/$p) 2>/dev/null; then ok=0; break; fi
    done
    [[ "$ok" == 1 ]] && { echo "$base-$((base + 29))"; return; }
  done
}

rpc() { # <url> <method> [params json]
  curl -s -m 10 "$1" -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}"
}

load_env() {
  [[ -f "$STATE_DIR/env" ]] || { echo "run-probe: not up (no $STATE_DIR/env)" >&2; exit 1; }
  # shellcheck disable=SC1091
  source "$STATE_DIR/env"
}

status() {
  load_env
  local health web
  health="$(rpc "http://127.0.0.1:$RPC_PORT" getHealth | grep -o '"result":"[a-z]*"' || true)"
  web="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WEB_PORT/config.json" || true)"
  echo "Probe page:      http://127.0.0.1:$WEB_PORT/#wallet-probe   (config.json: HTTP $web)"
  echo "Solana RPC:      http://127.0.0.1:$RPC_PORT   (getHealth: ${health:-no answer})"
  echo "Genesis hash:    $GENESIS"
  echo "Validator pid:   $(cat "$STATE_DIR/validator.pid" 2>/dev/null || echo none)"
}

up() {
  if [[ -f "$STATE_DIR/env" ]]; then
    echo "run-probe: already up"
    status
    return
  fi
  command -v solana-test-validator >/dev/null || { echo "run-probe: solana-test-validator is not on PATH" >&2; exit 1; }
  mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"
  local rpc_port faucet gossip range web genesis
  rpc_port="$(free_port)"
  faucet="$(free_port)"
  gossip="$(free_port)"
  range="$(free_range)"
  echo "run-probe: starting solana-test-validator (rpc :$rpc_port, faucet :$faucet, gossip :$gossip, dynamic $range)"
  solana-test-validator --ledger "$STATE_DIR/ledger" --reset --quiet --bind-address 127.0.0.1 \
    --rpc-port "$rpc_port" --faucet-port "$faucet" --gossip-port "$gossip" --dynamic-port-range "$range" \
    >"$STATE_DIR/validator.log" 2>&1 &
  echo $! >"$STATE_DIR/validator.pid"
  for _ in $(seq 1 90); do
    rpc "http://127.0.0.1:$rpc_port" getHealth | grep -q '"result":"ok"' && break
    sleep 1
  done
  genesis="$(rpc "http://127.0.0.1:$rpc_port" getGenesisHash | sed -E 's/.*"result":"([1-9A-HJ-NP-Za-km-z]+)".*/\1/')"
  [[ "$genesis" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "run-probe: the validator did not answer" >&2; down; exit 1; }

  echo "run-probe: building the site in the $CHECK container"
  DOCKER_CHECK_NAME="$CHECK" bash "$ROOT/scripts/docker-check.sh" up >/dev/null
  DOCKER_CHECK_NAME="$CHECK" bash "$ROOT/scripts/docker-check.sh" sync
  DOCKER_CHECK_NAME="$CHECK" bash "$ROOT/scripts/docker-check.sh" run \
    '[ -d node_modules/@nightmarket ] || bun install --frozen-lockfile; [ -f vendor/passport/contract/contracts/managed/account/contract/index.js ] || bun run contracts; bun run build:web' >"$STATE_DIR/build.log" 2>&1
  rm -rf "$STATE_DIR/site"
  docker cp "$CHECK-runner:/app/web/dist" "$STATE_DIR/site"
  cat >"$STATE_DIR/site/config.json" <<JSON
{
  "network": "undeployed",
  "relayUrl": "",
  "tokens": { "mode": "replace", "tokens": [{ "symbol": "twUSDC", "decimals": 6, "midnightColour": "$(printf 'a1%.0s' {1..32})" }] },
  "devProbe": true,
  "solana": { "rpcUrl": "http://127.0.0.1:$rpc_port", "genesisHash": "$genesis", "cluster": "solana:localnet" }
}
JSON
  web="$(free_port)"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --memory 256m -p "127.0.0.1:$web:8080" \
    -v "$STATE_DIR/site:/site:ro" -v "$HERE/static-server.ts:/srv/static-server.ts:ro" \
    "$BUN_IMAGE" bun /srv/static-server.ts >/dev/null
  printf 'RPC_PORT=%s\nWEB_PORT=%s\nGENESIS=%s\n' "$rpc_port" "$web" "$genesis" >"$STATE_DIR/env"
  for _ in $(seq 1 30); do
    curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web/config.json" | grep -q 200 && break
    sleep 1
  done
  status
}

airdrop() {
  load_env
  local address="${1:?usage: run-probe.sh airdrop <address> [SOL]}" sol="${2:-2}"
  [[ "$address" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || { echo "run-probe: not a base58 address" >&2; exit 1; }
  solana airdrop "$sol" "$address" --url "http://127.0.0.1:$RPC_PORT"
  solana balance "$address" --url "http://127.0.0.1:$RPC_PORT"
}

down() {
  set +e
  if [[ -f "$STATE_DIR/validator.pid" ]]; then
    local pid
    pid="$(cat "$STATE_DIR/validator.pid")"
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null
  fi
  docker rm -f "$NAME" >/dev/null 2>&1
  rm -rf "$STATE_DIR"
  echo "run-probe: down (validator stopped, $NAME removed, $STATE_DIR deleted)"
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  up) up ;;
  airdrop) airdrop "$@" ;;
  status) status ;;
  down) down ;;
  *) echo "usage: $0 up | airdrop <address> [SOL] | status | down" >&2; exit 64 ;;
esac
