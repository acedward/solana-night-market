#!/usr/bin/env bash
# The one-shot key-volume job (deploy/compose.yml service `keys`): compile the Passport account WITH
# prover and verifier keys, keep only the prover keys the relay proves with, verify the set, and
# install it into the key volume the relay mounts read-only. On later starts it only re-verifies (a
# few seconds) unless an input changed.
#
# The account declares the ERC20 vault (and through it the Signet singleton) as callees, so they are
# compiled first, WITH keys (the account's compile embeds each callee's verifier-key fingerprint),
# as upstream builds them: compactc 0.34.0. They are compile-time inputs only: the compactc 0.35.0
# account module imports none of their JavaScript, and Night Market proves none of their circuits
# (no bridge), so the installed volume holds the account bundle alone (AA 00047 B1.5).
#
# Inputs, all pinned in the image (deploy/key-volume.Dockerfile):
#   compactc 0.35.0, the account (release archive, SHA-256 checked)      /opt/compactc-0.35.0
#   compactc 0.34.0, the callees (release archive, SHA-256 checked)      /opt/compactc-0.34.0
#   the Passport sources (vendor/passport @ PASSPORT_COMMIT)              /app/vendor/passport/contract/contracts
#   @sig-net/midnight 0.23.0 (the Signet Compact module)                  /app/node_modules/@sig-net/midnight
#   compact-runtime 0.20.0 (the npm alias the account module imports)    /app/node_modules/@midnight-ntwrk/compact-runtime-0.20
#
# The volume is mounted at the path the relay mounts it, so the compiled module resolves
# /app/node_modules exactly as it will in the relay. Layout after a build:
#   <root>/account/{contract,compiler,zkir,keys}
#   <root>/.night-market-keys.json   the verification report (public values), written last
#
# Checks (relay/src/tools/key-volume.ts `verify`): verifier keys = compiled expectedVk; the kept
# prover keys are present; the fingerprint = RELAY_KEYS_FINGERPRINT. Any failure exits non-zero,
# so the proof servers and the relay (which depend on this job) do not start.
set -euo pipefail
umask 022

APP=/app
OUT="${KEYS_DIR:-$APP/vendor/passport/contract/contracts/managed}"
SRC="$APP/vendor/passport/contract/contracts"
V="$SRC/erc20-vault"
NM="$APP/node_modules"
CC=/opt/compactc-0.35.0/compactc
CALLEE_CC=/opt/compactc-0.34.0/compactc
KV=(bun "$APP/relay/src/tools/key-volume.ts")
# account.compact @ acedward/passport 451f761 (branch 00047-solana-ed25519-arm, the Ed25519 arm).
ACCOUNT_PIN="${KEYS_ACCOUNT_SOURCE_SHA256:-800dd4a38f2d25228d4732fdb39b3f5f0cbe42d792eef020914b8532c85f6f26}"
MIN_FREE_GB="${KEYS_MIN_FREE_GB:-16}"
export MIDNIGHT_PP="${MIDNIGHT_PP:-/tmp/zk-params}"

say() { printf 'key-volume: %s\n' "$*" >&2; }
die() {
  say "FAILED: $*"
  exit 1
}
# PID 1 in a container ignores SIGTERM unless it is trapped: stop promptly (and clean up) on
# `docker compose stop`.
trap 'say "stopped by a signal"; exit 143' TERM INT

[[ -d "$OUT" && -w "$OUT" ]] || die "the key volume at $OUT is missing or not writable by uid $(id -u)"
mkdir -p "$MIDNIGHT_PP" 2>/dev/null || true

# ── the pinned inputs ────────────────────────────────────────────────────────
COMPACTC_VERSION="$("$CC" --version)"
[[ "$COMPACTC_VERSION" == "0.35.0 (debb05f94 2026-09-29)" ]] ||
  die "compactc 0.35.0 (debb05f94) required for the account, found $COMPACTC_VERSION"
