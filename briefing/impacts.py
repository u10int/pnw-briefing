"""Rule-based weather-impact detection with multi-model agreement.

For each hazard, point and day, count the fraction of models exceeding the
threshold. Days where any point reaches `min_agreement` are grouped into
events so the briefing can say e.g. "Heavy rain, Nov 7 – 8, Forks/Aberdeen,
7 of 10 models".
"""
from __future__ import annotations

import numpy as np

HAZARDS = {
    "heavy_rain_24h": ("Heavy rain", "precip", "in/24h"),
    "heavy_rain_72h": ("Multi-day rain, flood risk", "precip", "in/72h"),
    "snow_24h": ("Snow", "snow", "in/24h"),
    "freezing_precip": ("Possible icy precipitation", "temp", "°F"),
    "hard_freeze": ("Hard freeze", "temp", "°F"),
    "wind": ("Strong gusts", "wind", "mph"),
    "heat": ("Heat", "temp", "°F"),
}


def _arr(m, p, v):
    return np.array(m["data"][p].get(v, []), dtype=float)


def in_leaf_season(date, imp):
    """Whether a YYYY-MM-DD date falls in the leaf-on season (`leaf_season`, MM-DD bounds)."""
    lo, hi = imp.get("leaf_season") or (None, None)
    return bool(lo and hi and lo <= str(date)[5:10] <= hi)


def gust_thresholds(imp, kind, dates, r72):
    """Per-day gust threshold for one location and model: the base level, the leaf-on level in
    season, less `wind_wet_soil_drop_mph` on a multi-day-rain day and the two days after."""
    base = imp["wind_gust_mph"][kind]
    if base is None:
        return None
    leaf = (imp.get("wind_gust_leaf_mph") or {}).get(kind, base)
    thr = np.array([float(leaf if in_leaf_season(d, imp) else base) for d in dates[: len(r72)]])
    drop, wet_at = imp.get("wind_wet_soil_drop_mph", 0), imp["heavy_rain_72h"].get(kind)
    if drop and wet_at is not None and len(thr):
        wet = np.nan_to_num(r72[: len(thr)]) >= wet_at
        recent = wet.copy()
        for lag in (1, 2):
            recent[lag:] |= wet[:-lag]
        thr = thr - drop * recent
    return thr


def detect(point_models, cfg):
    imp = cfg["impacts"]
    ndays = cfg["days"]
    pts = cfg["points"]
    dates = point_models[0]["dates"][:ndays] if point_models else []
    # agreement[hazard][point] -> (frac[day], peak[day])
    agree = {h: {} for h in HAZARDS}

    for p in pts:
        name, kind = p["name"], p["kind"]
        per = {h: [] for h in HAZARDS}
        for m in point_models:
            pr = _arr(m, name, "precipitation_sum")[:ndays]
            if np.all(np.isnan(pr)):
                continue
            sn = _arr(m, name, "snowfall_sum")[:ndays]
            ra = _arr(m, name, "rain_sum")[:ndays]
            tmin = _arr(m, name, "temperature_2m_min")[:ndays]
            tmax = _arr(m, name, "temperature_2m_max")[:ndays]
            gust = _arr(m, name, "wind_gusts_10m_max")[:ndays]
            r72 = np.array([np.nansum(pr[max(0, i - 2): i + 1]) if not np.isnan(pr[i]) else np.nan
                            for i in range(len(pr))])

            def flag(vals, thr, ge=True):
                if thr is None or len(vals) == 0:
                    return None
                hit = vals >= thr if ge else vals <= thr
                return np.where(np.isnan(vals), np.nan, hit.astype(float)), vals, m["label"]

            per["heavy_rain_24h"].append(flag(pr, imp["heavy_rain_24h"][kind]))
            per["heavy_rain_72h"].append(flag(r72, imp["heavy_rain_72h"][kind]))
            per["snow_24h"].append(flag(sn, imp["snow_24h"][kind]))
            per["hard_freeze"].append(flag(tmin, imp["hard_freeze_f"][kind], ge=False))
            gthr = gust_thresholds(imp, kind, dates, r72)
            ng = min(len(gust), len(gthr)) if gthr is not None else 0
            per["wind"].append(flag(gust[:ng], gthr[:ng]) if ng else None)
            per["heat"].append(flag(tmax, imp["heat_f"][kind]))
            if kind != "pass":
                fz = ((tmin <= imp["freezing_precip_f"]) & (tmax <= imp["freezing_precip_f"] + 4)
                      & (pr >= 0.05) & (np.nan_to_num(ra) > 0))
                per["freezing_precip"].append((np.where(np.isnan(tmin), np.nan, fz.astype(float)), tmin, m["label"]))

        for h, lst in per.items():
            lst = [x for x in lst if x is not None and len(x[0])]
            if not lst:
                continue
            n = min(len(x[0]) for x in lst)
            hits = np.vstack([x[0][:n] for x in lst])
            vals = np.vstack([x[1][:n] for x in lst])
            frac = np.nanmean(hits, axis=0)
            nmod = np.sum(~np.isnan(hits), axis=0)
            hi = HAZARDS[h][2] == "°F" and h in ("hard_freeze", "freezing_precip")
            peak = np.nanmin(vals, axis=0) if hi else np.nanmax(vals, axis=0)
            # each model's value and whether it crossed, for the page's per-model tooltips
            agree[h][name] = {"frac": frac, "n": nmod, "peak": peak,
                              "models": [x[2] for x in lst], "hits": hits, "vals": vals}

    return dates, agree


