"""NBM probabilities: the National Blend of Models' own calibrated chances of heavy rain and
strong gusts at each forecast location, per 12Z – 12Z day.

NBM publishes probabilities of exceeding fixed amounts in its `qmd` files on AWS (the same bucket
the deterministic NBM comes from). Read at each location's nearest grid cell:

- rain24: 24-hour precipitation ending each 12Z, at or above each of `rain24_in`;
- rain72: 72-hour precipitation ending each 12Z (3 days ending that day), at or above `rain72_in`;
- gust: the chance of a gust at or above each of `gust_mph` at an hour, taken at the hours NBM
  publishes (3-hourly to day 3, 6-hourly after) and the day's highest of those. It is the chance
  at one moment, so the chance of reaching it at some point in the day runs higher.

NBM's gust thresholds are fixed in m/s (17.5, 21.1, 24.7, 28.8 and 32.9: about 39, 47, 55, 64 and
74 mph) and its precipitation thresholds in mm (25.4 = 1″), so the amounts here are ones it
publishes rather than each location's impact threshold. NBM has no 24-hour snowfall
probabilities (only 6-hour), so snow is left out.

Only the needed GRIB messages are downloaded, by byte range from each file's index.
"""
from __future__ import annotations

import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import requests

from .grib import TRANSIENT, _retry, _sample_sites, day12

log = logging.getLogger(__name__)
BASE = "https://noaa-nbm-grib2-pds.s3.amazonaws.com"
MAX_H = 264
MPH = 2.236936
# the gust thresholds NBM publishes (m/s), by the mph we label them with
GUST_MS = {39: 17.4911, 47: 21.0922, 55: 24.6933, 64: 28.8089, 74: 32.9244}
DEFAULT = {"rain24_in": [1, 2, 3], "rain72_in": [3, 5], "gust_mph": [39, 47, 55, 64], "gust_days": 7}


def _url(run: datetime, f: int):
    return f"{BASE}/blend.{run:%Y%m%d/%H}/qmd/blend.t{run:%H}z.qmd.f{f:03d}.co.grib2"


def _get(url, **kw):
    def go():
        r = requests.get(url, timeout=60, **kw)
        if r.status_code == 404:
            return None
        if r.status_code >= 400:
            raise RuntimeError(f"HTTP {r.status_code} for {url}")
        return r
    return _retry(go)


def parse_idx(text):
    """[(offset, end or None, var, level, period, prob threshold or None)] from a GRIB .idx."""
    rows = []
    for ln in text.strip().splitlines():
        p = ln.split(":")
        if len(p) < 6:
            continue
        thr = None
        if len(p) > 6 and p[6].startswith("prob >"):
            try:
                thr = float(p[6][6:])
            except ValueError:
                pass
        rows.append([int(p[1]), None, p[3], p[4], p[5], thr])
    for a, b in zip(rows, rows[1:]):
        a[1] = b[0] - 1
    return rows


def period(a: int, b: int):
    """The .idx text for an accumulation from hour a to b: in days when both fall on whole days."""
    return f"{a // 24}-{b // 24} day acc fcst" if a % 24 == 0 and b % 24 == 0 else f"{a}-{b} hour acc fcst"


def _find(rows, var, period, thr, level="surface"):
    for r in rows:
        if r[2] == var and r[3] == level and r[4] == period and r[5] is not None and abs(r[5] - thr) < 1e-3:
            return r
    return None


def _read(url, row, sites):
    """One message, sampled at the sites (percent)."""
    import xarray as xr
    rng = f"bytes={row[0]}-{'' if row[1] is None else row[1]}"
    r = _get(url, headers={"Range": rng})
    if r is None:
        return None
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "m.grib2"
        f.write_bytes(r.content)
        ds = xr.open_dataset(f, engine="cfgrib", backend_kwargs={"indexpath": ""})
        da = ds[list(ds.data_vars)[0]].load()
        ds.close()
    return _sample_sites(da, sites, max_deg=0.1)


def _run(start: datetime):
    """The latest NBM run at or before the briefing's start whose last needed file is there."""
    for back in range(0, 19, 6):
        run = start - timedelta(hours=back)
        last = next(f for f in range(MAX_H, 0, -1) if (run.hour + f) % 24 == 12)
        try:
            if _get(_url(run, last) + ".idx") is not None:
                return run
        except Exception as e:
            if not TRANSIENT.search(str(e)):
                raise
    return None


