"""Extremes over a forecast window on each model's own grid: highest and lowest 2 m temperature,
strongest sustained 10 m wind and strongest gust.

Built from `ext_series` (see grib.extreme_series): values at each model's native output steps,
using the max/min-since-the-previous-output records where the model publishes them, so peaks
between output times are caught. Each entry is (start, end, field): an interval record covers
(start, end]; an instantaneous value has start == end. Without a series (demo data, or a model
whose interval read failed) the time-stepped map fields are used as instantaneous values.

`compute(m)` returns {var: ndarray[days, y, x]}, where index d-1 holds the extreme over the
first d 12Z – 12Z days, so any window up to the model's range is one lookup.
"""
from __future__ import annotations

import logging

import numpy as np

from . import analysis

log = logging.getLogger(__name__)

VARS = {
    "tmax": {"label": "Highest temperature", "short": "High temp", "units": "°F"},
    "tmin": {"label": "Lowest temperature", "short": "Low temp", "units": "°F"},
    "wind": {"label": "Strongest sustained wind", "short": "Wind", "units": "mph"},
    "gust": {"label": "Strongest gust", "short": "Gusts", "units": "mph"},
}


def _in_day(start, end, a, b, kind):
    """Whether an entry belongs to the 12Z – 12Z day (a, b]. Intervals go by their end; an
    instantaneous value at exactly 12Z counts toward the following day's low (as before)."""
    if start < end:
        return a < end <= b
    return (a < end <= b) if kind == "max" else (a <= end < b)


def daily(entries, bounds, kind):
    """Per-day extreme [days, y, x] from (start, end, field) entries, for the days between the
    forecast-hour `bounds` (grib.day_bounds); NaN for days with none."""
    reduce = np.nanmax if kind == "max" else np.nanmin
    shape = entries[0][2].shape
    ndays = len(bounds) - 1
    out = np.full((ndays, *shape), np.nan, dtype="float32")
    for d in range(ndays):
        a, b = bounds[d], bounds[d + 1]
        day = [f for s0, e0, f in entries if _in_day(s0, e0, a, b, kind)]
        if day:
            with _quiet():
                out[d] = reduce(np.stack(day), axis=0)
    return out


def _cumulative(entries, bounds, kind):
    """Extreme over the first d days for d = 1..ndays."""
    per_day = daily(entries, bounds, kind)
    pick = np.fmax if kind == "max" else np.fmin
    return pick.accumulate(per_day, axis=0).astype("float32")


def _from_fields(m):
    """Instantaneous entries from the time-stepped map fields (demo data, or no series)."""
    f = m.get("fields") or {}
    inst = lambda e: [(h, h, e["data"][i]) for i, h in enumerate(e["hours"])] if e and len(e["hours"]) else []
    out = {"tmax": inst(f.get("t2m")), "tmin": inst(f.get("t2m")), "gust": inst(f.get("gust"))}
    u, v = f.get("u10"), f.get("v10")
    if u and v:
        vi = {h: i for i, h in enumerate(v["hours"])}
        out["wind"] = [(h, h, np.hypot(u["data"][i], v["data"][vi[h]])) for i, h in enumerate(u["hours"]) if h in vi]
    return {k: x for k, x in out.items() if x}


class _quiet:
    """Silence 'All-NaN slice' warnings from cells outside a regional model's domain."""
    def __enter__(self):
        import warnings
        self._w = warnings.catch_warnings()
        self._w.__enter__()
        warnings.simplefilter("ignore", RuntimeWarning)

    def __exit__(self, *a):
        return self._w.__exit__(*a)


def _bounds(m):
    """The model's day boundaries in forecast hours (whole days from lead0 for older dicts)."""
    lead0, nd = m.get("lead0"), int(m.get("range_days") or 0)
    if lead0 is None or nd <= 0:
        return None
    return m.get("targets") or [lead0 + 24 * d for d in range(nd + 1)]


def compute(m) -> dict:
    """Window extremes for one GRIB model, in display units (°F, mph)."""
    bounds = _bounds(m)
    if not bounds:
        return {}
    shape = analysis._ll2d(m["lat"], m["lon"])[0].shape
    series = {**_from_fields(m), **(m.get("ext_series") or {})}
    out = {}
    for var in VARS:
        entries = [e for e in series.get(var, []) if e[2].shape == shape]
        if entries:
            out[var] = _cumulative(entries, bounds, "min" if var == "tmin" else "max")
    missing = [k for k in VARS if k not in out]
    if missing:
        log.info("%s: no window extremes for %s", m["label"], ", ".join(missing))
    return out


def daily_temps(m) -> dict:
    """Per-day high and low [days, y, x] (°F) on the model's grid, for departure from normal."""
    bounds = _bounds(m)
    if not bounds:
        return {}
    shape = analysis._ll2d(m["lat"], m["lon"])[0].shape
    series = {**_from_fields(m), **(m.get("ext_series") or {})}
    out = {}
    for var, kind in (("tmax", "max"), ("tmin", "min")):
        entries = [e for e in series.get(var, []) if e[2].shape == shape]
        if entries:
            out[var] = daily(entries, bounds, kind)
    return out


def window(m, var, days):
    """The extreme over the first `days` days, or None if the model doesn't cover that window."""
    e = (m.get("extremes") or {}).get(var)
    if e is None or days < 1 or days > e.shape[0]:
        return None
    return e[days - 1]
