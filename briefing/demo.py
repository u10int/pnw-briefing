"""Synthetic but meteorologically shaped data for offline tests of the whole pipeline.

Mid-period atmospheric river, orographic enhancement on the coast, Olympics and
Cascades, a colder spell late with pass snow and a lowland freeze. Regional
models get rotated 2-D grids so the projected-grid code path is exercised.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np

from .grib import day0, day_bounds, day_dates, first_day_hours, nearest_index, point_hourly

RNG = np.random.default_rng(7)
# For faking "yesterday's" briefing: issued a day earlier, same weather on the same dates,
# a bit drier overall so the change view has something to show.
DAY_OFFSET = 0
SCALE = 1.0


def reset(day_offset: int = 0, scale: float = 1.0, seed: int = 7):
    global RNG, DAY_OFFSET, SCALE
    RNG, DAY_OFFSET, SCALE = np.random.default_rng(seed), day_offset, scale


def _start(cfg):
    return day0(cfg) - timedelta(days=DAY_OFFSET)


def _terrain(la, lo):
    coast = np.exp(-((lo + 123.9) / 0.45) ** 2) * 1.2
    olympics = np.exp(-(((lo + 123.6) / 0.35) ** 2 + ((la - 47.8) / 0.35) ** 2)) * 1.6
    cascades = np.exp(-((lo + 121.6) / 0.35) ** 2) * 1.5
    shadow = np.exp(-(((lo + 122.8) / 0.25) ** 2 + ((la - 48.2) / 0.3) ** 2)) * -0.55
    east = np.clip((lo + 120.95) * 3.0, 0, None)
    ocean = np.where(lo < -124.3, 0.6, 1.0)
    return np.clip((0.45 + coast + olympics + cascades + shadow - east) * ocean, 0.08, None)


def _shape(ndays, shift, scale):
    d = np.arange(ndays)
    base = 0.35 + 0.25 * np.sin(d / 2.2)
    ar = 1.6 * np.exp(-((d - (4 + DAY_OFFSET + shift)) / 1.1) ** 2)
    late = 0.8 * np.exp(-((d - (10 + DAY_OFFSET + shift)) / 1.5) ** 2)
    return np.clip((base + ar + late) * scale * SCALE * 0.55 + RNG.normal(0, 0.08, ndays), 0, None)


def _grid(dom, spec):
    if spec.get("tier") == "global":
        lat = np.arange(dom["lat_min"], dom["lat_max"] + 1e-6, 0.25)
        lon = np.arange(dom["lon_min"], dom["lon_max"] + 1e-6, 0.25)
        return lat, lon, *np.meshgrid(lat, lon, indexing="ij")
    res = 0.03 if spec["id"] != "nbm" else 0.025
    y, x = np.meshgrid(np.arange(dom["lat_min"] - 1, dom["lat_max"] + 1, res * 1.6),
                       np.arange(dom["lon_min"] - 1.5, dom["lon_max"] + 1.5, res * 2.2), indexing="ij")
    rot = np.deg2rad(8)  # a slight rotation, like a Lambert grid
    cx, cy = x.mean(), y.mean()
    lo = cx + (x - cx) * np.cos(rot) - (y - cy) * np.sin(rot) * 1.4
    la = cy + (x - cx) * np.sin(rot) / 1.4 + (y - cy) * np.cos(rot)
    return la, lo, la, lo


def grib(cfg):
    dom, n = cfg["domain"], cfg["days"]
    start = _start(cfg)
    tz = ZoneInfo(cfg["timezone"])
    dates = day_dates(start, n, tz)
    out = []
    for spec in cfg["grib_models"]:
        nd = spec["range_days"] if spec["id"] != "ifs" else 9
        lat, lon, la, lo = _grid(dom, spec)
        terr = _terrain(la, lo)
        shp = _shape(n, RNG.normal(0, 0.5), RNG.uniform(0.85, 1.2))[:nd]
        daily = shp[:, None, None] * terr[None] * 25.4 * (1 + RNG.normal(0, 0.06, terr.shape))
        daily[0] *= first_day_hours(start) / 24            # a later cycle's first day is only the rest of it
        cum = np.concatenate([np.zeros_like(daily[:1]), np.cumsum(np.clip(daily, 0, None), axis=0)])
        cold = np.clip((np.exp(-((lo + 121.45) / 0.28) ** 2) * (1.1 + 0.3 * np.sin(la * 3.1))
                        + np.exp(-(((lo + 123.6) / 0.25) ** 2 + ((la - 47.8) / 0.25) ** 2)) - 0.35) * 0.45, 0, None)
        snow = cum / 25.4 * 10 * cold[None] * np.linspace(0.2, 1.0, nd + 1)[:, None, None]
        snow = None if spec["id"] == "aifs" else snow

        idx = nearest_index(lat, lon, cfg["points"])
        data = {}
        for p, (i, j) in zip(cfg["points"], idx):
            pr = np.diff(cum[:, i, j]) / 25.4
            sn = np.diff(snow[:, i, j]) if snow is not None else np.full(nd, np.nan)
            base = {"lowland": 50, "coast": 52, "pass": 35}[p["kind"]]
            d = np.arange(nd)
            tmax = base - np.where(d >= 8, 5 + (d - 8) * 0.8, 0) + RNG.normal(0, 1.5, nd)
            tmin = tmax - RNG.uniform(7, 11, nd) - (2.5 if p["kind"] == "lowland" else 0) * (d >= 11)
            gust = 18 + 22 * np.exp(-((d - 4) / 0.8) ** 2) * (1.5 if p["kind"] == "coast" else 1) + RNG.normal(0, 3, nd)
            wind = 0.62 * gust + RNG.normal(0, 1.5, nd)
            # drier and windier mid-period (an offshore push), humid at the coast
            rhmin = np.clip(62 - 22 * np.exp(-((d - 6) / 1.5) ** 2) - (8 if p["kind"] == "pass" else 0)
                            + (12 if p["kind"] == "coast" else 0) + RNG.normal(0, 4, nd), 8, 100)
            vpd = 6.112 * np.exp(17.67 * ((tmax - 32) * 5 / 9) / ((tmax - 32) * 5 / 9 + 243.5)) * (1 - rhmin / 100)
            hdw = vpd * wind / 2.237
            smoke = np.where(np.arange(nd) < 2, np.clip(8 + 30 * np.exp(-((d - 1) / 0.7) ** 2) + RNG.normal(0, 3, nd), 0, None),
                             np.nan) if spec.get("tier") == "regional" else np.full(nd, np.nan)
            if spec.get("gust") is False:
                gust = np.full(nd, np.nan)
            row = {"precipitation_sum": pr, "rain_sum": np.clip(pr - np.nan_to_num(sn) / 10, 0, None),
                   "snowfall_sum": sn, "temperature_2m_max": tmax, "temperature_2m_min": tmin,
                   "wind_gusts_10m_max": gust, "wind_speed_10m_max": wind,
                   "relative_humidity_2m_min": rhmin, "hdw_max": hdw, "smoke_max": smoke}
            data[p["name"]] = {k: list(np.concatenate([v, np.full(n - nd, np.nan)])) for k, v in row.items()}
        run = start - timedelta(hours=0 if spec.get("tier") != "global" else 12)
        lead0 = int((start - run).total_seconds() // 3600)
        flds = _fields(spec, la, lo, lead0, nd, _outside(cfg, spec))
        hourly = point_hourly(flds, la, lo, idx, cfg["points"], run, lead0, lead0 + 54)
        out.append({"id": spec["id"], "label": spec["label"], "source": "grib", "tier": spec.get("tier", "global"),
                    "run": run, "lead0": lead0, "range_days": nd, "targets": day_bounds(lead0, nd, first_day_hours(start)),
                    "dates": dates, "data": data,
                    "lat": lat, "lon": lon, "precip_mm": cum, "snow_in": snow,
                    "snow_method": "model snowfall (ASNOW)" if spec["family"] == "ncep" else "snowfall water equivalent at 10:1",
                    "fields": flds, "hourly": hourly,
                    "ivt": _ivt(spec, lat, lon, lead0, nd) if spec.get("ivt") else None})
    return out


def _ivt(spec, lat, lon, lead0, nd):
    """A plume of water vapour transport aimed at the coast around day 4, peaking near 800 kg/m/s."""
    la, lo = np.meshgrid(lat, lon, indexing="ij") if lat.ndim == 1 else (lat, lon)
    hours = list(range(lead0 + 6, lead0 + 24 * nd + 1, 6))
    peak = 820 if spec["id"] == "gfs" else 700
    u, v = [], []
    for h in hours:
        d = (h - lead0) / 24
        amp = 180 + peak * np.exp(-((d - 4.2 - DAY_OFFSET) / 0.9) ** 2) + 380 * np.exp(-((d - 9.5) / 0.7) ** 2)
        band = np.exp(-((la - (46.5 + 0.4 * np.sin(d))) / 1.4) ** 2)
        mag = amp * band * np.clip(1 - (lo + 121) / 4, 0.2, 1)
        u.append(mag * 0.8)
        v.append(mag * 0.6)
    return {"hours": hours, "lat": lat, "lon": lon, "u": np.stack(u).astype("float32"), "v": np.stack(v).astype("float32")}


def observed_days(cfg, ndays):
    """Synthetic past daily precipitation (inches) on a 0.03° grid: a wet spell a week ago."""
    dom = cfg["domain"]
    lat = np.arange(dom["lat_min"], dom["lat_max"], 0.03)
    lon = np.arange(dom["lon_min"], dom["lon_max"], 0.03)
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    terr = _terrain(la, lo)
    rng = np.random.default_rng(11)
    days = []
    for k in range(ndays):
        wet = 0.15 + 0.9 * np.exp(-((k - (ndays - 9)) / 2.0) ** 2) + 0.3 * rng.random()
        days.append((terr * wet * 0.6 * rng.uniform(0.6, 1.4)).astype("float32"))
    out = np.stack(days)
    out[ndays - 13] = np.nan                                      # one missing day, as MRMS sometimes has
    return lat, lon, out


def _elev_ft(la, lo):
    """Rough terrain height: Cascades and Olympics."""
    return (6000 * np.exp(-((lo + 121.55) / 0.3) ** 2) * (1 + 0.25 * np.sin(la * 4))
            + 5000 * np.exp(-(((lo + 123.6) / 0.3) ** 2 + ((la - 47.8) / 0.3) ** 2)))


def _outside(cfg, spec):
    """Gradient stations north of the map; the regional models' grids don't reach them."""
    from .grib import outside_sites
    return [] if spec.get("tier") == "regional" else outside_sites(cfg)


def _fields(spec, la, lo, lead0, nd, sites=()):
    """Synthetic time-stepped fields in display units: a Pacific low tracking inland with a trailing
    cold front, snow in the Cascades behind it, and a pocket of freezing rain in the Columbia Gorge."""
    from .fields import _wanted
    stepped, hourly, hourly_hours = _wanted(spec)
    step = spec.get("sample_hours", 6)
    s_hours = list(range(lead0, lead0 + 24 * nd + 1, step))
    h_hours = list(range(lead0 + 1, lead0 + min(hourly_hours, 24 * nd) + 1)) if hourly else []
    elev = _elev_ft(la, lo)
    gorge = np.exp(-(((lo + 121.95) / 0.25) ** 2 + ((la - 45.65) / 0.08) ** 2))
    noise = np.random.default_rng(3).normal(0, 1, (6,) + la.shape)

    def state(h):
        t = (h - lead0) % 120                      # a new system every five days
        lon_c, lat_c = -131 + 0.18 * t, 47.6 + 0.015 * t
        dx, dy = (lo - lon_c) * np.cos(np.deg2rad(47)), la - lat_c
        e = np.exp(-(dx ** 2 + dy ** 2) / 3.5 ** 2)
        mslp = 1019 - 21 * e
        k = 1.25 * (1 - 0.35 * np.clip(elev / 4000, 0, 1))
        u, v = -k * 21 * 2 * dy / 3.5 ** 2 * e * 9, k * 21 * 2 * dx / 3.5 ** 2 * e * 9 + 4
        local = (h - lead0 + 4) % 24                # hours after 4 AM local
        cold = (h - lead0) / 24 > 8
        front = lon_c + 2.6 - 0.45 * (la - lat_c)
        behind = np.clip((front - lo) / 1.2, 0, 1)
        t_sl = 49 + 6 * np.sin(2 * np.pi * (local - 6) / 24) + 4 * (1 - behind) - 7 * behind - (6 if cold else 0)
        t2m = t_sl - 3.5 * elev / 1000 - 9 * gorge * (t < 30)
        frz = np.clip(3000 + 260 * (t_sl - 40), 0, None)
        band = np.exp(-((lo - front) / 0.35) ** 2) * (la > lat_c - 5)
        refc = 44 * band + 10 * band * np.clip(elev / 5000, 0, 1) + 4 * noise[h % 6] * band - 4
        refc += 18 * np.exp(-((lo - (lon_c + 0.6)) ** 2 + (la - lat_c - 0.4) ** 2) / 0.6)   # comma head
        pt = np.zeros_like(refc)
        wet = refc >= 12
        pt[wet] = 1
        pt[wet & (t2m <= 35)] = 5
        pt[wet & (t2m <= 33)] = 2
        pt[wet & (gorge > 0.4) & (t2m < 32)] = 3
        rh = np.clip(95 - 2.4 * (t2m - 40) + 30 * band - 25 * behind * (lo > -122.3), 5, 100)
        smoke = 60 * np.exp(-(((lo + 121.9) / 0.35) ** 2 + ((la - 45.7 - 0.08 * ((h - lead0) % 24)) / 0.5) ** 2)) * (lo < -121.2) \
            + 4 * np.exp(-((lo + 121.9) ** 2 + (la - 45.7) ** 2) / 4)
        return {"t2m": t2m, "gust": np.hypot(u, v) * 1.45 + 6, "u10": u, "v10": v, "mslp": mslp,
                "frz": frz, "refc": np.where(refc >= 5, refc, np.nan), "ptype": pt, "rh": rh, "smoke": smoke}

    out = {}
    names = ["t2m"] + (["gust"] if spec.get("gust", True) else []) + stepped
    for name in dict.fromkeys(names):
        out[name] = {"hours": s_hours, "data": np.stack([state(h)[name] for h in s_hours]).astype("float32")}
    for name in hourly:
        if name == "gust" and spec.get("gust", True) is False:
            continue
        hrs = sorted(set(out.get(name, {}).get("hours", [])) | set(h_hours))   # hourly merged with stepped
        out[name] = {"hours": hrs, "data": np.stack([state(h)[name] for h in hrs]).astype("float32")}
    # running precipitation and snowfall totals on the map time axis, from the reflectivity band
    # (about 0.15 in/h in the heaviest cores) and the type, snow at 10:1
    acc_hours = sorted({h for v in out.values() for h in v["hours"]} - {lead0})
    p_run, s_run, prev, p_acc, s_acc = np.zeros_like(la), np.zeros_like(la), lead0, [], []
    for h in acc_hours:
        st = state(h)
        rate = 0.15 * np.clip((np.nan_to_num(st["refc"]) - 12) / 38, 0, 1) * (h - prev)
        p_run = p_run + rate
        s_run = s_run + np.where(np.isin(st["ptype"], (2, 5)), rate * 10, 0) * np.where(st["ptype"] == 5, 0.5, 1)
        p_acc.append(p_run)
        s_acc.append(s_run)
        prev = h
    if acc_hours:
        out["apcp"] = {"hours": acc_hours, "data": np.stack(p_acc).astype("float32")}
        out["asnow"] = {"hours": acc_hours, "data": np.stack(s_acc).astype("float32")}
    if sites and "mslp" in out:
        # an arctic high building over the B.C. interior around days 8-11 (Fraser outflow)
        hrs = out["mslp"]["hours"]
        d = (np.array(hrs) - lead0) / 24
        hi = 1018 + 2 * np.sin(d) + 17 * np.exp(-((d - 9.5) / 1.6) ** 2)
        out["mslp"]["sites"] = {"names": [p["name"] for p in sites],
                                "data": np.stack([hi for _ in sites], axis=1).astype("float32")}
    return out


def supplement(cfg):
    if not cfg.get("supplement", {}).get("enabled"):
        return []
    n = cfg["days"]
    base = max(grib(cfg), key=lambda m: m["range_days"])
    out = []
    for m, nd in zip(cfg["supplement"]["point_models"], [2, 10, 7, 14, 4, 11]):
        data = {}
        for p, v in base["data"].items():
            s = RNG.uniform(0.75, 1.25)
            d = {}
            for k, arr in v.items():
                a = np.array(arr, dtype=float)
                a = np.where(np.isnan(a), np.nanmean(a), a)
                a = a * s if "sum" in k else a + RNG.normal(0, 1.5, n)
                a[nd:] = np.nan
                d[k] = list(a)
            data[p] = d
        out.append({"id": m["ids"][0], "label": m["label"], "source": "open-meteo", "tier": m.get("tier", "global"),
                    "run": None, "range_days": nd, "dates": base["dates"], "data": data})
    return out


def ensembles(cfg):
    n = cfg["days"]
    start = _start(cfg)
    tz = ZoneInfo(cfg["timezone"])
    dates = day_dates(start, n, tz)
    oro = {"lowland": 1.0, "coast": 2.1, "pass": 2.5}
    specs = [(e["label"], 31 if e["id"] == "gefs" else 51) for e in cfg.get("grib_ensembles", [])]
    if cfg.get("supplement", {}).get("enabled"):
        specs += [(e["label"], 21) for e in cfg["supplement"].get("ensemble_models", [])]
    out = []
    for label, k in specs:
        mem = {p["name"]: np.vstack([_shape(n, RNG.normal(0, 1.2), RNG.uniform(0.5, 1.6)) * oro[p["kind"]]
                                     for _ in range(k)])
               for p in cfg["points"]}
        rec = {"id": label, "label": label, "dates": dates, "members": mem,
               "run": None if label == "Canadian GEPS" else start - timedelta(hours=12)}
        if label != "Canadian GEPS":
            rec["grid"] = _ens_grid(cfg, k, n, snow="ENS" in label)
        out.append(rec)
    return out


def _ens_grid(cfg, k, n, snow):
    """Per-member daily precipitation [member, day, y, x] on a 0.25° grid, terrain-shaped."""
    dom = cfg["domain"]
    lat = np.arange(dom["lat_min"], dom["lat_max"] + 1e-6, 0.25)
    lon = np.arange(dom["lon_min"], dom["lon_max"] + 1e-6, 0.25)
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    terr = _terrain(la, lo)
    rng = np.random.default_rng(5 + k)
    pr = np.stack([_shape(n, rng.normal(0, 1.2), rng.uniform(0.5, 1.6))[:, None, None] * terr[None] * 1.4
                   for _ in range(k)]).astype("float32")
    sn = None
    if snow:
        cold = np.clip(np.exp(-((lo + 121.45) / 0.3) ** 2) * 1.2 - 0.2, 0, None)
        sn = (pr * 10 * cold[None, None] * np.linspace(0.3, 1.0, n)[None, :, None, None]).astype("float32")
    return {"lat": lat, "lon": lon, "precip_in": pr, "snow_in": sn}


def _snow_hist(rng, swe, med, today):
    """30 days building to today's SWE in a few storm steps, with the median rising smoothly."""
    n = 31
    steps = np.sort(rng.random(4)) * n
    frac = np.array([sum(k >= s for s in steps) / 4 for k in range(n)])
    sw = np.round(swe * frac, 1)
    return {"start": (today - timedelta(days=30)).isoformat(), "swe": sw.tolist(),
            "median": np.round(med * np.linspace(0.35, 1, n), 1).tolist(), "depth": np.round(sw * 3.5).tolist()}


