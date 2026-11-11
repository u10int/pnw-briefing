"""Active Environment Canada weather alerts for the B.C. forecast locations.

Environment Canada publishes its current alerts through MSC GeoMet's OGC API
(api.weather.gc.ca, collection `weather-alerts`): one feature per alert per public forecast region,
with the region's polygon. The alerts in a box around the Canadian locations (config points with
`country: CA`) are fetched in one request, each location is matched to the regions it falls in,
and the per-region features of one alert are joined back into a single record.

Alerts carry Environment Canada's colour-coded risk (yellow, orange, red), shown on the page in
place of the NWS hazard colours. The locations' coordinates and the box are written into the
briefing so the page can repeat the same request live in the browser.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import requests

log = logging.getLogger(__name__)
API = "https://api.weather.gc.ca/collections/weather-alerts/items"
LOCATION_PAGE = "https://weather.gc.ca/en/location/index.html?coords={lat:.3f},{lon:.3f}"
GONE = {"ended", "cancelled"}


def canadian(cfg):
    return [p for p in cfg["points"] if p.get("country") == "CA"]


def bbox(points, pad=0.5):
    return [round(min(p["lon"] for p in points) - pad, 2), round(min(p["lat"] for p in points) - pad, 2),
            round(max(p["lon"] for p in points) + pad, 2), round(max(p["lat"] for p in points) + pad, 2)]


def _in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def contains(geom, lon, lat):
    """Whether a GeoJSON Polygon or MultiPolygon holds the point (holes respected)."""
    if not geom:
        return False
    polys = [geom["coordinates"]] if geom.get("type") == "Polygon" else geom.get("coordinates", []) if geom.get("type") == "MultiPolygon" else []
    return any(rings and _in_ring(lon, lat, rings[0]) and not any(_in_ring(lon, lat, h) for h in rings[1:]) for rings in polys)


def _title(s):
    return " ".join(w.capitalize() for w in (s or "").split())


def _headline(text):
    """The alert text's opening sentence (Environment Canada leads with the hazard in brief)."""
    first = (text or "").strip().split("\n", 1)[0].strip()
    return first or None


def match(features, points):
    """Features to alert records for the locations, one per alert (its regions joined)."""
    groups = {}
    for f in features:
        a = f.get("properties") or {}
        if (a.get("status_en") or "").lower() in GONE:
            continue
        hit = [p["name"] for p in points if contains(f.get("geometry"), p["lon"], p["lat"])]
        if not hit:
            continue
        key = (a.get("alert_code"), a.get("risk_colour_en"), a.get("validity_datetime"), a.get("event_end_datetime"))
        g = groups.get(key)
        if g is None:
            g = groups[key] = {
                "id": f"eccc-{a.get('alert_code')}-{a.get('validity_datetime')}-{a.get('feature_id')}",
                "event": _title(a.get("alert_name_en")), "type": a.get("alert_type"),
                "colour": (a.get("risk_colour_en") or "").lower() or None,
                "severity": a.get("impact_en"), "certainty": a.get("confidence_en"), "urgency": None,
                "headline": _headline(a.get("alert_text_en")),
                "onset": a.get("validity_datetime") or a.get("publication_datetime"),
                "ends": a.get("event_end_datetime") or a.get("expiration_datetime"),
                "issued": a.get("publication_datetime"), "status": a.get("status_en"),
                "sender": "Environment Canada", "areas": [], "points": [],
                "url": None, "source": "eccc",
            }
        if a.get("feature_name_en") and a["feature_name_en"] not in g["areas"]:
            g["areas"].append(a["feature_name_en"])
        g["points"] += [n for n in hit if n not in g["points"]]
    out = list(groups.values())
    order = [p["name"] for p in points]
    for g in out:
        g["areaDesc"] = "; ".join(g.pop("areas"))
        g["points"].sort(key=order.index)
        first = points[order.index(g["points"][0])]          # its page on weather.gc.ca shows the alert in full
        g["url"] = LOCATION_PAGE.format(lat=first["lat"], lon=first["lon"])
    out.sort(key=lambda a: (_rank(a["type"]), a["onset"] or ""))
    return out


def _rank(kind):
    return {"warning": 0, "watch": 1, "advisory": 2, "statement": 3}.get((kind or "").lower(), 4)


def fetch(cfg, demo=False):
    pts = canadian(cfg)
    if not pts:
        return None
    box = bbox(pts)
    where = {p["name"]: [p["lon"], p["lat"]] for p in pts}
    if demo:
        return _demo(pts, box, where)
    try:
        r = requests.get(API, params={"f": "json", "lang": "en", "bbox": ",".join(map(str, box)), "limit": 1000}, timeout=60)
        r.raise_for_status()
        items = match(r.json().get("features", []), pts)
        log.info("Environment Canada alerts: %d active for the B.C. locations", len(items))
        return {"fetched": datetime.now(timezone.utc), "bbox": box, "points": where, "items": items, "ok": True}
    except Exception as e:
        log.warning("Environment Canada alerts unavailable (%s)", e)
        return {"fetched": datetime.now(timezone.utc), "bbox": box, "points": where, "items": [], "ok": False}


def _demo(pts, box, where):
    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    iso = lambda h: (now + timedelta(hours=h)).isoformat()
    coast = [p for p in pts if p["kind"] == "coast"] or pts[:1]
    return {"fetched": now, "bbox": box, "points": where, "ok": True, "demo": True, "items": [
        {"id": "eccc-demo-1", "event": "Rainfall Warning", "type": "warning", "colour": "orange", "severity": "Moderate",
         "certainty": "High", "urgency": None, "headline": "Heavy rain is expected (demo).", "onset": iso(-6), "ends": iso(30),
         "issued": iso(-7), "status": "continued", "sender": "Environment Canada", "areaDesc": "West Vancouver Island",
         "points": [p["name"] for p in coast], "source": "eccc",
         "url": LOCATION_PAGE.format(lat=coast[0]["lat"], lon=coast[0]["lon"])},
        {"id": "eccc-demo-2", "event": "Wind Warning", "type": "warning", "colour": "yellow", "severity": "Moderate",
         "certainty": "Moderate", "urgency": None, "headline": "Strong winds that may cause damage are expected (demo).",
         "onset": iso(20), "ends": iso(40), "issued": iso(-2), "status": "issued", "sender": "Environment Canada",
         "areaDesc": "; ".join(sorted({p.get("area") or p["name"] for p in pts})), "points": [p["name"] for p in pts], "source": "eccc",
         "url": LOCATION_PAGE.format(lat=pts[0]["lat"], lon=pts[0]["lon"])},
    ]}
