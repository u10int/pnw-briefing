"""How the models have been doing: each recent briefing's precipitation forecasts at the forecast
locations against what MRMS observed on those days.

A day verified is a 12Z – 12Z day that has an MRMS total (the briefing's `observed.daily`, the
past 30 days). Its forecasts come from the earlier briefings (one per day, from the site archive):
the briefing issued k days before the day forecast it at lead k (day 1 is the day it starts with).
Scores, per model and lead group, over every location and day:

- typical error: the mean absolute difference, in inches;
- bias: total forecast over total observed (1.0 is right on; 1.3 forecast 30% too wet);
- wet-day hits: of the location-days that got 0.25" or more, how many the model had at 0.25" or more,
  and how many of the days it forecast that much were actually that wet.

Briefing.json-shaped dicts throughout, so archived briefings can be read straight off the site.
"""
from __future__ import annotations

from datetime import date

import numpy as np

LEADS = [{"id": "d1", "label": "Day 1", "leads": [0]},
         {"id": "d23", "label": "Days 2 – 3", "leads": [1, 2]},
         {"id": "d47", "label": "Days 4 – 7", "leads": [3, 4, 5, 6]}]
WET = 0.25


def _d(s):
    return date.fromisoformat(str(s)[:10])


def verify(now, earlier, max_days=14):
    obs = now.get("observed") or {}
    odates = [str(d)[:10] for d in obs.get("dates", [])]
    daily = obs.get("daily") or {}
    if not odates or not daily or not earlier:
        return None
    # the most recent days with observations, newest first, at most max_days
    days = [d for d in odates[-max_days:]]
    o_at = {(p, d): daily[p][odates.index(d)] for p in daily for d in days if odates.index(d) < len(daily[p])}
    region_of = {p["name"]: p.get("region") for p in now["points"]}

    # pairs[(model, lead group)] -> list of (forecast, observed, point, day)
    pairs, tiers = {}, {}
    day1 = {}                                         # (model, day, region) -> [forecast], for the chart
    for b in earlier:
        bd = [str(x)[:10] for x in b.get("dates", [])]
        if not bd:
            continue
        for m in b.get("models", []):
            tiers.setdefault(m["label"], m.get("tier"))
            for p, series in (m.get("data") or {}).items():
                fc = series.get("precipitation_sum") or []
                for k, d in enumerate(bd):
                    if d not in days or k >= len(fc) or fc[k] is None:
                        continue
                    o = o_at.get((p, d))
                    if o is None:
                        continue
                    lead = k
                    grp = next((g["id"] for g in LEADS if lead in g["leads"]), None)
                    if grp:
                        pairs.setdefault((m["label"], grp), []).append((float(fc[k]), float(o), p, d))
                    if lead == 0 and region_of.get(p):
                        day1.setdefault((m["label"], d, region_of[p]), []).append(float(fc[k]))
    if not pairs:
        return None

    def score(xs):
        f = np.array([x[0] for x in xs]); o = np.array([x[1] for x in xs])
        wet_o, wet_f = o >= WET, f >= WET
        return {"mae": round(float(np.mean(np.abs(f - o))), 3),
                "bias": round(float(f.sum() / o.sum()), 2) if o.sum() > 0.05 else None,
                "pod": round(float((wet_o & wet_f).sum() / wet_o.sum()), 2) if wet_o.sum() else None,
                "far": round(float((wet_f & ~wet_o).sum() / wet_f.sum()), 2) if wet_f.sum() else None,
                "n": int(len(xs)), "days": len({x[3] for x in xs}), "obs": round(float(o.sum()), 2), "fc": round(float(f.sum()), 2)}

    models = sorted({m for m, _ in pairs})
    rows = [{"model": m, "tier": tiers.get(m), "scores": {g["id"]: score(pairs[(m, g["id"])]) for g in LEADS if (m, g["id"]) in pairs}}
            for m in models]
    # regional observed and each model's day-1 forecast, per day, for the chart
    regions = [r["id"] for r in now["regions"]]
    obs_reg = {r: [(round(float(np.mean(v)), 2) if (v := [o_at[(p, d)] for p in daily if region_of.get(p) == r and o_at.get((p, d)) is not None]) else None)
                   for d in days] for r in regions}
    fc_reg = {m: {r: [round(float(np.mean(day1[(m, d, r)])), 2) if (m, d, r) in day1 else None for d in days] for r in regions} for m in models}
    used = sorted({x[3] for xs in pairs.values() for x in xs})
    return {"from": used[0], "to": used[-1], "nDays": len(used), "wet": WET, "leads": LEADS,
            "models": rows, "chart": {"dates": days, "observed": obs_reg, "day1": fc_reg}}


