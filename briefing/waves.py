"""Gridded wave forecast for the map: NOAA's GFS-Wave (WAVEWATCH III), global 0.16° grid.

For each forecast step (hourly through `hourly_hours`, then every `step` hours to `max_hours`) it
reads three records over the map's area: significant wave height (HTSGW), peak period (PERPW)
and the direction the waves come from (DIRPW). Land is missing in the files and stays blank.

Exported for the page:
- time-stepped fields (data/fields/, the hourly map), model "GFS-Wave":
  wave  significant wave height, ft
  wper  peak period, s
  wu/wv the waves' travel, as a vector: deep-water group velocity (g T / 4π, in mph) toward the
        direction they're heading, so the map's particles move with the swell and faster for
        longer periods
- window maxima (data/cogs/, the summary map): highest significant wave height over each
  briefing window the forecast covers, var "waves".
"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import cogs

log = logging.getLogger(__name__)

M_TO_FT = 3.28084
MS_TO_MPH = 2.23694
G = 9.81
RECORDS = {"wave": ":HTSGW:surface:", "wper": ":PERPW:surface:", "wdir": ":DIRPW:surface:"}
CFGRIB = {"wave": ["swh"], "wper": ["perpw"], "wdir": ["dirpw"]}
VARS = {
    "wave": {"label": "Significant wave height", "units": "ft", "scale": 0.01},
    "wper": {"label": "Peak wave period", "units": "s", "scale": 0.01},
    "wu": {"label": "Wave travel (east component)", "units": "mph", "scale": 0.01},
    "wv": {"label": "Wave travel (north component)", "units": "mph", "scale": 0.01},
}
DEFAULTS = {"product": "global.0p16", "hourly_hours": 48, "step": 3, "max_hours": 240, "cycles": [0, 6, 12, 18]}


def hours(spec) -> list[int]:
    h1, step, last = spec["hourly_hours"], spec["step"], spec["max_hours"]
    return list(range(0, h1 + 1)) + list(range(h1 + step, last + 1, step))


def _herbie(spec, run, fxx):
    from herbie import Herbie

    from .grib import _retry
    return _retry(Herbie, run.replace(tzinfo=None), model="gfs_wave", product=spec["product"], fxx=fxx,
                  priority=["aws", "nomads"], verbose=False)


def latest_run(spec, now: datetime, prefer: datetime | None = None):
    """The cycle to use: `prefer` (the GFS run the briefing used) when its last step is there, else
    the latest cycle whose last step is."""
    now = now.replace(tzinfo=None)                       # naive UTC
    cands = ([prefer.replace(tzinfo=None)] if prefer else []) + [
        (now - timedelta(hours=b)).replace(minute=0, second=0, microsecond=0) for b in range(3, 36)]
    for run in cands:
        if run.hour not in spec["cycles"]:
            continue
        try:
            H = _herbie(spec, run, spec["max_hours"])
            if H.grib and H.idx:
                return run
        except Exception as e:      # still being written, or a source without it
            log.info("GFS-Wave %s: not usable (%s)", run.strftime("%HZ"), e)
    return None


def _step(spec, run, fxx, dom):
    """{var: (lat, lon, values)} for one forecast step."""
    from .grib import _crop, _first_var, _retry
    H = _herbie(spec, run, fxx)
    out = {}
    for var, rec in RECORDS.items():
        ds = _retry(H.xarray, re.escape(rec), remove_grib=True)
        try:
            da = _first_var(ds, CFGRIB[var])
        except LookupError:
            da = _first_var(ds)                              # cfgrib named it differently
        out[var] = _crop(da, dom)
    return out


def fetch(cfg, now: datetime, prefer_run: datetime | None = None, workers: int = 8):
    """The wave forecast over the map's area, or None when switched off or unavailable."""
    wcfg = cfg.get("waves") or {}
    if wcfg.get("enabled") is False:
        return None
    spec = {**DEFAULTS, **wcfg}
    run = latest_run(spec, now, prefer_run)
    if run is None:
        log.warning("GFS-Wave: no usable cycle")
        return None
    dom = cfg["domain"]
    # half a degree beyond the map so the edges aren't cut short
    pad = {"lat_min": dom["lat_min"] - 0.5, "lat_max": dom["lat_max"] + 0.5,
           "lon_min": dom["lon_min"] - 0.5, "lon_max": dom["lon_max"] + 0.5}
    hs = hours(spec)
    with ThreadPoolExecutor(workers) as ex:
        steps = list(ex.map(lambda h: _try_step(spec, run, h, pad), hs))
    got = [(h, s) for h, s in zip(hs, steps) if s]
    if not got:
        return None
    lat, lon, _ = got[0][1]["wave"]
    stack = {v: np.stack([s[v][2] for _, s in got]).astype("float32") for v in RECORDS}
    log.info("GFS-Wave %s: %d of %d steps, %d x %d grid", run.strftime("%HZ %-m/%-d"), len(got), len(hs), len(lat), len(lon))
    wave = stack["wave"] * M_TO_FT
    per = stack["wper"]
    # travel: toward (from + 180°), at the deep-water group speed g T / (4π)
    to = np.deg2rad(stack["wdir"] + 180.0)
    cg = G * per / (4 * np.pi) * MS_TO_MPH
    return {"run": run, "hours": [h for h, _ in got], "lat": lat, "lon": lon,
            "wave": wave, "wper": per, "wu": cg * np.sin(to), "wv": cg * np.cos(to)}


