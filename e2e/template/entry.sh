#!/usr/bin/env bash
# e00050 S4 — in-container entry for the `ci` service.
#
# 1. Sync: copy the files run.sh listed (git ls-files: tracked + untracked-not-ignored, from the
#    host checkout mounted read-only at /src) into /work/repo, and delete files that were synced
#    before but are gone now. Ignored paths in /work/repo (node_modules, downloaded binaries,
#    compiled contracts, logs) are left alone, so later runs reuse them. The host tree is never
#    written.
# 2. Install: `bun install` at the repo root (+ patch.sh), as .github/Dockerfile does.
# 3. exec "$@".
#
# S4_SKIP_SYNC=1 / S4_SKIP_INSTALL=1 skip steps 1 / 2.
set -euo pipefail
export LC_ALL=C

SRC=/src
DST=/work/repo
LIST="${S4_LIST:-/harness/.state/files.lst}"
MANIFEST=/work/.s4-manifest

mkdir -p "$DST"

if [ "${S4_SKIP_SYNC:-0}" != "1" ]; then
  if [ ! -s "$LIST" ]; then
    echo "[s4] missing $LIST — start containers through run.sh" >&2
    exit 2
  fi
  t0=$(date +%s)
  rsync -a --from0 --files-from="$LIST" "$SRC"/ "$DST"/
  removed=0
  if [ -f "$MANIFEST" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      rm -f -- "$DST/$f"
      removed=$((removed + 1))
    done < <(comm -23 <(tr '\0' '\n' <"$MANIFEST" | sort -u) <(tr '\0' '\n' <"$LIST" | sort -u))
  fi
  cp "$LIST" "$MANIFEST"
  echo "[s4] synced $(tr -cd '\0' <"$LIST" | wc -c) files from $SRC (removed $removed stale) in $(($(date +%s) - t0))s"
fi

cd "$DST"

if [ "${S4_SKIP_INSTALL:-0}" != "1" ]; then
  t0=$(date +%s)
  bun install
  bash ./patch.sh
  echo "[s4] root bun install in $(($(date +%s) - t0))s"
fi

echo "[s4] $(uname -m) bun $(bun --version) node $(node --version) — exec: $*"
exec "$@"
