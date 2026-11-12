"""Departure from normal of the daily high and low: each location's multi-model median against
PRISM 1991 – 2020 normals, by day and averaged over each forecast window, and gridded maps of the
model-mean departure per window.

PRISM normals are for calendar days; the models' days run 12Z – 12Z (4 AM to 4 AM Pacific in
winter), which still holds the afternoon high and the early-morning low of the same date.
B.C. normals come from ClimateNA (see normals.py).
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from . import analysis, report

log = logging.getLogger(__name__)
VARS = {"tmax": ("temperature_2m_max", "High"), "tmin": ("temperature_2m_min", "Low")}


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _nearest_finite(lat, lon, grid, p, max_deg=0.12):
    """Nearest cell with a value (coastal points can fall on an ocean cell), or None."""
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    d = np.hypot(la - p["lat"], (lo - p["lon"]) * np.cos(np.deg2rad(p["lat"])))
    d = np.where(np.isfinite(grid), d, np.inf)
    k = np.unravel_index(np.argmin(d), d.shape)
    return k if d[k] <= max_deg else None


def summarize(models, cfg, cache: Path, demo: bool = False):
    """(summary for briefing.json, normal grids for the maps) or (None, None)."""
    from .normals import daily_temp_normals
    dates = models[0]["dates"]
    try:
        lat, lon, nrm = daily_temp_normals(dates, cfg, cache, demo)
    except Exception as e:
        log.warning("temperature normals unavailable (%s); temperature departures left out", report.short(e))
        return None, None
    nd = len(dates)
    points, normals = {}, {}
    for p in cfg["points"]:
        k = _nearest_finite(lat, lon, nrm["tmax"][0], p)
        rec, nrec = {}, {}
        for var, (key, _) in VARS.items():
            normal = [None] * nd if k is None else [_r(nrm[var][t][k]) for t in range(nd)]
            fc = np.array([[np.nan if v is None else v for v in (m["data"].get(p["name"], {}).get(key) or [])[:nd]]
                           + [np.nan] * max(0, nd - len((m["data"].get(p["name"], {}).get(key) or [])[:nd]))
                           for m in models], dtype=float)                  # [model, day]
            with np.errstate(all="ignore"), report_quiet():
                med = np.nanmedian(fc, 0)
                lo_, hi_ = np.nanmin(fc, 0), np.nanmax(fc, 0)
            n = np.isfinite(fc).sum(0)
            dep = [None if normal[t] is None or not np.isfinite(med[t]) else _r(med[t] - normal[t]) for t in range(nd)]
            rec[var] = {"forecast": [_r(v) for v in med], "low": [_r(v) for v in lo_], "high": [_r(v) for v in hi_],
                        "models": [int(x) for x in n], "departure": dep}
            nrec[var] = normal
        points[p["name"]], normals[p["name"]] = rec, nrec

    def mean(vals):
        v = [x for x in vals if x is not None]
        return _r(sum(v) / len(v)) if v else None

    regions = {}
    for rid in cfg["regions"]:
        names = [p["name"] for p in cfg["points"] if p.get("region") == rid]
        regions[rid] = {var: [mean([points[n][var]["departure"][t] for n in names]) for t in range(nd)] for var in VARS}
    windows = []
    for w in analysis.windows(cfg):
        n = min(w["days"], nd)
        windows.append({"days": w["days"], "label": w["label"],
                        "points": {name: {var: mean(r[var]["departure"][:n]) for var in VARS} for name, r in points.items()},
                        "regions": {rid: {var: mean(r[var][:n]) for var in VARS} for rid, r in regions.items()}})
    log.info("temperature departures: %d locations, %d days", len(points), nd)
    from .normals import SOURCE
    summary = {"source": SOURCE.replace(", 4 km", ", 4 km, interpolated to each day") + (" (synthetic in demo)" if demo else ""),
               "dates": dates, "normals": normals, "points": points, "regions": regions, "windows": windows}
    return summary, {"lat": lat, "lon": lon, **nrm}


class report_quiet:
    def __enter__(self):
        import warnings
        self._w = warnings.catch_warnings()
        self._w.__enter__()
        warnings.simplefilter("ignore", RuntimeWarning)

    def __exit__(self, *a):
        return self._w.__exit__(*a)


def normal_on_model(nlat, nlon, ngrid, mlat, mlon):
    """The PRISM normal [day, y, x] on a model's grid. Where the model is coarser than PRISM's 4 km
    (the global models), each model cell gets the average normal over its area, so a model whose
    terrain is smoothed to 25 km is compared with a normal at the same scale, not with the 4 km
    peaks and valleys it can't resolve. Where it's as fine or finer (HRRR, RRFS, HRDPS), the normal
    is interpolated to its points."""
    nlat, nlon, mlat, mlon = (np.asarray(x) for x in (nlat, nlon, mlat, mlon))
    ngrid = np.asarray(ngrid, dtype="float32")
    nd = ngrid.shape[0]
    if mlat.ndim == 1 and mlat.size > 1 and mlon.size > 1 and \
            np.median(np.abs(np.diff(mlat))) > 1.5 * np.median(np.abs(np.diff(nlat))):
        def edges(c):
            mid = (c[1:] + c[:-1]) / 2
            return np.concatenate([[c[0] - (mid[0] - c[0])], mid, [c[-1] + (c[-1] - mid[-1])]])
        oy, ox = np.argsort(mlat), np.argsort(mlon)
        ey, ex = edges(mlat[oy]), edges(mlon[ox])
        iy, ix = np.searchsorted(ey, nlat) - 1, np.searchsorted(ex, nlon) - 1
        oky, okx = (iy >= 0) & (iy < mlat.size), (ix >= 0) & (ix < mlon.size)
        ny, nx = mlat.size, mlon.size
        IY, IX = np.meshgrid(np.where(oky, iy, 0), np.where(okx, ix, 0), indexing="ij")
        ok = oky[:, None] & okx[None, :]
        cell = (IY * nx + IX)[ok]
        out = np.full((nd, ny, nx), np.nan, "float32")
        for t in range(nd):
            v = ngrid[t][ok]
            f = np.isfinite(v)
            s = np.bincount(cell[f], v[f], ny * nx)
            c = np.bincount(cell[f], minlength=ny * nx)
            with np.errstate(all="ignore"):
                srt = (s / c).reshape(ny, nx)
            res = np.empty_like(srt)
            res[np.ix_(oy, ox)] = srt                    # back to the model's own row and column order
            out[t] = res
        return out
    from scipy.interpolate import RegularGridInterpolator
    la, lo = analysis._ll2d(mlat, mlon)
    pts = np.column_stack([la.ravel(), lo.ravel()])
    oy, ox = np.argsort(nlat), np.argsort(nlon)
    out = np.full((nd, *la.shape), np.nan, "float32")
    for t in range(nd):
        g = ngrid[t][np.ix_(oy, ox)]
        lin = RegularGridInterpolator((nlat[oy], nlon[ox]), g, bounds_error=False, fill_value=np.nan)(pts)
        near = RegularGridInterpolator((nlat[oy], nlon[ox]), g, method="nearest", bounds_error=False, fill_value=np.nan)(pts)
        out[t] = np.where(np.isfinite(lin), lin, near).reshape(la.shape)   # nearest along the coast, where linear meets ocean
    return out


def grids(grib_models, cfg, normal_grid, out_dir: Path):
    """COGs of the model-mean departure of daily highs and lows, averaged over each window."""
    from .cogs import write_cog
    from .extremes import daily_temps
    if not normal_grid:
        return []
    glat, glon = analysis.common_grid(cfg)
    # each model's departure is worked out on its own grid, against the normal at its own scale
    # (see normal_on_model), and only then brought onto the common grid, bilinearly for the
    # regular lat/lon models, so a 0.25° model doesn't land as solid blocks or paint its smoothed
    # terrain as warm peaks and cold valleys
    deps = []
    for m in grib_models:
        dt = m.get("daily_temps") or daily_temps(m)
        if not dt:
            continue
        rec = {}
        for var, g in dt.items():
            if var not in VARS:
                continue
            nm = normal_on_model(normal_grid["lat"], normal_grid["lon"], normal_grid[var], m["lat"], m["lon"])
            k = min(g.shape[0], nm.shape[0])
            with np.errstate(all="ignore"):
                rec[var] = np.asarray(g[:k], dtype="float32") - nm[:k]
        deps.append((m, rec))
    manifest = []
    for w in analysis.windows(cfg):
        n = w["days"]
        for var, (_, word) in VARS.items():
            per = []
            for m, rec in deps:
                d = rec.get(var)
                if d is None or d.shape[0] < n:
                    continue
                with np.errstate(all="ignore"), report_quiet():
                    mean_native = np.nanmean(d[:n], 0)
                per.append((m["label"], analysis.regrid(m["lat"], m["lon"], mean_native, glat, glon)))
            if not per:
                continue
            with np.errstate(all="ignore"), report_quiet():
                mean = np.nanmean(np.stack([g for _, g in per]), 0)
            rel = f"departure_{var}_{n}d.tif"
            write_cog(out_dir / rel, glat, glon, mean, "°F",
                      f"Daily {word.lower()} temperature, model-mean departure from 1991 – 2020 normal, {w['label'].lower()}")
            manifest.append({"path": f"cogs/{rel}", "model": "Departure from normal", "tier": "consensus",
                             "var": f"{var}dep", "days": n, "units": "°F", "members": [l for l, _ in per]})
    log.info("temperature departure maps: %d", len(manifest))
    return manifest
