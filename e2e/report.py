#!/usr/bin/env python3
"""AA 00057 P3: one run's evidence table, from the files the journey wrote to $OUT (public values only).

  python3 e2e/report.py <OUT>   ->  <OUT>/report.json and <OUT>/report.md

The oracle table per checkpoint (expected and observed, every surface exact or not), the time of every
step (SC-002: Bridge in, lock to delivered; SC-003: the RPC after a change), the wallet prompts (SC-005),
the negatives (SC-004, SC-006), the stack's memory peak and the teardown check.
"""
import json
import os
import sys

out = sys.argv[1]


def load(name, default=None):
    p = os.path.join(out, name)
    if not os.path.exists(p):
        return default
    with open(p) as f:
        return json.load(f)


def lines(name):
    p = os.path.join(out, name)
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return [json.loads(l) for l in f if l.strip()]


journey = (load("journey.json") or {}).get("steps", {})
landing = (load("landing.json") or {}).get("steps", {})
flows = load("market-flows-make-take.json") or {}
memory = load("memory.json")
health = load("health.json")
down = load("down-check.json")

# ── timings ──
marks = {}
for m in lines("timings.jsonl"):
    marks.setdefault(m["what"], {})[m["event"]] = m["t"]
durations = {k: v["end"] - v["start"] for k, v in marks.items() if "start" in v and "end" in v}

bi_ii = landing.get("bridge-in:ii") or {}
bi_b = landing.get("bridge-in:prefund-b") or {}
inject = landing.get("inject") or {}
out_a = landing.get("out:a") or {}
timings = {
    "stepSeconds": durations,
    "SC-002 bridge in, II (A, 500 X): lock sent -> in the account (page decode), s": bi_ii.get("completedSeconds"),
    "SC-002 bridge in, pre-funding (B, 50 Y), s": bi_b.get("completedSeconds"),
    "III registration synced, s": inject.get("syncedSeconds"),
    "III RPC = page, s": inject.get("matchSeconds"),
    "V tx1 (account -> landing key), s": (out_a.get("tx1") or {}).get("seconds"),
    "V lock (landing key -> bridge), s": (out_a.get("lock") or {}).get("seconds"),
    "V release arrived on Solana after the lock, s": (out_a.get("arrival") or {}).get("seconds"),
    "IV make, s": (flows.get("make") or {}).get("seconds") if isinstance(flows.get("make"), dict) else None,
    "IV take, s": (flows.get("take") or {}).get("seconds") if isinstance(flows.get("take"), dict) else None,
}
sc003 = {}
for cp in ("III", "IV", "V", "after-negatives"):
    o = journey.get(f"oracle:{cp}") or {}
    s = (o.get("secondsToExact") or {})
    sc003[cp] = {"rpcA.midnight": s.get("rpcA.midnight"), "rpcA.spl": s.get("rpcA.spl")}
timings["SC-003 RPC exact after the step ended, s (oracle)"] = sc003

# ── the oracle ──
oracle_rows = []
for cp in ("start", "II", "III", "IV", "V", "after-negatives"):
    o = journey.get(f"oracle:{cp}")
    if not o:
        oracle_rows.append({"checkpoint": cp, "ran": False})
        continue
    oracle_rows.append({
        "checkpoint": cp,
        "ran": True,
        "exact": o.get("exact"),
        "observed": o.get("table"),
        "expected": o.get("expectedTable"),
        "surfaces": {s["surface"]: s["exact"] for s in o.get("surfaces", [])},
        "unregisteredIdentity": None if o.get("unregisteredIdentity") is None else all(i.get("ok") for i in o["unregisteredIdentity"]),
        "realSplUntouched": o.get("realSplUntouched"),
    })