def snowpack(cfg):
    """Synthetic early-season snowpack: a little SWE at the high stations, near the median."""
    rng = np.random.default_rng(21)
    today = (_start(cfg)).date()
    areas = []
    for a in cfg["snowpack"]["areas"]:
        sts = []
        for k in range(3):
            elev = 3200 + 900 * k + rng.integers(0, 300)
            med = round(max(0.0, (elev - 3300) / 600 * rng.uniform(0.6, 1.2)), 1)
            swe = round(max(0.0, med * rng.uniform(0.5, 1.6)), 1)
            sts.append({"name": f"{a['name']} {['Lower', 'Mid', 'Upper'][k]}", "triplet": f"demo{k}", "elev_ft": int(elev),
                        "lat": a["lat"], "lon": a["lon"], "date": today.isoformat(), "swe": swe, "median": med,
                        "pct": round(100 * swe / med) if med >= 1 else None, "change7": round(rng.uniform(-0.3, 1.5), 1),
                        "depth": round(swe * 3.5),
                        "hist": _snow_hist(rng, swe, med, today)})
        sts.sort(key=lambda x: -x["elev_ft"])
        tot, totm = sum(x["swe"] for x in sts), sum(x["median"] for x in sts)
        from .snowpack import area_hist
        areas.append({"name": a["name"], "stations": sts, "hist": area_hist([x["hist"] for x in sts], today - timedelta(days=30)), "swe": round(tot / 3, 1), "median": round(totm / 3, 1),
                      "pct": round(100 * tot / totm) if totm / 3 >= 1 else None,
                      "change7": round(sum(x["change7"] for x in sts) / 3, 1)})
    return {"asOf": today.isoformat(), "minMedian": 1.0, "areas": areas,
            "source": "Synthetic snowpack (demo)"}


