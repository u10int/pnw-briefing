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
        out.append({"id": spec["id"], "label": spec["label"], "source": "grib", "tier": spec.get("tier", "global"),
                    "run": run, "range_days": nd, "dates": dates, "data": data,
                    "lat": lat, "lon": lon, "precip_mm": cum, "snow_in": snow,
                    "snow_method": "model snowfall (ASNOW)" if spec["family"] == "ncep" else "snowfall water equivalent at 10:1"})
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
