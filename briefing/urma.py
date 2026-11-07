"""What the temperature actually did: daily highs and lows at the forecast locations from URMA,
NOAA's 2.5 km Un-Restricted Mesoscale Analysis (the RTMA re-run about six hours later, once
late observations are in; NWS verifies its own gridded forecasts against it).

A day is the briefing's 12Z – 12Z day, like the model highs and lows: the high and low of the 24
hourly analyses after its 12Z start. Hourly snapshots can miss a peak between hours, so highs run
slightly cool and lows slightly warm, typically by under a degree.

Each hourly file holds the whole CONUS grid; only the 2 m temperature field is fetched (a byte
range of about 6 MB). Days already in an earlier briefing's `observedTemps` are reused, so a run
only fetches the days it hasn't seen, at most `max_new` of them, newest first.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import report

log = logging.getLogger(__name__)

LAG_H = 8              # URMA's analysis for hour H is on S3 about 7 hours later
MIN_HOURS = 20         # a day needs this many of its 24 hourly analyses
MAX_KM = 5             # a location farther than this from the nearest grid cell (off the grid) is left out
K_TO_F = lambda k: (k - 273.15) * 9 / 5 + 32


def wanted_days(now: datetime, ndays: int) -> list[date]:
    """The last `ndays` complete 12Z – 12Z days whose analyses should be out by `now` (UTC)."""
    now = now.astimezone(timezone.utc).replace(tzinfo=None)
    last = (now - timedelta(hours=24 + LAG_H)).date()
    if datetime(last.year, last.month, last.day, 12) + timedelta(hours=24 + LAG_H) > now:   # its end plus the lag
        last -= timedelta(days=1)
    return [last - timedelta(days=k) for k in range(ndays - 1, -1, -1)]


def _cached(earlier) -> dict[tuple[str, str], tuple]:
    """(point, day) -> (high, low) from earlier briefings' observedTemps."""
    out = {}
    for b in earlier:
        ot = b.get("observedTemps") or {}
        for k, d in enumerate(ot.get("dates") or []):
            for p, hi in (ot.get("tmax") or {}).items():
                lo = (ot.get("tmin") or {}).get(p) or []
                if k < len(hi) and hi[k] is not None and k < len(lo) and lo[k] is not None:
                    out[(p, str(d)[:10])] = (hi[k], lo[k])
    return out


def _hour(valid: datetime, dom):
    """lat, lon, °F for one hourly analysis, cut to the domain."""
    from herbie import Herbie

    from .grib import _crop, _retry
    H = _retry(Herbie, valid, model="urma", product="anl", priority=["aws", "nomads"], verbose=False)
    da = _retry(H.xarray, ":TMP:2 m above ground:anl", remove_grib=True)
    da = da[list(da.data_vars)[0]] if hasattr(da, "data_vars") else da
    lat, lon, v = _crop(da, dom)
    return lat, lon, K_TO_F(v)


def _fetch_day(d: date, points, dom):
    """{point: (high, low)} for one 12Z – 12Z day, or {} when too few hours are out."""
    from .grib import nearest_index
    start = datetime(d.year, d.month, d.day, 12)
    hours = [start + timedelta(hours=h) for h in range(1, 25)]

    def one(t):
        try:
            return _hour(t, dom)
        except Exception as e:
            log.info("URMA %s: skipped (%s)", t.strftime("%Y-%m-%d %HZ"), report.short(e))
            return None
    with ThreadPoolExecutor(6) as ex:
        res = [r for r in ex.map(one, hours) if r is not None]
    if len(res) < MIN_HOURS:
        log.warning("URMA %s: only %d of 24 hours", d, len(res))
        return {}
    lat, lon = res[0][0], res[0][1]
    idx = nearest_index(lat, lon, points)
    stack = np.stack([r[2] for r in res])                       # [hour, y, x]
    out = {}
    for p, (i, j) in zip(points, idx):
        km = 111.0 * np.hypot(lat[i, j] - p["lat"], (lon[i, j] - p["lon"]) * np.cos(np.deg2rad(p["lat"]))) if lat.ndim == 2 else 0
        if km > MAX_KM:
            continue
        s = stack[:, i, j]
        if np.isfinite(s).sum() >= MIN_HOURS:
            out[p["name"]] = (round(float(np.nanmax(s)), 1), round(float(np.nanmin(s)), 1))
    return out


def collect(cfg, earlier, now: datetime | None = None, ndays: int = 14, max_new: int = 5, demo: bool = False):
    """{source, dates, tmax: {point: [..]}, tmin: {point: [..]}} for the last `ndays` complete days."""
    points = cfg["points"]
    days = wanted_days(now or datetime.now(timezone.utc), ndays)
    have = _cached(earlier)
    if demo:
        from .demo import observed_temps
        have.update(observed_temps(earlier, days))
    missing = [] if demo else [d for d in reversed(days) if not any((p["name"], d.isoformat()) in have for p in points)][:max_new]
    for d in missing:
        got = _fetch_day(d, points, cfg["domain"])
        log.info("URMA %s: %d locations", d, len(got))
        for p, v in got.items():
            have[(p, d.isoformat())] = v
    keep = [d.isoformat() for d in days if any((p["name"], d.isoformat()) in have for p in points)]
    if not keep:
        return None
    col = lambda k: {p["name"]: [have.get((p["name"], d), (None, None))[k] for d in keep] for p in points}
    return {"source": "URMA", "dates": keep, "tmax": col(0), "tmin": col(1)}
