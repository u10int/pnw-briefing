"""Active NWS watches, warnings and advisories for the forecast locations.

Each location is resolved once to its NWS forecast zone and county (api.weather.gov
/points). Active alerts for the states are then fetched in one request and matched to
locations through each alert's affected zones. The zone list is written into the
briefing so the page can repeat the same request live in the browser.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

import requests

log = logging.getLogger(__name__)
API = "https://api.weather.gov"


def user_agent(cfg) -> str:
    """NWS asks for an identifying User-Agent. Uses the repo name, never a personal address."""
    repo = os.environ.get("GITHUB_REPOSITORY")
    return cfg.get("nws_user_agent") or f"(pnw-briefing, {'github.com/' + repo if repo else 'local run'})"


def _get(url, ua, params=None, tries=3):
    for i in range(tries):
        r = requests.get(url, params=params, timeout=30,
                         headers={"User-Agent": ua, "Accept": "application/geo+json"})
        if r.status_code == 200:
            return r.json()
        time.sleep(3 * (i + 1))
    r.raise_for_status()


def _zone_id(url: str) -> str:
    return url.rstrip("/").rsplit("/", 1)[-1]


def resolve_zones(points, ua):
    zones = {}
    for p in points:
        try:
            pr = _get(f"{API}/points/{p['lat']:.4f},{p['lon']:.4f}", ua)["properties"]
            zones[p["name"]] = sorted({_zone_id(pr[k]) for k in ("forecastZone", "county", "fireWeatherZone") if pr.get(k)})
        except Exception as e:
            log.info("zones for %s unavailable (%s)", p["name"], e)
    return zones


def match(features, zones):
    """Turn alert features into compact records, keeping those that touch a forecast location."""
    out = []
    for f in features:
        pr = f.get("properties", {})
        affected = {_zone_id(z) for z in pr.get("affectedZones", [])}
        hit = [name for name, zs in zones.items() if affected & set(zs)]
        if not hit:
            continue
        out.append({
            "id": pr.get("id") or f.get("id"), "event": pr.get("event"), "severity": pr.get("severity"),
            "certainty": pr.get("certainty"), "urgency": pr.get("urgency"), "headline": pr.get("headline"),
            "onset": pr.get("onset") or pr.get("effective"), "ends": pr.get("ends") or pr.get("expires"),
            "sender": pr.get("senderName"), "areaDesc": pr.get("areaDesc"), "points": hit,
            "url": f"https://alerts.weather.gov/search?id={pr.get('id')}" if pr.get("id") else None,
        })
    out.sort(key=lambda a: (_rank(a["event"]), a["onset"] or ""))
    return out


def _rank(event: str | None) -> int:
    e = (event or "").lower()
    return 0 if "warning" in e else 1 if "watch" in e else 2 if "advisory" in e else 3


def fetch(cfg, demo: bool = False):
    areas = cfg.get("nws_areas", ["WA", "OR"])
    if demo:
        return _demo(cfg, areas)
    ua = user_agent(cfg)
    try:
        zones = resolve_zones(cfg["points"], ua)
        feats = _get(f"{API}/alerts/active", ua, params={"area": ",".join(areas)}).get("features", [])
        items = match(feats, zones)
        log.info("NWS alerts: %d active for the forecast locations", len(items))
        return {"fetched": datetime.now(timezone.utc), "areas": areas, "zones": zones, "items": items, "ok": True}
    except Exception as e:
        log.warning("NWS alerts unavailable (%s)", e)
        return {"fetched": datetime.now(timezone.utc), "areas": areas, "zones": {}, "items": [], "ok": False}


def _demo(cfg, areas):
    now = datetime.now(timezone.utc)
    coast = [p["name"] for p in cfg["points"] if p["kind"] == "coast"]
    passes = [p["name"] for p in cfg["points"] if p["kind"] == "pass"]
    iso = lambda h: (now.replace(minute=0, second=0, microsecond=0) + __import__("datetime").timedelta(hours=h)).isoformat()
    return {"fetched": now, "areas": areas, "zones": {}, "ok": True, "demo": True, "items": [
        {"id": "demo-1", "event": "Flood Watch", "severity": "Severe", "certainty": "Possible", "urgency": "Future",
         "headline": "Flood Watch in effect from Friday morning through Sunday evening (demo)",
         "onset": iso(60), "ends": iso(120), "sender": "NWS Seattle WA", "areaDesc": "Coast, Olympics",
         "points": coast, "url": None},
        {"id": "demo-2", "event": "Winter Storm Watch", "severity": "Moderate", "certainty": "Possible", "urgency": "Future",
         "headline": "Winter Storm Watch for the Cascades above 4000 feet (demo)",
         "onset": iso(230), "ends": iso(290), "sender": "NWS Seattle WA", "areaDesc": "Cascades of Snohomish and King Counties",
         "points": passes, "url": None},
    ]}
