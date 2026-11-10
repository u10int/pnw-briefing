"""Forecast trends: each location's and region's precipitation, snow, strongest gust and
average high and low over the next 48 hours, 7 days and 14 days, and how each changed since
yesterday's briefing.

Per location, each model gives one value over the window (a total, the maximum or the
average); the median across models that cover the whole window is the location's value, with
their range. A region combines its locations within each model first (snow at its passes,
gusts at its lowland and coastal locations), then takes the median. The comparison with
yesterday uses the same dates in both briefings, as change.py does for precipitation.

Works on briefing.json-shaped dicts (lists, None for missing), so yesterday's file can be read
straight off the published site.
"""
from __future__ import annotations

import numpy as np

from .change import full_dates

# key: daily series; agg: over the window; kinds: locations a region's value uses; combine: across them
SPECS = {
    "precip": {"key": "precipitation_sum", "agg": "sum", "kinds": ("lowland", "coast", "pass"), "combine": "mean"},
    "snow": {"key": "snowfall_sum", "agg": "sum", "kinds": ("pass",), "combine": "mean"},
    "gust": {"key": "wind_gusts_10m_max", "agg": "max", "kinds": ("lowland", "coast"), "combine": "max"},
    "tmax": {"key": "temperature_2m_max", "agg": "mean", "kinds": ("lowland", "coast"), "combine": "mean"},
    "tmin": {"key": "temperature_2m_min", "agg": "mean", "kinds": ("lowland", "coast"), "combine": "mean"},
}
_AGG = {"sum": np.sum, "max": np.max, "mean": np.mean}


def _model_values(doc, cols, names):
    """{var: {model: {point: value}}} for each model covering every date at that point."""
    out = {v: {} for v in SPECS}
    for m in doc.get("models", []):
        for var, spec in SPECS.items():
            vals = {}
            for n in names:
                s = m.get("data", {}).get(n, {}).get(spec["key"]) or []
                v = [s[c] if c < len(s) else None for c in cols]
                if v and all(x is not None for x in v):
                    vals[n] = float(_AGG[spec["agg"]](v))
            if vals:
                out[var][m["label"]] = vals
    return out


def _stats(xs):
    return {"median": float(np.median(xs)), "lo": float(min(xs)), "hi": float(max(xs)), "n": len(xs)} if xs else None


def _window(doc, cols, names):
    """{"points": {name: {var: stats}}, "regions": {rid or "zone:<name>": {var: stats}}}."""
    mv = _model_values(doc, cols, names)
    pts = {n: {} for n in names}
    regs = {}
    kind = {p["name"]: p for p in doc["points"]}
    for var, spec in SPECS.items():
        for n in names:
            s = _stats([v[n] for v in mv[var].values() if n in v])
            if s:
                pts[n][var] = s
        # regions, then a group per zone for locations outside every region (e.g. Southwest BC),
        # keyed "zone:<name>"
        groups = [(r["id"], lambda n, rid=r["id"]: kind[n].get("region") == rid) for r in doc["regions"]]
        groups += [(f"zone:{z}", lambda n, z=z: not kind[n].get("region") and kind[n].get("zone") == z)
                   for z in dict.fromkeys(kind[n].get("zone") for n in names if not kind[n].get("region") and kind[n].get("zone"))]
        for gid, inside in groups:
            members = [n for n in names if inside(n) and kind[n]["kind"] in spec["kinds"]]
            per_model = []
            for v in mv[var].values():
                xs = [v[n] for n in members if n in v]
                # a model counts for the region only with all of its locations
                if members and len(xs) == len(members):
                    per_model.append(float(_AGG[spec["combine"]](xs)))
            s = _stats(per_model)
            if s:
                regs.setdefault(gid, {})[var] = s
    return {"points": {n: v for n, v in pts.items() if v}, "regions": regs}


