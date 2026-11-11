"""What changed since the previous briefing.

Windows shift by a day between issues, so totals are compared over the *same dates*:
today's days that yesterday's forecast also covered. For the 14-day window that is
13 days; the overlap length is reported with each comparison.

Works on the cleaned briefing.json dicts (lists, None for missing), so the previous
day's file can be read straight off the published site. Only locations present in both
briefings are compared, so adding or removing a location doesn't blank the comparison.
"""
from __future__ import annotations

from datetime import date

import numpy as np

from . import impacts


def full_dates(doc) -> set:
    """The dates a briefing covers whole: all but the first when it started after that day's 12Z
    (an 18Z, 00Z or 06Z edition's first day is only the rest of the day)."""
    ds = [str(d)[:10] for d in doc.get("dates") or []]
    partial = (doc.get("meta") or {}).get("firstDayHours", 24) < 24
    return set(ds[1:] if partial else ds)


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


def compare(now: dict, prev: dict | None, windows: list[dict]):
    if not prev or not prev.get("models"):
        return None
    # Compare only locations both briefings have: a location added since yesterday (or removed)
    # has nothing to compare against and would otherwise rule out every model.
    prev_names = {p["name"] for p in prev.get("points", [])}
    points = [p for p in now["points"] if p["name"] in prev_names]
    regions = [r for r in now["regions"] if any(p.get("region") == r["id"] for p in points)]
    if not points:
        return {"prevIssued": prev.get("meta", {}).get("issued"), "windows": [], "events": _with_kind(_events(now, prev))}
    out_w = []
    for w in windows:
        both = full_dates(now) & full_dates(prev)        # like for like: whole days in both
        dates = [d for d in now["dates"][: w["days"]] if str(d)[:10] in both]
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

    return {"prevIssued": prev.get("meta", {}).get("issued"), "windows": out_w, "events": _with_kind(_events(now, prev))}


MAX_GAP = 1   # days between yesterday's event and today's for a move to count as the same event


def _d(x):
    return date.fromisoformat(x)


def _rel(p, e):
    """(gap in days, overlap in days) between two date ranges; gap 0 means overlapping or touching."""
    lo, hi = max(_d(p["start"]), _d(e["start"])), min(_d(p["end"]), _d(e["end"]))
    n = (hi - lo).days
    return (0, n + 1) if n >= 0 else (-n - 1, 0)


def _where(e):
    return [{"name": q["name"], "peak": q.get("peak")} for q in e.get("points", [])]


def _events(now, prev):
    """Hazards today against yesterday's, matched one to one by hazard: overlapping dates first,
    then the nearest within MAX_GAP days, so an event that moved is reported as moved rather
    than as one dropped and one new. Each record keeps yesterday's dates (clipped to today's
    first day, since earlier days have simply passed) and whether they changed."""
    first = now["dates"][0]
    ev_now = now.get("events", [])
    ev_prev = [dict(e, start=max(e["start"], first)) for e in prev.get("events", []) if e["end"] >= first]
    pairs = []
    for i, e in enumerate(ev_now):
        for j, p in enumerate(ev_prev):
            if p["hazard"] != e["hazard"]:
                continue
            gap, over = _rel(p, e)
            if gap <= MAX_GAP:
                pairs.append((gap, -over, abs((_d(p["start"]) - _d(e["start"])).days), i, j))
    match, used = {}, set()
    for *_, i, j in sorted(pairs):
        if i not in match and j not in used:
            match[i] = j
            used.add(j)
    changes = {"new": [], "upgraded": [], "downgraded": [], "dropped": [], "same": []}
    for i, e in enumerate(ev_now):
        p = ev_prev[match[i]] if i in match else None
        rec = {"hazard": e["hazard"], "label": e["label"], "start": e["start"], "end": e["end"], "level": e["level"],
               "prevLevel": p["level"] if p else None, "prevStart": p["start"] if p else None, "prevEnd": p["end"] if p else None,
               "shifted": bool(p) and (p["start"], p["end"]) != (e["start"], e["end"]),
               "agreement": e.get("agreement"), "where": _where(e), "unit": e.get("unit")}
        if not p:
            changes["new"].append(rec)
        elif p["level"] != e["level"]:
            changes["upgraded" if e["level"] == "likely" else "downgraded"].append(rec)
        else:
            changes["same"].append(rec)
    for j, p in enumerate(ev_prev):
        if j not in used:
            changes["dropped"].append({"hazard": p["hazard"], "label": p["label"], "start": p["start"], "end": p["end"],
                                       "level": None, "prevLevel": p["level"], "prevStart": p["start"], "prevEnd": p["end"],
                                       "shifted": False, "agreement": p.get("agreement"), "where": _where(p), "unit": p.get("unit")})
    return changes


