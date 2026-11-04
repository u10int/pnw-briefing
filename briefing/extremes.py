"""Extremes over a forecast window on each model's own grid: highest and lowest 2 m temperature,
strongest sustained 10 m wind and strongest gust.

Built from the time-stepped samples the pipeline already has (every 3 h for regional models,
every 6 h for global ones), so a peak between output times can be missed: highs and lows may
run a degree or two short of the true extreme. Gusts are the model's own gust field, which for
ECMWF is already the maximum since the previous output step.

`compute(m)` returns {var: ndarray[days, y, x]}, where index d-1 holds the extreme over the
first d 12Z–12Z days, so any window up to the model's range is one lookup.
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


def _cumulative(hours, data, lead0, ndays, fn, closed_hi):
    """Extreme over the first d days for d = 1..ndays. Max uses (start, end], min uses [start, end),
    matching the daily highs and lows at the forecast locations."""
    hours = np.asarray(hours)
    pick = np.fmax if fn == "max" else np.fmin
    reduce = np.nanmax if fn == "max" else np.nanmin
    out, run = [], None
    for d in range(ndays):
        a, b = lead0 + 24 * d, lead0 + 24 * (d + 1)
        sel = ((hours > a) & (hours <= b)) if closed_hi else ((hours >= a) & (hours < b))
        if sel.any():
            with np.errstate(all="ignore"), _quiet():
                day = reduce(data[sel], axis=0)
            run = day if run is None else pick(run, day)
        out.append(run if run is not None else np.full(data.shape[1:], np.nan, dtype="float32"))
    return np.stack(out).astype("float32")


class _quiet:
    """Silence 'All-NaN slice' warnings from cells outside a regional model's domain."""
    def __enter__(self):
        import warnings
        self._w = warnings.catch_warnings()
        self._w.__enter__()
        warnings.simplefilter("ignore", RuntimeWarning)

    def __exit__(self, *a):
        return self._w.__exit__(*a)


def compute(m) -> dict:
    """Window extremes for one GRIB model, from its time-stepped fields (display units)."""
    f = m.get("fields") or {}
    lead0, nd = m.get("lead0"), int(m.get("range_days") or 0)
    if lead0 is None or nd <= 0:
        return {}
    shape = analysis._ll2d(m["lat"], m["lon"])[0].shape
    ok = lambda e: e is not None and len(e["hours"]) and e["data"].shape[-2:] == shape
    out = {}
    t = f.get("t2m")
    if ok(t):
        out["tmax"] = _cumulative(t["hours"], t["data"], lead0, nd, "max", True)
        out["tmin"] = _cumulative(t["hours"], t["data"], lead0, nd, "min", False)
    g = f.get("gust")
    if ok(g):
        out["gust"] = _cumulative(g["hours"], g["data"], lead0, nd, "max", True)
    u, v = f.get("u10"), f.get("v10")
    if ok(u) and ok(v):
        common = sorted(set(u["hours"]) & set(v["hours"]))
        iu = [u["hours"].index(h) for h in common]
        iv = [v["hours"].index(h) for h in common]
        speed = np.hypot(u["data"][iu], v["data"][iv])
        out["wind"] = _cumulative(common, speed, lead0, nd, "max", True)
    elif ok(m.get("wind_speed")):
        w = m["wind_speed"]
        out["wind"] = _cumulative(w["hours"], w["data"], lead0, nd, "max", True)
    missing = [k for k in VARS if k not in out]
    if missing:
        log.info("%s: no window extremes for %s", m["label"], ", ".join(missing))
    return out


def window(m, var, days):
    """The extreme over the first `days` days, or None if the model doesn't cover that window."""
    e = (m.get("extremes") or {}).get(var)
    if e is None or days < 1 or days > e.shape[0]:
        return None
    return e[days - 1]
