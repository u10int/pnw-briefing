"""How wet it has already been: observed precipitation over the past 7 and 30 days from NOAA's
MRMS multi-sensor (radar + gauge, Pass 2) 24-hour QPE, against PRISM 1991–2020 normals.

The 24-hour files ending at 12Z line up with the briefing's 12Z–12Z days. They're read straight
from the public AWS bucket (one ~5 MB gzipped GRIB2 per day), cropped to the domain and
averaged to 0.03°. MRMS covers southern B.C. by radar only, and PRISM normals are US-only, so
percent of normal is blank in Canada.
"""
from __future__ import annotations

import gzip
import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from . import analysis, report

log = logging.getLogger(__name__)
BASE = "https://noaa-mrms-pds.s3.amazonaws.com/CONUS/MultiSensor_QPE_24H_Pass2_00.00"
MM_TO_IN = 1 / 25.4
WINDOWS = (7, 30)
RES = 0.03


def _url(end: datetime) -> str:
    return f"{BASE}/{end:%Y%m%d}/MRMS_MultiSensor_QPE_24H_Pass2_00.00_{end:%Y%m%d-%H%M%S}.grib2.gz"


def _read(end: datetime, dom):
    """One 24-hour total ending at `end` (12Z): (lat, lon, inches) on the native 0.01° grid, or None."""
    import requests
    import xarray as xr
    from .grib import _retry
    r = _retry(requests.get, _url(end), timeout=60)
    if r.status_code == 404:
        return None
    r.raise_for_status()
    with tempfile.NamedTemporaryFile(suffix=".grib2") as tf:
        tf.write(gzip.decompress(r.content))
        tf.flush()
        with xr.open_dataset(tf.name, engine="cfgrib", backend_kwargs={"indexpath": ""}) as ds:
            da = ds[list(ds.data_vars)[0]]
            lat = da["latitude"].values
            lon = ((da["longitude"].values + 180) % 360) - 180
            yi = np.where((lat >= dom["lat_min"]) & (lat <= dom["lat_max"]))[0]
            xi = np.where((lon >= dom["lon_min"]) & (lon <= dom["lon_max"]))[0]
            v = da.isel(latitude=slice(yi.min(), yi.max() + 1), longitude=slice(xi.min(), xi.max() + 1)).values
    v = np.where(v >= 0, v, np.nan).astype("float32") * MM_TO_IN                 # -3 / -1: no coverage
    la, lo = lat[yi.min():yi.max() + 1], lon[xi.min():xi.max() + 1]
    if la[0] > la[-1]:
        la, v = la[::-1], v[::-1]
    return la, lo, v


