"""Active NWS watches, warnings and advisories for the forecast locations.

Each location is resolved once to its NWS forecast zone and county (api.weather.gov
/points). Active alerts for the states are then fetched in one request and matched to
locations through each alert's affected zones. The zone list is written into the
briefing so the page can repeat the same request live in the browser.
"""
from __future__ import annotations

import logging
import os
import re
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


HAZARDS_PAGE = "https://forecast.weather.gov/showsigwx.php"


def location_page(forecast=None, county=None, fire=None):
    """weather.gov's hazards page for one place, the page its forecasts link to: every active watch,
    warning and advisory for that forecast zone, county and fire weather zone, in full text."""
    if not forecast:
        return None
    url = f"{HAZARDS_PAGE}?warnzone={forecast}"
    url += f"&warncounty={county}" if county else ""
    return url + (f"&firewxzone={fire}" if fire else "")


def resolve_zones(points, ua):
    """Each location's NWS zones (for matching alerts) and its hazards page (for linking them)."""
    zones, pages = {}, {}
    for p in points:
        if p.get("country") == "CA":            # outside NWS's area (Environment Canada's alerts cover these)
            continue
        try:
            pr = _get(f"{API}/points/{p['lat']:.4f},{p['lon']:.4f}", ua)["properties"]
            ids = {k: _zone_id(pr[k]) for k in ("forecastZone", "county", "fireWeatherZone") if pr.get(k)}
            zones[p["name"]] = sorted(set(ids.values()))
            page = location_page(ids.get("forecastZone"), ids.get("county"), ids.get("fireWeatherZone"))
            if page:
                pages[p["name"]] = page
        except Exception as e:
            log.info("zones for %s unavailable (%s)", p["name"], e)
    return zones, pages


def alert_url(affected_zones, pages=None, points=()):
    """Where an alert links: the hazards page of the first forecast location it covers (that page
    shows the alert in full), else the page for the alert's first forecast zone. NWS retired
    alerts.weather.gov's per-alert search, and the API's alert URL is raw JSON."""
    for name in points:
        if pages and pages.get(name):
            return pages[name]
    ids = [_zone_id(z) for z in affected_zones or []]
    zone = next((z for z in ids if re.fullmatch(r"[A-Z]{2}Z\d{3}", z)), None)
    return location_page(zone)


def match(features, zones, pages=None):
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
            "url": alert_url(pr.get("affectedZones"), pages, hit),
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
        zones, pages = resolve_zones(cfg["points"], ua)
        feats = _get(f"{API}/alerts/active", ua, params={"area": ",".join(areas)}).get("features", [])
        items = match(feats, zones, pages)
        log.info("NWS alerts: %d active for the forecast locations", len(items))
        return {"fetched": datetime.now(timezone.utc), "areas": areas, "zones": zones, "pages": pages, "items": items, "ok": True}
    except Exception as e:
        log.warning("NWS alerts unavailable (%s)", e)
        return {"fetched": datetime.now(timezone.utc), "areas": areas, "zones": {}, "pages": {}, "items": [], "ok": False}


def _demo(cfg, areas):
    now = datetime.now(timezone.utc)
    us = [p for p in cfg["points"] if p.get("country") != "CA"]
    coast = [p["name"] for p in us if p["kind"] == "coast"]
    passes = [p["name"] for p in us if p["kind"] == "pass"]
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
