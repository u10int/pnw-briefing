"""1991 – 2020 precipitation and temperature normals from PRISM, for departure-from-normal.

PRISM publishes monthly normals as one grid per month (4 km here). Monthly totals are
spread into daily normals by interpolating between mid-month daily rates, so a window
that crosses a month boundary is handled smoothly.

Grids are cached on disk (the workflow keeps the cache between runs), so PRISM is only
contacted when a new month is needed.
"""
from __future__ import annotations

import calendar
import logging
import time
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import requests

from . import analysis

log = logging.getLogger(__name__)
# Since October 2025 PRISM serves normals from data.prism.oregonstate.edu ("25m" is its code for 4 km).
# The old web-service URL is kept as a fallback.
PRISM_URLS = [
    "https://data.prism.oregonstate.edu/normals/us/4km/{var}/monthly/prism_{var}_us_25m_2020{month:02d}_avg_30y.zip",
    "https://services.nacse.org/prism/data/public/normals/4km/{var}/{month:02d}",
]
MM_TO_IN = 1 / 25.4


def _download(month: int, cache: Path, var: str = "ppt") -> Path:
    """Fetch one month's normal (ppt, tmax or tmin) as a zip, trying each known URL; only a real
    zip is cached."""
    path = cache / f"prism_{var}_normal_4km_{month:02d}.zip"
    if path.exists() and path.read_bytes()[:2] == b"PK":
        return path
    cache.mkdir(parents=True, exist_ok=True)
    problems = []
    for url in PRISM_URLS:
        u = url.format(month=month, var=var)
        try:
            r = requests.get(u, timeout=180, headers={"User-Agent": "pnw-briefing/1.0"})
            time.sleep(2)  # PRISM asks for a pause between requests
            if r.status_code == 200 and r.content[:2] == b"PK":
                path.write_bytes(r.content)
                return path
            snippet = " ".join(r.content[:120].decode("utf-8", "replace").split())
            problems.append(f"{u} -> HTTP {r.status_code}, {r.headers.get('content-type', '?')}: {snippet!r}")
        except requests.RequestException as e:
            problems.append(f"{u} -> {type(e).__name__}")
    raise RuntimeError("PRISM normal not available. " + " | ".join(problems))


def _read(zip_path: Path, dom):
    """Monthly normal (mm) cropped to the domain, as (lat asc, lon asc, grid)."""
    import zipfile

    import rasterio
    from rasterio.windows import Window, from_bounds

    names = zipfile.ZipFile(zip_path).namelist()
    grid_name = next(n for n in names if n.lower().endswith((".bil", ".tif", ".tiff")))
    with rasterio.open(f"/vsizip/{zip_path}/{grid_name}") as src:
        win = from_bounds(dom["lon_min"], dom["lat_min"], dom["lon_max"], dom["lat_max"], src.transform).round_offsets().round_lengths()
        # The domain can extend past the grid (PRISM starts at -125.02°). Clip the window to the grid
        # first: reading an out-of-range window returns clipped data, and labelling it from the
        # unclipped window shifts every cell.
        win = win.intersection(Window(0, 0, src.width, src.height))
        a = src.read(1, window=win, masked=True).astype("float32").filled(np.nan)
        t = src.window_transform(win)
    lon = t.c + t.a * (np.arange(a.shape[1]) + 0.5)
    lat = t.f + t.e * (np.arange(a.shape[0]) + 0.5)
    a[a < -1000] = np.nan  # PRISM nodata
    return lat[::-1], lon, a[::-1]


def _daily_rate(months: dict[int, np.ndarray], d: date) -> np.ndarray:
    """Daily normal for date d, interpolated between mid-month daily rates."""
    def rate(y, m):
        return months[m] / calendar.monthrange(y, m)[1]

    mid = date(d.year, d.month, 15)
    if d >= mid:
        nxt = (d.replace(day=1) + timedelta(days=32)).replace(day=15)
        a, b, t = rate(d.year, d.month), rate(nxt.year, nxt.month), (d - mid).days / (nxt - mid).days
    else:
        prv = (d.replace(day=1) - timedelta(days=1)).replace(day=15)
        a, b, t = rate(prv.year, prv.month), rate(d.year, d.month), (d - prv).days / (mid - prv).days
    return a + (b - a) * t


def daily_normals(dates: list[date], cfg, cache: Path, demo: bool = False):
    """(lat, lon, normals[day, y, x] in inches/day) for the briefing's days."""
    dom = cfg["domain"]
    need = set()
    for d in dates:
        need |= {d.month, ((d.month - 2) % 12) + 1, (d.month % 12) + 1}
    months, lat, lon = {}, None, None
    for m in sorted(need):
        if demo:
            lat, lon, months[m] = _demo_month(m, dom)
        else:
            lat, lon, months[m] = _read(_download(m, cache), dom)
    return lat, lon, np.stack([_daily_rate(months, d) for d in dates]) * MM_TO_IN


