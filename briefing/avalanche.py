"""Avalanche danger from the Northwest Avalanche Center (NWAC), via avalanche.org's public API.

The map layer gives every zone's overall danger for today (or "no rating" outside the forecast
season, with the early-season travel advice). In season, each zone's forecast adds danger by
elevation band (upper, middle, lower) for today and tomorrow, the avalanche problems and the
bottom line: one request per zone.
"""
from __future__ import annotations

import html
import logging
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from . import report

log = logging.getLogger(__name__)
API = "https://api.avalanche.org/v2/public"
LABELS = {1: "Low", 2: "Moderate", 3: "Considerable", 4: "High", 5: "Extreme"}
# west to east, north to south, the way NWAC lists them
ORDER = ["Olympics", "West Slopes North", "West Slopes Central", "West Slopes South", "Stevens Pass",
         "Snoqualmie Pass", "East Slopes North", "East Slopes Central", "East Slopes South", "Mt Hood"]


def _text(s):
    if not s:
        return None
    t = html.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", t).strip() or None


def _bands(danger, day):
    d = next((x for x in danger or [] if x.get("valid_day") == day), None)
    if not d or all(d.get(k) in (None, 0, -1) for k in ("upper", "middle", "lower")):
        return None
    return {k: (d.get(k) if (d.get(k) or 0) >= 1 else None) for k in ("upper", "middle", "lower")}


def _local_date(iso, tz):
    if not iso:
        return None
    t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    t = t if t.tzinfo else t.replace(tzinfo=timezone.utc)   # naive map-layer times match the products' UTC times
    return t.astimezone(tz).date().isoformat()


def fetch(cfg, demo: bool = False):
    spec = cfg.get("avalanche")
    if not spec:
        return None
    if demo:
        from .demo import avalanche as demo_avalanche
        return demo_avalanche(cfg)
    from .snowpack import http_json
    center = spec.get("center", "NWAC")
    js = http_json(f"{API}/products/map-layer/{center}", {})
    zones = []
    for f in js.get("features", []):
        p = f.get("properties", {})
        tz = ZoneInfo(p.get("timezone") or cfg["timezone"])
        level = int(p.get("danger_level") if p.get("danger_level") is not None else -1)
        warn = (p.get("warning") or {}).get("product")
        z = {"id": f.get("id"), "name": p.get("name"), "state": p.get("state"), "level": level,
             "label": LABELS.get(level, "No rating"), "color": p.get("color"), "link": p.get("link"),
             "travelAdvice": _text(p.get("travel_advice")), "offSeason": bool(p.get("off_season")),
             "start": _local_date(p.get("start_date"), tz), "end": _local_date(p.get("end_date"), tz),
             "warning": (_text(warn.get("bottom_line")) or "Avalanche warning in effect") if isinstance(warn, dict)
             else ("Avalanche warning in effect" if warn else None)}
        if level >= 1 and f.get("id") is not None:
            try:
                pr = http_json(f"{API}/product", {"type": "forecast", "center_id": center, "zone_id": f["id"]})
                z["today"], z["tomorrow"] = _bands(pr.get("danger"), "current"), _bands(pr.get("danger"), "tomorrow")
                z["bottomLine"] = _text(pr.get("bottom_line"))
                z["problems"] = [x.get("name") for x in sorted(pr.get("forecast_avalanche_problems") or [],
                                                                key=lambda x: x.get("rank") or 9) if x.get("name")]
            except Exception as e:
                log.info("avalanche forecast for %s unavailable (%s)", z["name"], report.short(e))
        zones.append(z)
    if not zones:
        return None
    zones.sort(key=lambda z: (ORDER.index(z["name"]) if z["name"] in ORDER else 99, z["name"] or ""))
    in_season = any(z["level"] >= 1 for z in zones)
    ends = sorted(z["end"] for z in zones if z["end"])
    log.info("avalanche: %d %s zones, %s", len(zones), center,
             "in season" if in_season else f"no ratings yet (summary until {ends[0] if ends else '?'})")
    return {"center": center, "url": "https://nwac.us/avalanche-forecast/", "zones": zones,
            "inSeason": in_season, "until": None if in_season else (ends[0] if ends else None)}
