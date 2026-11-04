"""Window totals, region means, regridding and the headline summary.

Every comparison is made over a window (e.g. the next 2, 7 or 14 days) and
only includes models that cover the whole window, so a 2-day HRRR is never
compared with a 14-day GFS total.
"""
from __future__ import annotations

import numpy as np
from matplotlib.path import Path

MM_TO_IN = 1 / 25.4


def windows(cfg):
    return cfg.get("windows", [{"days": 2, "label": "Next 48 hours"},
                               {"days": 7, "label": "Next 7 days"},
                               {"days": cfg["days"], "label": f"Next {cfg['days']} days"}])


def coverage(m):
    if "range_days" in m and m["range_days"]:
        return int(m["range_days"])
    arr = np.array([m["data"][p]["precipitation_sum"] for p in m["data"]], dtype=float)
    return int(np.sum(~np.all(np.isnan(arr), axis=0)))


# ---------------------------------------------------------------- grids

def _ll2d(lat, lon):
    return np.meshgrid(lon, lat)[::-1] if lat.ndim == 1 else (lat, lon)


def region_mask(lat, lon, polygon):
    la, lo = _ll2d(lat, lon)
    return Path(polygon).contains_points(np.column_stack([lo.ravel(), la.ravel()])).reshape(la.shape)


def common_grid(cfg, res=0.05):
    d = cfg["domain"]
    return np.arange(d["lat_min"], d["lat_max"] + 1e-6, res), np.arange(d["lon_min"], d["lon_max"] + 1e-6, res)


class Regridder:
    """Nearest-neighbour mapping from a model grid onto a regular grid, built once and reused.

    Cells farther than 2.5 source grid spacings from any source cell (outside a regional
    model's domain) come out NaN.
    """

    def __init__(self, lat, lon, glat, glon):
        from scipy.spatial import cKDTree
        la, lo = _ll2d(lat, lon)
        k = np.cos(np.deg2rad(46))
        tree = cKDTree(np.column_stack([la.ravel(), lo.ravel() * k]))
        GL, GO = np.meshgrid(glat, glon, indexing="ij")
        dist, self.idx = tree.query(np.column_stack([GL.ravel(), GO.ravel() * k]))
        spacing = np.median(np.abs(np.diff(la, axis=0))) if la.shape[0] > 1 else 0.25
        self.outside = dist > 2.5 * max(spacing, 0.03)
        self.shape = GL.shape

    def __call__(self, field):
        f = np.asarray(field)
        out = f.reshape(*f.shape[:-2], -1)[..., self.idx].astype("float32")   # works for [y,x] or [t,y,x]
        out[..., self.outside] = np.nan
        return out.reshape(*f.shape[:-2], *self.shape)


def regrid(lat, lon, field, glat, glon):
    """Nearest-neighbour onto a regular grid; good enough for display mean/spread."""
    return Regridder(lat, lon, glat, glon)(field)


def grid_window(m, wdays):
    """Window total grid (in) for a GRIB model, or None if it doesn't cover the window."""
    if "precip_mm" not in m or m["range_days"] < wdays:
        return None
    return m["precip_mm"][wdays] * MM_TO_IN


def grib_region_series(grib_models, cfg):
    """Area-mean cumulative precip (in) per model and region at each day boundary."""
    rows = []
    for m in grib_models:
        series = {}
        for rid, r in cfg["regions"].items():
            mask = region_mask(m["lat"], m["lon"], r["polygon"])
            series[rid] = [float(np.nanmean(f[mask])) * MM_TO_IN for f in m["precip_mm"][1:]]
        rows.append({"label": m["label"], "tier": m.get("tier"), "days": m["range_days"], "series": series})
    return rows


# ---------------------------------------------------------------- points

def point_window_totals(models, cfg, wdays):
    """{label: {point: total}} for models covering the window, plus region averages."""
    totals, region_avg = {}, {}
    for m in models:
        if coverage(m) < wdays:
            continue
        t = {}
        for p, v in m["data"].items():
            a = np.array(v["precipitation_sum"][:wdays], dtype=float)
            t[p] = float(np.sum(a)) if not np.any(np.isnan(a)) else np.nan
        totals[m["label"]] = t
        region_avg[m["label"]] = {rid: float(np.nanmean([t[p["name"]] for p in cfg["points"] if p["region"] == rid]))
                                  for rid in cfg["regions"]}
    return totals, region_avg


def summary(models, ensembles, cfg):
    wins = windows(cfg)
    by_window = []
    for w in wins:
        _, ravg = point_window_totals(models, cfg, w["days"])
        regs = []
        for rid, r in cfg["regions"].items():
            vals = {k: v[rid] for k, v in ravg.items() if np.isfinite(v[rid])}
            if not vals:
                continue
            regs.append({"rid": rid, "region": r["name"], "median": float(np.median(list(vals.values()))),
                         "lo": min(vals.values()), "hi": max(vals.values()),
                         "wettest": max(vals, key=vals.get), "driest": min(vals, key=vals.get), "n": len(vals)})
        by_window.append({**w, "regions": regs})

    # wettest 3-day stretch, consensus of point-averaged daily precip
    dates = models[0]["dates"]
    daily = []
    for m in models:
        a = np.array([m["data"][p["name"]]["precipitation_sum"] for p in cfg["points"]], dtype=float)
        with np.errstate(all="ignore"):
            daily.append(np.nanmean(a, axis=0))
    with np.errstate(all="ignore"):
        daily = np.nanmedian(np.vstack(daily), axis=0)
    roll = np.convolve(np.nan_to_num(daily), np.ones(3), mode="valid")
    i = int(np.argmax(roll))

    plumes = []
    for e in ensembles:
        for p, mem in e["members"].items():
            tot = np.nansum(mem, axis=1)
            plumes.append({"model": e["label"], "point": p, "n": len(tot),
                           **{f"p{q}": float(np.percentile(tot, q)) for q in (10, 50, 90)}})
    models_ = list(dict.fromkeys(p["model"] for p in plumes))
    look = {(p["point"], p["model"]): p for p in plumes}
    locs = list(dict.fromkeys(p["point"] for p in plumes))
    return {"windows": by_window, "wettest_window": (dates[i], dates[i + 2], float(roll[i])),
            "plume_models": models_, "plume_table": [(l, [look.get((l, m)) for m in models_]) for l in locs]}
