#!/usr/bin/env bash
# AA 00057 P2 + P3: the Solana <-> Midnight journey (spec US5) on local stand-ins: Night Market's localnet
# (test/stack/p6), a native solana-test-validator, TWO real bridge deployments X and Y (AA 00058) and the
# injector RPC (AA 00059), then the scripted journey with its oracle table checked EXACTLY at every step.
# It adopts AA 00060's P9 harness (evidence/00060-night-market-bridge-wallet/p9/harness/run-p9.sh @ sha256
# 88dc0e78…, prep-tmpl.sh @ 8f3e1960…) and reorders it as the journey.
#
#   e2e/run-local.sh prep      the 00058 template volume (bridge deploys, CLI, nodes), the app volume and the
#                              relay image; once per code change (nothing is pulled; builds use --pull=false)
#   e2e/run-local.sh up        takes the stack lock and brings the whole stack up; health of every service;
#                              LEAVES IT RUNNING (for P4 by hand); `down` ends it
#   e2e/run-local.sh journey   the scripted journey + negatives on the running stack (P3)
#   e2e/run-local.sh down      tears everything down, checks nothing is left, releases the lock
#   e2e/run-local.sh run       up, journey, down (down always): one clean run
#
# Environment: OUT (the evidence directory; required by up/run), LOCK_WAIT_S (default 4 h), JOURNEY=0 (run:
# skip the journey). Pinned inputs (checked before the lock is taken; refused when they differ):
#   00058  effectstream @ BRIDGE_PIN, the local clone BRIDGE_WT (clean)  -> deploy tooling, nodes, CLI
#   00059  solana-token-injector @ INJECTOR_PIN, the local clone INJECTOR_REPO (clean) -> injector image
#   the Passport key volume ~/.cache/aa-00047/p10i-keys (VERIFIED, fingerprint 21493588…), copied per run
#   the images of the p6 compose (node by digest, indexer 4.4.0-rc.1, proof servers rc.6/rc.8, bun 1.3.11)
#   and e00050/unit:s4 (the template's step image); the native Agave 3.0.14 CLI in ~/.cache/aa-00058/agave
#
# Every host port is a random free one >= 10000 on 127.0.0.1. Compose projects are aa00057-<n>,
# aa00057-<n>-x, aa00057-<n>-y. The stack lock ~/.aa-00057-stack.lock (shared by AA 00057-00060) is taken
# before anything starts and released after `down`; a held lock makes `up` wait politely (it never removes
# another holder's lock). Secrets (keys, seeds) live only in the run's temp directory (700/600) and are
# removed at `down`; everything written to $OUT is public.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$ROOT/e2e"
CMD="${1:-run}"

BRIDGE_WT="${BRIDGE_WT:-/Users/edwardalvarado/todo/AA/experiments/00058-bridge-contract-delivery}"
BRIDGE_PIN=1c9f4959db1a9f004820c01fb321225bb255916c
TPL="$BRIDGE_WT/templates/solana-midnight-bridge"
INJECTOR_REPO="${INJECTOR_REPO:-/Users/edwardalvarado/todo/AA/experiments/00059-injector-passport-accounts}"
INJECTOR_PIN=459c904fc7f6e1180ad48bd4d3b8bc64971e1909
AGAVE="${AGAVE:-$HOME/.cache/aa-00058/agave/bin}"
SPL_TOKEN="${SPL_TOKEN:-$HOME/.local/share/solana/install/active_release/bin/spl-token}"
KEYS_SRC="${KEYS_SRC:-$HOME/.cache/aa-00047/p10i-keys}"
PASSPORT="${PASSPORT:-$ROOT/vendor/passport}"
PS_PARAMS_SRC="${PS_PARAMS_SRC:-$HOME/.cache/aa-00047/ps-params}"
PS8_PARAMS_SRC="${PS8_PARAMS_SRC:-$HOME/.cache/aa-00047/ps-params-rc8}"
STATE_ROOT="${AA00057_STATE:-$HOME/.cache/aa-00057}"
LOCK="$HOME/.aa-00057-stack.lock"
STEP_IMAGE=e00050/unit:s4
BUN_IMAGE=oven/bun:1.3.11
TMPL_VOLUME="${TMPL_VOLUME:-aa00057-tmpl}"
TMPL_CACHE="${TMPL_CACHE:-aa00057-tmpl-bun}"
APP_VOLUME="${APP_VOLUME:-aa00057-check-app}"
TROOT=/work/repo/templates/solana-midnight-bridge
LOCK_WAIT_S="${LOCK_WAIT_S:-14400}"
UP_BUDGET_S="${UP_BUDGET_S:-1500}"
# X: 600 to A's wallet + 1 for the non-account lock (the SC-004 negative). Y: 50 to B's wallet.
X_USER_TOKENS=601
Y_USER_TOKENS=50
# The bridge contract's verifier keys Night Market vendors (web/src/bridge/vendor/bridge/contract/index.js).
VK_LOCK=b54ed1f6aff46df16f9e3e132c3e4d5e3e7c3d51fd731049f5421f4848e3967f
VK_MINT=5f4fa8ace0ea0e47685532f67fcfbd460d826877b877b6dbfbf33bd7dd7e80f9