def outlooks(cfg):
    """Synthetic NWS discussions and outlooks for layout tests."""
    start = _start(cfg)
    iso = (start - timedelta(hours=2)).replace(tzinfo=timezone.utc).isoformat()
    disc = [
        {"office": "SEW", "name": "NWS Seattle", "issued": iso, "url": "https://forecast.weather.gov/product.php?site=SEW&issuedby=SEW&product=AFD",
         "synopsis": ["A series of Pacific systems brings periods of rain, high mountain snow and breezy winds through the "
                      "weekend. A stronger atmospheric river may arrive early next week (demo)."],
         "keyMessages": ["Rain heaviest Saturday into Sunday on the coast and in the Olympics (demo).",
                         "Snow levels fall to pass level by Monday (demo)."],
         "hydrology": ["Rivers stay below flood stage through Sunday; rises are possible next week (demo)."],
         "sections": [
             {"title": "Synopsis", "paragraphs": ["A series of Pacific systems brings periods of rain, high mountain snow and breezy winds through the weekend (demo)."]},
             {"title": "Short term (tonight through Monday)", "paragraphs": [
                 "A warm front lifts north tonight with steady rain on the coast and in the Olympics. The cold front follows Sunday (demo).",
                 "- Gusts to 45 mph on the coast Sunday morning (demo)."]},
             {"title": "Long term (Tuesday through Friday)", "paragraphs": ["Ensembles agree on a stronger atmospheric river midweek (demo)."]},
             {"title": "Aviation", "paragraphs": ["MVFR ceilings with rain; gusty south winds Sunday (demo)."]},
             {"title": "Hydrology", "paragraphs": ["Rivers stay below flood stage through Sunday; rises are possible next week (demo)."]},
         ]},
        {"office": "PQR", "name": "NWS Portland", "issued": iso, "url": "https://forecast.weather.gov/product.php?site=PQR&issuedby=PQR&product=AFD",
         "synopsis": ["Light rain spreads inland this evening; an active pattern continues into next week (demo)."],
         "keyMessages": None, "hydrology": None},
    ]
    pts = [p["name"] for p in cfg["points"]]
    coast = {p["name"] for p in cfg["points"] if p["kind"] in ("coast", "pass")}
    ero = {"names": {1: "Marginal", 2: "Slight", 3: "Moderate", 4: "High"},
           "url": "https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php",
           "days": [{"day": d, "points": {n: (1 if (d in (3, 4) and n in coast) else 0) for n in pts}} for d in range(1, 6)]}
    s1, e1 = (start + timedelta(days=6)).date().isoformat(), (start + timedelta(days=10)).date().isoformat()
    s2, e2 = (start + timedelta(days=8)).date().isoformat(), (start + timedelta(days=14)).date().isoformat()
    cpc = {"url": "https://www.cpc.ncep.noaa.gov/products/predictions/610day/", "outlooks": [
        {"period": "6-10", "var": "temperature", "start": s1, "end": e1, "points": {n: {"cat": "Above", "prob": 50.0} for n in pts}},
        {"period": "6-10", "var": "precipitation", "start": s1, "end": e1, "points": {n: {"cat": "Above", "prob": 60.0} for n in pts}},
        {"period": "8-14", "var": "temperature", "start": s2, "end": e2, "points": {n: {"cat": "Normal", "prob": 33.0} for n in pts}},
        {"period": "8-14", "var": "precipitation", "start": s2, "end": e2, "points": {n: {"cat": "Below", "prob": 40.0} for n in pts}},
    ]}
    return {"discussions": disc, "ero": ero, "cpc": cpc}


