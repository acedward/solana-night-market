#!/usr/bin/env bash
# Light compile (--skip-zk: contract JavaScript and type declarations only, NO prover keys)
# of the Passport account and its callees, from the pinned submodule vendor/passport.
#
# Why: the browser needs the compiled account's `pureCircuits` (challenges, the Ed25519 arm's
# message renderers, the boot commitment, the offer's change nonce). The generated modules are not
# in git upstream, so every checkout builds them. Prover keys are a separate one-shot volume
# (relay-keys-init; plan P0.5 decision) and are never built here.
#
# Toolchain (AA 00047 B1.5, the recipe of acedward/passport branch 00047-solana-ed25519-arm):
#   - the ACCOUNT with compactc 0.35.0 (--feature-zkir-v3): its Ed25519 arm uses the 0.35.0
#     standard library's `ed25519Verify`, `sha512` and Curve25519 types;
#   - its declared CALLEES (the ERC20 vault and the Signet singleton) with compactc 0.34.0, as
#     upstream builds them (the vault is deployed and frozen). The account only reads their
#     declarations at compile time; the 0.35.0 module does not import their JavaScript. Night Market
#     calls none of their circuits (no bridge).
#   - then scripts/pin-contract-runtime.mjs points the account module (only it) at compact-runtime
#     0.20.0 (the `@midnight-ntwrk/compact-runtime-0.20` alias); the SDK keeps 0.19.0.
# Both compilers come from scripts/fetch-compactc.sh (release archives, SHA-256 pinned).
#
# Order (the compiler resolves a declared contract type to <compact-path>/<TypeName>, so callees go
# first and sit side by side):
#   1. SignetSigner   <- erc20-vault/src/vendor/signet-contract.compact            (0.34.0)
#   2. SignetCircuits <- node_modules/@sig-net/midnight/src/circuits.compact       (0.34.0)
#   3. Erc20Vault     <- erc20-vault/src/erc20-vault.compact                       (0.34.0)
#   4. account        <- contracts/account.compact, with contracts/managed/{Erc20Vault,SignetSigner}
#                        linked to the vault's own output (upstream scripts/link-callees.sh) (0.35.0)
#
# Outputs land in the submodule's git-ignored managed/ directories, exactly where the upstream
# sources import them from. A stamp over every input skips the work when nothing changed.
#
# Environment: COMPACTC_ACCOUNT / COMPACTC_CALLEES name compilers already installed (their version
# lines are still checked); otherwise scripts/fetch-compactc.sh installs the pinned ones.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
P="$ROOT/vendor/passport/contract"
V="$P/contracts/erc20-vault"
NM="$ROOT/node_modules"
SIG="$NM/@sig-net/midnight"

[[ -f "$P/contracts/account.compact" ]] || {
  echo "compile-contracts: $P is empty; run: git submodule update --init" >&2
  exit 66
}
[[ -f "$SIG/package.json" ]] || {
  echo "compile-contracts: $SIG is missing; run: bun install" >&2
  exit 66
}

