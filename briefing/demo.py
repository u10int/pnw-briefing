"""Synthetic but meteorologically shaped data for offline tests of the whole pipeline.

Mid-period atmospheric river, orographic enhancement on the coast, Olympics and
Cascades, a colder spell late with pass snow and a lowland freeze. Regional
models get rotated 2-D grids so the projected-grid code path is exercised.
"""
from __future__ import annotations

from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np

from .grib import day0, nearest_index

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
    dates = [(start + timedelta(days=d)).replace(tzinfo=timezone.utc).astimezone(tz).date() for d in range(n)]
    out = []
    for spec in cfg["grib_models"]:
        nd = spec["range_days"] if spec["id"] != "ifs" else 9
        lat, lon, la, lo = _grid(dom, spec)
        terr = _terrain(la, lo)
        shp = _shape(n, RNG.normal(0, 0.5), RNG.uniform(0.85, 1.2))[:nd]
        daily = shp[:, None, None] * terr[None] * 25.4 * (1 + RNG.normal(0, 0.06, terr.shape))
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
            if spec.get("gust") is False:
                gust = np.full(nd, np.nan)
            row = {"precipitation_sum": pr, "rain_sum": np.clip(pr - np.nan_to_num(sn) / 10, 0, None),
                   "snowfall_sum": sn, "temperature_2m_max": tmax, "temperature_2m_min": tmin,
                   "wind_gusts_10m_max": gust}
            data[p["name"]] = {k: list(np.concatenate([v, np.full(n - nd, np.nan)])) for k, v in row.items()}
        run = start - timedelta(hours=0 if spec.get("tier") != "global" else 12)
        lead0 = int((start - run).total_seconds() // 3600)
        out.append({"id": spec["id"], "label": spec["label"], "source": "grib", "tier": spec.get("tier", "global"),
                    "run": run, "range_days": nd, "dates": dates, "data": data,
                    "lat": lat, "lon": lon, "precip_mm": cum, "snow_in": snow,
                    "snow_method": "model snowfall (ASNOW)" if spec["family"] == "ncep" else "snowfall water equivalent at 10:1",
                    "fields": _fields(spec, la, lo, lead0, nd)})
    return out


def _elev_ft(la, lo):
    """Rough terrain height: Cascades and Olympics."""
    return (6000 * np.exp(-((lo + 121.55) / 0.3) ** 2) * (1 + 0.25 * np.sin(la * 4))
            + 5000 * np.exp(-(((lo + 123.6) / 0.3) ** 2 + ((la - 47.8) / 0.3) ** 2)))


def _fields(spec, la, lo, lead0, nd):
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
        return {"t2m": t2m, "gust": np.hypot(u, v) * 1.45 + 6, "u10": u, "v10": v, "mslp": mslp,
                "frz": frz, "refc": np.where(refc >= 5, refc, np.nan), "ptype": pt}

    out = {}
    names = ["t2m"] + (["gust"] if spec.get("gust", True) else []) + stepped
    for name in dict.fromkeys(names):
        out[name] = {"hours": s_hours, "data": np.stack([state(h)[name] for h in s_hours]).astype("float32")}
    for name in hourly:
        out[name] = {"hours": h_hours, "data": np.stack([state(h)[name] for h in h_hours]).astype("float32")}
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
    dates = [(start + timedelta(days=d)).replace(tzinfo=timezone.utc).astimezone(tz).date() for d in range(n)]
    oro = {"lowland": 1.0, "coast": 2.1, "pass": 2.5}
    specs = [(e["label"], 31 if e["id"] == "gefs" else 51) for e in cfg.get("grib_ensembles", [])]
    if cfg.get("supplement", {}).get("enabled"):
        specs += [(e["label"], 21) for e in cfg["supplement"].get("ensemble_models", [])]
    out = []
    for label, k in specs:
        mem = {p["name"]: np.vstack([_shape(n, RNG.normal(0, 1.2), RNG.uniform(0.5, 1.6)) * oro[p["kind"]]
                                     for _ in range(k)])
               for p in cfg["points"] if p.get("plume")}
        out.append({"id": label, "label": label, "dates": dates, "members": mem,
                    "run": None if label == "Canadian GEPS" else start - timedelta(hours=12)})
    return out