# ------------------------------------------------------------------ impacts since the last edition

KINDS = ("new", "upgraded", "downgraded", "dropped", "same")
# _with_kind, used above, is defined below


def _like_for_like(now, prev):
    """Both briefings' models cut down to what both can speak to: the models in both, each kept
    only on the dates and fields where both editions have a value, and only on dates both cover
    in full. Returns (dates, now models, prev models) in the shape impacts.detect takes."""
    both = sorted(full_dates(now) & full_dates(prev))
    if not both:
        return [], [], []
    pm = {m["label"]: m for m in prev.get("models", [])}
    ni = {str(d)[:10]: i for i, d in enumerate(now["dates"])}
    pi = {str(d)[:10]: i for i, d in enumerate(prev["dates"])}
    a, b = [], []
    for m in now.get("models", []):
        q = pm.get(m["label"])
        if not q:
            continue
        da, db = {}, {}
        for name, fields in m["data"].items():
            other = q["data"].get(name)
            if not other:
                continue
            da[name], db[name] = {}, {}
            for v, xs in fields.items():
                ys = other.get(v)
                if ys is None:
                    continue
                pick = lambda arr, idx, d: arr[idx[d]] if idx[d] < len(arr) else None
                xa = [pick(xs, ni, d) for d in both]
                xb = [pick(ys, pi, d) for d in both]
                keep = [x is not None and y is not None for x, y in zip(xa, xb)]
                da[name][v] = [x if k else None for x, k in zip(xa, keep)]
                db[name][v] = [y if k else None for y, k in zip(xb, keep)]
        a.append({"label": m["label"], "dates": both, "data": da})
        b.append({"label": m["label"], "dates": both, "data": db})
    return both, a, b


def _with_kind(changes):
    for k in KINDS:
        for r in changes[k]:
            r["kind"] = "moved" if k == "same" and r.get("shifted") else k
    return changes


def events_since(now, prev, cfg):
    """How the impact events moved since an earlier edition, judged like for like: both editions'
    events rebuilt from the models they share, on the dates both cover in full, so a model that
    runs only at some cycles, or a first day only partly covered, doesn't read as a change.

    Each change is then attached to the event the page shows (built from every model): its dates
    and level are the page's, and `kind` says what happened. A shown event with no like-for-like
    counterpart can't be compared and is left out (the page shows no tag for it): an event only on
    a day one edition covers in part, or one only models missing from the other edition flag."""
    if not prev or not prev.get("models") or not now.get("models"):
        return None
    dates, a, b = _like_for_like(now, prev)
    if not a:
        return None
    pts = {p["name"] for p in now["points"]} & {p["name"] for p in prev.get("points", [])}
    c = {**cfg, "points": [p for p in cfg["points"] if p["name"] in pts], "days": len(dates)}
    ev_a = impacts.events(*impacts.detect(a, c), c)
    ev_b = impacts.events(*impacts.detect(b, c), c)
    clean = lambda evs: [{**e, "points": [{"name": n, "frac": f, "peak": pk} for n, f, pk in e["points"]]} for e in evs]
    raw = _events({"dates": dates, "events": clean(ev_a)}, {"dates": dates, "events": clean(ev_b)})

    def overlap(x, y):
        lo, hi = max(x["start"], y["start"]), min(x["end"], y["end"])
        return (_d(hi) - _d(lo)).days + 1 if lo <= hi else 0

    out = {k: [] for k in KINDS}
    like = [(k, r) for k in ("new", "upgraded", "downgraded", "same") for r in raw[k]]
    for e in now.get("events", []):
        cand = [(overlap(e, r), k, r) for k, r in like if r["hazard"] == e["hazard"] and overlap(e, r)]
        if not cand:
            continue
        _, k, r = max(cand, key=lambda x: x[0])
        out[k].append({"hazard": e["hazard"], "label": e["label"], "start": e["start"], "end": e["end"], "level": e["level"],
                       "prevLevel": r.get("prevLevel"), "prevStart": r.get("prevStart"), "prevEnd": r.get("prevEnd"),
                       "shifted": bool(r.get("shifted")), "agreement": e.get("agreement"), "where": _where(e), "unit": e.get("unit")})
    out["dropped"] = raw["dropped"]
    return _with_kind(out)