# ── negatives ──
nr = journey.get("neg-registration") or {}
un = journey.get("unregistered") or {}
nu = journey.get("neg-undeliverable") or {}
neg_relay = landing.get("negRelay") or {}
neg_f = landing.get("out:f") or {}
negatives = {
    "SC-004 forged registration": nr.get("forged"),
    "SC-004 registration for another key's account": nr.get("otherKeysAccount"),
    "SC-004 lock to a non-account": {
        "precheckRefused": (nu.get("precheck") or {}).get("refused"),
        "status": (nu.get("view") or {}).get("status"),
        "code": ((nu.get("view") or {}).get("reason") or {}).get("code"),
        "delivery": (nu.get("view") or {}).get("delivery"),
        "bridgeActionsBefore": (nu.get("before") or {}).get("xBridgeActions"),
        "bridgeActionsAfter": (nu.get("after") or {}).get("xBridgeActions"),
        "decidedSeconds": nu.get("decidedSeconds"),
        "pageSawUndeliverable": nu.get("pageSawUndeliverable"),
        "pageTimeline": nu.get("timeline"),
    } if nu else None,
    "SC-004 tampered landing-key recipient": {
        "status": neg_relay.get("status"), "code": neg_relay.get("code"),
        "authNonceUnchanged": neg_relay.get("authNonceBefore") == neg_relay.get("authNonceAfter") if neg_relay else None,
    } if neg_relay else None,
    "SC-004 non-deterministic signer": {"refusal": neg_f.get("refusal"), "walletAsked": neg_f.get("walletAsked")} if neg_f else None,
    "SC-006 unregistered byte-identical": {k: all(r.get("ok") for r in v) for k, v in (un.get("results") or {}).items()} or None,
}

prompts = journey.get("prompts")
errors = {k: v for k, v in {**journey, **landing}.items() if k.endswith(":error")}
verdict = {
    "oracleExactEverywhere": all(r.get("ran") and r.get("exact") for r in oracle_rows),
    "negativesAllRan": all(v is not None for v in negatives.values()),
    "sc005": None if not prompts else {"A": prompts["A"]["journeyTotal"], "perStep": prompts["A"]["perStep"],
                                        "withinLimit": prompts["A"]["withinLimit"], "matchesExpected": prompts["A"]["matchesExpected"]},
    "memoryPeakGiB": memory and memory.get("peakGiB"),
    "upSeconds": health and health.get("seconds"),
    "downClean": down is not None and all(down.get(k) == 0 for k in ("containers", "volumes", "validatorProcesses", "runDirLeft", "injectorImageLeft", "lockHeldBy00057")),
    "errors": errors,
}
verdict["pass"] = bool(verdict["oracleExactEverywhere"] and verdict["negativesAllRan"] and verdict["sc005"]
                       and verdict["sc005"]["withinLimit"] and verdict["sc005"]["matchesExpected"] and not errors)
report = {"verdict": verdict, "oracle": oracle_rows, "timings": timings, "negatives": negatives, "prompts": prompts,
          "memory": memory, "health": health, "down": down}
with open(os.path.join(out, "report.json"), "w") as f:
    json.dump(report, f, indent=1)

md = [f"# Journey run: {'PASS' if verdict['pass'] else 'NOT PASS'}", ""]
md += ["| After | exact | Wallet A Solana | Account A on Midnight | Wallet A through RPC | Account B on Midnight | Vaults |", "|---|---|---|---|---|---|---|"]
for r in oracle_rows:
    if not r.get("ran"):
        md.append(f"| {r['checkpoint']} | not run | | | | | |")
        continue
    o, e = r["observed"] or {}, r["expected"] or {}
    cell = lambda k: o.get(k, "?") if o.get(k) == e.get(k) else f"{o.get(k, '?')} (expected {e.get(k, '?')})"
    md.append(f"| {r['checkpoint']} | {'EXACT' if r['exact'] else 'NO'} | {cell('walletASolana')} | {cell('accountA')} | {cell('walletAThroughRpc')} | {cell('accountB')} | {o.get('vaults', '')} |")
md += ["", "## Timings (s)", ""]
for k, v in timings.items():
    md.append(f"- {k}: {json.dumps(v)}")
md += ["", "## Prompts (SC-005)", "", json.dumps(verdict["sc005"]), "", "## Negatives", ""]
for k, v in negatives.items():
    md.append(f"- {k}: {json.dumps(v)}")
md += ["", f"Memory peak: {verdict['memoryPeakGiB']} GiB; up in {verdict['upSeconds']} s; down clean: {verdict['downClean']}", ""]
if errors:
    md += ["## Errors", ""] + [f"- {k}: {str(v)[:400]}" for k, v in errors.items()]
with open(os.path.join(out, "report.md"), "w") as f:
    f.write("\n".join(md) + "\n")
print("\n".join(md))