def _mid_month(months: dict[int, np.ndarray], d: date) -> np.ndarray:
    """Daily value for date d, interpolated linearly between mid-month normals (temperatures)."""
    mid = date(d.year, d.month, 15)
    if d >= mid:
        nxt = (d.replace(day=1) + timedelta(days=32)).replace(day=15)
        a, b, t = months[d.month], months[nxt.month], (d - mid).days / (nxt - mid).days
    else:
        prv = (d.replace(day=1) - timedelta(days=1)).replace(day=15)
        a, b, t = months[prv.month], months[d.month], (d - prv).days / (mid - prv).days
    return a + (b - a) * t


def daily_temp_normals(dates: list[date], cfg, cache: Path, demo: bool = False):
    """(lat, lon, {"tmax": [day, y, x], "tmin": [day, y, x]}) normal daily high and low in °F."""
    dom = cfg["domain"]
    need = set()
    for d in dates:
        need |= {d.month, ((d.month - 2) % 12) + 1, (d.month % 12) + 1}
    out, lat, lon = {}, None, None
    for var in ("tmax", "tmin"):
        months = {}
        for m in sorted(need):
            if demo:
                lat, lon, months[m] = _demo_temp_month(m, dom, var)
            else:
                lat, lon, months[m] = _read(_download(m, cache, var), dom)
        out[var] = np.stack([_mid_month(months, d) for d in dates]) * 9 / 5 + 32
    return lat, lon, out


def _demo_temp_month(month, dom, var):
    from .demo import _elev_ft
    lat = np.arange(dom["lat_min"], dom["lat_max"], 0.04)
    lon = np.arange(dom["lon_min"], dom["lon_max"], 0.04)
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    season = 11 * np.cos((month - 7.5) / 12 * 2 * np.pi)                # warmest late July
    base = (16 if var == "tmax" else 6) + season - 0.4 * (la - 46)        # °C
    return lat, lon, (base - 2.0 * _elev_ft(la, lo) / 1000).astype("float32")


def _demo_month(month, dom):
    from .demo import _terrain
    lat = np.arange(dom["lat_min"], dom["lat_max"], 0.04)
    lon = np.arange(dom["lon_min"], dom["lon_max"], 0.04)
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    season = 0.55 + 0.45 * np.cos((month - 12) / 12 * 2 * np.pi)   # wettest Nov – Jan
    return lat, lon, (_terrain(la, lo) * 175 * season).astype("float32")  # mm/month


def summarize(models, cfg, cache: Path, demo: bool = False, first: float = 1.0):
    """Normals at points, region averages and percent of normal for each window. `first` is the
    share of the first day the briefing covers (0.25 for a 06Z start), so its normal is scaled."""
    dates = models[0]["dates"]
    try:
        lat, lon, daily = daily_normals(dates, cfg, cache, demo)
    except Exception as e:
        log.warning("normals unavailable (%s); departure from normal is left out", e)
        return None, None
    daily = daily.copy()
    daily[0] *= first
    from .grib import nearest_index
    idx = nearest_index(lat, lon, cfg["points"])
    pts = {p["name"]: [float(daily[t, i, j]) for t in range(len(dates))] for p, (i, j) in zip(cfg["points"], idx)}

    windows = []
    for w in analysis.windows(cfg):
        n = w["days"]
        pn = {p: float(np.nansum(v[:n])) for p, v in pts.items()}
        tot, ravg = analysis.point_window_totals(models, cfg, n)
        region = {}
        for rid in cfg["regions"]:
            names = [p["name"] for p in cfg["points"] if p.get("region") == rid]
            normal = float(np.nanmean([pn[p] for p in names]))
            vals = [v[rid] for v in ravg.values() if np.isfinite(v[rid])]
            med = float(np.median(vals)) if vals else None
            region[rid] = {"normal": normal, "median": med, "pct": (100 * med / normal) if med is not None and normal > 0 else None}
        points = {}
        for p in pts:
            vals = [t[p] for t in tot.values() if t.get(p) is not None and np.isfinite(t[p])]
            med = float(np.median(vals)) if vals else None
            points[p] = {"normal": pn[p], "median": med, "pct": (100 * med / pn[p]) if med is not None and pn[p] > 0 else None}
        windows.append({"days": n, "label": w["label"], "regions": region, "points": points})

    grid = {"lat": lat, "lon": lon, "daily": daily}
    return {"source": "PRISM 1991 – 2020 monthly normals, 4 km" + (" (synthetic in demo)" if demo else ""),
            "points": pts, "windows": windows}, grid