WITHIN = 3.0          # °F: a forecast this close counts as "within"


def verify_temps(now, earlier, max_days=14):
    """Each recent briefing's daily highs and lows against the URMA analysis (`observedTemps`).

    Scores per model and lead group, over every location and day: the typical miss (mean absolute
    error, °F) for highs, lows and both; the bias (mean forecast minus analysed, so + is too warm);
    and the share of highs and lows within 3 °F."""
    ot = now.get("observedTemps") or {}
    days = [str(d)[:10] for d in ot.get("dates") or []][-max_days:]
    if not days or not earlier:
        return None
    pos = {d: k for k, d in enumerate(str(x)[:10] for x in ot["dates"])}
    o_at = {}
    for p in ot.get("tmax") or {}:
        for d in days:
            k = pos[d]
            hi, lo = ot["tmax"][p], (ot.get("tmin") or {}).get(p) or []
            if k < len(hi) and k < len(lo) and hi[k] is not None and lo[k] is not None:
                o_at[(p, d)] = (float(hi[k]), float(lo[k]))
    region_of = {p["name"]: p.get("region") for p in now["points"]}

    pairs, tiers, day1 = {}, {}, {}
    for b in earlier:
        bd = [str(x)[:10] for x in b.get("dates", [])]
        for m in b.get("models", []):
            tiers.setdefault(m["label"], m.get("tier"))
            for p, series in (m.get("data") or {}).items():
                fh, fl = series.get("temperature_2m_max") or [], series.get("temperature_2m_min") or []
                for k, d in enumerate(bd):
                    o = o_at.get((p, d))
                    if o is None or k >= len(fh) or k >= len(fl) or fh[k] is None or fl[k] is None:
                        continue
                    grp = next((g["id"] for g in LEADS if k in g["leads"]), None)
                    if grp:
                        pairs.setdefault((m["label"], grp), []).append((float(fh[k]), o[0], float(fl[k]), o[1], p, d))
                    if k == 0 and region_of.get(p):
                        day1.setdefault((m["label"], d, region_of[p]), []).append((float(fh[k]), float(fl[k])))
    if not pairs:
        return None

    def score(xs):
        a = np.array([x[:4] for x in xs])
        eh, el = a[:, 0] - a[:, 1], a[:, 2] - a[:, 3]
        both = np.concatenate([eh, el])
        r = lambda v: round(float(v), 1)
        return {"mae": r(np.mean(np.abs(both))), "maeHi": r(np.mean(np.abs(eh))), "maeLo": r(np.mean(np.abs(el))),
                "biasHi": r(np.mean(eh)), "biasLo": r(np.mean(el)),
                "within": round(float(np.mean(np.abs(both) <= WITHIN)), 2),
                "n": int(len(xs)), "days": len({x[5] for x in xs})}

    models = sorted({m for m, _ in pairs})
    rows = [{"model": m, "tier": tiers.get(m), "scores": {g["id"]: score(pairs[(m, g["id"])]) for g in LEADS if (m, g["id"]) in pairs}}
            for m in models]
    regions = [r["id"] for r in now["regions"]]

    def reg_obs(r, d, k):
        v = [o_at[(p, d)][k] for p in ot.get("tmax") or {} if region_of.get(p) == r and (p, d) in o_at]
        return round(float(np.mean(v)), 1) if v else None
    observed = {r: {"hi": [reg_obs(r, d, 0) for d in days], "lo": [reg_obs(r, d, 1) for d in days]} for r in regions}
    fc = {m: {r: {key: [round(float(np.mean([x[k] for x in day1[(m, d, r)]])), 1) if (m, d, r) in day1 else None for d in days]
                  for key, k in (("hi", 0), ("lo", 1))} for r in regions} for m in models}
    used = sorted({x[5] for xs in pairs.values() for x in xs})
    return {"from": used[0], "to": used[-1], "nDays": len(used), "within": WITHIN, "source": ot.get("source", "URMA"),
            "leads": LEADS, "models": rows, "chart": {"dates": days, "observed": observed, "day1": fc}}
