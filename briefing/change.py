"""What changed since the previous briefing.

Windows shift by a day between issues, so totals are compared over the *same dates*:
today's days that yesterday's forecast also covered. For the 14-day window that is
13 days; the overlap length is reported with each comparison.

Works on the cleaned briefing.json dicts (lists, None for missing), so the previous
day's file can be read straight off the published site.
"""
from __future__ import annotations

import numpy as np


def _region_stats(doc, dates, regions, points):
    """Per-model region averages over `dates`, then the median across models; also per-point medians."""
    idx = {d: i for i, d in enumerate(doc["dates"])}
    if not all(d in idx for d in dates):
        return None
    cols = [idx[d] for d in dates]
    per_model_region, point_vals = {}, {p["name"]: [] for p in points}
    for m in doc["models"]:
        totals = {}
        for p in points:
            series = m["data"].get(p["name"], {}).get("precipitation_sum", [])
            vals = [series[c] if c < len(series) else None for c in cols]
            if any(v is None for v in vals):
                break
            totals[p["name"]] = float(sum(vals))
        else:
            for p, v in totals.items():
                point_vals[p].append(v)
            per_model_region[m["label"]] = {r["id"]: float(np.mean([totals[p["name"]] for p in points if p.get("region") == r["id"]]))
                                            for r in regions}
    if not per_model_region:
        return None
    med = {r["id"]: float(np.median([v[r["id"]] for v in per_model_region.values()])) for r in regions}
    pts = {p: (float(np.median(v)) if v else None) for p, v in point_vals.items()}
    return {"median": med, "models": per_model_region, "points": pts}


def _overlaps(a, b):
    return a["start"] <= b["end"] and b["start"] <= a["end"]


def compare(now: dict, prev: dict | None, windows: list[dict]):
    if not prev or not prev.get("models"):
        return None
    regions, points = now["regions"], now["points"]
    out_w = []
    for w in windows:
        dates = [d for d in now["dates"][: w["days"]] if d in set(prev["dates"])]
        if not dates:
            continue
        a, b = _region_stats(now, dates, regions, points), _region_stats(prev, dates, regions, points)
        if not a or not b:
            continue
        out_w.append({
            "days": w["days"], "label": w["label"], "overlapDays": len(dates), "from": dates[0], "to": dates[-1],
            "regions": {r["id"]: {"now": a["median"][r["id"]], "prev": b["median"][r["id"]],
                                  "delta": a["median"][r["id"]] - b["median"][r["id"]]} for r in regions},
            "points": {p: {"now": a["points"][p], "prev": b["points"][p],
                           "delta": (a["points"][p] - b["points"][p]) if a["points"][p] is not None and b["points"][p] is not None else None}
                       for p in a["points"]},
            "models": {m: {rid: a["models"][m][rid] - b["models"][m][rid] for rid in a["models"][m]}
                       for m in a["models"] if m in b["models"]},
        })

    # hazards: new, upgraded, downgraded, dropped (only for dates both briefings cover)
    first = now["dates"][0]
    ev_now = now.get("events", [])
    ev_prev = [e for e in prev.get("events", []) if e["end"] >= first]
    changes = {"new": [], "upgraded": [], "downgraded": [], "dropped": [], "same": []}
    for e in ev_now:
        match = next((p for p in ev_prev if p["hazard"] == e["hazard"] and _overlaps(p, e)), None)
        rec = {"label": e["label"], "start": e["start"], "end": e["end"], "level": e["level"],
               "prevLevel": match["level"] if match else None}
        if not match:
            changes["new"].append(rec)
        elif match["level"] != e["level"]:
            changes["upgraded" if e["level"] == "likely" else "downgraded"].append(rec)
        else:
            changes["same"].append(rec)
    for p in ev_prev:
        if not any(p["hazard"] == e["hazard"] and _overlaps(p, e) for e in ev_now):
            changes["dropped"].append({"label": p["label"], "start": p["start"], "end": p["end"],
                                       "level": None, "prevLevel": p["level"]})
    return {"prevIssued": prev.get("meta", {}).get("issued"), "windows": out_w, "events": changes}