def avalanche(cfg):
    """Synthetic NWAC zones mid-season: higher danger on the west slopes after a storm."""
    from .avalanche import LABELS, ORDER
    zones = []
    for k, name in enumerate(ORDER):
        west = name.startswith("West") or name in ("Olympics", "Stevens Pass", "Snoqualmie Pass", "Mt Hood")
        up = 3 if west else 2
        today = {"upper": up, "middle": max(1, up - (0 if k % 3 else 1)), "lower": max(1, up - 1)}
        tomorrow = {b: max(1, v - 1) for b, v in today.items()}
        slug = name.lower().replace(" ", "-")
        zones.append({"id": 3020 + k, "name": name, "state": "OR" if name == "Mt Hood" else "WA", "level": up,
                      "label": LABELS[up], "color": None, "link": f"https://nwac.us/forecasts/avalanche/{slug}",
                      "travelAdvice": None, "offSeason": False, "start": None, "end": None,
                      "warning": "Avalanche warning in effect" if name == "West Slopes Central" else None,
                      "today": today, "tomorrow": tomorrow,
                      "problems": ["Storm Slab", "Wind Slab"] if west else ["Wind Slab"],
                      "bottomLine": "Fresh snow and strong winds have built reactive slabs near and above treeline. "
                                    "Avoid steep, wind-loaded slopes and give cornices a wide berth."})
    return {"center": "NWAC", "url": "https://nwac.us/avalanche-forecast/", "zones": zones, "inSeason": True, "until": None}


