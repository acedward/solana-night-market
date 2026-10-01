#!/usr/bin/env bash
# P9.I (AA 00047) local stack: the key dir test/stack/p6/fund-unshielded.ts proves with. The relay's
# key volume keeps only the prover keys the relay uses (deposit_unshielded is not one of them), and
# midnight-js refuses a prover key its bundle's manifest does not list. So: copy the key volume
# (APFS clones on macOS: no extra disk), add the account's `deposit_unshielded` prover key from a full
# keyed build of the SAME account.compact, and add its manifest entry after checking the file's
# SHA-256 against the full build's own manifest.
#
#   test/stack/p6/fund-keys.sh <relay key volume> <full keyed build (holds account/)> <out dir>
set -euo pipefail
SRC="${1:?relay key volume}" FULL="${2:?full keyed build}" OUT="${3:?out dir}"
CIRCUIT=deposit_unshielded
[[ -f "$SRC/.night-market-keys.json" ]] || { echo "fund-keys: $SRC is not a key volume" >&2; exit 66; }
[[ -f "$FULL/account/keys/$CIRCUIT.prover" ]] || { echo "fund-keys: no $CIRCUIT.prover in $FULL" >&2; exit 66; }
# The same account: every verifier key the volume holds equals the full build's.
for v in "$SRC"/account/keys/*.verifier; do
  cmp -s "$v" "$FULL/account/keys/$(basename "$v")" || { echo "fund-keys: $(basename "$v") differs: another build" >&2; exit 65; }
done
rm -rf "$OUT"
cp -Rc "$SRC" "$OUT" 2>/dev/null || cp -R "$SRC" "$OUT"
cp "$FULL/account/keys/$CIRCUIT.prover" "$OUT/account/keys/"
python3 - "$OUT/account/compiler/contract-manifest.json" "$FULL/account/compiler/contract-manifest.json" \
  "$OUT/account/keys/$CIRCUIT.prover" "$CIRCUIT.prover" <<'EOF'
import hashlib, json, os, sys
out_manifest, full_manifest, prover, name = sys.argv[1:5]
full = json.load(open(full_manifest))
entry = full["keys"][name]
digest = hashlib.sha256(open(prover, "rb").read()).hexdigest()
assert digest == entry["hash"] and os.path.getsize(prover) == entry["size"], (digest, entry)
m = json.load(open(out_manifest))
m["keys"][name] = entry
tmp = out_manifest + ".tmp"
json.dump(m, open(tmp, "w"), indent=2)
os.replace(tmp, out_manifest)
print(f"fund-keys: {name} added ({entry['size']} B, sha256 {digest[:16]}…)")
EOF
