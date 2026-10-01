#!/usr/bin/env bash
# Tests for scripts/fetch-compactc.sh's re-verification (AA 00047 P10, audit round 2 R2-9 / F-A2-7.2):
# a cached install is never trusted by its `.archive-sha256` stamp and `--version` alone, and a
# compiler named by COMPACTC_ACCOUNT must sit in a verified toolchain directory.
#
#   scripts/test-fetch-compactc.sh [version]     default 0.35.0; exit 0 = every case passed
#
# It works on copies of a real verified install (the repository's .tools cache, installed or
# re-verified first: COMPACTC_ZIP_<version> or a download), in a temporary directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
F="$ROOT/scripts/fetch-compactc.sh"
VERSION="${1:-0.35.0}"
work="$(mktemp -d)"
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
member_sha() {
  if command -v unzip >/dev/null; then
    unzip -p "$1" "$2" | { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; } | cut -d' ' -f1
  else
    python3 -c 'import sys,zipfile,hashlib; print(hashlib.sha256(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2])).hexdigest())' "$1" "$2"
  fi
}

pass=0
fail=0
ok() {
  echo "PASS $1"
  pass=$((pass + 1))
}
ko() {
  echo "FAIL $1"
  fail=$((fail + 1))
}

# 0. A verified install to copy from.
src="$(bash "$F" "$VERSION")"
srcdir="$(dirname "$src")"
copy() {
  rm -rf "$work/$1"
  cp -R "$srcdir" "$work/$1"
  chmod -R u+w "$work/$1"
}

# 1. An intact cached install is served as it is.
copy intact
out="$(COMPACTC_DIR="$work/intact" bash "$F" "$VERSION" 2>"$work/err")" && [[ "$out" == "$work/intact/compactc" ]] &&
  ok "an intact cached install is re-verified and served" || ko "an intact cached install is re-verified and served"

# 2. A changed binary with an intact stamp is NOT trusted: it is reinstalled from the kept archive.
copy tampered
printf 'x' >>"$work/tampered/compactc.bin"
if out="$(COMPACTC_DIR="$work/tampered" bash "$F" "$VERSION" 2>"$work/err")" &&
  grep -q 'failed verification' "$work/err" && [[ -f "$work/tampered/artifact.zip" ]] &&
  [[ "$(sha "$work/tampered/compactc.bin")" == "$(member_sha "$work/tampered/artifact.zip" compactc.bin)" ]]; then
  ok "a changed binary under a valid stamp is caught and restored from the kept archive"
else
  ko "a changed binary under a valid stamp is caught and restored from the kept archive"
fi

# 3. A cached install whose archive is gone (stamp and version line still right) is not trusted, and
#    with no archive to reinstall from, the fetch fails.
copy noarchive
rm -f "$work/noarchive/artifact.zip"
printf 'x' >>"$work/noarchive/zkir"
var="COMPACTC_ZIP_${VERSION//./_}"
if env "$var=$work/does-not-exist.zip" COMPACTC_DIR="$work/noarchive" bash "$F" "$VERSION" >/dev/null 2>"$work/err"; then
  ko "a stamp without its archive is not trusted"
else
  ok "a stamp without its archive is not trusted"
fi

# 4. --verify: a verified directory passes; one with any file changed is refused (exit 65).
copy verify-ok
copy verify-bad
printf 'x' >>"$work/verify-bad/compactc"
bash "$F" --verify "$work/verify-ok" "$VERSION" 2>/dev/null && ok "--verify accepts a verified toolchain" ||
  ko "--verify accepts a verified toolchain"
set +e
bash "$F" --verify "$work/verify-bad" "$VERSION" 2>/dev/null
code=$?
set -e
[[ "$code" -eq 65 ]] && ok "--verify refuses a changed toolchain (exit 65)" || ko "--verify refuses a changed toolchain (exit $code)"

# 5. compile-contracts refuses a COMPACTC_ACCOUNT override that is not a verified toolchain, even when
#    its version line is right (only for the account's compiler, 0.35.0).
if [[ "$VERSION" == 0.35.0 ]]; then
  copy override
  printf 'x' >>"$work/override/compactc.bin"
  set +e
  COMPACTC_ACCOUNT="$work/override/compactc" bash "$ROOT/scripts/compile-contracts.sh" >/dev/null 2>"$work/err"
  code=$?
  set -e
  [[ "$code" -eq 65 ]] && grep -q 'not a verified compactc 0.35.0 toolchain' "$work/err" &&
    ok "COMPACTC_ACCOUNT must be a verified toolchain" || ko "COMPACTC_ACCOUNT must be a verified toolchain (exit $code)"
fi

echo "test-fetch-compactc $VERSION: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
