#!/usr/bin/env bash
# Install a pinned Compact compiler into .tools/compactc-<version>/.
#
#   scripts/fetch-compactc.sh 0.35.0    the Passport account (the Ed25519 arm needs 0.35.0's
#                                       `ed25519Verify`, `sha512` and Curve25519; --feature-zkir-v3)
#   scripts/fetch-compactc.sh 0.34.0    the account's declared callees only (the ERC20 vault and the
#                                       Signet singleton stay on 0.34.0, as upstream builds them)
#
#   scripts/fetch-compactc.sh --verify <dir> <version>
#                                       verify an installed toolchain directory: exit 0, or 65 refused
#
#   scripts/fetch-compactc.sh --resolve <path> <version>
#                                       resolve a compiler override (COMPACTC_ACCOUNT /
#                                       COMPACTC_CALLEES) to the VERIFIED executable itself: <path>,
#                                       with every symbolic link followed, must be the `compactc` of a
#                                       toolchain directory --verify accepts. Prints that
#                                       `<dir>/compactc` on stdout (run exactly it), or exits 65. AA 00047
#                                       P11, audit round 3 R3-10 / F-B3-8, F-A3-6.2: an override used to
#                                       be verified by its directory and then run by its own path, so
#                                       another executable in a verified directory passed.
#
# The release archive is verified against the SHA-256 pinned below before it is unpacked, and the
# unpacked compiler's `--version` line must be the pinned one. The compactc-v0.35.0 release
# publishes no checksum file: its digests are GitHub's per-asset sha256 values, each re-checked
# against a download (AA 00047 spike 3, evidence/00047-mn-bank-solana/p0-pins.json).
# Pass COMPACTC_ZIP_<version with underscores>=<path> (e.g. COMPACTC_ZIP_0_35_0) to use an
# archive you already have (it is verified the same way); otherwise the archive for this platform
# is downloaded from the pinned release. COMPACTC_DIR overrides the install directory.
#
# A cached install is RE-VERIFIED on every run, never trusted by a stamp (AA 00047 P10, audit round 2
# R2-9 / F-A2-7.2, the round-1 F-A7.2 pattern): the verified archive is kept beside the binaries
# (`artifact.zip`, as the `compact` CLI and the passport's verify-compactc.sh keep it), its SHA-256
# must be the pin, and EVERY file of the archive must be byte-identical on disk. A cached install
# that fails is reinstalled from its kept archive when that archive is still the pinned one, and
# downloaded again otherwise; an install that still fails is refused (exit 65).
#
# Prints the compactc path on stdout (everything else goes to stderr).
set -euo pipefail

MODE=install
if [[ "${1:-}" == "--verify" ]]; then
  MODE=verify
  VERIFY_DIR="${2:?usage: fetch-compactc.sh --verify <dir> <version>}"
  shift 2
elif [[ "${1:-}" == "--resolve" ]]; then
  MODE=resolve
  RESOLVE_PATH="${2:?usage: fetch-compactc.sh --resolve <path> <version>}"
  shift 2
fi
VERSION="${1:-0.35.0}"
BASE_URL="https://github.com/LFDT-Minokawa/compact/releases/download/compactc-v${VERSION}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${COMPACTC_DIR:-$ROOT/.tools/compactc-$VERSION}"
PLATFORM="$(uname -s)-$(uname -m)"