def rivers(cfg):
    """Synthetic river gauges for layout tests: one reaching moderate flood, one minor, one action
    stage and a few quiet ones, each with three days observed and a week forecast."""
    import math
    start = _start(cfg).replace(tzinfo=timezone.utc)
    spec = [("SQUW1", "Skykomish River near Gold Bar (demo)", 47.84, -121.69, {"action": 13, "minor": 15, "moderate": 17, "major": 19}, 9.0, 17.6),
            ("MVEW1", "Skagit River near Mt Vernon (demo)", 48.445, -122.334, {"action": 23.5, "minor": 28, "moderate": 30, "major": 32}, 12.0, 28.9),
            ("CGMW1", "Chehalis River near Grand Mound (demo)", 46.78, -123.03, {"action": 14, "minor": 16, "moderate": 17.5, "major": 19}, 9.5, 14.6),
            ("CRNW1", "Snoqualmie River near Carnation (demo)", 47.66, -121.92, {"action": 50, "minor": 54, "moderate": 56, "major": 58}, 44.0, 49.0),
            ("SALO3", "Willamette River at Salem (demo)", 44.94, -123.04, {"action": 25, "minor": 28, "moderate": 30, "major": 32}, 9.0, 13.5),
            ("FSSO3", "Nehalem River near Foss (demo)", 45.70, -123.75, {"action": 14, "minor": 16, "moderate": 18, "major": 20}, 6.0, 12.0)]
    out = []
    for lid, name, lat, lon, cats, base, peak in spec:
        obs = [[(start + timedelta(hours=h)).isoformat().replace("+00:00", "Z"), round(base + 0.3 * math.sin(h / 9), 2)] for h in range(-72, 1)]
        fc = []
        for h in range(0, 24 * 7 + 1, 6):
            rise = (peak - base) * math.exp(-((h - 72) / 30) ** 2)
            fc.append([(start + timedelta(hours=h)).isoformat().replace("+00:00", "Z"), round(base + rise, 2)])
        crest = max(fc, key=lambda x: x[1])
        from .rivers import category
        out.append({"lid": lid, "name": name, "lat": lat, "lon": lon, "wfo": "SEW" if lat > 46 else "PQR", "state": "WA" if lat > 46 else "OR",
                    "units": "ft", "categories": cats, "observed": obs, "forecast": fc, "issued": start.isoformat().replace("+00:00", "Z"),
                    "now": {"stage": obs[-1][1], "time": obs[-1][0], "level": category(obs[-1][1], cats)},
                    "crest": {"stage": crest[1], "time": crest[0], "level": category(crest[1], cats)},
                    "record": {"stage": cats["major"] + 3, "time": "2021-11-16T12:00:00Z"}, "url": f"https://water.noaa.gov/gauges/{lid}"})
    out.sort(key=lambda r: (-(r["crest"]["level"] or 0), r["name"]))
    return {"source": "Demo river forecasts", "gauges": out}


