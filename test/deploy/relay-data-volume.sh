#!/usr/bin/env bash
# The relay's data volume, with the relay run as a uid other than the image's (AA 00047 P7.4).
#
#   RELAY_IMAGE=nightmarket/relay:ci test/deploy/relay-data-volume.sh      (CI: the relay-image job)
#
# The RUNBOOK runs the relay as the host user (RELAY_USER, so it can read the seed file). A new named
# volume mounted the default way takes the image's /var/lib/night-market (uid 1000, mode 700), and
# the relay could not write its claims lock: it reported "in use by another relay (holder unknown)"
# and exited 78 in a restart loop. This script checks, with real containers:
#
#   1. the bug's setting: a relay run as TEST_USER on such a volume exits 78 with the real cause
#      (EACCES, the lock's path, its uid/gid, the fix), never "in use by another relay";
#   2. deploy/compose.yml's relay-data-init, on that volume (plus a claims file and a stale lock of
#      uid 1000, as an older deployment leaves them), hands the directory and its contents to
#      TEST_USER, mode 700;
#   3. the relay as TEST_USER, mounted as compose mounts it (nocopy), then starts, takes over the
#      stale lock, reads the claims history, and removes its lock when stopped;
#   4. a fresh volume that compose creates is TEST_USER's, mode 700, after the init alone;
#   5. the init refuses a RELAY_USER that is not a numeric uid[:gid] (exit 64);
#   6. the init runs as root with CHOWN as its only capability, no network and a read-only root.
#
# Environment:
#   RELAY_IMAGE  the relay image to test (default nightmarket/relay:ci)
#   NAME         prefix of every container, volume and compose project (default nightmarket-relaydata)
#   TEST_USER    the relay's uid:gid (default 4321:4321; anything but the image's 1000:1000)
# Everything it creates is removed at the end.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELAY_IMAGE="${RELAY_IMAGE:-nightmarket/relay:ci}"
NAME="${NAME:-nightmarket-relaydata}"
TEST_USER="${TEST_USER:-4321:4321}"
TEST_UID="${TEST_USER%%:*}"
TEST_GID="${TEST_USER##*:}"
PROJECT="$NAME"
FRESH="$NAME-fresh"
VOL="${PROJECT}_relay-data"
RELAY="$NAME-relay"
DATA=/var/lib/night-market
OWNER_KEY="$(printf 'ab%.0s' $(seq 1 32))"
TMP="$(mktemp -d)"

say() { echo "relay-data-volume: $*" >&2; }
fail() {
  say "FAIL: $*"
  exit 1
}

compose() { # <project> <args...>
  local p="$1"
  shift
  docker compose -p "$p" -f "$ROOT/deploy/compose.yml" --env-file "$TMP/bundle.env" "$@"
}