mkdir -p "$STATE_ROOT" && chmod 700 "$STATE_ROOT"
say() { echo "[e2e $(date -u +%H:%M:%SZ)] $*"; }
fail() { say "FAILED: $*"; exit 1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

free_ports() { # <n>: the first of n consecutive ports free for TCP and UDP (the validator binds both)
  python3 - "$1" <<'PY'
import random, socket, sys
def free(p):
    for typ in (socket.SOCK_STREAM, socket.SOCK_DGRAM):
        for host in ("127.0.0.1", "0.0.0.0"):
            s = socket.socket(socket.AF_INET, typ)
            try:
                s.bind((host, p))
            except OSError:
                return False
            finally:
                s.close()
    return True
n = int(sys.argv[1])
for _ in range(5000):
    b = random.randint(10001, 59000 - n)
    if all(free(q) for q in range(b, b + n)):
        print(b)
        break
PY
}

check_pins() {
  [[ "$(git -C "$BRIDGE_WT" rev-parse HEAD)" == "$BRIDGE_PIN" && -z "$(git -C "$BRIDGE_WT" status --porcelain)" ]] \
    || fail "the 00058 clone $BRIDGE_WT is not clean at $BRIDGE_PIN"
  [[ "$(git -C "$INJECTOR_REPO" rev-parse HEAD)" == "$INJECTOR_PIN" && -z "$(git -C "$INJECTOR_REPO" status --porcelain)" ]] \
    || fail "the 00059 clone $INJECTOR_REPO is not clean at $INJECTOR_PIN"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# prep: the template volume (00058 @ pin), the bridge's compiled keys, the app volume, the relay image
# ═════════════════════════════════════════════════════════════════════════════════════════════
prep() {
  check_pins
  local t0=$SECONDS
  # 1. The 00058 template volume, as AA 00058 P5 / AA 00060 P9 built theirs: the clean worktree synced into
  #    a native volume (00050 S4's entry.sh), the template's install, link, the bridge compile (compactc
  #    0.35.0), the Passport bundle from the VERIFIED key volume, and this journey's wallet driver.
  (cd "$BRIDGE_WT" && git ls-files -z --cached --others --exclude-standard) | python3 -c '
import os, sys
root = sys.argv[1]; out = sys.stdout.buffer
for p in sys.stdin.buffer.read().split(b"\0"):
    if p and os.path.lexists(os.path.join(root.encode(), p)): out.write(p + b"\0")
' "$BRIDGE_WT" >"$STATE_ROOT/files.lst"
  docker volume create "$TMPL_VOLUME" >/dev/null && docker volume create "$TMPL_CACHE" >/dev/null || fail "volumes"
  docker run --rm --name aa00057-prep --memory 8g --pull=never \
    -v "$BRIDGE_WT:/src:ro" -v "$E2E/template:/harness:ro" -v "$STATE_ROOT:/harness-state:ro" \
    -v "$TMPL_VOLUME:/work" -v "$TMPL_CACHE:/root/.bun/install/cache" -v "$KEYS_SRC:/keys:ro" \
    -e S4_LIST=/harness-state/files.lst -e NODE_ENV=development -e POLKADOTJS_DISABLE_ESM_CJS_WARNING=1 \
    -e PIN="$BRIDGE_PIN" "$STEP_IMAGE" bash /harness/entry.sh bash -c '
      set -e
      cd templates/solana-midnight-bridge
      bun install
      bash ./link.sh
      bash packages/contracts-midnight/scripts/compile.sh
      sha256sum packages/contracts-midnight/contract-bridge/src/bridge.compact packages/contracts-midnight/contract-bridge/src/managed/keys/*.verifier
      rm -rf packages/delivery-passport/bundle
      bun run delivery:import-bundle /keys/account
      sha256sum packages/delivery-passport/bundle/account/keys/deposit_shielded.verifier
      sha256sum packages/contracts-solana/build/bridge.so
      mkdir -p packages/contracts-midnight/.journey
      cp /harness/bridge-wallets.ts packages/contracts-midnight/.journey/bridge-wallets.ts
      cp /harness/solana-shim.ts packages/contracts-solana/.journey-shim.ts
      sha256sum packages/contracts-midnight/.journey/bridge-wallets.ts packages/contracts-solana/.journey-shim.ts
      echo "$PIN" > /work/.aa00057-pin
    ' || fail "the template volume"
  # 2. The bridge's compiled contract (the relay proves Bridge out's locks with it; the harness too). Its
  #    verifier keys must be the ones Night Market vendors.
  rm -rf "$STATE_ROOT/bridge-managed" && mkdir -p "$STATE_ROOT/bridge-managed"
  docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" \
    tar -C "$TROOT/packages/contracts-midnight/contract-bridge/src/managed" -cf - . | tar -C "$STATE_ROOT/bridge-managed" -xf - \
    || fail "copy the bridge's compiled contract"
  [[ "$(sha "$STATE_ROOT/bridge-managed/keys/lockForSolana.verifier")" == "$VK_LOCK" && \
     "$(sha "$STATE_ROOT/bridge-managed/keys/mintFromSolana.verifier")" == "$VK_MINT" ]] \
    || fail "the bridge's verifier keys are not the ones Night Market vendors"
  # 3. The app volume (this tree, its install and the light contract compile) and the relay image.
  DOCKER_CHECK_NAME=aa00057-check DOCKER_CHECK_MEMORY=8g "$ROOT/scripts/docker-check.sh" up >/dev/null || fail "check container"
  DOCKER_CHECK_NAME=aa00057-check "$ROOT/scripts/docker-check.sh" sync || fail "sync"
  DOCKER_CHECK_NAME=aa00057-check "$ROOT/scripts/docker-check.sh" run 'bun install --frozen-lockfile >/dev/null && bun run contracts >/dev/null' \
    || fail "install + contracts"
  local tag; tag="nm-relay:aa00057-$(git -C "$ROOT" rev-parse --short HEAD)"
  docker build --pull=false -q -f "$ROOT/deploy/relay.Dockerfile" -t "$tag" "$ROOT" >"$STATE_ROOT/relay-build.log" 2>&1 \
    || { tail -20 "$STATE_ROOT/relay-build.log"; fail "the relay image"; }
  echo "$tag" >"$STATE_ROOT/relay-image"
  say "prep done in $((SECONDS - t0)) s: template volume $TMPL_VOLUME (00058 $BRIDGE_PIN), app volume $APP_VOLUME, relay $tag"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# The stack's helpers (need the variables `up` saves in $RUN/stack.env)
# ═════════════════════════════════════════════════════════════════════════════════════════════
dc() { docker compose -f "$ROOT/test/stack/p6/compose.yml" -f "$E2E/compose.yml" "$@"; }
dcb() { local w=$1; shift; docker compose -p "$CP-$w" --env-file "$RUN/$w.env" -f "$TPL/deploy/standin/compose.bridge.yml" "$@"; }
quiet() { grep -v -E 'polkadot|conflicting packages|^[[:space:]]+(cjs|esm) |Either remove|bigint: Failed'; }
mark() { printf '{"at":"%s","t":%s,"what":"%s","event":"%s"}\n' "$(date -u +%FT%TZ)" "$(date +%s)" "$1" "$2" >>"$OUT/timings.jsonl"; }

# A container in the TEMPLATE environment on the stack network.
tmpl() { # <name> <X|Y|-> <dir under the template> <cmd...>
  local name=$1 dep=$2 wd=$3; shift 3
  local extra=() secmode=ro
  [[ "${TMPL_SECRETS_RW:-0}" == 1 ]] && secmode=rw
  [[ "$dep" != "-" ]] && extra+=(-e "BRIDGE_DEPLOYMENT=standin-$(echo "$dep" | tr 'XY' 'xy')" -e "BRIDGE_SECRETS_DIR=/secrets-$(echo "$dep" | tr 'XY' 'xy')")
  docker run --rm --name "$CP-$name" --network "${CP}_default" --memory "${TMPL_MEM:-4g}" --pull=never \
    --add-host host.docker.internal:host-gateway \
    -v "$TMPL_VOLUME:/work" -v "$RUN/secrets-x:/secrets-x:$secmode" -v "$RUN/secrets-y:/secrets-y:$secmode" \
    -v "$OUT:/out" ${extra[@]+"${extra[@]}"} \
    -e BRIDGE_MODE=live -e MIDNIGHT_NETWORK_ID=undeployed -e MIDNIGHT_NODE_HTTP=http://node:9944 \
    -e MIDNIGHT_INDEXER_HTTP=http://indexer:8088/api/v4/graphql -e MIDNIGHT_INDEXER_WS=ws://indexer:8088/api/v4/graphql/ws \
    -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300 -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 \
    -e "SOLANA_DEVNET_RPC_URL=http://host.docker.internal:$SOL_RPC" -e "SOLANA_EXPECTED_GENESIS_HASH=$GENESIS" \
    -e BRIDGE_DELIVERY_ADAPTERS=passport -e NODE_ENV=production -e OUT=/out \
    -w "$TROOT/$wd" "$STEP_IMAGE" bash -c '
      if [ -n "${BRIDGE_SECRETS_DIR:-}" ] && [ -f "$BRIDGE_SECRETS_DIR/storage-password" ]; then export MIDNIGHT_STORAGE_PASSWORD="$(cat "$BRIDGE_SECRETS_DIR/storage-password")"; fi
      exec "$@"' _ "$@"
}
bun_nm() { # Night Market's app volume, read only, on the stack network (named, so the memory sampler sees it)
  docker run --rm --name "$CP-step-$(od -An -N4 -tu4 /dev/urandom | tr -d ' ')" --network "${CP}_default" \
    --memory "${FLOWS_MEM_LIMIT:-6g}" --pull=never --add-host host.docker.internal:host-gateway \
    -v "$APP_VOLUME:/app:ro" -w /app "$@"
}
# The env every journey step shares (the page-code harnesses and journey.ts).
journey_env() {
  printf '%s\n' -e NETWORK=undeployed -e STATE_DIR=/state -e OUT=/out -e RUN_DIR_IN=/run/nm \
    -e JOURNEY_FILE=/run/nm/journey-tokens.undeployed.json -e PROMPT_LOG=/out/prompts.jsonl \
    -e RELAY_URL=http://relay:8080 -e INDEXER_URL=http://indexer:8088/api/v4/graphql -e NODE_WS_URL=ws://node:9944 \
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300 -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server:6300 \
    -e THIRD_PARTY_SEED_FILE=/run/nm/third.seed -e SPONSOR_SEED_FILE=/run/nm/sponsor.seed \
    -e "SOLANA_GENESIS=$GENESIS" -e "SOLANA_RPC_URL=http://host.docker.internal:$SOL_RPC" \
    -e INJECTOR_URL=http://injector:8899 -e "INJECTOR_PUBLIC_URL=http://127.0.0.1:$INJECTOR_PORT"
}
landing() { # JOURNEY_STEP=<s> STEP=… [VAR=…]…  (test/gates/landing/landing.ts: the page's own operations)
  local args=(); for kv in "$@"; do args+=(-e "$kv"); done
  local envs=(); while IFS= read -r l; do envs+=("$l"); done < <(journey_env)
  bun_nm -v "$RUN/keys-harness:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm" \
    -v "$RUN/state:/state" -v "$OUT:/out" "${envs[@]}" "${args[@]}" "$BUN_IMAGE" bun test/gates/landing/landing.ts 2>&1 | tee -a "$OUT/landing.log"
  return "${PIPESTATUS[0]}"
}
flows() { # <steps> JOURNEY_STEP=<s> [VAR=…]…  (test/stack/p6/market-flows.ts)
  local steps=$1; shift
  local args=(); for kv in "$@"; do args+=(-e "$kv"); done
  bun_nm -v "$RUN/keys-relay:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm:ro" \
    -v "$RUN/state:/state" -v "$OUT:/out" -e RELAY_URL=http://relay:8080 -e NETWORK=undeployed \
    -e TOKENS_FILE=/run/nm/tokens.json -e STATE_DIR=/state -e OUT=/out -e "OUT_NAME=market-flows-${steps//,/-}.json" \
    -e INDEXER_URL=http://indexer:8088/api/v4/graphql -e KERNEL_URL=http://kernel:9999 -e "STEPS=$steps" \
    -e PROMPT_LOG=/out/prompts.jsonl ${args[@]+"${args[@]}"} "$BUN_IMAGE" bun test/stack/p6/market-flows.ts 2>&1 | tee -a "$OUT/market-flows.log"
  return "${PIPESTATUS[0]}"
}
journey_ts() { # STEP=… [VAR=…]…  (e2e/journey.ts)
  local args=(); for kv in "$@"; do args+=(-e "$kv"); done
  local envs=(); while IFS= read -r l; do envs+=("$l"); done < <(journey_env)
  bun_nm -v "$RUN/keys-harness:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm:ro" \
    -v "$RUN/state:/state" -v "$OUT:/out" "${envs[@]}" "${args[@]}" "$BUN_IMAGE" bun e2e/journey.ts 2>&1 | tee -a "$OUT/journey.log"
  return "${PIPESTATUS[0]}"
}
oracle() { journey_ts STEP=oracle "CHECKPOINT=$1" "JOURNEY_STEP=oracle-$1" || fail "oracle $1: the table is not exact"; }
relay_ready() {
  for _ in $(seq 1 100); do curl -sf "http://127.0.0.1:$RELAY_PORT/health" | grep -q '"synced":true' && return 0; sleep 3; done
  return 1
}
fresh_prover() {
  dc restart proof-server-rc8 >/dev/null
  for _ in $(seq 1 30); do
    docker run --rm --network "${CP}_default" --memory 256m "$BUN_IMAGE" bun -e \
      "const r = await fetch('http://proof-server-rc8:6300/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)" >/dev/null 2>&1 && break
    sleep 2
  done
}
spl_transfer() { # <mint> <whole tokens> <recipient> <owner key file> <log>
  "$SPL_TOKEN" transfer "$1" "$2" "$3" --fund-recipient --allow-unfunded-recipient --owner "$4" --fee-payer "$4" \
    --url "http://127.0.0.1:$SOL_RPC" >"$OUT/$5" 2>&1
}
airdrop() { "$AGAVE/solana" airdrop "$2" "$1" --url "http://127.0.0.1:$SOL_RPC" --commitment confirmed >>"$OUT/airdrops.log" 2>&1; }

load_current() {
  [[ -f "$STATE_ROOT/current" ]] || fail "no running journey stack (run \`$0 up\` first)"
  RUN="$(cat "$STATE_ROOT/current")"
  [[ -f "$RUN/stack.env" ]] || fail "the running stack's state $RUN/stack.env is missing"
  # shellcheck disable=SC1091
  source "$RUN/stack.env"
  [[ "$(cut -d' ' -f1 "$LOCK/holder" 2>/dev/null)" == 00057 ]] && grep -q "$CP" "$LOCK/holder" \
    || say "WARNING: the stack lock is not held for $CP ($(cat "$LOCK/holder" 2>/dev/null || echo 'no lock'))"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# up
# ═════════════════════════════════════════════════════════════════════════════════════════════
up() {
  : "${OUT:?OUT (the evidence directory) is required}"
  check_pins
  docker volume inspect "$TMPL_VOLUME" >/dev/null 2>&1 || fail "no template volume $TMPL_VOLUME (run \`$0 prep\`)"
  [[ "$(docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" cat /work/.aa00057-pin 2>/dev/null)" == "$BRIDGE_PIN" ]] \
    || fail "the template volume was not built from 00058 @ $BRIDGE_PIN (run \`$0 prep\`)"
  docker volume inspect "$APP_VOLUME" >/dev/null 2>&1 || fail "no app volume $APP_VOLUME (run \`$0 prep\`)"
  RELAY_IMAGE="$(cat "$STATE_ROOT/relay-image" 2>/dev/null)"
  [[ -n "$RELAY_IMAGE" ]] && docker image inspect "$RELAY_IMAGE" >/dev/null 2>&1 || fail "no relay image (run \`$0 prep\`)"
  [[ -f "$STATE_ROOT/current" ]] && fail "a journey stack is already up ($(cat "$STATE_ROOT/current")); \`$0 down\` first"
  mkdir -p "$OUT"

  # The stack lock: wait politely; never remove another holder's lock.
  local waited=0
  until mkdir "$LOCK" 2>/dev/null; do
    if (( waited % 600 == 0 )); then say "the stack lock is held: $(cat "$LOCK/holder" 2>/dev/null || echo '?'); waiting"; fi
    (( waited >= LOCK_WAIT_S )) && fail "gave up waiting for the stack lock after $waited s"
    sleep 60; waited=$((waited + 60))
  done
  CP="aa00057-$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')"
  printf '00057 %s W2 journey stack (compose projects %s, %s-x, %s-y)\n' "$(date -u +%FT%TZ)" "$CP" "$CP" "$CP" >"$LOCK/holder"
  say "lock taken: $(cat "$LOCK/holder")"
  T_UP=$(date +%s)

  RUN="$(mktemp -d "${TMPDIR:-/tmp}/aa00057-run.XXXXXX")"; chmod 700 "$RUN"
  NODE_PORT="" INDEXER_PORT="" RELAY_PORT="" SOL_RPC="" SOL_FAUCET="" SOL_GOSSIP="" DYN_LO="" X_API_PORT="" Y_API_PORT=""
  INJECTOR_PORT="" INJECTOR_IMAGE="" VPID="" MEM_PID="" GENESIS=""
  echo "$RUN" >"$STATE_ROOT/current"
  save_env
  OWN_STACK=1
  mkdir -p "$RUN"/{secrets-x,secrets-y,nm,state,ledger}; chmod 700 "$RUN"/secrets-x "$RUN"/secrets-y "$RUN"/nm "$RUN"/state
  printf '%064x\n' 1 >"$RUN/nm/sponsor.seed"; printf '%064x\n' 2 >"$RUN/nm/batcher.seed"; printf '%064x\n' 3 >"$RUN/nm/third.seed"
  chmod 600 "$RUN"/nm/*.seed
  cp -Rc "$KEYS_SRC" "$RUN/keys-relay"; cp -Rc "$STATE_ROOT/bridge-managed" "$RUN/keys-relay/bridge"
  cp -Rc "$KEYS_SRC" "$RUN/keys-harness"; cp -Rc "$STATE_ROOT/bridge-managed" "$RUN/keys-harness/bridge"
  cp -Rc "$PS_PARAMS_SRC" "$RUN/ps-params"; cp -Rc "$PS8_PARAMS_SRC" "$RUN/ps8-params"
  echo '{}' >"$RUN/nm/journey-tokens.undeployed.json"
  echo '{}' >"$RUN/nm/injector-tokens.undeployed.json"

  NODE_PORT=$(free_ports 1); INDEXER_PORT=$(free_ports 1); RELAY_PORT=$(free_ports 1)
  SOL_RPC=$(free_ports 2); SOL_FAUCET=$(free_ports 1); SOL_GOSSIP=$(free_ports 1); DYN_LO=$(free_ports 60)
  X_API_PORT=$(free_ports 1); Y_API_PORT=$(free_ports 1); INJECTOR_PORT=$(free_ports 2)
  INJECTOR_IMAGE="s00059/service:aa00057-$(date +%s)"
  save_env
  export_env
  say "ports: node $NODE_PORT indexer $INDEXER_PORT relay $RELAY_PORT solana $SOL_RPC/$SOL_FAUCET/$SOL_GOSSIP dyn $DYN_LO+59 bridge X $X_API_PORT Y $Y_API_PORT injector $INJECTOR_PORT"
  mark up start

  # ── the chains ──
  { echo "night-market $(git -C "$ROOT" rev-parse HEAD)$( [[ -n "$(git -C "$ROOT" status --porcelain)" ]] && echo ' (dirty)')"
    echo "00058 $(git -C "$BRIDGE_WT" rev-parse HEAD)"; echo "00059 $(git -C "$INJECTOR_REPO" rev-parse HEAD)"
    echo "agave $("$AGAVE/solana-test-validator" --version)"; echo "relay-image $RELAY_IMAGE $(docker image inspect "$RELAY_IMAGE" --format '{{.Id}}')"
    echo "step-image $(docker image inspect "$STEP_IMAGE" --format '{{.Id}}')"
    for i in midnightntwrk/indexer-standalone:4.4.0-rc.1 midnightntwrk/proof-server:9.0.0-rc.8 "$BUN_IMAGE"; do echo "$i $(docker image inspect "$i" --format '{{.Id}}')"; done
  } >"$OUT/pins.txt"
  ( ulimit -n 65536 2>/dev/null; cd "$RUN" && exec nohup "$AGAVE/solana-test-validator" --ledger "$RUN/ledger" --reset --quiet \
      --bind-address 127.0.0.1 --rpc-port "$SOL_RPC" --faucet-port "$SOL_FAUCET" --gossip-port "$SOL_GOSSIP" \
      --dynamic-port-range "$DYN_LO-$((DYN_LO + 59))" --limit-ledger-size 5000000 >"$RUN/validator.out" 2>&1 ) &
  VPID=$!; disown "$VPID" 2>/dev/null || true
  for _ in $(seq 1 120); do curl -sf -m 3 "http://127.0.0.1:$SOL_RPC/health" | grep -q ok && break; sleep 1; done
  curl -sf -m 3 "http://127.0.0.1:$SOL_RPC/health" | grep -q ok || { tail -20 "$RUN/validator.out"; fail "the validator is not healthy"; }
  GENESIS="$("$AGAVE/solana" genesis-hash --url "http://127.0.0.1:$SOL_RPC")"
  save_env
  health validator
  say "validator pid $VPID; genesis $GENESIS"
  dc up -d node indexer proof-server proof-server-rc8 >/dev/null || fail "compose up"
  for _ in $(seq 1 160); do
    curl -sf "http://127.0.0.1:$INDEXER_PORT/api/v4/graphql" -H 'content-type: application/json' -d '{"query":"{ block { height } }"}' | grep -q '"height"' && break
    sleep 3
  done
  curl -sf "http://127.0.0.1:$INDEXER_PORT/api/v4/graphql" -H 'content-type: application/json' -d '{"query":"{ block { height } }"}' \
    | grep -q '"height"' || fail "the indexer never answered"
  health node; health indexer
  nohup bash -c '
    while :; do
      ts=$(date -u +%FT%TZ)
      docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" 2>/dev/null | grep -E "^'"$CP"'" | sed "s/^/$ts /"
      rss=$(ps -o rss= -p '"$VPID"' 2>/dev/null | tr -d " "); [ -n "$rss" ] && echo "$ts solana-test-validator ${rss}KiB"
      sleep 20
    done' >>"$OUT/mem.log" 2>&1 &
  MEM_PID=$!; disown "$MEM_PID" 2>/dev/null || true
  save_env
  bun_nm -v "$RUN/keys-relay:/app/vendor/passport/contract/contracts/managed:ro" -v "$RUN/nm:/run/nm" \
    -e FUNDER_SEED_FILE=/run/nm/sponsor.seed "$BUN_IMAGE" bun test/stack/b3/deploy-faucets.ts >"$RUN/nm/tokens.json" 2>"$OUT/deploy-faucets.log" \
    || fail "deploy-faucets"
  say "chains up; Night Market's faucets deployed"

  # ── X and Y: fresh keys, funding (dev seed 3 only), the program, deploy-devnet, deploy, bridge:record ──
  docker run --rm --pull=never --memory 256m -v "$TMPL_VOLUME:/work" "$STEP_IMAGE" sh -c \
    "rm -rf $TROOT/deployments/standin-x.json $TROOT/deployments/standin-y.json $TROOT/deployments/standin-x.record.json $TROOT/deployments/standin-y.record.json $TROOT/packages/contracts-midnight/midnight-level-db-deploy" \
    || fail "clean the template's run files"
  TMPL_SECRETS_RW=1 tmpl wallets-keys - packages/contracts-midnight/.journey env PHASE=keys bun bridge-wallets.ts 2>&1 | quiet | tee "$OUT/bridge-wallets-keys.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "bridge keys"
  tmpl wallets-fund - packages/contracts-midnight/.journey env PHASE=fund bun bridge-wallets.ts 2>&1 | quiet | tee "$OUT/bridge-wallets-fund.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "bridge funding"
  for w in x y; do
    local W tokens ok a
    W=$(echo "$w" | tr 'xy' 'XY'); tokens=$X_USER_TOKENS; [[ "$w" == y ]] && tokens=$Y_USER_TOKENS
    "$AGAVE/solana" program deploy "$TPL/packages/contracts-solana/build/bridge.so" --url "http://127.0.0.1:$SOL_RPC" \
      --keypair "$RUN/secrets-$w/solana-operator.json" --upgrade-authority "$RUN/secrets-$w/solana-operator.json" \
      --program-id "$RUN/secrets-$w/solana-bridge-program.json" --commitment confirmed --use-rpc --output json \
      >"$OUT/deploy-$w-program.json" 2>"$OUT/deploy-$w-program.err" || fail "program deploy $W"
    tmpl "deploy-sol-$w" "$W" packages/contracts-solana bun run scripts/deploy-devnet.ts --out "standin-$w" --user-tokens "$tokens" 2>&1 | tee "$OUT/deploy-$w-solana.log"
    [[ "${PIPESTATUS[0]}" == 0 ]] || fail "deploy-devnet $W"
    TMPL_MEM=6g tmpl "deploy-mn-$w" "$W" packages/contracts-midnight bun run deploy.ts --mode stagenet --out "standin-$w" 2>&1 | quiet | tee "$OUT/deploy-$w-midnight.log"
    [[ "${PIPESTATUS[0]}" == 0 ]] || fail "deploy.ts $W"
    ok=""
    for a in 1 2 3 4 5 6; do
      tmpl "record-$w" "$W" . bun run bridge:record --mode live --api "http://bridge-$w:9999" --name "$W" --symbol "$W" 2>&1 | tee -a "$OUT/record-$w.log"
      [[ "${PIPESTATUS[0]}" == 0 ]] && { ok=1; break; }
      sleep 10
    done
    [[ -n "$ok" ]] || fail "bridge:record $W"
    docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" cat "$TROOT/deployments/standin-$w.record.json" >"$OUT/standin-$w.record.json"
    docker run --rm --pull=never -v "$TMPL_VOLUME:/work:ro" "$STEP_IMAGE" cat "$TROOT/deployments/standin-$w.json" >"$OUT/standin-$w.json"
  done
  mark deploys end

  # ── I-1: the journey registry, generated from the two records (P1), the mints checked on the validator, with
  #    the icons of the one table (P3b.3: image, splImage, icon) and the site's icon map from the same table ──
  bun_nm -v "$RUN/nm:/run/nm" -v "$OUT:/out:ro" "$BUN_IMAGE" bun e2e/registry/build.ts --network undeployed \
    --genesis "$GENESIS" --solana-rpc "http://host.docker.internal:$SOL_RPC" --out /run/nm/journey-tokens.undeployed.json \
    --site-icons-out /run/nm/site-icons.json /out/standin-x.record.json /out/standin-y.record.json 2>&1 | tee "$OUT/registry-build.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "the journey registry"
  python3 - "$RUN/nm/tokens.json" "$RUN/nm/site-config.json" <<'PY'
import json, sys
json.dump({"network": "undeployed", "relayUrl": "http://relay:8080", "tokens": json.load(open(sys.argv[1]))}, open(sys.argv[2], "w"), indent=1)
PY
  bun_nm -v "$RUN/nm:/run/nm" "$BUN_IMAGE" bun scripts/bridge-tokens.ts /run/nm/journey-tokens.undeployed.json \
    --site-config /run/nm/site-config.json --relay-tokens /run/nm/tokens.json --pairs X/Y --icons /run/nm/site-icons.json \
    --solana-rpc "http://host.docker.internal:$SOL_RPC" 2>&1 | tee "$OUT/bridge-tokens.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "bridge-tokens"
  # P3b.3 (Q10): the injector's own token file from Night Market's FULL list (the relay's TOKENS_FILE), over
  # the injector's bundled file at its pin (the genesis tokens).
  bun_nm -v "$RUN/nm:/run/nm" -v "$INJECTOR_REPO/tokens:/injector-tokens:ro" "$BUN_IMAGE" bun e2e/registry/build.ts \
    injector-tokens --network undeployed --journey /run/nm/journey-tokens.undeployed.json --nm-tokens /run/nm/tokens.json \
    --base /injector-tokens/tokens.undeployed.json --out /run/nm/injector-tokens.undeployed.json 2>&1 | tee "$OUT/injector-tokens.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "the injector's token file"
  cp "$RUN/nm/journey-tokens.undeployed.json" "$RUN/nm/tokens.json" "$RUN/nm/site-config.json" "$RUN/nm/site-icons.json" \
    "$RUN/nm/injector-tokens.undeployed.json" "$OUT/"
  export BRIDGE_REGISTRY_FILE=/run/nm/journey-tokens.undeployed.json
  # AA 00060 P13.3 (Q7 A): the relay's test SPL faucet gets X's and Y's mint authorities, which on the
  # localnet deploy are the bridges' OPERATOR keys (deploy-devnet.ts: operator = payer = mint authority).
  # The tool picks, per I-1 mint, the keypair that is its on-chain authority (mode 600; public keys printed).
  bun_nm -v "$RUN/nm:/run/nm" -v "$RUN/secrets-x:/secrets-x:ro" -v "$RUN/secrets-y:/secrets-y:ro" "$BUN_IMAGE" \
    bun relay/src/tools/spl-faucet-keys.ts --journey /run/nm/journey-tokens.undeployed.json \
    --rpc "http://host.docker.internal:$SOL_RPC" --out /run/nm/spl-faucet-keys.json \
    /secrets-x/solana-operator.json /secrets-y/solana-operator.json 2>&1 | tee "$OUT/spl-faucet-keys.log"
  [[ "${PIPESTATUS[0]}" == 0 ]] || fail "the faucet keys"
  export SPL_FAUCET_KEYS_FILE=/run/nm/spl-faucet-keys.json SPL_FAUCET_RPC_URL="http://host.docker.internal:$SOL_RPC"

  # ── the injector (built here from the pinned 00059 clone, nothing pulled), the relay, the mock exchange ──
  docker build --pull=false -q -t "$INJECTOR_IMAGE" "$INJECTOR_REPO" >"$OUT/injector-build.log" 2>&1 || fail "the injector image"
  dc --profile injector up -d --no-deps injector >/dev/null || fail "injector up"
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$INJECTOR_PORT/health" >/dev/null && break; sleep 2; done
  curl -sf "http://127.0.0.1:$INJECTOR_PORT/health" >/dev/null || { dc --profile injector logs --no-color injector | tail -30; fail "the injector is not up"; }
  health injector
  dc --profile relay up -d relay kernel >/dev/null && relay_ready || { dc --profile relay logs --no-color relay | tail -40; fail "the relay is not ready"; }
  curl -s "http://127.0.0.1:$RELAY_PORT/v1/config" >"$OUT/relay-config.json"
  health relay; health kernel

  # ── the bridge nodes X and Y (00058's deploy/standin/compose.bridge.yml, once per deployment) ──
  for w in x y; do
    local W port
    W=$(echo "$w" | tr 'xy' 'XY'); port=$X_API_PORT; [[ "$w" == y ]] && port=$Y_API_PORT
    cat >"$RUN/$w.env" <<EOF
BRIDGE_HOST=bridge-$w
BRIDGE_DEPLOYMENT=standin-$w
BRIDGE_SECRETS_HOST_DIR=$RUN/secrets-$w
BRIDGE_TEMPLATE_VOLUME=$TMPL_VOLUME
BRIDGE_STACK_NETWORK=${CP}_default
BRIDGE_API_PORT=$port
BRIDGE_RECORD_NAME=$W
BRIDGE_RECORD_SYMBOL=$W
BRIDGE_DELIVERY_NOT_FOUND_GRACE_MS=60000
BRIDGE_MEM_LIMIT=4g
SOLANA_DEVNET_RPC_URL=http://host.docker.internal:$SOL_RPC
MIDNIGHT_NETWORK_ID=undeployed
MIDNIGHT_NODE_HTTP=http://node:9944
MIDNIGHT_INDEXER_HTTP=http://indexer:8088/api/v4/graphql
MIDNIGHT_INDEXER_WS=ws://indexer:8088/api/v4/graphql/ws
MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300
MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-rc8:6300
EOF
    dcb "$w" up -d >/dev/null || fail "bridge node $W up"
  done
  for w in x y; do
    local port; port=$X_API_PORT; [[ "$w" == y ]] && port=$Y_API_PORT
    for _ in $(seq 1 300); do curl -sf -m 5 "http://127.0.0.1:$port/deployment" >/dev/null && break; sleep 3; done
    curl -sf -m 5 "http://127.0.0.1:$port/deployment" >"$OUT/deployment-$w.json" || { dcb "$w" logs --no-color | tail -40; fail "node $w: no /deployment"; }
    # The node serves exactly the record the registry was built from (I-3).
    python3 -c "import json,sys; a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2])); sys.exit(0 if a==b else 1)" \
      "$OUT/deployment-$w.json" "$OUT/standin-$w.record.json" || fail "node $w serves another record than the one recorded"
    health "bridge-$w"
  done
  # The provers answer.
  for p in proof-server proof-server-rc8; do
    docker run --rm --network "${CP}_default" --memory 256m "$BUN_IMAGE" bun -e \
      "const r = await fetch('http://$p:6300/ready').catch(() => null); process.exit(r?.ok ? 0 : 1)" >/dev/null 2>&1 && health "$p"
  done
  mark up end
  local took=$(( $(date +%s) - T_UP ))
  python3 - "$OUT/health.jsonl" "$took" "$UP_BUDGET_S" >"$OUT/health.json" <<'PY'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
need = ["validator", "node", "indexer", "injector", "relay", "kernel", "bridge-x", "bridge-y", "proof-server", "proof-server-rc8"]
seen = {r["service"]: r["seconds"] for r in rows}
print(json.dumps({"seconds": int(sys.argv[2]), "budget": int(sys.argv[3]), "services": seen,
                  "missing": [s for s in need if s not in seen], "withinBudget": int(sys.argv[2]) <= int(sys.argv[3])}, indent=1))
PY
  cat "$OUT/health.json"
  python3 -c "import json,sys; h=json.load(open(sys.argv[1])); sys.exit(0 if not h['missing'] and h['withinBudget'] else 1)" "$OUT/health.json" \
    || fail "up: a service is not healthy, or up took longer than $UP_BUDGET_S s"
  say "UP in $took s: every service healthy (lock held; \`$0 down\` ends it). Injector RPC http://127.0.0.1:$INJECTOR_PORT, validator http://127.0.0.1:$SOL_RPC, relay http://127.0.0.1:$RELAY_PORT"
}
health() { printf '{"service":"%s","seconds":%s}\n' "$1" "$(( $(date +%s) - T_UP ))" >>"$OUT/health.jsonl"; }
save_env() {
  # Plain assignments (not `declare -p`): load_current sources this inside a function, where `declare`
  # would make locals, and macOS's bash 3.2 has no `declare -g`.
  local v
  for v in CP RUN OUT NODE_PORT INDEXER_PORT RELAY_PORT SOL_RPC SOL_FAUCET SOL_GOSSIP DYN_LO X_API_PORT Y_API_PORT \
    INJECTOR_PORT INJECTOR_IMAGE RELAY_IMAGE VPID MEM_PID GENESIS T_UP; do
    printf '%s=%q\n' "$v" "${!v-}"
  done >"$RUN/stack.env"
  chmod 600 "$RUN/stack.env"
}
export_env() {
  export COMPOSE_PROJECT_NAME="$CP" NODE_PORT INDEXER_PORT RELAY_PORT RUN_DIR="$RUN/nm" KEYS_DIR="$RUN/keys-relay"
  export RELAY_IMAGE APP_VOLUME BUN_IMAGE INDEXER_IMAGE=midnightntwrk/indexer-standalone:4.4.0-rc.1
  export PS_PARAMS="$RUN/ps-params" PS8_PARAMS="$RUN/ps8-params" RELAY_KEYS_FINGERPRINT="" DEMO_TOKENS_PATH=direct
  export PS8_MEM_LIMIT=12g PS_MEM_LIMIT=4g RELAY_MEM_LIMIT=4g
  export INJECTOR_IMAGE INJECTOR_PORT INJECTOR_WS_PORT=$((INJECTOR_PORT + 1))
  export VALIDATOR_RPC_PORT="$SOL_RPC" VALIDATOR_WS_PORT=$((SOL_RPC + 1)) JOURNEY_FILE="$RUN/nm/journey-tokens.undeployed.json"
  export INJECTOR_TOKENS_FILE="$RUN/nm/injector-tokens.undeployed.json"
  export BRIDGE_REGISTRY_FILE=/run/nm/journey-tokens.undeployed.json
  export SPL_FAUCET_KEYS_FILE=/run/nm/spl-faucet-keys.json SPL_FAUCET_RPC_URL="http://host.docker.internal:$SOL_RPC"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# journey (spec US5, plan P3): I, pre-funding, II, III, IV, V, the oracle after each; the negatives
# ═════════════════════════════════════════════════════════════════════════════════════════════
journey() {
  load_current; export_env
  : >"$OUT/prompts.jsonl"
  local t0=$SECONDS
  say "==== I: open accounts A and B (Night Market's relay)"
  mark I start
  flows open-a JOURNEY_STEP=I || fail "I: open A"
  flows open-b JOURNEY_STEP=I || fail "I: open B"
  mark I end
  landing JOURNEY_STEP=setup STEP=adopt-bridges || fail "adopt-bridges"
  landing JOURNEY_STEP=setup STEP=wallets >"$RUN/wallets.txt" || fail "wallets"
  WALLET_A=$(awk '/^WALLET_A /{print $2}' "$RUN/wallets.txt"); WALLET_B=$(awk '/^WALLET_B /{print $2}' "$RUN/wallets.txt")
  [[ -n "$WALLET_A" && -n "$WALLET_B" ]] || fail "no wallets"
  MINT_X=$(python3 -c "import json;print(json.load(open('$OUT/standin-x.record.json'))['splMint'])")
  MINT_Y=$(python3 -c "import json;print(json.load(open('$OUT/standin-y.record.json'))['splMint'])")

  say "==== pre-funding: A's wallet gets 600 X; B's wallet gets 50 Y and B bridges them in (its own page)"
  mark prefund start
  airdrop "$WALLET_A" 1 || fail "SOL to A"; airdrop "$WALLET_B" 1 || fail "SOL to B"
  spl_transfer "$MINT_X" 600 "$WALLET_A" "$RUN/secrets-x/solana-user.json" transfer-x-to-a.log || { cat "$OUT/transfer-x-to-a.log"; fail "600 X to A"; }
  spl_transfer "$MINT_Y" 50 "$WALLET_B" "$RUN/secrets-y/solana-user.json" transfer-y-to-b.log || { cat "$OUT/transfer-y-to-b.log"; fail "50 Y to B"; }
  landing JOURNEY_STEP=prefund WHO=B STEP=bridge-in SYMBOL=Y AMOUNT=50000000 LABEL=prefund-b || fail "B's Bridge in of 50 Y"
  mark prefund end
  oracle start

  say "==== II: A bridges 500 X in (its page; one Solana transaction)"
  mark II start
  landing JOURNEY_STEP=II WHO=A STEP=bridge-in SYMBOL=X AMOUNT=500000000 LABEL=ii || fail "II"
  mark II end
  oracle II

  say "==== III: A registers with the injector (Show in my wallet; one message)"
  mark III start
  landing JOURNEY_STEP=III STEP=inject "INJECTOR_PUBLIC_URL=http://127.0.0.1:$INJECTOR_PORT" || fail "III"
  mark III end
  oracle III

  say '==== IV: A makes "200 X for 50 Y"; B takes it'
  mark IV start
  flows make,take JOURNEY_STEP=IV GIVE_SYMBOL=X GIVE_AMOUNT=200000000 WANT_SYMBOL=Y WANT_AMOUNT=50000000 || fail "IV"
  grep -q 'This site labels it: 200.000000 X' "$OUT/market-flows-make-take.json" || fail "IV: the make's wallet text has no 'This site labels it: 200.000000 X'"
  mark IV end
  oracle IV

  say "==== V: A bridges 50 Y out through the landing key; the release arrives in A's wallet on Solana"
  fresh_prover
  mark V start
  landing JOURNEY_STEP=V STEP=out OUT_CASE=a || fail "V"
  mark V end
  oracle V

  say "==== negatives (SC-004, SC-006): each fails closed, nothing lands"
  mark negatives start
  journey_ts JOURNEY_STEP=neg STEP=neg-registration || fail "SC-004 registrations"
  journey_ts JOURNEY_STEP=neg STEP=unregistered || fail "SC-006"
  landing JOURNEY_STEP=neg STEP=neg-relay NEG_SYMBOL=X || fail "SC-004 tampered landing recipient"
  landing JOURNEY_STEP=neg STEP=out OUT_CASE=f || fail "SC-004 non-deterministic signer"
  journey_ts JOURNEY_STEP=neg STEP=third-party >"$RUN/third.txt" || fail "third party"
  THIRD=$(awk '/^THIRD /{print $2}' "$RUN/third.txt"); [[ -n "$THIRD" ]] || fail "no third party"
  airdrop "$THIRD" 1 || fail "SOL to the third party"
  spl_transfer "$MINT_X" 1 "$THIRD" "$RUN/secrets-x/solana-user.json" transfer-x-to-third.log || { cat "$OUT/transfer-x-to-third.log"; fail "1 X to the third party"; }
  journey_ts JOURNEY_STEP=neg STEP=neg-undeliverable || fail "SC-004 non-account lock"
  mark negatives end
  oracle after-negatives

  say "==== P3b.4: the rows beyond the spec's table (FR-021, P13, 00059 P7, Q10)"
  mark rows start
  fresh_prover
  landing JOURNEY_STEP=fr021 STEP=out OUT_CASE=partial OUT_SYMBOL=X OUT_AMOUNT=100000000 || fail "FR-021: the partial Bridge out"
  oracle after-partial
  journey_ts JOURNEY_STEP=fr021 STEP=fr021 || fail "FR-021: the injector after the partial Bridge out"
  journey_ts JOURNEY_STEP=p13 STEP=spl-faucet || fail "P13: the test SPL faucet"
  journey_ts JOURNEY_STEP=p7 STEP=spl-metadata "EXPECT_SPL_FILLIN=${EXPECT_SPL_FILLIN:-1}" || fail "00059 P7: the real SPL metadata"
  flows demo-a JOURNEY_STEP=demo || fail "A claims the demo tokens"
  journey_ts JOURNEY_STEP=demo STEP=demo-decimals || fail "Q10: decimals and icons through the injector"
  journey_ts JOURNEY_STEP=icons STEP=icons || fail "Q10: the published icons"
  mark rows end

  journey_ts JOURNEY_STEP=summary STEP=prompts || fail "SC-005"
  journey_ts JOURNEY_STEP=summary STEP=summary || fail "summary"
  say "JOURNEY PASS ($((SECONDS - t0)) s)"
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
# down: everything goes, and it is checked
# ═════════════════════════════════════════════════════════════════════════════════════════════
down() {
  set +e
  load_current
  # Compose needs every variable it interpolates, even to take a half-started stack down.
  local v; for v in NODE_PORT INDEXER_PORT RELAY_PORT SOL_RPC INJECTOR_PORT; do [[ -n "${!v}" ]] || printf -v "$v" '%s' 1; done
  [[ -n "$INJECTOR_IMAGE" ]] || INJECTOR_IMAGE=s00059/service:unset
  export_env
  say "down $CP"
  [[ -n "${MEM_PID:-}" ]] && kill "$MEM_PID" 2>/dev/null
  dc --profile relay logs --no-color relay >"$OUT/relay.log" 2>&1
  dc --profile relay logs --no-color kernel >"$OUT/mock-exchange.log" 2>&1
  dc --profile injector logs --no-color injector >"$OUT/injector.log" 2>&1
  dc logs --no-color proof-server-rc8 2>&1 | tail -300 >"$OUT/proof-server-rc8.tail.log"
  dc logs --no-color node 2>&1 | grep -E 'Rejected transaction|Transaction malformed|Invalid Transaction|InvalidProof|Custom error' | tail -100 >"$OUT/node-rejections.log"
  for w in x y; do
    if [[ -f "$RUN/$w.env" ]]; then
      dcb "$w" logs --no-color >"$OUT/node-$w-container.log" 2>&1
      dcb "$w" down -v --remove-orphans >/dev/null 2>&1
    fi
  done
  dc --profile relay --profile injector down -v --remove-orphans >/dev/null 2>&1
  docker ps -a --format '{{.Names}}' | grep -E "^$CP-" | xargs -r docker rm -f >/dev/null 2>&1
  if [[ -n "${VPID:-}" ]]; then
    kill "$VPID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$VPID" 2>/dev/null || break; sleep 1; done
    kill -9 "$VPID" 2>/dev/null
  fi
  pkill -f "$RUN/ledger" 2>/dev/null
  tail -100 "$RUN/validator.out" >"$OUT/validator.tail.log" 2>/dev/null
  docker image rm "$INJECTOR_IMAGE" >/dev/null 2>&1
  docker run --rm --pull=never --memory 256m -v "$TMPL_VOLUME:/work" "$STEP_IMAGE" sh -c \
    "rm -rf $TROOT/deployments/standin-x.json $TROOT/deployments/standin-y.json $TROOT/deployments/standin-x.record.json $TROOT/deployments/standin-y.record.json $TROOT/packages/contracts-midnight/midnight-level-db-deploy" >/dev/null 2>&1
  peak_memory
  sleep 2
  local containers volumes validator rundir image
  containers=$(docker ps -a --format '{{.Names}}' | grep -cE "^$CP")
  volumes=$(docker volume ls --format '{{.Name}}' | grep -cE "^$CP")
  validator=$(pgrep -f "$RUN/ledger" | wc -l | tr -d ' ')
  rm -rf "$RUN"; rundir=$([[ -e "$RUN" ]] && echo 1 || echo 0)
  image=$(docker image inspect "$INJECTOR_IMAGE" >/dev/null 2>&1 && echo 1 || echo 0)
  rm -f "$STATE_ROOT/current"
  [[ "$(cut -d' ' -f1 "$LOCK/holder" 2>/dev/null)" == 00057 ]] && rm -rf "$LOCK"
  local lock; lock=$([[ -d "$LOCK" && "$(cut -d' ' -f1 "$LOCK/holder" 2>/dev/null)" == 00057 ]] && echo 1 || echo 0)
  printf '{"project":"%s","containers":%s,"volumes":%s,"validatorProcesses":%s,"runDirLeft":%s,"injectorImageLeft":%s,"lockHeldBy00057":%s,"at":"%s"}\n' \
    "$CP" "$containers" "$volumes" "$validator" "$rundir" "$image" "$lock" "$(date -u +%FT%TZ)" | tee "$OUT/down-check.json"
  report
  (( containers + volumes + validator + rundir + image + lock == 0 )) || { say "DOWN LEFT SOMETHING BEHIND"; return 1; }
  say "down: nothing left; lock released"
}
peak_memory() {
  [[ -f "$OUT/mem.log" ]] || return 0
  python3 - "$OUT" <<'PY'
import json, re, sys
out = sys.argv[1]
units = {"B": 1, "KiB": 1024, "MiB": 1024**2, "GiB": 1024**3, "kB": 1000, "MB": 1000**2, "GB": 1000**3}
def size(t):
    m = re.match(r"([0-9.]+)\s*([A-Za-z]+)", t)
    return float(m.group(1)) * units.get(m.group(2), 1) if m else 0
by_ts, top = {}, {}
for line in open(f"{out}/mem.log"):
    p = line.split()
    if len(p) >= 3:
        v = size(p[2])
        by_ts[p[0]] = by_ts.get(p[0], 0) + v
        top[p[1]] = max(top.get(p[1], 0), v)
peak = max(by_ts, key=by_ts.get) if by_ts else None
res = {"peakGiB": round(by_ts.get(peak, 0) / 1024**3, 2), "peakAt": peak, "samples": len(by_ts),
       "perContainerMaxGiB": {k: round(v / 1024**3, 2) for k, v in sorted(top.items(), key=lambda kv: -kv[1])}}
json.dump(res, open(f"{out}/memory.json", "w"), indent=1)
print(f"peak memory {res['peakGiB']} GiB at {peak} ({len(by_ts)} samples)")
PY
}

# The run's evidence table: the oracle per checkpoint, the timings (SC-002, SC-003), the prompts (SC-005),
# the negatives (SC-004, SC-006), the memory peak. Public values only.
report() {
  [[ -f "$OUT/journey.json" ]] || return 0
  python3 "$E2E/report.py" "$OUT" || say "WARNING: the report could not be written"
}

OWN_STACK=0
case "$CMD" in
  report) : "${OUT:?}"; report ;;
  prep) prep ;;
  up)
    # A failed bring-up never leaves a half stack behind (only this invocation's own stack is taken down).
    trap 'rc=$?; trap - EXIT; if [[ $rc != 0 && $OWN_STACK == 1 ]]; then down; fi; exit $rc' EXIT
    up
    ;;
  journey) journey ;;
  down) down ;;
  run)
    : "${OUT:?OUT (the evidence directory) is required}"
    T_RUN=$SECONDS
    trap 'rc=$?; trap - EXIT; [[ $OWN_STACK == 1 ]] && { down || rc=1; }; say "run total $((SECONDS - T_RUN)) s (exit $rc)"; exit $rc' EXIT
    up
    [[ "${JOURNEY:-1}" == 0 ]] || journey
    ;;
  *) echo "usage: $0 prep|up|journey|down|run" >&2; exit 64 ;;
esac