def observed_temps(earlier, days):
    """Synthetic analysed highs and lows: the earliest-lead median forecast of the earlier
    briefings, plus a few degrees of noise, so the demo has temperature verification to show."""
    rng = np.random.default_rng(21)
    want = {d.isoformat() for d in days}
    best = {}                                                   # (point, day) -> (lead, [highs], [lows])
    for b in earlier:
        bd = [str(x)[:10] for x in b.get("dates", [])]
        for k, d in enumerate(bd):
            if d not in want:
                continue
            for m in b.get("models", []):
                for p, s in (m.get("data") or {}).items():
                    hi, lo = (s.get("temperature_2m_max") or [None] * (k + 1)), (s.get("temperature_2m_min") or [None] * (k + 1))
                    if k >= len(hi) or hi[k] is None or k >= len(lo) or lo[k] is None:
                        continue
                    cur = best.get((p, d))
                    if cur is None or k < cur[0]:
                        best[(p, d)] = cur = (k, [], [])
                    if k == cur[0]:
                        cur[1].append(hi[k]); cur[2].append(lo[k])
    return {key: (round(float(np.median(h)) + rng.normal(0.5, 2.5), 1), round(float(np.median(l)) + rng.normal(-0.3, 2.5), 1))
            for key, (_, h, l) in best.items()}


def convective(cfg):
    """A marginal risk over the Olympic Peninsula and coast today, general thunder around it, and a
    couple of storm reports."""
    now = datetime.now(timezone.utc)
    v = now.replace(hour=12, minute=0, second=0, microsecond=0) - (timedelta(days=1) if now.hour < 12 else timedelta(0))
    ring = lambda pts: {"type": "MultiPolygon", "coordinates": [[pts + [pts[0]]]]}
    tstm = ring([[-125.5, 46.2], [-122.2, 46.2], [-121.6, 48.9], [-125.2, 49.0]])
    mrgl = ring([[-125.0, 46.8], [-123.4, 46.8], [-123.0, 48.4], [-124.9, 48.5]])
    from .wildfire import _inside
    areas = [{"kind": "cat", "label": "MRGL", "name": "Marginal Risk", "dn": 3, "rank": 2, "sig": False, "fill": "#66A366",
              "stroke": "#005500", "points": _inside(mrgl, cfg), "geometry": mrgl},
             {"kind": "cat", "label": "TSTM", "name": "General Thunderstorms Risk", "dn": 2, "rank": 1, "sig": False,
              "fill": "#C1E9C1", "stroke": "#55BB55", "points": _inside(tstm, cfg), "geometry": tstm},
             {"kind": "wind", "label": "0.05", "name": "5% Severe Wind Risk", "dn": 5, "rank": 5, "sig": False,
              "fill": "#8B4726", "stroke": "#8B4726", "points": _inside(mrgl, cfg), "geometry": mrgl}]
    iso = lambda t: t.isoformat()
    return {"source": "NOAA/NWS Storm Prediction Center (demo)",
            "outlooks": [{"day": 1, "issued": iso(v), "valid": iso(v), "expire": iso(v + timedelta(days=1)), "areas": areas}],
            "reports": [{"type": "wind", "time": iso(now - timedelta(hours=3)), "lat": 47.95, "lon": -124.38, "mag": "62",
                         "location": "Forks", "county": "Clallam", "state": "WA", "comments": "Measured gust (demo)."},
                        {"type": "hail", "time": iso(now - timedelta(hours=5)), "lat": 47.0, "lon": -123.8, "mag": "75",
                         "location": "Aberdeen", "county": "Grays Harbor", "state": "WA", "comments": "Pea to dime size hail (demo)."}]}


