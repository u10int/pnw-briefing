"""When the strongest gusts and the heaviest precipitation come, location by location, over the
next two days — only where they're expected to matter.

From the models with hourly map fields (the high-resolution ones), each location's gust and
hourly precipitation rate are lined up by valid time and the median across models taken, the
high-resolution ones weighted double (config `timing.weights`, by tier). A
period is the run of hours where that median reaches the location's threshold (gusts: config
`timing.gust_mph` by location kind; precipitation: `timing.rate_in_per_h`, moderate rain),
with gaps of up to two hours bridged. Each period gives its start and end, its peak and when,
how many models reach the threshold in it, and when the individual models peak, so the spread in
timing shows.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np

DEFAULTS = {"gust_mph": {"lowland": 35, "coast": 45, "pass": 50}, "rate_in_per_h": 0.10, "heavy_in_per_h": 0.30,
            # snowfall (in/h): moderate and heavy; and the "any amount" floors for the light spans
            "snow_in_per_h": 0.5, "heavy_snow_in_per_h": 1.0, "any_rate_in_per_h": 0.01, "any_snow_in_per_h": 0.1,
            "hours": 48, "max_gap_h": 2,
            # high-resolution models count more in the median: they resolve gusts and showers the
            # global ones smooth out
            "weights": {"regional": 2, "blend": 1, "global": 1}}


def wmedian(vals, weights):
    """Weighted median: the value where the running weight first reaches half the total."""
    order = np.argsort(vals)
    v, w = np.asarray(vals, float)[order], np.asarray(weights, float)[order]
    c = np.cumsum(w)
    half = c[-1] / 2
    i = int(np.searchsorted(c, half))
    # an exact split between two values takes their mean, as the ordinary median does
    return float((v[i] + v[i + 1]) / 2) if np.isclose(c[i], half) and i + 1 < len(v) else float(v[i])


def _t(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _hourly_models(models):
    """Models whose map fields step hourly (at least in their first day)."""
    out = []
    for m in models:
        h = m.get("hourly")
        if h and h.get("times") and sum(1 for s in h["step"][:24] if s <= 1) >= 12:
            out.append(m)
    return out


def _periods(times, med, thr, max_gap):
    """Runs of hours with med >= thr, bridging gaps of up to max_gap hours."""
    hit = [i for i, v in enumerate(med) if v is not None and v >= thr]
    runs = []
    for i in hit:
        if runs and (times[i] - times[runs[-1][-1]]).total_seconds() / 3600 <= max_gap + 1:
            runs[-1].append(i)
        else:
            runs.append([i])
    return runs


def _series(models, var, name, grid):
    """{model: {time: value}} for one location, on the shared hourly grid."""
    out = {}
    for m in models:
        h = m["hourly"]
        vals = (h.get(var) or {}).get(name)
        if not vals:
            continue
        out[m["label"]] = {t: v for t, v, s in zip(h["times"], vals, h["step"]) if v is not None and s <= 1 and t in grid}
    return {k: v for k, v in out.items() if v}


def compute(models, cfg, start):
    """{"hours", "models": [labels], "points": {name: {"gust": [period], "precip": [period]}}} for the
    locations with at least one period; None when no model has hourly fields."""
    spec = {**DEFAULTS, **(cfg.get("timing") or {})}
    ms = _hourly_models(models)
    if not ms:
        return None
    wt = {m["label"]: spec["weights"].get(m.get("tier") or "global", 1) for m in ms}
    t0 = start if start.tzinfo else start.replace(tzinfo=timezone.utc)
    grid_t = [t0 + timedelta(hours=k) for k in range(1, spec["hours"] + 1)]
    grid = {t.strftime("%Y-%m-%dT%H:00Z") for t in grid_t}
    keys = [t.strftime("%Y-%m-%dT%H:00Z") for t in grid_t]
    out = {}
    for p in cfg["points"]:
        rec = {}
        for var, src, thr, floor, heavy in (("gust", "gust", spec["gust_mph"].get(p["kind"], 40), None, None),
                                            ("precip", "rate", spec["rate_in_per_h"], spec["any_rate_in_per_h"], spec["heavy_in_per_h"]),
                                            ("snow", "snow", spec["snow_in_per_h"], spec["any_snow_in_per_h"], spec["heavy_snow_in_per_h"])):
            per = _series(ms, src, p["name"], grid)
            if not per:
                continue
            med = []
            for k in keys:
                have = [(s[k], wt[lab]) for lab, s in per.items() if k in s]
                med.append(wmedian([x for x, _ in have], [w for _, w in have]) if len(have) >= min(2, len(per)) else None)
            events = []
            for run in _periods(grid_t, med, thr, spec["max_gap_h"]):
                a, b = run[0], run[-1]
                pk = max(run, key=lambda i: med[i])
                # each model's own peak within the period (padded 3 h either side), and whether it reaches the threshold
                lo, hi = grid_t[a] - timedelta(hours=3), grid_t[b] + timedelta(hours=3)
                peaks, reach = [], 0
                for s in per.values():
                    win = [(t, v) for t, v in s.items() if lo <= _t(t) <= hi]
                    if not win:
                        continue
                    t, v = max(win, key=lambda x: x[1])
                    peaks.append(t)
                    reach += v >= thr
                ev = {"start": keys[a], "end": keys[b], "peak": round(med[pk], 0 if var == "gust" else 2 if var == "precip" else 1), "peakTime": keys[pk],
                      "models": reach, "of": len(per), "peakFrom": min(peaks) if peaks else None, "peakTo": max(peaks) if peaks else None}
                if heavy is not None:
                    ev["total"] = round(sum(med[i] or 0 for i in range(a, b + 1)), 2 if var == "precip" else 1)
                    ev["heavy"] = ev["peak"] >= heavy                          # as shown, so 0.30 reads heavy
                events.append(ev)
            if events:
                # the two strongest periods, in time order
                rec[var] = sorted(sorted(events, key=lambda e: -e["peak"])[:2], key=lambda e: e["start"])
            if floor is not None:
                # every stretch with any measurable amount (gaps of an hour bridged), drawn light under the bars
                light = []
                for run in _periods(grid_t, med, floor, 1):
                    a, b = run[0], run[-1]
                    pk = max(run, key=lambda i: med[i])
                    light.append({"start": keys[a], "end": keys[b], "peak": round(med[pk], 2 if var == "precip" else 1), "peakTime": keys[pk],
                                  "total": round(sum(med[i] or 0 for i in range(a, b + 1)), 2 if var == "precip" else 1)})
                if light:
                    rec[f"{var}Any"] = light
        if rec:
            out[p["name"]] = rec
    return {"hours": spec["hours"], "models": [m["label"] for m in ms],
            "weighted": sorted({m["label"] for m in ms if wt[m["label"]] > 1}, key=[m["label"] for m in ms].index),
            "thresholds": {k: spec[k] for k in ("gust_mph", "rate_in_per_h", "heavy_in_per_h", "snow_in_per_h", "heavy_snow_in_per_h",
                                                "any_rate_in_per_h", "any_snow_in_per_h")},
            "points": out}