case "$VERSION" in
  0.34.0)
    # compactc-v0.34.0: language 0.26.0, runtime 0.19.0.
    VERSION_LINE="0.34.0"
    case "$PLATFORM" in
      Linux-x86_64) ASSET="compactc_v${VERSION}_x86_64-unknown-linux-musl.zip"
        SHA=775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584 ;;
      Linux-aarch64 | Linux-arm64) ASSET="compactc_v${VERSION}_aarch64-unknown-linux-musl.zip"
        SHA=d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d ;;
      Darwin-arm64) ASSET="compactc_v${VERSION}_aarch64-darwin.zip"
        SHA=ce458c4062f1a1dd2920591a0bb5ab657be02f4ab8422f2d76988773f60103c3 ;;
      *) ASSET="" ;;
    esac
    ;;
  0.35.0)
    # compactc-v0.35.0 @ debb05f9414b9d1e176741c2be289bb32233f0fc (2026-09-29): language 0.27.0,
    # runtime 0.20.0, bundled zkir-v3 = midnight-zkir 3.1.0-rc.1.
    VERSION_LINE="0.35.0 (debb05f94 2026-09-29)"
    case "$PLATFORM" in
      Linux-x86_64) ASSET="compactc_v${VERSION}_x86_64-unknown-linux-musl.zip"
        SHA=70f22fb8209cc5a8504b2b3d91796cfdab2d71d88807ceef12fab87fed03bae2 ;;
      Linux-aarch64 | Linux-arm64) ASSET="compactc_v${VERSION}_aarch64-unknown-linux-musl.zip"
        SHA=3f74ec6fc98ccca7365c5c915f6015d8893db4527faafe04a90bc36effc40a3a ;;
      Darwin-arm64) ASSET="compactc_v${VERSION}_aarch64-darwin.zip"
        SHA=5898b3d916b2b26f2c110b55a4a4121c22c88eefbd076994e8c3dd3e56c571fc ;;
      Darwin-x86_64) ASSET="compactc_v${VERSION}_x86_64-darwin.zip"
        SHA=adfd3738965d758897d8038b86a5c32e5bd20fb437fc0f1cbc01c8d816b0e212 ;;
      *) ASSET="" ;;
    esac
    ;;
  *)
    echo "fetch-compactc: no pinned compactc $VERSION (pinned: 0.34.0, 0.35.0)" >&2
    exit 64
    ;;
esac
if [[ -z "$ASSET" ]]; then
  echo "fetch-compactc: no pinned compactc $VERSION archive for $PLATFORM" >&2
  exit 64
fi

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
sha256_stdin() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
# The archive's files (not its directories), and one file's SHA-256 inside it.
zip_files() {
  if command -v unzip >/dev/null; then
    unzip -Z1 "$1" | grep -v '/$' || true
  else
    python3 -c 'import sys,zipfile; [print(n) for n in zipfile.ZipFile(sys.argv[1]).namelist() if not n.endswith("/")]' "$1"
  fi
}
zip_file_sha() {
  if command -v unzip >/dev/null; then
    unzip -p "$1" "$2" | sha256_stdin
  else
    python3 -c 'import sys,zipfile,hashlib; print(hashlib.sha256(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2])).hexdigest())' "$1" "$2"
  fi
}

# verify_dir <dir>: 0 when <dir> holds the pinned archive and every one of its files unchanged, and
# its compactc prints the pinned version line; otherwise 1, saying why on stderr.
verify_dir() {
  local dir="$1" zip="$1/artifact.zip" got n=0 f
  if [[ ! -f "$zip" ]]; then
    echo "fetch-compactc: $dir has no verified archive (artifact.zip) to check its binaries against" >&2
    return 1
  fi
  got="$(sha256 "$zip")"
  if [[ "$got" != "$SHA" ]]; then
    echo "fetch-compactc: $zip sha256 $got, expected $SHA ($PLATFORM)" >&2
    return 1
  fi
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    n=$((n + 1))
    if [[ ! -f "$dir/$f" ]] || [[ "$(sha256 "$dir/$f")" != "$(zip_file_sha "$zip" "$f")" ]]; then
      echo "fetch-compactc: $dir/$f is missing or differs from the verified archive's copy" >&2
      return 1
    fi
  done < <(zip_files "$zip")
  if [[ "$n" -eq 0 ]]; then
    echo "fetch-compactc: $zip lists no files" >&2
    return 1
  fi
  if [[ "$("$dir/compactc" --version 2>/dev/null)" != "$VERSION_LINE" ]]; then
    echo "fetch-compactc: $dir/compactc --version is not '$VERSION_LINE'" >&2
    return 1
  fi
}