def fronts(cfg):
    """A Pacific cold front and occlusion moving onshore: three analyses up to now, then three
    forecast frames."""
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    now -= timedelta(hours=now.hour % 3)
    frames = []
    for k, (h, kind) in enumerate([(-6, "analysis"), (-3, "analysis"), (0, "analysis"), (12, "forecast"), (24, "forecast"), (48, "forecast")]):
        dx = 1.1 * k if h <= 0 else 1.1 * 2 + h / 12 * 2.2
        lo = [-134.0 + dx * 0.6, 50.5]
        frames.append({"kind": kind, "valid": (now + timedelta(hours=h)).isoformat(), **({"day": k - 2} if kind == "forecast" else {}),
                       "fronts": [
                           {"type": "occluded", "coords": [lo, [lo[0] + 2.5, 50.0], [lo[0] + 4.0, 48.8]]},
                           {"type": "cold", "coords": [[lo[0] + 4.0, 48.8], [-128.5 + dx, 46.5], [-130.0 + dx, 43.5], [-133.0 + dx, 40.0]]},
                           {"type": "warm", "coords": [[lo[0] + 4.0, 48.8], [-124.0 + dx * 0.8, 48.0], [-121.0 + dx * 0.8, 46.8]]},
                           {"type": "trough", "coords": [[-136.0 + dx, 47.5], [-138.0 + dx, 44.0]]},
                           {"type": "stationary", "coords": [[-118.0, 51.5], [-114.0, 50.0], [-110.0, 49.5]]},
                       ]})
    return {"source": "NOAA/NWS Weather Prediction Center (demo)", "frames": frames}


def obs_reports(cfg):
    """Three wet, windy days and today so far, with a few storm reports."""
    from zoneinfo import ZoneInfo
    rng = np.random.default_rng(7)
    today = datetime.now(ZoneInfo("America/Los_Angeles")).date()
    days = [today - timedelta(days=k) for k in range(3, -1, -1)]
    st = (cfg.get("obs_reports") or {}).get("stations", {})
    points = {}
    for p in cfg["points"]:
        s = st.get(p["name"])
        if not s:
            continue
        wet = {"coast": 1.6, "pass": 1.4}.get(p["kind"], 0.8)
        precip = [round(float(x), 2) for x in rng.gamma(1.5, wet / 3, 4)]
        precip[-1] = round(precip[-1] / 3, 2)
        snow = [round(float(x)) for x in rng.gamma(1.2, 3, 4)] if s.get("snotel") else [None] * 4
        gust = [None] * 4 if s.get("snotel") else [int(x) for x in rng.integers(18, 55 if p["kind"] == "coast" else 42, 4)]
        base = {"pass": 34, "coast": 52}.get(p["kind"], 50)
        tmax = [int(base + x) for x in rng.integers(-3, 5, 4)]
        tmin = [int(t - x) for t, x in zip(tmax, rng.integers(6, 14, 4))]
        tmax[-1] = None if rng.random() < 0.3 else tmax[-1] - 2          # today so far
        points[p["name"]] = {"precip": precip, "gust": gust, "tmax": tmax, "tmin": tmin,
                             "gustTime": [f"{d.isoformat()}T{int(rng.integers(0, 23)):02d}:15:00" if g else None for d, g in zip(days, gust)],
                             "snow": snow, "stations": [f"{s.get('asos') or s.get('snotel')} (demo)"]}
    now = datetime.now(timezone.utc)
    reports = [
        {"kind": "gust", "type": "Non-Tstm Wnd Gst", "time": (now - timedelta(hours=20)).isoformat(), "lat": 46.97, "lon": -123.94,
         "mag": 62, "unit": "mph", "measured": True, "place": "Hoquiam", "county": "Grays Harbor", "state": "WA", "source": "ASOS",
         "remark": None, "near": "Aberdeen"},
        {"kind": "snow", "type": "Snow", "time": (now - timedelta(hours=14)).isoformat(), "lat": 47.74, "lon": -121.09,
         "mag": 9.0, "unit": "inch", "measured": True, "place": "Stevens Pass", "county": "King", "state": "WA", "source": "Dept of Highways",
         "remark": "24 hour snowfall.", "near": "Stevens Pass"},
        {"kind": "rain", "type": "Heavy Rain", "time": (now - timedelta(hours=10)).isoformat(), "lat": 47.9, "lon": -124.35,
         "mag": 3.12, "unit": "inch", "measured": True, "place": "2 SW Forks", "county": "Clallam", "state": "WA", "source": "CoCoRaHS",
         "remark": "48 hour total.", "near": "Forks"},
        {"kind": "low", "type": "Low Temperature", "time": (now - timedelta(hours=16)).isoformat(), "lat": 47.42, "lon": -121.43,
         "mag": 24, "unit": "F", "measured": None, "place": "Snoqualmie Pass", "county": "King County", "state": None, "source": None,
         "remark": None, "near": "Snoqualmie Pass", "summary": {"office": "SEW", "title": "Low Temperature Reports", "issued": (now - timedelta(hours=12)).isoformat()}},
        {"kind": "low", "type": "Low Temperature", "time": (now - timedelta(hours=17)).isoformat(), "lat": None, "lon": None,
         "mag": 31, "unit": "F", "measured": None, "place": "Corvallis Airport", "county": "Benton County", "state": None, "source": "AWOS",
         "remark": None, "near": "Corvallis", "summary": {"office": "PQR", "title": "Low Temperature Reports", "issued": (now - timedelta(hours=12)).isoformat()}},
        {"kind": "damage", "type": "Non-Tstm Wnd Dmg", "time": (now - timedelta(hours=19)).isoformat(), "lat": 47.6, "lon": -122.3,
         "mag": None, "unit": None, "measured": False, "place": "Seattle", "county": "King", "state": "WA", "source": "Public",
         "remark": "Large tree down across power lines.", "near": "Seattle"},
    ]
    return {"days": [d.isoformat() for d in days], "today": today.isoformat(), "points": points, "reports": reports,
            "reportHours": 48, "source": "demo"}


