"""Window summaries for snow, wind and temperature, and how they changed since yesterday.

The precip tab's window cards (next 48 hours, 7 days, 14 days) have a matching set here for
the other tabs: for each region and window, one value per model (pass snowfall, the strongest
lowland or coastal gust, the average high and low), the median across models and their range.
The comparison with yesterday's briefing uses the same dates in both, as change.py does for
precipitation.

Works on briefing.json-shaped dicts (lists, None for missing), so yesterday's file can be read
straight off the published site.
"""
from __future__ import annotations

import numpy as np

# value per point over the window (agg), then per region across its points (combine)
SPECS = {
    "snow": {"key": "snowfall_sum", "agg": "sum", "kinds": ("pass",), "combine": "mean"},
    "gust": {"key": "wind_gusts_10m_max", "agg": "max", "kinds": ("lowland", "coast"), "combine": "max"},
    "tmax": {"key": "temperature_2m_max", "agg": "mean", "kinds": ("lowland", "coast"), "combine": "mean"},
    "tmin": {"key": "temperature_2m_min", "agg": "mean", "kinds": ("lowland", "coast"), "combine": "mean"},
}
_AGG = {"sum": np.sum, "max": np.max, "mean": np.mean}


def _per_model(doc, spec, cols, points, regions):
    """{model: {rid: value}} for models with a value at every included point and date."""
    out = {}
    for m in doc.get("models", []):
        vals = {}
        for p in points:
            s = m.get("data", {}).get(p["name"], {}).get(spec["key"]) or []
            v = [s[c] if c < len(s) else None for c in cols]
            if any(x is None for x in v):
                break
            vals[p["name"]] = float(_AGG[spec["agg"]](v))
        else:
            reg = {}
            for r in regions:
                xs = [vals[p["name"]] for p in points if p.get("region") == r["id"]]
                if xs:
                    reg[r["id"]] = float(_AGG[spec["combine"]](xs))
            if reg:
                out[m["label"]] = reg
    return out


def _points(doc, spec, names=None):
    return [p for p in doc["points"] if p["kind"] in spec["kinds"] and p.get("region") and (names is None or p["name"] in names)]


def _regions(doc, points):
    return [r for r in doc["regions"] if any(p.get("region") == r["id"] for p in points)]


def summarize(doc, windows):
    """{var: [{days, label, regions: [{rid, region, median, lo, hi, n}]}]}."""
    out = {}
    for var, spec in SPECS.items():
        pts = _points(doc, spec)
        regs = _regions(doc, pts)
        wins = []
        for w in windows:
            cols = list(range(min(w["days"], len(doc["dates"]))))
            pm = _per_model(doc, spec, cols, pts, regs)
            rows = []
            for r in regs:
                v = [x[r["id"]] for x in pm.values() if r["id"] in x]
                if v:
                    rows.append({"rid": r["id"], "region": r["name"], "median": float(np.median(v)),
                                 "lo": float(min(v)), "hi": float(max(v)), "n": len(v)})
            if rows:
                wins.append({"days": w["days"], "label": w["label"], "regions": rows})
        if wins:
            out[var] = wins
    return out


def compare(now, prev, windows):
    """{var: [{days, label, overlapDays, regions: {rid: {now, prev, delta}}}]} over the dates both cover."""
    if not prev or not prev.get("models"):
        return None
    prev_names = {p["name"] for p in prev.get("points", [])}
    out = {}
    for var, spec in SPECS.items():
        pts = _points(now, spec, prev_names)
        regs = _regions(now, pts)
        wins = []
        for w in windows:
            dates = [d for d in now["dates"][: w["days"]] if d in set(prev["dates"])]
            if not dates:
                continue
            a = _per_model(now, spec, [now["dates"].index(d) for d in dates], pts, regs)
            b = _per_model(prev, spec, [prev["dates"].index(d) for d in dates], pts, regs)
            rr = {}
            for r in regs:
                va = [x[r["id"]] for x in a.values() if r["id"] in x]
                vb = [x[r["id"]] for x in b.values() if r["id"] in x]
                if va and vb:
                    ma, mb = float(np.median(va)), float(np.median(vb))
                    rr[r["id"]] = {"now": ma, "prev": mb, "delta": ma - mb}
            if rr:
                wins.append({"days": w["days"], "label": w["label"], "overlapDays": len(dates), "regions": rr})
        if wins:
            out[var] = wins
    return out
