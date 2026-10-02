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

# 6-9. AA 00047 P11, audit round 3 R3-10 (F-B3-8, F-A3-6.2): an override must resolve to the verified
#      `compactc` executable itself, and that file is what runs. Before, the override's DIRECTORY was
#      verified and then the override's own path was run.
case "$VERSION" in
  0.35.0) line='0.35.0 (debb05f94 2026-09-29)' var_name=COMPACTC_ACCOUNT ;;
  *) line="$VERSION" var_name=COMPACTC_CALLEES ;;
esac
# 6. Another executable inside an otherwise verified directory, printing the pinned version line.
copy impostor
marker="$work/impostor-ran"
printf '#!/bin/sh\ntouch "%s"\necho "%s"\n' "$marker" "$line" >"$work/impostor/evil-compactc"
chmod +x "$work/impostor/evil-compactc"
set +e
env "$var_name=$work/impostor/evil-compactc" bash "$ROOT/scripts/compile-contracts.sh" >/dev/null 2>"$work/err"
code=$?
set -e
if [[ "$code" -eq 65 ]] && grep -q "not a verified compactc $VERSION toolchain" "$work/err" && [[ ! -e "$marker" ]]; then
  ok "$var_name naming another executable in a verified toolchain is refused, and never run"
else
  ko "$var_name naming another executable in a verified toolchain is refused, and never run (exit $code, ran: $([[ -e "$marker" ]] && echo yes || echo no))"
fi
# 7. --resolve: a verified toolchain's compactc resolves to itself; a symbolic link to it (from an
#    unverified directory) resolves to the verified file.
copy resolve-ok
mkdir -p "$work/bin"
ln -sfn "$work/resolve-ok/compactc" "$work/bin/compactc"
ln -sfn "$work/resolve-ok/compactc" "$work/bin/my-compiler"
real_ok="$(cd -P "$work/resolve-ok" && pwd -P)/compactc"
if [[ "$(bash "$F" --resolve "$work/resolve-ok/compactc" "$VERSION" 2>/dev/null)" == "$real_ok" ]] &&
  [[ "$(bash "$F" --resolve "$work/bin/compactc" "$VERSION" 2>/dev/null)" == "$real_ok" ]] &&
  [[ "$(bash "$F" --resolve "$work/bin/my-compiler" "$VERSION" 2>/dev/null)" == "$real_ok" ]]; then
  ok "--resolve gives the verified compactc itself (also through a symbolic link)"
else
  ko "--resolve gives the verified compactc itself (also through a symbolic link)"
fi
# 8. --resolve refuses an archive file that is not compactc, a link to an impostor, and a missing path.
chmod +x "$work/resolve-ok/zkir" 2>/dev/null || true
ln -sfn "$work/impostor/evil-compactc" "$work/bin/compactc-evil-link"
set +e
bash "$F" --resolve "$work/resolve-ok/zkir" "$VERSION" >/dev/null 2>&1
c1=$?
bash "$F" --resolve "$work/bin/compactc-evil-link" "$VERSION" >/dev/null 2>&1
c2=$?
bash "$F" --resolve "$work/does-not-exist/compactc" "$VERSION" >/dev/null 2>&1
c3=$?
set -e
[[ "$c1$c2$c3" == 656565 ]] && ok "--resolve refuses a non-compactc file, a link to an impostor and a missing path (exit 65)" ||
  ko "--resolve refuses a non-compactc file, a link to an impostor and a missing path (exits $c1 $c2 $c3)"
# 9. A compactc whose directory is NOT verified (a changed sibling) is refused by --resolve too.
copy resolve-bad
printf 'x' >>"$work/resolve-bad/zkir"
set +e
bash "$F" --resolve "$work/resolve-bad/compactc" "$VERSION" >/dev/null 2>&1
c4=$?
set -e
[[ "$c4" -eq 65 ]] && ok "--resolve refuses a compactc in a changed toolchain (exit 65)" ||
  ko "--resolve refuses a compactc in a changed toolchain (exit $c4)"
# 10. An override through a symbolic link to a verified toolchain is accepted by compile-contracts
#     (which then runs the verified file; the light compile is up to date or is redone with it).
set +e
env "$var_name=$work/bin/compactc" bash "$ROOT/scripts/compile-contracts.sh" >/dev/null 2>"$work/err"
code=$?
set -e
[[ "$code" -eq 0 ]] && ok "$var_name through a link to a verified toolchain is accepted" ||
  ko "$var_name through a link to a verified toolchain is accepted (exit $code: $(tail -1 "$work/err"))"

echo "test-fetch-compactc $VERSION: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