ACCOUNT_CC="${COMPACTC_ACCOUNT:-}"
if [[ -z "$ACCOUNT_CC" ]]; then ACCOUNT_CC="$(bash "$ROOT/scripts/fetch-compactc.sh" 0.35.0)"; fi
[[ "$("$ACCOUNT_CC" --version)" == "0.35.0 (debb05f94 2026-09-29)" ]] || {
  echo "compile-contracts: compactc 0.35.0 (debb05f94) required for the account, got $("$ACCOUNT_CC" --version)" >&2
  exit 65
}
CALLEE_CC="${COMPACTC_CALLEES:-}"
if [[ -z "$CALLEE_CC" ]]; then CALLEE_CC="$(bash "$ROOT/scripts/fetch-compactc.sh" 0.34.0)"; fi
[[ "$("$CALLEE_CC" --version)" == "0.34.0" ]] || {
  echo "compile-contracts: compactc 0.34.0 required for the callees, got $("$CALLEE_CC" --version)" >&2
  exit 65
}
JS_RUN="$(command -v bun || command -v node)" || {
  echo "compile-contracts: bun or node is required" >&2
  exit 66
}
SIG_VERSION="$(node -p "require('$SIG/package.json').version" 2>/dev/null || bun -e "console.log(require('$SIG/package.json').version)")"
[[ "$SIG_VERSION" == "0.23.0" ]] || {
  echo "compile-contracts: @sig-net/midnight 0.23.0 required, got $SIG_VERSION" >&2
  exit 65
}

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
inputs() {
  "$ACCOUNT_CC" --version
  "$CALLEE_CC" --version
  echo "sig-net/midnight $SIG_VERSION"
  git -C "$ROOT/vendor/passport" rev-parse HEAD 2>/dev/null || true
  find "$P/contracts" -name '*.compact' -not -path '*/managed/*' -not -path '*/node_modules/*' | LC_ALL=C sort | xargs cat
  find "$SIG/src" -name '*.compact' | LC_ALL=C sort | xargs cat
  cat "$ROOT/scripts/compile-contracts.sh" "$ROOT/scripts/pin-contract-runtime.mjs"
}
STAMP_VALUE="$(inputs | sha256 | cut -d' ' -f1)"
STAMP="$P/contracts/managed/.light-compile-stamp"
if [[ "${FORCE:-0}" != 1 && -f "$STAMP" && "$(cat "$STAMP")" == "$STAMP_VALUE" && -f "$P/contracts/managed/account/contract/index.js" ]]; then
  echo "compile-contracts: up to date ($STAMP_VALUE)" >&2
  exit 0
fi

compile() { # <compactc> <compact-path> <source> <target>
  local t0=$SECONDS
  rm -rf "$4"
  COMPACT_PATH="$2" "$1" --skip-zk --feature-zkir-v3 --compact-path "$2" "$3" "$4"
  echo "compile-contracts: $(basename "$4") ($("$1" --version | cut -d' ' -f1)) in $((SECONDS - t0)) s" >&2
}

# The vault package imports @sig-net/midnight through ../node_modules (upstream
# src/signet-sdk.ts); the link makes that path resolve to the root install. Git-ignored upstream.
ln -sfn "$NM" "$V/node_modules"

mkdir -p "$V/managed" "$P/contracts/managed"
compile "$CALLEE_CC" "$NM" "$V/src/vendor/signet-contract.compact" "$V/managed/SignetSigner"
compile "$CALLEE_CC" "$NM" "$SIG/src/circuits.compact" "$V/managed/SignetCircuits"
compile "$CALLEE_CC" "$NM:$V/managed" "$V/src/erc20-vault.compact" "$V/managed/Erc20Vault"

# upstream scripts/link-callees.sh: a real directory whose children are links
for name in Erc20Vault SignetSigner; do
  rm -rf "$P/contracts/managed/$name"
  mkdir -p "$P/contracts/managed/$name"
  for child in "$V/managed/$name"/*; do ln -s "$child" "$P/contracts/managed/$name/$(basename "$child")"; done
done
compile "$ACCOUNT_CC" "$NM:$P/contracts/managed" "$P/contracts/account.compact" "$P/contracts/managed/account"
"$JS_RUN" "$ROOT/scripts/pin-contract-runtime.mjs" "$P/contracts/managed/account"

for d in "$V/managed/SignetSigner" "$V/managed/SignetCircuits" "$V/managed/Erc20Vault" "$P/contracts/managed/account"; do
  [[ -f "$d/contract/index.js" && -f "$d/contract/index.d.ts" ]] || {
    echo "compile-contracts: $d/contract/index.{js,d.ts} missing" >&2
    exit 70
  }
  if find "$d" -name '*.prover' | grep -q .; then
    echo "compile-contracts: $d holds prover keys; this script must never produce keys" >&2
    exit 70
  fi
done
echo "$STAMP_VALUE" >"$STAMP"
echo "compile-contracts: done ($STAMP_VALUE)" >&2
