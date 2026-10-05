#!/usr/bin/env bash
# AA 00057 P5R: a PREVIEW of Night Market for the owner, against Midnight stagenet, the Offer Files stagenet
# exchange and (for the site's Solana side) devnet. Local: the relay (sponsor Temporary 11), the provers (rc.8
# contract, rc.6 DUST) and the built site on 127.0.0.1. No bridges are configured (Bridge in/out show "not
# available"); demo tokens are on (the stagenet mint-test-tokens faucets).
#
#   e2e/stagenet/preview.sh up       takes the stack lock and starts it; prints the site URL; leaves it running
#   e2e/stagenet/preview.sh status   the site, the relay's sponsor, the containers
#   e2e/stagenet/preview.sh down     stops it, removes its containers, volumes and temp files, releases the lock
#
# Inputs: `e2e/run-local.sh prep` + `e2e/stagenet/run-gate.sh prep` (the relay image and the site build). The
# sponsor seed is mounted read-only into the relay and read in-process. The private devnet RPC
# (~/.config/aa-00057/devnet/rpc-url, an API key in its URL) goes only into the site's config.json, served on
# 127.0.0.1 for this LOCAL preview (a deployment must never ship an API-keyed URL in a public config.json).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/e2e/stagenet"
CMD="${1:-up}"
STATE_ROOT="${AA00057_STATE:-$HOME/.cache/aa-00057}"
CONF="$HOME/.config/aa-00057"
DIR="$STATE_ROOT/preview"
LOCK="$HOME/.aa-00057-stack.lock"
P=aa00057-preview
NET="$P-net"
BUN_IMAGE=oven/bun:1.3.11
PS6_IMAGE=midnightntwrk/proof-server@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b
PS8_IMAGE=midnightntwrk/proof-server:9.0.0-rc.8
KEYS_SRC="${KEYS_SRC:-$HOME/.cache/aa-00047/p10i-keys}"
PS_PARAMS_SRC="${PS_PARAMS_SRC:-$HOME/.cache/aa-00047/ps-params}"
PS8_PARAMS_SRC="${PS8_PARAMS_SRC:-$HOME/.cache/aa-00047/ps-params-rc8}"
SPONSOR_FILE="$CONF/stagenet/temporary-11.seed"
RPC_FILE="$CONF/devnet/rpc-url"
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
# The pinned Passport circuit set's sha256 (public: AA 00047's verified key volume); the relay checks it.
ACCOUNT_CIRCUITS_SHA256=21493588f30536e0f409dcf79deea54878f0c2cf6fee601a2359e54a776d5c5e

die() { echo "preview: $*" >&2; exit 1; }
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

