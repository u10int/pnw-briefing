"""Rule-based weather-impact detection with multi-model agreement.

For each hazard, point and day, count the fraction of models exceeding the
threshold. Days where any point reaches `min_agreement` are grouped into
events so the briefing can say e.g. "Heavy rain, Nov 7–8, Forks/Aberdeen,
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
                return np.where(np.isnan(vals), np.nan, hit.astype(float)), vals

            per["heavy_rain_24h"].append(flag(pr, imp["heavy_rain_24h"][kind]))
            per["heavy_rain_72h"].append(flag(r72, imp["heavy_rain_72h"][kind]))
            per["snow_24h"].append(flag(sn, imp["snow_24h"][kind]))
            per["hard_freeze"].append(flag(tmin, imp["hard_freeze_f"][kind], ge=False))
            per["wind"].append(flag(gust, imp["wind_gust_mph"][kind]))
            per["heat"].append(flag(tmax, imp["heat_f"][kind]))
            if kind != "pass":
                fz = ((tmin <= imp["freezing_precip_f"]) & (tmax <= imp["freezing_precip_f"] + 4)
                      & (pr >= 0.05) & (np.nan_to_num(ra) > 0))
                per["freezing_precip"].append((np.where(np.isnan(tmin), np.nan, fz.astype(float)), tmin))

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
            agree[h][name] = {"frac": frac, "n": nmod, "peak": peak}

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
    """hazard x day matrix of the max agreement across points."""
    rows, labels = [], []
    for h, by_pt in agree.items():
        if not by_pt:
            continue
        m = np.vstack([np.nan_to_num(d["frac"][: len(dates)]) for d in by_pt.values()]).max(axis=0)
        if m.max() < 0.1:  # nothing worth a row
            continue
        rows.append(m)
        labels.append(HAZARDS[h][0])
    return labels, (np.vstack(rows) if rows else np.zeros((0, len(dates))))
