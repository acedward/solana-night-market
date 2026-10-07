#!/usr/bin/env bash
# Reproducible build of Night Market's client-proof verifier WASM (AA 00062 task P3.5).
#
#   relay/verifier/build.sh           build, then write relay/src/client-proving/verifier-wasm/
#   relay/verifier/build.sh --check   build, then compare with the committed files (exit 1 if they differ)
#
# Pinned: the Rust toolchain (rust-toolchain.toml, 1.95.0 with wasm32-unknown-unknown), every crate
# (Cargo.lock, --locked: midnight-ledger tag ledger-9.1.0.0-rc.3, midnight-zkir tag zkir-3.1.0-rc.1,
# wasm-bindgen 0.2.104), wasm-pack 0.14.0 and the wasm-opt it runs (binaryen version_117). Local
# paths are remapped out of the binary, so the build directory does not change the bytes.
#
# The relay pins the WASM's SHA-256 in relay/src/client-proving/verifier.ts
# (CLIENT_PROOF_VERIFIER_WASM_SHA256) and refuses CLIENT_PROVING=required when the file differs.
# After a rebuild that changes the bytes, update that constant (the relay's tests check it against
# SHA256SUMS).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$REPO/relay/src/client-proving/verifier-wasm"
NAME=client_proof_verifier
WASM_PACK_VERSION=0.14.0
WASM_OPT_VERSION='version_117'
RUST_VERSION=1.95.0

mode=build
case "${1:-}" in
  '') ;;
  --check) mode=check ;;
  *) echo "usage: $0 [--check]" >&2; exit 64 ;;
esac

die() { echo "build.sh: $*" >&2; exit 1; }

cd "$HERE"
rustc_v="$(rustc --version)"
[[ "$rustc_v" == "rustc $RUST_VERSION "* ]] || die "rustc is '$rustc_v', expected $RUST_VERSION (rust-toolchain.toml; run: rustup toolchain install $RUST_VERSION --target wasm32-unknown-unknown)"
rustup target list --installed | grep -qx wasm32-unknown-unknown || die "the wasm32-unknown-unknown target is missing (rustup target add wasm32-unknown-unknown --toolchain $RUST_VERSION)"
wp_v="$(wasm-pack --version)"
[[ "$wp_v" == "wasm-pack $WASM_PACK_VERSION" ]] || die "wasm-pack is '$wp_v', expected $WASM_PACK_VERSION (cargo install wasm-pack --version $WASM_PACK_VERSION --locked)"

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${TMPDIR:-/tmp}/nightmarket-client-proof-verifier-target}"
mkdir -p "$CARGO_TARGET_DIR"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
# Keep local paths (panic locations) out of the binary. The standard library's sources map to
# `/rustc/<commit>`, the path its prebuilt parts already carry, whether or not rust-src is installed.
SYSROOT="$(rustc --print sysroot)"
RUSTC_COMMIT="$(rustc -vV | sed -n 's/^commit-hash: //p')"
[[ -n "$RUSTC_COMMIT" ]] || die "rustc -vV reports no commit hash"
export RUSTFLAGS="--remap-path-prefix=$SYSROOT/lib/rustlib/src/rust=/rustc/$RUSTC_COMMIT --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$HERE=/verifier --remap-path-prefix=$(cd "$CARGO_TARGET_DIR" && pwd -P)=/target --remap-path-prefix=$CARGO_TARGET_DIR=/target"
export SOURCE_DATE_EPOCH=0
unset CARGO_BUILD_RUSTFLAGS CARGO_ENCODED_RUSTFLAGS

stage="$(mktemp -d "${TMPDIR:-/tmp}/nightmarket-client-proof-verifier.XXXXXX")"
trap 'rm -rf "$stage"' EXIT

# --locked: the build fails rather than re-resolve Cargo.lock.
wasm-pack --log-level warn build "$HERE" --release --target web --no-pack \
  --out-dir "$stage/pkg" --out-name "$NAME" -- --locked >&2

# The wasm-opt wasm-pack ran (it downloads a pinned binaryen into its cache).
opt_bin="$(find "$HOME/Library/Caches/.wasm-pack" "$HOME/.cache/.wasm-pack" -name wasm-opt -type f 2>/dev/null | head -1 || true)"
opt_v="$([[ -n "$opt_bin" ]] && "$opt_bin" --version 2>/dev/null || true)"
[[ "$opt_v" == *"$WASM_OPT_VERSION"* ]] || echo "build.sh: warning: wasm-opt reports '$opt_v', expected $WASM_OPT_VERSION" >&2

files=("${NAME}_bg.wasm" "${NAME}.js" "${NAME}.d.ts" "${NAME}_bg.wasm.d.ts")
for f in "${files[@]}"; do [[ -f "$stage/pkg/$f" ]] || die "wasm-pack did not write $f"; done
(cd "$stage/pkg" && shasum -a 256 "${files[@]}") >"$stage/SHA256SUMS"

if [[ "$mode" == check ]]; then
  if (cd "$OUT" && shasum -a 256 -c "$stage/SHA256SUMS" >/dev/null 2>&1) && cmp -s "$stage/SHA256SUMS" "$OUT/SHA256SUMS"; then
    echo "reproducible: the rebuild equals the committed files"
    cat "$stage/SHA256SUMS"
    exit 0
  fi
  echo "NOT reproducible: the rebuild differs from the committed files" >&2
  echo "rebuilt:" >&2; cat "$stage/SHA256SUMS" >&2
  echo "committed:" >&2; cat "$OUT/SHA256SUMS" >&2
  exit 1
fi

mkdir -p "$OUT"
for f in "${files[@]}"; do cp "$stage/pkg/$f" "$OUT/$f"; done
cp "$stage/SHA256SUMS" "$OUT/SHA256SUMS"
echo "wrote $OUT"
cat "$OUT/SHA256SUMS"
echo "wasm bytes: $(wc -c <"$OUT/${NAME}_bg.wasm" | tr -d ' ')"