# real_path <path>: <path> with every symbolic link followed (the link's own directory for a
# relative target), as an absolute physical path; fails when it does not exist or links loop.
real_path() {
  local p="$1" t n=0 d
  while [[ -L "$p" ]]; do
    n=$((n + 1))
    [[ "$n" -le 40 ]] || return 1
    t="$(readlink "$p")" || return 1
    if [[ "$t" == /* ]]; then p="$t"; else p="$(dirname "$p")/$t"; fi
  done
  [[ -f "$p" ]] || return 1
  d="$(cd -P "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$d" "$(basename "$p")"
}

if [[ "$MODE" == resolve ]]; then
  if ! real="$(real_path "$RESOLVE_PATH")"; then
    echo "fetch-compactc: the compiler override $RESOLVE_PATH does not exist (or its links loop)" >&2
    exit 65
  fi
  if [[ "$(basename "$real")" != compactc ]]; then
    echo "fetch-compactc: the compiler override $RESOLVE_PATH is $real, not a toolchain's compactc" >&2
    exit 65
  fi
  dir="$(dirname "$real")"
  if ! verify_dir "$dir" || [[ ! "$real" -ef "$dir/compactc" ]]; then
    echo "fetch-compactc: the compiler override $RESOLVE_PATH ($real) is not in a verified compactc $VERSION toolchain" >&2
    exit 65
  fi
  echo "fetch-compactc: compactc $VERSION override $RESOLVE_PATH resolved to the verified $dir/compactc" >&2
  echo "$dir/compactc"
  exit 0
fi

if [[ "$MODE" == verify ]]; then
  if verify_dir "$VERIFY_DIR"; then
    echo "fetch-compactc: compactc $VERSION in $VERIFY_DIR verified ($SHA; every file of the archive matches)" >&2
    exit 0
  fi
  echo "fetch-compactc: compactc $VERSION in $VERIFY_DIR refused" >&2
  exit 65
fi

# A cached install is re-verified, never trusted by its stamp.
if [[ -d "$DEST" ]]; then
  if verify_dir "$DEST"; then
    echo "$DEST/compactc"
    exit 0
  fi
  echo "fetch-compactc: the cached compactc $VERSION in $DEST failed verification; reinstalling" >&2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/$ASSET"
local_zip_var="COMPACTC_ZIP_${VERSION//./_}"
if [[ -n "${!local_zip_var:-}" ]]; then
  cp "${!local_zip_var}" "$zip"
elif [[ -f "$DEST/artifact.zip" ]] && [[ "$(sha256 "$DEST/artifact.zip")" == "$SHA" ]]; then
  # The kept archive is still the pinned one: reinstall from it (only a binary was changed).
  cp "$DEST/artifact.zip" "$zip"
else
  echo "fetch-compactc: downloading $ASSET" >&2
  curl -fsSL --retry 3 -o "$zip" "$BASE_URL/$ASSET"
fi
got="$(sha256 "$zip")"
if [[ "$got" != "$SHA" ]]; then
  echo "fetch-compactc: SHA-256 mismatch for $ASSET: expected $SHA, got $got" >&2
  exit 65
fi
rm -rf "$DEST"
mkdir -p "$DEST"
if command -v unzip >/dev/null; then
  unzip -o -q "$zip" -d "$DEST"
else
  python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$zip" "$DEST"
fi
chmod +x "$DEST"/compactc "$DEST"/compactc.bin "$DEST"/zkir "$DEST"/zkir-v3 2>/dev/null || true
# Keep the verified archive beside the binaries: every later run re-verifies them against it.
cp "$zip" "$DEST/artifact.zip"
if ! verify_dir "$DEST"; then
  echo "fetch-compactc: the fresh install of compactc $VERSION in $DEST did not verify" >&2
  exit 65
fi
# The verified archive's SHA-256, for build records (the key-volume job stamps it into its report).
echo "$SHA" >"$DEST/.archive-sha256"
echo "fetch-compactc: compactc $VERSION verified ($SHA) in $DEST" >&2
echo "$DEST/compactc"