ARCHIVE_SHA="$(cat /opt/compactc-0.35.0/.archive-sha256 2>/dev/null || echo unknown)"
CALLEE_VERSION="$("$CALLEE_CC" --version)"
[[ "$CALLEE_VERSION" == 0.34.0 ]] || die "compactc 0.34.0 required for the callees, found $CALLEE_VERSION"
CALLEE_ARCHIVE_SHA="$(cat /opt/compactc-0.34.0/.archive-sha256 2>/dev/null || echo unknown)"
RUNTIME_020="$(bun -e "console.log(require('$NM/@midnight-ntwrk/compact-runtime-0.20/package.json').version)")"
[[ "$RUNTIME_020" == 0.20.0 ]] || die "compact-runtime 0.20.0 (the account module's alias) required, found $RUNTIME_020"
SIG_VERSION="$(bun -e "console.log(require('$NM/@sig-net/midnight/package.json').version)")"
[[ "$SIG_VERSION" == 0.23.0 ]] || die "@sig-net/midnight 0.23.0 required, found $SIG_VERSION"
ACCOUNT_SHA="$(sha256sum "$SRC/account.compact" | cut -d' ' -f1)"
[[ "$ACCOUNT_SHA" == "$ACCOUNT_PIN" ]] ||
  die "account.compact is $ACCOUNT_SHA, not the pinned $ACCOUNT_PIN (set KEYS_ACCOUNT_SOURCE_SHA256 when re-pinning)"

inputs() {
  echo night-market-key-volume/2
  echo "compactc $COMPACTC_VERSION archive $ARCHIVE_SHA"
  echo "callees compactc $CALLEE_VERSION archive $CALLEE_ARCHIVE_SHA"
  echo "compact-runtime $RUNTIME_020"
  sha256sum "$APP/scripts/pin-contract-runtime.mjs" | cut -d' ' -f1
  echo "sig-net/midnight $SIG_VERSION"
  (cd "$APP" && find vendor/passport/contract/contracts node_modules/@sig-net/midnight/src -name '*.compact' \
    -not -path '*/managed/*' | LC_ALL=C sort | xargs sha256sum)
  printf '%s\n' "${KEYS_KEEP_PROVERS:-default}" | tr ' ,' '\n\n' | grep . | LC_ALL=C sort
}
INPUTS="$(inputs | sha256sum | cut -d' ' -f1)"
export KV_COMPACTC_VERSION="$COMPACTC_VERSION" KV_COMPACTC_ARCHIVE_SHA256="$ARCHIVE_SHA" \
  KV_CALLEE_COMPACTC_VERSION="$CALLEE_VERSION" KV_CALLEE_COMPACTC_ARCHIVE_SHA256="$CALLEE_ARCHIVE_SHA" \
  KV_CONTRACT_RUNTIME="$RUNTIME_020" \
  KV_SIGNET_VERSION="$SIG_VERSION" KV_PASSPORT_COMMIT="${PASSPORT_COMMIT:-unknown}" KV_ACCOUNT_SHA256="$ACCOUNT_SHA"
say "inputs $INPUTS (compactc $COMPACTC_VERSION, callees $CALLEE_VERSION, compact-runtime $RUNTIME_020, @sig-net/midnight $SIG_VERSION, passport ${PASSPORT_COMMIT:-unknown})"

# ── already built from these inputs: re-verify only ──────────────────────────
current="$("${KV[@]}" marker-inputs "$OUT")" || die "the verification tool does not run (see the error above)"
if [[ "$current" == "$INPUTS" ]]; then
  say "the key volume was built from these inputs; re-verifying"
  "${KV[@]}" verify "$OUT" --inputs "$INPUTS" --recheck --write-marker ||
    die "the installed key set no longer verifies (the problems are listed above)"
  say "OK: the key volume is verified"
  exit 0
fi

