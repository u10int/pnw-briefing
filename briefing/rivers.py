"""River status and forecasts from NOAA's National Water Prediction Service (the Northwest River
Forecast Center's official forecasts): every forecast gauge in the Seattle and Portland offices'
areas west of the Cascade crest that has flood categories, with its latest observed stage, the
forecast hydrograph, the forecast crest and the flood category each reaches.

api.water.noaa.gov/nwps/v1: one request for the gauge list over the domain, then two per gauge
(its flood categories and its stage/flow series), run a few at a time.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import requests

from . import report
from .alerts import user_agent

log = logging.getLogger(__name__)
API = "https://api.water.noaa.gov/nwps/v1"
LEVELS = ["no_flooding", "action", "minor", "moderate", "major"]


def _get(url, ua, params=None):
    r = requests.get(url, params=params, timeout=40, headers={"User-Agent": ua, "Accept": "application/json"})
    r.raise_for_status()
    return r.json()


def category(stage, cats):
    """The flood category a stage reaches: 0 none, 1 action, 2 minor, 3 moderate, 4 major."""
    if stage is None:
        return None
    lvl = 0
    for k, name in enumerate(LEVELS[1:], start=1):
        s = (cats or {}).get(name)
        if s is not None and stage >= s:
            lvl = k
    return lvl


def _hourly(points, since):
    """Observed readings on the hour (the last reading in each hour) since `since`."""
    by_hour = {}
    for p in points:
        t = datetime.fromisoformat(p["validTime"].replace("Z", "+00:00"))
        if t >= since and p.get("primary") is not None and p["primary"] > -900:
            by_hour[t.replace(minute=0, second=0)] = (t, p["primary"])
    return [[t.isoformat().replace("+00:00", "Z"), round(v, 2)] for _, (t, v) in sorted(by_hour.items())]


def _gauge(g, ua, now):
    lid = g["lid"]
    info = _get(f"{API}/gauges/{lid}", ua)
    cats = {k: v.get("stage") for k, v in ((info.get("flood") or {}).get("categories") or {}).items()
            if v and v.get("stage") is not None and v["stage"] > -900}
    if "minor" not in cats and "action" not in cats:
        return None                                    # no flood categories to measure against
    sf = _get(f"{API}/gauges/{lid}/stageflow", ua)
    obs = _hourly((sf.get("observed") or {}).get("data") or [], now - timedelta(hours=72))
    fc_raw = (sf.get("forecast") or {}).get("data") or []
    fc = [[p["validTime"], round(p["primary"], 2)] for p in fc_raw if p.get("primary") is not None and p["primary"] > -900]
    if not fc:
        return None
    crest = max(fc, key=lambda x: x[1])
    now_stage = obs[-1][1] if obs else None
    hist = ((info.get("flood") or {}).get("crests") or {}).get("historic") or []
    record = max((c for c in hist if c.get("stage")), key=lambda c: c["stage"], default=None)
    return {
        "lid": lid, "name": info.get("name") or g.get("name"), "lat": g["latitude"], "lon": g["longitude"],
        "wfo": (g.get("wfo") or {}).get("abbreviation"), "state": (g.get("state") or {}).get("abbreviation"),
        "units": (sf.get("forecast") or {}).get("primaryUnits") or "ft", "categories": cats,
        "observed": obs, "forecast": fc, "issued": (sf.get("forecast") or {}).get("issuedTime"),
        "now": {"stage": now_stage, "time": obs[-1][0] if obs else None, "level": category(now_stage, cats)},
        "crest": {"stage": crest[1], "time": crest[0], "level": category(crest[1], cats)},
        "record": {"stage": record["stage"], "time": record["occurredTime"]} if record else None,
        "url": f"https://water.noaa.gov/gauges/{lid}",
    }


def fetch(cfg, demo=False):
    if demo:
        from . import demo as src
        return src.rivers(cfg)
    rc = cfg.get("rivers") or {}
    d = cfg["domain"]
    ua = user_agent(cfg)
    lst = _get(f"{API}/gauges", ua, params={
        "bbox.xmin": d["lon_min"], "bbox.ymin": d["lat_min"], "bbox.xmax": rc.get("lon_max", -121.0), "bbox.ymax": d["lat_max"],
        "srid": "EPSG_4326"})
    offices = set(rc.get("offices", ["SEW", "PQR"]))
    cand = [g for g in lst.get("gauges", [])
            if (g.get("wfo") or {}).get("abbreviation") in offices and (g.get("pedts") or {}).get("forecast")
            and (g.get("status") or {}).get("forecast", {}).get("floodCategory") not in ("fcst_not_current", "not_defined", "out_of_service")]
    now = datetime.now(timezone.utc)
    out, failed = [], 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        for res in ex.map(lambda g: _try(g, ua, now), cand):
            if res == "failed":
                failed += 1
            elif res:
                out.append(res)
    if failed:
        log.warning("rivers: %d of %d gauges unavailable", failed, len(cand))
    out.sort(key=lambda r: (-(r["crest"]["level"] or 0), r["name"]))
    log.info("rivers: %d forecast gauges, %d reach action stage or higher", len(out), sum((r["crest"]["level"] or 0) >= 1 for r in out))
    return {"source": "NOAA NWPS / Northwest River Forecast Center", "gauges": out} if out else None


def _try(g, ua, now):
    try:
        return _gauge(g, ua, now)
    except Exception as e:
        log.info("river gauge %s: %s", g.get("lid"), report.short(e))
        return "failed"