def events(dates, agree, cfg):
    thr = cfg["impacts"]["min_agreement"]
    out = []
    for h, by_pt in agree.items():
        if not by_pt:
            continue
        n = len(dates)
        day_hit = np.zeros(n, bool)
        for d in by_pt.values():
            f = np.nan_to_num(d["frac"][:n])
            day_hit[: len(f)] |= f >= thr
        i = 0
        while i < n:
            if not day_hit[i]:
                i += 1
                continue
            j = i
            while j + 1 < n and day_hit[j + 1]:
                j += 1
            hits, best_frac, best_n = [], 0.0, 0
            for pname, d in by_pt.items():
                f = np.nan_to_num(d["frac"][i: j + 1])
                if len(f) and f.max() >= thr:
                    k = int(np.argmax(f))
                    pk = d["peak"][i + k]
                    hits.append((pname, float(f.max()), float(pk)))
                    if f.max() > best_frac:
                        best_frac, best_n = float(f.max()), int(d["n"][i + k])
            hits.sort(key=lambda x: -x[1])
            label, _, unit = HAZARDS[h]
            out.append({
                "hazard": h, "label": label, "unit": unit,
                "start": dates[i], "end": dates[j],
                "points": hits, "agreement": best_frac, "n_models": best_n,
                "level": "likely" if best_frac >= 0.6 else "possible",
            })
            i = j + 1
    out.sort(key=lambda e: (e["start"], -e["agreement"]))
    return out


def timeline(dates, agree):
    """hazard x day matrix of the max agreement across points, and for each cell the location it
    comes from with each model's value there and whether it crossed the threshold."""
    rows, labels, detail = [], [], []
    for h, by_pt in agree.items():
        if not by_pt:
            continue
        names = list(by_pt)
        fr = np.vstack([np.nan_to_num(np.pad(by_pt[n]["frac"][: len(dates)], (0, max(0, len(dates) - len(by_pt[n]["frac"]))),
                                             constant_values=np.nan)) for n in names])
        m = fr.max(axis=0)
        if m.max() < 0.1:  # nothing worth a row
            continue
        rows.append(m)
        labels.append(HAZARDS[h][0])
        low = h in ("hard_freeze", "freezing_precip")
        cells = []
        for k in range(len(dates)):
            if m[k] <= 0:
                cells.append(None)
                continue
            # the most affected location: the highest agreement, then the worst peak
            cand = [n for i, n in enumerate(names) if fr[i, k] == m[k]]
            pk = lambda n: by_pt[n]["peak"][k] if k < len(by_pt[n]["peak"]) and not np.isnan(by_pt[n]["peak"][k]) else np.nan
            best = min(cand, key=pk) if low else max(cand, key=lambda n: np.nan_to_num(pk(n), nan=-1e9))
            d = by_pt[best]
            mods = []
            for j, lab in enumerate(d["models"]):
                if k >= d["hits"].shape[1] or np.isnan(d["hits"][j, k]):
                    continue
                v = d["vals"][j, k]
                mods.append([lab, None if np.isnan(v) else round(float(v), 2), bool(d["hits"][j, k])])
            cells.append({"point": best, "models": mods})
        detail.append(cells)
    return labels, (np.vstack(rows) if rows else np.zeros((0, len(dates)))), detail