def _coarsen(lat, lon, v, k=3):
    """Block mean k x k (NaN-aware) for a lighter grid; returns cell-centre coordinates."""
    ny, nx = (v.shape[0] // k) * k, (v.shape[1] // k) * k
    b = v[:ny, :nx].reshape(ny // k, k, nx // k, k)
    with np.errstate(invalid="ignore"), _quiet():
        m = np.nanmean(b, axis=(1, 3))
    return lat[:ny].reshape(-1, k).mean(1), lon[:nx].reshape(-1, k).mean(1), m.astype("float32")


class _quiet:
    def __enter__(self):
        import warnings
        self._w = warnings.catch_warnings()
        self._w.__enter__()
        warnings.simplefilter("ignore", RuntimeWarning)

    def __exit__(self, *a):
        return self._w.__exit__(*a)


def fetch_days(cfg, start: datetime, ndays: int, demo: bool = False):
    """Daily observed totals for the `ndays` 12Z–12Z days before `start` (oldest first):
    (lat, lon, [day, y, x] inches with NaN for missing days, local dates)."""
    tz = ZoneInfo(cfg["timezone"])
    ends = [start - timedelta(days=k) for k in range(ndays, 0, -1)]
    ends = [e + timedelta(days=1) for e in ends]                     # file time = end of the day
    dates = [(e - timedelta(days=1)).replace(tzinfo=timezone.utc).astimezone(tz).date() for e in ends]
    if demo:
        from .demo import observed_days
        lat, lon, stack = observed_days(cfg, ndays)
        return lat, lon, stack, dates
    dom = cfg["domain"]

    def one(e):
        try:
            got = _read(e, dom)
            return None if got is None else _coarsen(*got)
        except Exception as ex:
            log.info("MRMS %s: %s", e.strftime("%Y-%m-%d %HZ"), report.short(ex))
            return None
    with ThreadPoolExecutor(4) as ex:
        res = list(ex.map(one, ends))
    ok = [r for r in res if r is not None]
    if not ok:
        raise RuntimeError("no MRMS days could be read")
    lat, lon = ok[0][0], ok[0][1]
    stack = np.stack([r[2] if r is not None else np.full((lat.size, lon.size), np.nan, "float32") for r in res])
    log.info("MRMS observed precipitation: %d of %d days", len(ok), ndays)
    return lat, lon, stack, dates


def summarize(cfg, start: datetime, cache: Path, demo: bool = False):
    """Observed totals and percent of normal for the past 7 and 30 days, for regions, locations and
    as grids. Returns (summary for briefing.json, grids for maps/COGs)."""
    from .normals import daily_normals
    n = max(WINDOWS)
    lat, lon, daily, dates = fetch_days(cfg, start, n, demo)
    have = np.array([np.isfinite(d).any() for d in daily])
    try:
        nlat, nlon, ndaily = daily_normals(dates, cfg, cache, demo)
        normal_daily = analysis.regrid(nlat, nlon, ndaily, lat, lon)            # [day, y, x] on the MRMS grid
    except Exception as e:
        log.warning("observed: normals unavailable (%s); percent of normal left out", report.short(e))
        normal_daily = None

    from .grib import nearest_index
    idx = nearest_index(lat, lon, cfg["points"])
    masks = {rid: analysis.region_mask(lat, lon, r["polygon"]) for rid, r in cfg["regions"].items()}
    windows, grids = [], {"lat": lat, "lon": lon}
    for w in WINDOWS:
        sel = slice(n - w, n)
        days_ok = have[sel]
        with _quiet():
            obs = np.nansum(daily[sel], axis=0)
            obs = np.where(np.isfinite(daily[sel]).any(0), obs, np.nan)
            norm = (np.nansum(normal_daily[sel][days_ok], axis=0) if normal_daily is not None and days_ok.any() else None)
        with np.errstate(divide="ignore", invalid="ignore"):
            pct = (np.where(norm > 0.05, 100 * obs / norm, np.nan) if norm is not None else None)
        grids[f"obs{w}"], grids[f"pct{w}"] = obs, pct

        def stat(mask_or_idx):
            if isinstance(mask_or_idx, tuple):
                i, j = mask_or_idx
                o = obs[i, j]
                nm = norm[i, j] if norm is not None else np.nan
            else:
                with _quiet():
                    o = np.nanmean(obs[mask_or_idx])
                    nm = np.nanmean(norm[mask_or_idx]) if norm is not None else np.nan
            r = lambda x, d=2: None if not np.isfinite(x) else round(float(x), d)
            has_normal = np.isfinite(nm) and nm > 0.05            # PRISM is US-only: none in Canada
            return {"obs": r(o), "normal": r(nm) if has_normal else None, "pct": r(100 * o / nm, 0) if has_normal else None}

        windows.append({"days": w, "label": f"Past {w} days", "from": dates[n - w], "to": dates[-1],
                        "missingDays": [d for d, ok in zip(dates[sel], days_ok) if not ok],
                        "regions": {rid: stat(m) for rid, m in masks.items()},
                        "points": {p["name"]: stat(ij) for p, ij in zip(cfg["points"], idx)}})
    # the last 30 days at each location, for a small daily chart
    point_daily = {p["name"]: [None if not np.isfinite(daily[t, i, j]) else round(float(daily[t, i, j]), 2)
                               for t in range(n)] for p, (i, j) in zip(cfg["points"], idx)}
    summary = {"source": "NOAA MRMS multi-sensor QPE (Pass 2); PRISM 1991–2020 normals" + (" (synthetic in demo)" if demo else ""),
               "dates": dates, "windows": windows, "daily": point_daily}
    return summary, grids


def export(grids, out_dir: Path):
    """COGs of observed totals and percent of normal; cog-manifest entries."""
    from .cogs import write_cog
    out = []
    for w in WINDOWS:
        for var, key, units, what in (("obs", f"obs{w}", "in", "Observed precipitation"),
                                      ("obspct", f"pct{w}", "%", "Observed precipitation, percent of normal")):
            g = grids.get(key)
            if g is None:
                continue
            rel = f"observed_{var}_{w}d.tif"
            write_cog(out_dir / rel, grids["lat"], grids["lon"], g, units, f"{what}, past {w} days (MRMS)")
            out.append({"path": f"cogs/{rel}", "model": "Observed (MRMS)", "tier": "observed", "var": var,
                        "days": w, "units": units})
    return out