def coast(cfg):
    """A big westerly swell building on the coast, a gale in the Strait, a king tide at Westport."""
    from zoneinfo import ZoneInfo
    spec = cfg.get("coast") or {}
    rng = np.random.default_rng(11)
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    buoys = []
    for b in spec.get("buoys", []):
        outer = b["area"] == "Outer coast"
        wave = None if b["id"] == "WPOW1" else round(float(rng.uniform(14, 24) if outer else rng.uniform(1, 5)), 1)
        buoys.append({**{k: b[k] for k in ("id", "name", "lat", "lon", "area")}, "time": (now - timedelta(minutes=30)).isoformat(),
                      "wave": wave, "period": None if wave is None else float(rng.integers(12, 17) if outer else rng.integers(4, 7)),
                      "waveDir": 260.0, "wind": int(rng.integers(15, 35)), "gust": int(rng.integers(25, 50)), "windDir": 220.0,
                      "water": int(rng.integers(52, 56)), "waveMax24": None if wave is None else round(wave * 1.15, 1),
                      "gustMax24": int(rng.integers(40, 60)),
                      "spark": [] if wave is None else [round(wave * f, 1) for f in (0.55, 0.6, 0.7, 0.8, 0.9, 1.0, 1.05, 1.1, 1.0)]})
    pt = ZoneInfo("America/Los_Angeles")
    t0 = now.astimezone(pt).replace(hour=0, tzinfo=None)
    times = [t0 + timedelta(hours=h) for h in range(24 * 7)]
    waves = []
    for p in spec.get("wave_points", []):
        base = 18 if p["area"] == "Outer coast" else 3
        h = [round(base * (0.7 + 0.5 * np.exp(-((k - 30) / 18) ** 2) + 0.35 * np.exp(-((k - 110) / 14) ** 2)) * (1 + 0.05 * rng.standard_normal()), 1)
             for k in range(len(times))]
        per = [14.0 if p["area"] == "Outer coast" else 5.0] * len(times)
        daily = {}
        for i, t in enumerate(times):
            d = t.date().isoformat()
            if d not in daily or h[i] > daily[d]["max"]:
                daily[d] = {"date": d, "max": h[i], "period": per[i], "dir": 265.0, "time": t.isoformat(timespec="minutes")}
        waves.append({"name": p["name"], "lat": p["lat"], "lon": p["lon"], "near": p.get("near"), "area": p["area"],
                      "hourly": {"time": [t.isoformat(timespec="minutes") for t in times], "height": h, "period": per, "dir": [265.0] * len(times)},
                      "daily": [daily[d] for d in sorted(daily)]})
    tides = []
    for g in spec.get("tides", []):
        flood = None if g.get("flood") is False or g["name"] == "Garibaldi" else round(float(rng.uniform(12, 16)), 2)
        surge = round(float(rng.uniform(-0.2, 1.4)), 2)
        highs = []
        for k in range(13):
            t = t0 + timedelta(hours=11 + 12.4 * k)
            hgt = round((flood or 12) - (0.4 if g["name"] == "Westport" and k in (4, 6) else rng.uniform(1.5, 4.5)) - surge, 2)
            highs.append({"time": t.isoformat(timespec="minutes"), "height": hgt,
                          "margin": round(flood - hgt - surge, 2) if flood else None})
        tides.append({"id": g["id"], "name": g["name"], "near": g.get("near"), "area": g.get("area"), "flood": flood, "surge": surge, "highs": highs})
    alerts = [
        {"id": "demo-1", "event": "Gale Warning", "severity": "Moderate", "headline": "Gale Warning until Mon 4 PM",
         "onset": now.isoformat(), "ends": (now + timedelta(hours=30)).isoformat(),
         "areaDesc": "West Entrance U.S. Waters Strait Of Juan De Fuca; Central U.S. Waters Strait Of Juan De Fuca", "zones": ["PZZ130", "PZZ131"],
         "sender": "NWS Seattle WA", "url": None},
        {"id": "demo-2", "event": "Hazardous Seas Warning", "severity": "Moderate", "headline": "Hazardous Seas Warning until Tue 4 AM",
         "onset": now.isoformat(), "ends": (now + timedelta(hours=42)).isoformat(),
         "areaDesc": "Coastal waters from Cape Shoalwater WA to Cape Falcon OR out 10 nm", "zones": ["PZZ251", "PZZ271"],
         "sender": "NWS Portland OR", "url": None},
        {"id": "demo-3", "event": "Small Craft Advisory", "severity": "Minor", "headline": "Small Craft Advisory until Mon 10 AM",
         "onset": now.isoformat(), "ends": (now + timedelta(hours=24)).isoformat(),
         "areaDesc": "Puget Sound and Hood Canal; Admiralty Inlet", "zones": ["PZZ135", "PZZ134"], "sender": "NWS Seattle WA", "url": None},
    ]
    return {"fetched": now.isoformat(), "buoys": buoys, "waves": waves, "tides": tides, "marineAlerts": alerts,
            "zonePrefixes": spec.get("marine_zone_prefixes", ["PZZ1", "PZZ2"]), "source": "demo"}