# ── build ────────────────────────────────────────────────────────────────────
free_kb="$(df -Pk "$OUT" | awk 'NR == 2 { print $4 }')"
((free_kb >= MIN_FREE_GB * 1024 * 1024)) ||
  die "the key volume's disk has $((free_kb / 1024 / 1024)) GB free; a build needs ${MIN_FREE_GB} GB (KEYS_MIN_FREE_GB)"

W="$OUT/.work"
rm -rf "$W"
mkdir -p "$W"
ok=0
cleanup() { if [[ "$ok" != 1 ]]; then rm -rf "$W"; fi; }
trap cleanup EXIT

compile() { # <compactc> <label> <compact-path> <source> <target> [flags]
  local cc="$1" label="$2" cpath="$3" src="$4" target="$5"
  shift 5
  local t0=$SECONDS
  say "compiling $label ($("$cc" --version | cut -d' ' -f1))"
  COMPACT_PATH="$cpath" "$cc" "$@" --feature-zkir-v3 --compact-path "$cpath" "$src" "$target"
  say "$label done in $((SECONDS - t0)) s"
}

started=$SECONDS
if [[ -n "${KEYS_IMPORT_DIR:-}" ]]; then
  # A key set built elsewhere (for example on a larger machine), mounted read-only. It is NOT
  # trusted: it goes through exactly the same prune and verification as a fresh compile.
  [[ -d "$KEYS_IMPORT_DIR/account" ]] || die "KEYS_IMPORT_DIR has no account bundle"
  say "importing account from $KEYS_IMPORT_DIR"
  cp -RL "$KEYS_IMPORT_DIR/account" "$W/account"
  export KV_SOURCE=import
else
  # Callees first (compile-time inputs, in $W/callees): the compiler resolves a declared contract
  # type to <compact-path>/<TypeName>, so they sit side by side there.
  C="$W/callees"
  mkdir -p "$C"
  compile "$CALLEE_CC" SignetSigner "$NM" "$V/src/vendor/signet-contract.compact" "$C/SignetSigner"
  compile "$CALLEE_CC" SignetCircuits "$NM" "$NM/@sig-net/midnight/src/circuits.compact" "$C/SignetCircuits" --skip-zk
  compile "$CALLEE_CC" Erc20Vault "$NM:$C" "$V/src/erc20-vault.compact" "$C/Erc20Vault"
  compile "$CC" account "$NM:$C" "$SRC/account.compact" "$W/account"
  rm -rf "$C"
  export KV_SOURCE=compile
fi
# The account module (and only it) resolves compact-runtime 0.20.0; the SDK keeps 0.19.0. The same
# step re-stamps the compiler manifest for the two rewritten files. An imported set goes through it
# too (it is idempotent, and refuses a module not generated for runtime 0.20.0).
bun "$APP/scripts/pin-contract-runtime.mjs" "$W/account" || die "the account module is not a compactc 0.35.0 module"
export KV_COMPILE_SECONDS=$((SECONDS - started))
say "${KV_SOURCE} took ${KV_COMPILE_SECONDS} s; $(du -sh "$W" | cut -f1) before pruning"

"${KV[@]}" prune "$W"
say "$(du -sh "$W" | cut -f1) after pruning"

"${KV[@]}" verify "$W" --inputs "$INPUTS" --write-marker ||
  die "the compiled key set does not verify (the problems are listed above)"

# Install: replace the previous set (and any bundle an older release installed beside it), then
# the report last.
for b in account Erc20Vault SignetSigner SignetCircuits; do rm -rf "${OUT:?}/$b"; done
rm -f "$OUT/.mnbank-keys.json" "$OUT/.night-market-keys.json"
mv "$W/account" "$OUT/account"
mv "$W/.night-market-keys.json" "$OUT/.night-market-keys.json"
rm -rf "$W"
ok=1
say "OK: key volume installed and verified in $((SECONDS - started)) s ($(du -sh "$OUT" | cut -f1))"