cleanup() {
  docker rm -f "$RELAY" >/dev/null 2>&1 || true
  compose "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  compose "$FRESH" down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "$VOL" "${FRESH}_relay-data" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# The example settings, with a placeholder seed file and the test's RELAY_USER.
: >"$TMP/seed"
sed -e "s#^SPONSOR_SEED_HOST_FILE=.*#SPONSOR_SEED_HOST_FILE=$TMP/seed#" \
  -e "s#^RELAY_ENV_FILE=.*#RELAY_ENV_FILE=$TMP/bundle.env#" \
  -e "s#^RELAY_USER=.*#RELAY_USER=$TEST_USER#" \
  "$ROOT/deploy/.env.example" >"$TMP/bundle.env"
grep -qx "RELAY_USER=$TEST_USER" "$TMP/bundle.env" || fail "could not set RELAY_USER in the example settings"
BUSYBOX="$(compose "$PROJECT" config --images | grep '^busybox:')"
[[ -n "$BUSYBOX" ]] || fail "no busybox image in deploy/compose.yml"

# What a path in a volume looks like: "<mode> <uid> <gid>" per line, via the pinned busybox.
inspect() { # <volume> <paths...>
  local vol="$1"
  shift
  docker run --rm --network none -v "$vol:/data:ro" "$BUSYBOX" stat -c '%n %a %u %g' "$@"
}

# Run the relay as TEST_USER on the data volume, detached, as compose runs it (no key volume).
relay_run() { # <mount option>
  docker run -d --name "$RELAY" --init --user "$TEST_USER" --read-only --tmpfs /tmp \
    --cap-drop ALL --security-opt no-new-privileges:true \
    -e HOME=/tmp -e RELAY_NETWORK=stagenet -e DEMO_TOKENS_ENABLED=true -e RELAY_DATA_DIR="$DATA" \
    "$1" "$RELAY_IMAGE" >/dev/null
}

# 6. The init's privileges, as compose will run it.
compose "$PROJECT" config --format json >"$TMP/config.json"
python3 - "$TMP/config.json" <<'EOF' || fail "relay-data-init is not locked down as expected"
import json, sys
c = json.load(open(sys.argv[1]))
init, relay = c["services"]["relay-data-init"], c["services"]["relay"]
assert init["user"] == "0:0", init["user"]
assert init["cap_drop"] == ["ALL"] and init["cap_add"] == ["CHOWN"], (init["cap_drop"], init["cap_add"])
assert init["network_mode"] == "none" and init["read_only"] is True
assert "no-new-privileges:true" in init["security_opt"]
assert init["restart"] == "no"
assert [v["target"] for v in init["volumes"]] == ["/data"]
assert relay["depends_on"]["relay-data-init"]["condition"] == "service_completed_successfully"
data = [v for v in relay["volumes"] if v["target"] == "/var/lib/night-market"]
assert data and data[0]["source"] == "relay-data" and data[0]["volume"].get("nocopy") is True, data
EOF
say "6 PASS: the init is root with CHOWN only, no network, a read-only root; the relay waits for it and mounts the volume nocopy"

# 1. The bug's setting: the compose project's volume, mounted the default way (the image's
#    directory is copied in: uid 1000, mode 700), and the relay run as TEST_USER.
compose "$PROJECT" up --no-start relay-data-init >/dev/null 2>&1
docker volume inspect "$VOL" >/dev/null || fail "compose did not create $VOL"
relay_run "--volume=$VOL:$DATA"
for _ in $(seq 1 120); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$RELAY")" == false ]] && break
  sleep 0.5
done
code="$(docker inspect -f '{{.State.ExitCode}}' "$RELAY")"
docker logs "$RELAY" >"$TMP/eacces.log" 2>&1
docker rm -f "$RELAY" >/dev/null
[[ "$(inspect "$VOL" /data)" == "/data 700 1000 1000" ]] || fail "the default mount did not take the image's directory: $(inspect "$VOL" /data)"
[[ "$code" == 78 ]] || fail "the relay exited $code, not 78 (log: $(tail -3 "$TMP/eacces.log"))"
grep -q 'in use by another relay' "$TMP/eacces.log" && fail "EACCES was still reported as a lock conflict"
for want in 'cannot create its lock file' "$DATA/demo-token-claims.json.lock" 'EACCES' \
  "The relay runs as uid $TEST_UID gid $TEST_GID" "$DATA is owned by uid 1000 gid 1000, mode 700" 'RELAY_USER' 'relay-data-init'; do
  grep -qF -- "$want" "$TMP/eacces.log" || fail "the refusal does not say \"$want\" (log: $(tail -3 "$TMP/eacces.log"))"
done
say "1 PASS: exit 78, and the log names EACCES, the lock's path, uid $TEST_UID gid $TEST_GID, the owner and the fix:"
grep -o '"reason":"[^"]*"' "$TMP/eacces.log" | head -1 >&2

# 2. An older deployment's leftovers in that volume: a claims file and a stale lock of uid 1000.
now="$(date +%s)"
docker run --rm --network none -v "$VOL:/data" "$BUSYBOX" sh -euc "
  printf '{\"format\":\"night-market-demo-token-claims/1\",\"claims\":[{\"owner\":\"$OWNER_KEY\",\"account\":\"$(printf 'cd%.0s' $(seq 1 32))\",\"state\":\"claimed\",\"at\":$now,\"claimedAt\":$now,\"txs\":[]}]}\n' >/data/demo-token-claims.json
  echo 999999 >/data/demo-token-claims.json.lock
  chown 1000:1000 /data /data/demo-token-claims.json /data/demo-token-claims.json.lock
  chmod 600 /data/demo-token-claims.json /data/demo-token-claims.json.lock
  chmod 700 /data"