def fetch(cfg, start: datetime, dates, demo=False, models=None):
    spec = {**DEFAULT, **(cfg.get("nbm_odds") or {})}
    if spec.get("enabled") is False:
        return None
    sites = [{"name": p["name"], "lat": p["lat"], "lon": p["lon"]} for p in cfg["points"]]
    gust_mph = [g for g in spec["gust_mph"] if g in GUST_MS]
    variables = [{"key": "rain24", "label": "Rain, 24 h", "unit": "in", "thresholds": spec["rain24_in"]},
                 {"key": "rain72", "label": "Rain, 72 h", "unit": "in", "thresholds": spec["rain72_in"]},
                 {"key": "gust", "label": "Gusts", "unit": "mph", "thresholds": gust_mph}]
    if demo:
        return _demo(sites, dates, variables, models or [], start)
    run = _run(start)
    if run is None:
        log.info("NBM probabilities: no run with its files yet")
        return None
    d0 = day12(start)
    nd = len(dates)
    ends = [int((d0 + timedelta(days=k + 1) - run).total_seconds() // 3600) for k in range(nd)]
    # jobs: (var, threshold index, day, url, row)
    idx_cache: dict = {}

    def idx(f):
        if f not in idx_cache:
            r = _get(_url(run, f) + ".idx")
            idx_cache[f] = parse_idx(r.text) if r is not None else []
        return idx_cache[f]

    plan = []
    for k, f in enumerate(ends):
        if f > MAX_H:
            continue
        for var, hrs, ths in (("rain24", 24, spec["rain24_in"]), ("rain72", 72, spec["rain72_in"])):
            if f - hrs < 0:
                continue
            for i, t in enumerate(ths):
                plan.append((var, i, k, f, ("APCP", period(f - hrs, f), t * 25.4, "surface")))
        if k < spec["gust_days"]:
            step = 3 if f <= 84 else 6
            for h in range(max(1, f - 24 + step), f + 1, step):
                for i, g in enumerate(gust_mph):
                    plan.append(("gust", i, k, h, ("GUST", f"{h} hour fcst", GUST_MS[g], "10 m above ground")))
    with ThreadPoolExecutor(8) as ex:
        list(ex.map(idx, sorted({p[3] for p in plan})))

    def one(p):
        var, i, k, f, (v, period, thr, level) = p
        row = _find(idx(f), v, period, thr, level)
        if row is None:
            return p, None
        try:
            return p, _read(_url(run, f), row, sites)
        except Exception as e:
            log.info("NBM %s f%03d: %s", v, f, e)
            return p, None

    with ThreadPoolExecutor(8) as ex:
        got = list(ex.map(one, plan))
    out = {s["name"]: {v["key"]: [[None] * nd for _ in v["thresholds"]] for v in variables} for s in sites}
    n_read = 0
    for (var, i, k, _f, _), vals in got:
        if vals is None:
            continue
        n_read += 1
        for s, x in zip(sites, vals):
            if not np.isfinite(x):
                continue
            cell = out[s["name"]][var][i]
            cell[k] = round(float(x)) if cell[k] is None else max(cell[k], round(float(x)))
    log.info("NBM probabilities: %s run, %d of %d messages", run.strftime("%Y-%m-%d %HZ"), n_read, len(plan))
    if not n_read:
        return None
    return {"run": run.strftime("%Y-%m-%dT%H:00Z"), "dates": [str(d) for d in dates], "variables": variables, "points": out,
            "source": "NOAA National Blend of Models (qmd probabilities, AWS)"}


def _demo(sites, dates, variables, models, start):
    """Chances shaped like the demo models' medians, so the demo card has something to show."""
    nd = min(len(dates), 11)
    def med(name, key):
        xs = np.array([[np.nan if v is None else v for v in (m["data"].get(name, {}).get(key) or [None] * nd)[:nd]] for m in models], dtype=float)
        return np.nanmedian(xs, axis=0) if len(xs) else np.zeros(nd)
    out = {}
    for s in sites:
        rain = np.nan_to_num(med(s["name"], "precipitation_sum"))
        r3 = np.convolve(rain, np.ones(3), "full")[:nd]
        gust = np.nan_to_num(med(s["name"], "wind_gusts_10m_max"))
        def p(x, t, w):
            return [round(float(100 / (1 + np.exp(-(v - t) / w)))) for v in x] + [None] * (len(dates) - nd)
        out[s["name"]] = {
            "rain24": [p(rain, t, 0.3 * t + 0.15) for t in variables[0]["thresholds"]],
            "rain72": [[None, None] + p(r3, t, 0.3 * t + 0.3)[2:] for t in variables[1]["thresholds"]],
            "gust": [p(gust, g, 6)[:7] + [None] * (len(dates) - 7) for g in variables[2]["thresholds"]],
        }
    return {"run": start.strftime("%Y-%m-%dT%H:00Z"), "dates": [str(d) for d in dates], "variables": variables, "points": out,
            "source": "NOAA National Blend of Models (demo: shaped from the demo models)"}
