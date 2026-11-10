"""How unusual the totals are: each location's station history, as the wettest 1-, 3- and 7-day
stretch in every past year over the same part of the year, so the page can say where a forecast
or observed total ranks ("the most for 3 days this time of year since 2007").

Station records come from ACIS (data.rcc-acis.org, NOAA's Regional Climate Centers), one long-record
station per location (config `climo.stations`, an ACIS station id such as a GHCN id). "This time
of year" is a window around the briefing's date, from `before` days before it to `after` days
after (wide enough to hold the 14-day forecast). In each past year, a stretch counts only if every
day in it has a report, and a year counts only if at least `min_share` of its window does; the
current year is left out (its window isn't over).

Histories don't change, so each station's daily record is cached for a month (cache_dir/climo).
"""
from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import requests

log = logging.getLogger(__name__)
ACIS = "https://data.rcc-acis.org/StnData"
SPANS = (1, 3, 7)
DEFAULT = {"before": 30, "after": 45, "min_share": 0.8, "min_years": 20}


def _value(x):
    """ACIS daily precipitation text to inches: "T" is a trace (0), "M" missing, flags dropped.
    "S" (included in a later total) and "A" (an accumulated total) are kept as reported."""
    if x in (None, "", "M"):
        return None
    if x == "T":
        return 0.0
    try:
        return float(str(x).rstrip("ASab"))
    except ValueError:
        return 0.0 if str(x).startswith("S") else None


def _fetch(sid, cache: Path | None):
    f = cache / f"{sid.replace(' ', '_')}.json" if cache else None
    if f and f.exists() and time.time() - f.stat().st_mtime < 30 * 86400:
        return json.loads(f.read_text())
    r = requests.post(ACIS, json={"sid": sid, "sdate": "por", "edate": "por", "elems": [{"name": "pcpn"}],
                                   "meta": ["name", "elev", "ll", "sids"]}, timeout=90)
    r.raise_for_status()
    js = r.json()
    if "error" in js:
        raise RuntimeError(js["error"])
    out = {"meta": js.get("meta", {}), "data": js.get("data", [])}
    if f:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(out))
    return out


def season_maxima(days: list[str], vals: list, center: date, before=30, after=45, min_share=0.8):
    """{year: {n: wettest n-day total}} for each past year with enough reports in its window."""
    if not days:
        return {}
    d0 = date.fromisoformat(days[0])
    v = np.full((date.fromisoformat(days[-1]) - d0).days + 1, np.nan)
    for d, x in zip(days, vals):                            # by date, in case the record skips days
        if x is not None:
            v[(date.fromisoformat(d) - d0).days] = x
    out = {}
    for y in range(d0.year, center.year):
        try:
            c = center.replace(year=y)
        except ValueError:                                  # Feb 29
            c = center.replace(year=y, day=28)
        a, b = (c - timedelta(days=before) - d0).days, (c + timedelta(days=after) - d0).days
        if a < 0 or b >= len(v):
            continue
        w = v[a: b + 1]
        if np.isfinite(w).mean() < min_share:
            continue
        rec = {}
        for n in SPANS:
            if len(w) < n:
                continue
            sums = np.convolve(np.where(np.isfinite(w), w, 0), np.ones(n), "valid")
            ok = np.convolve(np.isfinite(w).astype(float), np.ones(n), "valid") == n
            if ok.any():
                rec[n] = round(float(sums[ok].max()), 2)
        if rec:
            out[y] = rec
    return out


def fetch(cfg, center: date, demo=False):
    spec = {**DEFAULT, **(cfg.get("climo") or {})}
    stations = spec.get("stations") or {}
    pts = [p["name"] for p in cfg["points"] if p["name"] in stations]
    if not pts:
        return None
    if demo:
        return _demo(pts, stations, center, spec)
    cache = Path(cfg.get("cache_dir", ".cache")) / "climo"

    def one(name):
        try:
            return name, _fetch(stations[name], cache)
        except Exception as e:
            log.warning("station history for %s (%s) unavailable (%s)", name, stations[name], e)
            return name, None

    with ThreadPoolExecutor(4) as ex:
        got = list(ex.map(one, pts))
    out = {}
    for name, js in got:
        if not js or not js["data"]:
            continue
        days = [r[0] for r in js["data"]]
        mx = season_maxima(days, [_value(r[1]) for r in js["data"]], center, spec["before"], spec["after"], spec["min_share"])
        if len(mx) < spec["min_years"]:
            log.info("station history for %s: only %d years, left out", name, len(mx))
            continue
        years = sorted(mx)
        m = js.get("meta") or {}
        out[name] = {"station": (m.get("name") or "").title(), "sid": stations[name], "elev_ft": m.get("elev"),
                     "years": years, "max": {str(n): [mx[y].get(n) for y in years] for n in SPANS}}
    log.info("station histories: %d of %d locations", len(out), len(pts))
    if not out:
        return None
    return {"from": (center - timedelta(days=spec["before"])).isoformat()[5:], "to": (center + timedelta(days=spec["after"])).isoformat()[5:],
            "spans": list(SPANS), "points": out, "source": "ACIS (NOAA Regional Climate Centers) daily station records"}


def _demo(pts, stations, center, spec):
    rng = np.random.default_rng(31)
    out = {}
    for k, name in enumerate(pts):
        years = list(range(1950 + (k % 4) * 10, center.year))
        scale = rng.uniform(0.8, 2.6)
        one = np.round(rng.gamma(4, scale / 4, len(years)) + 0.6 * scale, 2)
        out[name] = {"station": f"{name} (demo)", "sid": stations[name], "elev_ft": None, "years": years,
                     "max": {"1": one.tolist(), "3": np.round(one * rng.uniform(1.5, 2.0, len(years)), 2).tolist(),
                             "7": np.round(one * rng.uniform(2.3, 3.2, len(years)), 2).tolist()}}
    return {"from": (center - timedelta(days=spec["before"])).isoformat()[5:], "to": (center + timedelta(days=spec["after"])).isoformat()[5:],
            "spans": list(SPANS), "points": out, "source": "ACIS daily station records (demo: synthetic)"}
