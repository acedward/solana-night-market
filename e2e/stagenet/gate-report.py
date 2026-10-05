#!/usr/bin/env python3
"""AA 00057 P5R.0: the stagenet gate's summary (gate.json) from its evidence directory. Public values only.

    python3 e2e/stagenet/gate-report.py <OUT>

It reads timings.jsonl, snapshots.jsonl, landing.json, market-flows-*.json, deploy-x-midnight-tx.json,
node-tx-fees.jsonl and sync.jsonl, and writes <OUT>/gate.json: the result, step durations, every Midnight
transaction with its paid fee (DUST), the sponsor's settled DUST and the SOL balances per snapshot, and the
bridge node's Solana sync against devnet's tip.
"""
import glob
import json
import os
import sys

SPECK = 10**15  # 1 DUST


def load(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return default


def lines(path):
    out = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except Exception:
                        pass
    except FileNotFoundError:
        pass
    return out


def dust(specks):
    try:
        return round(int(specks) / SPECK, 6)
    except Exception:
        return None


def main(out):
    res = {"result": "PASS" if os.path.exists(f"{out}/result.txt") else "STOPPED"}
    if os.path.exists(f"{out}/stopped.txt"):
        res["stoppedAt"] = open(f"{out}/stopped.txt").read().strip()

    # Step durations from the start/end marks.
    marks = lines(f"{out}/timings.jsonl")
    starts, durations = {}, {}
    for m in marks:
        if m["event"] == "start":
            starts[m["what"]] = m["t"]
        elif m["event"] in ("end", "ready") and m["what"] in starts:
            durations[m["what"]] = m["t"] - starts[m["what"]]
    gate_start = starts.get("gate")
    res["seconds"] = durations
    res["milestones"] = {f'{m["what"]}:{m["event"]}': (m["t"] - gate_start if gate_start else None) for m in marks}

    # Midnight transactions with their paid fees.
    txs = []
    dep = load(f"{out}/deploy-x-midnight-tx.json", {})
    t = ((dep.get("data") or {}).get("contractAction") or {}).get("transaction") if isinstance(dep, dict) else None
    if t:
        txs.append({"step": "deploy", "what": "bridge X contract deploy", "payer": "Temporary 12", "hash": t.get("hash"),
                    "paidDust": dust((t.get("fees") or {}).get("paidFees"))})
    land = (load(f"{out}/landing.json", {}) or {}).get("steps", {})
    for key, v in land.items():
        if key == "out:whole":
            for part in ("tx1", "lock"):
                p = v.get(part) or {}
                txid = p.get("tx1Id") or p.get("tx2Id")
                txs.append({"step": "b", "what": f"Bridge out {part}", "payer": "Temporary 11 (sponsor)", "id": txid,
                            "paidDust": dust((p.get("fees") or {}).get("paidFees"))})
    for f in sorted(glob.glob(f"{out}/market-flows-*.json")):
        body = load(f, {}) or {}
        for name, rec in body.items():
            if not isinstance(rec, dict):
                continue
            for tx in (rec.get("txs") or []) + (rec.get("tx") or []):
                if isinstance(tx, dict) and tx.get("id"):
                    txs.append({"step": os.path.basename(f), "what": name, "id": tx.get("id"), "hash": tx.get("hash"),
                                "status": tx.get("status"), "paidDust": dust(tx.get("paidFeesSpecks"))})
    for row in lines(f"{out}/node-tx-fees.jsonl"):
        txs.append({"step": "a/c", "what": "bridge node X delivery (composed)", "payer": "Temporary 12", "id": row.get("tx"),
                    "hash": row.get("hash"), "status": (row.get("transactionResult") or {}).get("status"),
                    "paidDust": dust((row.get("fees") or {}).get("paidFees"))})
    res["midnightTransactions"] = txs
    res["paidDustTotal"] = round(sum(x["paidDust"] or 0 for x in txs), 6)

    # The sponsor's settled DUST and the SOL balances per snapshot.
    snaps = lines(f"{out}/snapshots.jsonl")
    res["snapshots"] = [{"label": s["label"], "at": s["at"], "sponsorDust": dust(s.get("sponsorDustSpecks")),
                         "sol": {k: (round(int(v) / 1e9, 9) if str(v).isdigit() else None) for k, v in s.get("lamports", {}).items()}}
                        for s in snaps]

    # The bridge node's Solana sync against devnet's tip.
    samples = []
    for s in lines(f"{out}/sync.jsonl"):
        bh = s.get("blockHeights") or []
        sol = next((r for r in bh if isinstance(r, dict) and "olana" in str(r.get("protocol_name"))), None)
        if sol and s.get("devnetSlot") and sol.get("synced_page") is not None:
            samples.append((s["t"], int(s["devnetSlot"]), int(sol["synced_page"])))
    if len(samples) >= 2:
        (t0, d0, n0), (t1, d1, n1) = samples[0], samples[-1]
        span = max(t1 - t0, 1)
        lags = [d - n for _, d, n in samples]
        res["solanaSync"] = {
            "samples": len(samples), "seconds": round(span), "devnetSlotsPerSecond": round((d1 - d0) / span, 3),
            "nodeSlotsPerSecond": round((n1 - n0) / span, 3), "lagSlotsFirst": lags[0], "lagSlotsLast": lags[-1],
            "lagSlotsMax": max(lags), "lagSecondsLastAt400ms": round(lags[-1] * 0.4, 1),
        }
    else:
        res["solanaSync"] = {"samples": len(samples)}

    with open(f"{out}/gate.json", "w") as f:
        json.dump(res, f, indent=1)
    print(json.dumps({k: res[k] for k in ("result", "seconds", "paidDustTotal", "solanaSync") if k in res}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1])