up() {
  [[ -f "$DIR/web-port" ]] && die "already up (http://127.0.0.1:$(cat "$DIR/web-port")/); \`$0 down\` first"
  local relay_image; relay_image="$(cat "$STATE_ROOT/relay-image" 2>/dev/null)"
  docker image inspect "$relay_image" >/dev/null 2>&1 || die "no relay image (run e2e/run-local.sh prep)"
  [[ -f "$STATE_ROOT/site-dist/index.html" ]] || die "no site build (run e2e/stagenet/run-gate.sh prep)"
  [[ -f "$SPONSOR_FILE" && "$(stat -f %Lp "$SPONSOR_FILE")" == 600 ]] || die "$SPONSOR_FILE missing or not 600"
  [[ -f "$RPC_FILE" && "$(stat -f %Lp "$RPC_FILE")" == 600 ]] || die "$RPC_FILE missing or not 600"
  mkdir "$LOCK" 2>/dev/null || die "the stack lock is held: $(cat "$LOCK/holder" 2>/dev/null || echo '?')"
  printf '00057 P5R preview for the owner %s (containers %s-*)\n' "$(date -u +%FT%TZ)" "$P" >"$LOCK/holder"
  trap 'rc=$?; trap - EXIT; [[ $rc != 0 ]] && down >/dev/null 2>&1; exit $rc' EXIT
  mkdir -p "$DIR" && chmod 700 "$DIR"
  rm -rf "$DIR/keys" "$DIR/ps-params" "$DIR/ps8-params" "$DIR/site"
  cp -Rc "$KEYS_SRC" "$DIR/keys"; cp -Rc "$PS_PARAMS_SRC" "$DIR/ps-params"; cp -Rc "$PS8_PARAMS_SRC" "$DIR/ps8-params"
  cp -Rc "$STATE_ROOT/site-dist" "$DIR/site"
  local web; web="$(free_port)"
  # The site's config.json: stagenet (the built-in token list, the profile's kernel and batcher), the relay
  # behind the site on /relay/, no bridges, Solana devnet through the private RPC (local preview only).
  DEVNET_URL="$(tr -d ' \r\n' <"$RPC_FILE")" python3 - "$DIR/site/config.json" "$web" "$DEVNET_GENESIS" <<'PY'
import json, os, sys
json.dump({"network": "stagenet", "relayUrl": f"http://127.0.0.1:{sys.argv[2]}/relay",
           "solana": {"rpcUrl": os.environ["DEVNET_URL"], "genesisHash": sys.argv[3], "cluster": "solana:devnet"},
           "walletTimeoutSeconds": 300}, open(sys.argv[1], "w"), indent=1)
PY
  chmod 600 "$DIR/site/config.json"
  docker network create "$NET" >/dev/null || die "network"
  docker run -d --name "$P-ps6" --network "$NET" --network-alias proof-server-dust --memory 4g --pull=never \
    -e PORT=6300 -e MIDNIGHT_PP=/params -v "$DIR/ps-params:/params" "$PS6_IMAGE" >/dev/null || die "rc.6 prover"
  docker run -d --name "$P-ps8" --network "$NET" --network-alias proof-server-contracts --memory 12g --memory-swap 12g \
    --restart on-failure:5 --pull=never -e PORT=6300 -e MIDNIGHT_PP=/params -v "$DIR/ps8-params:/params" "$PS8_IMAGE" >/dev/null \
    || die "rc.8 prover"
  docker volume create "$P-relay-data" >/dev/null
  docker run -d --name "$P-relay" --network "$NET" --network-alias relay --memory 4g --pull=never \
    --restart unless-stopped -e HOME=/tmp -e RELAY_NETWORK=stagenet \
    -e MIDNIGHT_MANAGED_PATH=/app/vendor/passport/contract/contracts/managed \
    -e MIDNIGHT_CONTRACT_PROOF_SERVER_URL=http://proof-server-contracts:6300 \
    -e MIDNIGHT_DUST_PROOF_SERVER_URL=http://proof-server-dust:6300 \
    -e RELAY_REQUIRE_KEYS=true -e "RELAY_KEYS_FINGERPRINT=$ACCOUNT_CIRCUITS_SHA256" \
    -e SPONSOR_ENABLED=true -e SPONSOR_SEED_FILE=/run/secrets/sponsor-seed -e SPONSOR_FUNDING_LOCK_FILE=/tmp/relay-funding.lock \
    -e SPONSOR_FEE_BLOCKS_MARGIN=5 -e DEMO_TOKENS_ENABLED=true -e DEMO_TOKENS_PACK=twUSDC:1000,twBTC:0.1 \
    -e DEMO_TOKENS_PATH=direct -e DEMO_TOKENS_DAILY_CAP=10 -e RELAY_DATA_DIR=/var/lib/night-market \
    -e RATE_LIMIT_ACTIONS_PER_MIN=100 -e RATE_LIMIT_ACTIONS_PER_OWNER_PER_MIN=100 -e LOG_LEVEL=info \
    -v "$DIR/keys:/app/vendor/passport/contract/contracts/managed:ro" \
    --mount "type=bind,source=$SPONSOR_FILE,target=/run/secrets/sponsor-seed,readonly" \
    -v "$P-relay-data:/var/lib/night-market" "$relay_image" >/dev/null || die "relay"
  docker run -d --name "$P-site" --network "$NET" --memory 256m --pull=never --restart unless-stopped \
    -p "127.0.0.1:$web:8080" -v "$DIR/site:/site:ro" -v "$HERE/site-server.ts:/srv/site-server.ts:ro" \
    -e RELAY_UPSTREAM=http://relay:8080/ -e KERNEL_UPSTREAM=https://stagenet.api-zswap.zkdojo.com/ \
    -e BATCHER_UPSTREAM=https://stagenet.batcher-zswap.zkdojo.com/ "$BUN_IMAGE" bun /srv/site-server.ts >/dev/null || die "site"
  echo "$web" >"$DIR/web-port"
  local h=""
  for _ in $(seq 1 120); do
    h="$(curl -s -m 10 "http://127.0.0.1:$web/relay/health" || true)"
    python3 -c 'import json,sys; s=json.loads(sys.argv[1]).get("sponsor",{}); sys.exit(0 if s.get("synced") is True else 1)' "$h" 2>/dev/null && break
    sleep 5
  done
  python3 -c 'import json,sys; s=json.loads(sys.argv[1]).get("sponsor",{}); sys.exit(0 if s.get("synced") is True else 1)' "$h" 2>/dev/null \
    || { docker logs "$P-relay" 2>&1 | tail -20; die "the relay's sponsor never synced"; }
  [[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web/")" == 200 ]] || die "the site does not answer"
  trap - EXIT
  echo "Night Market preview: http://127.0.0.1:$web/"
  echo "Nightly network: Solana devnet (no custom RPC needed for the preview)"
  echo "Stop: $0 down"
}

status() {
  local web; web="$(cat "$DIR/web-port" 2>/dev/null)" || { echo "not running"; return 0; }
  echo "site http://127.0.0.1:$web/ -> $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$web/")"
  curl -s -m 10 "http://127.0.0.1:$web/relay/health" | python3 -c '
import json, sys
h = json.load(sys.stdin); s = h.get("sponsor", {})
print("relay sponsor synced", s.get("synced"), "state", s.get("state"), "DUST", round(int(s.get("dustSpecks") or 0) / 1e15, 3))' 2>/dev/null
  docker ps --filter "name=^$P" --format '{{.Names}} {{.Status}}'
  echo "lock: $(cat "$LOCK/holder" 2>/dev/null || echo free)"
}

down() {
  # Bridge node X, when a gate ran on this preview (ATTACH=preview run-gate.sh): its compose project.
  docker ps -a --filter "label=com.docker.compose.project=$P-x" -q | xargs -r docker rm -f >/dev/null 2>&1
  docker volume ls -q --filter "label=com.docker.compose.project=$P-x" | xargs -r docker volume rm >/dev/null 2>&1
  docker network rm "$P-x_default" >/dev/null 2>&1
  docker rm -f "$P-site" "$P-relay" "$P-ps8" "$P-ps6" >/dev/null 2>&1
  docker volume rm "$P-relay-data" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$DIR"
  if [[ "$(cut -d' ' -f1-4 "$LOCK/holder" 2>/dev/null)" == "00057 P5R preview for" ]]; then rm -rf "$LOCK"; fi
  echo "preview down: containers $(docker ps -a --format '{{.Names}}' | grep -c "^$P"), volumes $(docker volume ls -q | grep -c "^$P"), lock $(cat "$LOCK/holder" 2>/dev/null || echo free)"
}

case "$CMD" in
  up) up ;;
  status) status ;;
  down) down ;;
  *) echo "usage: $0 up|status|down" >&2; exit 64 ;;
esac