def summarize(doc, windows):
    """{"windows": [{days, label, points, regions}]}."""
    names = [p["name"] for p in doc["points"]]
    out = []
    for w in windows:
        cols = list(range(min(w["days"], len(doc["dates"]))))
        out.append({"days": w["days"], "label": w["label"], **_window(doc, cols, names)})
    return {"windows": out}


def compare(now, prev, windows):
    """{"windows": [{days, label, overlapDays, points: {name: {var: {now, prev, delta}}}, regions: …}]}
    over the dates both briefings cover, for locations both have."""
    if not prev or not prev.get("models"):
        return None
    names = [p["name"] for p in now["points"] if p["name"] in {q["name"] for q in prev.get("points", [])}]
    prev_doc = {**prev, "points": [p for p in now["points"] if p["name"] in names], "regions": now["regions"]}
    now_doc = {**now, "points": prev_doc["points"]}
    out = []
    for w in windows:
        both = full_dates(now) & full_dates(prev)
        dates = [d for d in now["dates"][: w["days"]] if str(d)[:10] in both]
        if not dates:
            continue
        a = _window(now_doc, [now["dates"].index(d) for d in dates], names)
        b = _window(prev_doc, [prev["dates"].index(d) for d in dates], names)

        def diff(x, y):
            return {var: {"now": x[var]["median"], "prev": y[var]["median"], "delta": x[var]["median"] - y[var]["median"]}
                    for var in x if var in y}
        out.append({"days": w["days"], "label": w["label"], "overlapDays": len(dates),
                    "points": {n: d for n in a["points"] if n in b["points"] and (d := diff(a["points"][n], b["points"][n]))},
                    "regions": {r: d for r in a["regions"] if r in b["regions"] and (d := diff(a["regions"][r], b["regions"][r]))}})
    return {"windows": out}


def history(now, earlier, windows, min_share=0.5, max_runs=6):
    """How each region's and location's values moved over the last few briefings, for the trends
    table's sparklines and the run-to-run cards.

    `earlier` are previous briefings (any order). For each window, briefings are taken newest
    first while the dates they share with today's window stay at least `min_share` of it; every
    value is then over those same dates, so the runs compare like for like.
    {"windows": [{days, from, to, nDays, runs: [issued…], regions: {rid: {var: [value or None…]}},
                  points: {name: {var: [{median, lo, hi} or None…]}}}]}
    (runs oldest first; the last is today's briefing).
    """
    docs = sorted((d for d in earlier if d and d.get("models")), key=lambda d: d.get("meta", {}).get("issued") or "", reverse=True)
    if not docs:
        return None
    names = [p["name"] for p in now["points"]]
    out = []
    for w in windows:
        dates = [x for x in now["dates"][: w["days"]] if str(x)[:10] in full_dates(now)]
        used = []
        for d in docs[: max_runs - 1]:
            common = [x for x in dates if str(x)[:10] in full_dates(d)]
            if len(common) < max(1, int(np.ceil(min_share * w["days"]))):
                break
            dates, used = common, used + [d]
        if not used:
            continue
        runs = list(reversed(used)) + [now]
        regs, ptv = {}, {}
        for i, d in enumerate(runs):
            pts = [p for p in now["points"] if p["name"] in {q["name"] for q in d.get("points", [])}]
            doc = {**d, "points": pts, "regions": now["regions"]}
            vals = _window(doc, [d["dates"].index(x) for x in dates], [p["name"] for p in pts])
            for rid, byvar in vals["regions"].items():
                for var, st in byvar.items():
                    regs.setdefault(rid, {}).setdefault(var, [None] * len(runs))[i] = st["median"]
            for n, byvar in vals["points"].items():
                for var, st in byvar.items():
                    ptv.setdefault(n, {}).setdefault(var, [None] * len(runs))[i] = {k: st[k] for k in ("median", "lo", "hi", "n")}
        out.append({"days": w["days"], "from": dates[0], "to": dates[-1], "nDays": len(dates),
                    "runs": [d.get("meta", {}).get("issued") for d in runs], "regions": regs, "points": ptv})
    return {"windows": out}