def _try_step(spec, run, h, dom):
    try:
        return _step(spec, run, h, dom)
    except Exception as e:
        log.info("GFS-Wave f%03d: %s", h, e)
        return None


def _times(w):
    """Valid times, timezone-aware UTC (runs are naive UTC, as elsewhere in the briefing)."""
    return [(w["run"] + timedelta(hours=h)).replace(tzinfo=timezone.utc) for h in w["hours"]]


def export_fields(w, out_dir: Path) -> list:
    """The hourly map's wave fields, one multi-band COG per variable."""
    if not w:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    times = [t.isoformat() for t in _times(w)]
    run = w["run"].strftime("%HZ %a %-m/%-d")
    manifest = []
    for var, meta in VARS.items():
        rel = f"gfswave_{var}.tif"
        cogs.write_cog(out_dir / rel, w["lat"], w["lon"], w[var], meta["units"], f"GFS-Wave {meta['label'].lower()}",
                       dtype="int16", nodata=-32768, scale=meta["scale"], band_names=times)
        manifest.append({"path": f"fields/{rel}", "model": "GFS-Wave", "tier": "global", "var": var,
                         "units": meta["units"], "scale": meta["scale"], "nodata": -32768, "times": times,
                         "run": run, "init": w["run"].replace(tzinfo=timezone.utc).isoformat()})
    return manifest


def export_cogs(w, windows, start: datetime, out_dir: Path) -> list:
    """Highest significant wave height over each briefing window the forecast reaches."""
    if not w:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    from .grib import day12
    times = _times(w)
    # windows run 12Z – 12Z days from the edition's start (naive UTC), as the totals do
    first = start.replace(tzinfo=timezone.utc)
    day = day12(start).replace(tzinfo=timezone.utc)
    last = times[-1]
    run = w["run"].strftime("%HZ %a %-m/%-d")
    manifest = []
    for win in windows:
        end = day + timedelta(days=win["days"])
        if end > last + timedelta(hours=6):
            continue                                    # the forecast doesn't reach this window's end
        sel = [i for i, t in enumerate(times) if first <= t <= end]
        if not sel:
            continue
        with np.errstate(all="ignore"):
            top = np.nanmax(w["wave"][sel], axis=0)
        rel = f"gfswave_waves_{win['days']}d.tif"
        cogs.write_cog(out_dir / rel, w["lat"], w["lon"], top, "ft", f"GFS-Wave highest waves, {win['label'].lower()}")
        manifest.append({"path": f"cogs/{rel}", "model": "GFS-Wave", "tier": "global", "var": "waves",
                         "days": win["days"], "units": "ft", "run": run})
    return manifest


def summary(w, windows, start: datetime) -> dict | None:
    """What the page needs to know about the wave run (shown with the map)."""
    if not w:
        return None
    t = _times(w)
    return {"model": "GFS-Wave", "run": w["run"].strftime("%HZ %a %-m/%-d"), "first": t[0].isoformat(), "last": t[-1].isoformat(),
            "source": "NOAA GFS-Wave (WAVEWATCH III), global 0.16° grid"}