compose "$PROJECT" run --rm relay-data-init >"$TMP/init.log" 2>&1 || fail "relay-data-init failed: $(cat "$TMP/init.log")"
got="$(inspect "$VOL" /data /data/demo-token-claims.json /data/demo-token-claims.json.lock | tr '\n' ';')"
[[ "$got" == "/data 700 $TEST_UID $TEST_GID;/data/demo-token-claims.json 600 $TEST_UID $TEST_GID;/data/demo-token-claims.json.lock 600 $TEST_UID $TEST_GID;" ]] ||
  fail "after relay-data-init: $got"
say "2 PASS: relay-data-init handed the directory and its files to $TEST_USER (directory 700, files keep 600)"

# 3. The relay as TEST_USER, mounted as compose mounts it.
relay_run "--mount=type=volume,src=$VOL,dst=$DATA,volume-nocopy"
info=''
for _ in $(seq 1 120); do
  [[ "$(docker inspect -f '{{.State.Running}}' "$RELAY")" == true ]] || break
  info="$(docker exec "$RELAY" bun -e "fetch('http://127.0.0.1:8080/v1/demo-tokens?owner=$OWNER_KEY').then(r => r.text()).then(t => console.log(t)).catch(() => {})" 2>/dev/null || true)"
  [[ -n "$info" ]] && break
  sleep 0.5
done
[[ -n "$info" ]] || fail "the relay did not serve (exit $(docker inspect -f '{{.State.ExitCode}}' "$RELAY"); log: $(docker logs "$RELAY" 2>&1 | tail -3))"
echo "$info" | grep -q '"claimed":true' || fail "the relay did not read the claims history: $info"
echo "$info" | grep -q '"remainingToday":99' || fail "the day's count is not the history's: $info"
docker logs "$RELAY" 2>&1 | grep -q '"msg":"demo tokens enabled"' || fail "no 'demo tokens enabled' line"
pid="$(docker exec "$RELAY" cat "$DATA/demo-token-claims.json.lock")"
[[ "$pid" != 999999 ]] || fail "the stale lock was not taken over"
docker stop -t 20 "$RELAY" >/dev/null
[[ "$(docker inspect -f '{{.State.ExitCode}}' "$RELAY")" == 0 ]] || fail "the relay did not stop cleanly"
docker rm -f "$RELAY" >/dev/null
[[ "$(inspect "$VOL" /data/demo-token-claims.json.lock 2>/dev/null || true)" == '' ]] || fail "the lock was not removed at stop"
say "3 PASS: the relay as $TEST_USER took over the stale lock (now pid $pid), read the history (claimed true, remainingToday 99 of 100), and removed its lock at stop"

# 4. A fresh volume, created by compose, and the init alone.
compose "$FRESH" run --rm relay-data-init >"$TMP/init2.log" 2>&1 || fail "relay-data-init failed on a fresh volume: $(cat "$TMP/init2.log")"
[[ "$(inspect "${FRESH}_relay-data" /data)" == "/data 700 $TEST_UID $TEST_GID" ]] || fail "fresh volume: $(inspect "${FRESH}_relay-data" /data)"
say "4 PASS: a fresh volume is $TEST_USER's, mode 700 ($(grep 'relay-data-init:' "$TMP/init2.log" | tail -1))"

# 5. A RELAY_USER that is not numeric (a name means nothing inside the init's image).
set +e
RELAY_USER=bun compose "$FRESH" run --rm relay-data-init >"$TMP/init3.log" 2>&1
code=$?
set -e
[[ "$code" == 64 ]] || fail "a non-numeric RELAY_USER gave exit $code, not 64: $(cat "$TMP/init3.log")"
grep -q 'RELAY_USER must be a numeric uid:gid' "$TMP/init3.log" || fail "no explanation: $(cat "$TMP/init3.log")"
say "5 PASS: RELAY_USER=bun is refused (exit 64)"

say "ALL PASS"
