"""Snowpack from SNOTEL (USDA NRCS), via the AWDB REST API: snow water equivalent (SWE) against
the station's median for the date, snow depth, and the change over the past week.

Stations are grouped into the areas listed under `snowpack` in config.yaml (all SNOTEL stations
within `radius_km` of each area's centre). An area's percent of median is total SWE over total
median SWE across its stations, the way NRCS builds its basin indices. Early in the season the
medians are tiny, so percentages are only shown once the median reaches `min_median_in`.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
import requests

from . import report

log = logging.getLogger(__name__)
AWDB = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1"


def _km(lat1, lon1, lat2, lon2):
    k = np.cos(np.deg2rad((lat1 + lat2) / 2))
    return 111.2 * np.hypot(lat2 - lat1, (lon2 - lon1) * k)


def http_json(url, params, tries=4, timeout=60):
    """GET JSON, retrying server errors and dropped connections with backoff (these public
    services return the odd 502/503)."""
    import time
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            if r.status_code < 500 and r.status_code != 429:
                r.raise_for_status()
                return r.json()
            err = requests.HTTPError(f"{r.status_code} from {url.split('?')[0]}")
        except (requests.ConnectionError, requests.Timeout) as e:
            err = e
        if i < tries - 1:
            time.sleep((3, 8, 20)[min(i, 2)])
    raise err


def _get(path, params):
    return http_json(f"{AWDB}/{path}", params)


def _series(js, element):
    """{triplet: [{date, value, median}]} for one element."""
    out = {}
    for st in js:
        for d in st.get("data", []):
            if d.get("stationElement", {}).get("elementCode") == element:
                out[st["stationTriplet"]] = d.get("values", [])
    return out


def fetch(cfg, demo: bool = False, today: date | None = None):
    spec = cfg.get("snowpack") or {}
    areas = spec.get("areas", [])
    if not areas:
        return None
    if demo:
        from .demo import snowpack as demo_snowpack
        return demo_snowpack(cfg)
    radius = float(spec.get("radius_km", 30))
    min_median = float(spec.get("min_median_in", 1.0))
    states = spec.get("states", ["WA", "OR"])
    stations = _get("stations", {"stationTriplets": ",".join(f"*:{s}:SNTL" for s in states),
                                 "returnStationElements": "false"})
    near = {}
    for a in areas:
        near[a["name"]] = [s for s in stations if s.get("endDate", "2100") >= "2100"
                           and _km(a["lat"], a["lon"], s["latitude"], s["longitude"]) <= radius]
    trips = sorted({s["stationTriplet"] for v in near.values() for s in v})
    if not trips:
        return None
    end = today or date.today()
    js = _get("data", {"stationTriplets": ",".join(trips), "elements": "WTEQ,SNWD", "duration": "DAILY",
                       "beginDate": (end - timedelta(days=9)).isoformat(), "endDate": end.isoformat(),
                       "centralTendencyType": "MEDIAN", "returnFlags": "false"})
    swe, depth = _series(js, "WTEQ"), _series(js, "SNWD")

    def latest(vals, key="value"):
        vals = [v for v in vals if v.get(key) is not None]
        return vals[-1] if vals else None

    def station(s):
        sv = swe.get(s["stationTriplet"], [])
        last = latest(sv)
        if not last:
            return None
        cutoff = (date.fromisoformat(last["date"]) - timedelta(days=7)).isoformat()
        before = [v for v in sv if v["date"] <= cutoff and v.get("value") is not None]
        week = before[-1] if before else None                      # the latest reading a week or more ago
        d = latest(depth.get(s["stationTriplet"], []))
        med = last.get("median")
        return {"name": s["name"], "triplet": s["stationTriplet"], "elev_ft": s.get("elevation"),
                "lat": s["latitude"], "lon": s["longitude"], "date": last["date"],
                "swe": last["value"], "median": med,
                "pct": round(100 * last["value"] / med) if med and med >= min_median else None,
                "change7": round(last["value"] - week["value"], 1) if week else None,
                "depth": d["value"] if d and d["date"] == last["date"] else None}

    out_areas, as_of = [], None
    for a in areas:
        sts = [x for x in (station(s) for s in near[a["name"]]) if x]
        sts.sort(key=lambda x: -(x["elev_ft"] or 0))
        both = [x for x in sts if x["median"] is not None]
        tot, totm = sum(x["swe"] for x in both), sum(x["median"] for x in both)
        n = len(both) or 1
        ch = [x["change7"] for x in sts if x["change7"] is not None]
        out_areas.append({"name": a["name"], "stations": sts,
                          "swe": round(tot / n, 1) if both else None, "median": round(totm / n, 1) if both else None,
                          "pct": round(100 * tot / totm) if both and totm / n >= min_median else None,
                          "change7": round(sum(ch) / len(ch), 1) if ch else None})
        as_of = max([as_of] + [x["date"] for x in sts], key=lambda v: v or "")
    log.info("snowpack: %d stations in %d areas, as of %s", sum(len(a["stations"]) for a in out_areas), len(out_areas), as_of)
    return {"asOf": as_of, "minMedian": min_median, "areas": out_areas,
            "source": "USDA NRCS SNOTEL (AWDB); medians are the station's 1991–2020 daily median"}


def safe_fetch(cfg, demo=False):
    try:
        return fetch(cfg, demo)
    except Exception as e:
        log.warning("snowpack unavailable (%s)", report.short(e))
        return None
