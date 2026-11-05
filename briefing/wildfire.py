"""Wildfire-season context for the Wildfire tab, from public keyless services:

- NWS Red Flag Warnings and Fire Weather Watches from the region's offices (api.weather.gov)
- SPC fire weather outlooks, days 1–8 (NOAA mapservices: categorical wind/RH and dry thunderstorm
  areas for days 1–2, probabilities for days 3–8)
- the NWCC 7-day significant fire potential: fuel dryness and high-risk days for each Predictive
  Service Area (NWCG Predictive Services)
- current wildfire and prescribed-fire incidents and perimeters (NIFC WFIGS)
- the US Drought Monitor (current week)

Every part is optional: a source that fails leaves its section empty with ok=False. Geometry is
simplified on the server, cut to polygon parts that touch the map area, and rounded, so it stays
small inside briefing.json. Each location is tested against every area so the page can tabulate
outlooks and drought by location without any geometry work of its own.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import requests
from matplotlib.path import Path

from . import alerts as nws

log = logging.getLogger(__name__)

SPC = "https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/SPC_firewx/MapServer"
# layer id -> (day, kind): "windrh" is the wind and low humidity outlook, "dryt" dry thunderstorms
SPC_LAYERS = {1: (1, "windrh"), 2: (1, "dryt"), 4: (2, "windrh"), 5: (2, "dryt"),
              **{lid: (d, k) for d in range(3, 9) for lid, k in ((3 * d - 1, "windrh"), (3 * d - 2, "dryt"))}}
# days 1-2 are categorical (SPC's DN codes); days 3-8 are probabilities (DN is the percent)
SPC_CATS = {"windrh": {5: "Elevated", 8: "Critical", 10: "Extremely critical"},
            "dryt": {5: "Isolated dry thunderstorms", 8: "Scattered dry thunderstorms"}}
PSA_FORECAST = "https://fsapps.nwcg.gov/psp/arcgis/rest/services/npsg/current_forecast/FeatureServer/0"
PSA_AREAS = "https://fsapps.nwcg.gov/psp/arcgis/rest/services/npsg/PSA_GACC_KeyRAWS/MapServer/1"
# 7-day product codes: fuel dryness, or a high-risk day with its trigger
PSA_CODES = {0: ("", "No forecast", 0), 1: ("M", "Moist", 1), 2: ("D", "Dry", 2), 3: ("VD", "Very dry", 3),
             4: ("L", "High risk: lightning", 4), 5: ("W", "High risk: wind", 4), 7: ("HD", "High risk: hot and dry", 4),
             9: ("D", "Dry", 2), 11: ("B", "High risk: burn environment", 4)}
WFIGS = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/{}/FeatureServer/0"
USDM = "https://services5.arcgis.com/0OTVzJS4K09zlixn/ArcGIS/rest/services/USDM_current/FeatureServer/0"
USDM_LABELS = {0: "Abnormally dry", 1: "Moderate drought", 2: "Severe drought", 3: "Extreme drought",
               4: "Exceptional drought"}
OFFICE_CITY = {"SEW": "Seattle", "PQR": "Portland", "OTX": "Spokane", "PDT": "Pendleton", "MFR": "Medford"}
FIRE_EVENTS = ("Red Flag Warning", "Fire Weather Watch")


# ---------------------------------------------------------------- helpers

def _bbox(cfg, pad=0.0):
    d = cfg["domain"]
    return d["lon_min"] - pad, d["lat_min"] - pad, d["lon_max"] + pad, d["lat_max"] + pad


def _query(url, cfg, simplify=0.01, precision=3, geometry=True, spatial=True, **extra):
    """GeoJSON features intersecting the map area (or every feature, attributes only, with
    spatial=False)."""
    x0, y0, x1, y1 = _bbox(cfg)
    params = {"where": "1=1", "outFields": "*", "outSR": 4326,
              "returnGeometry": "true" if geometry else "false", "f": "geojson", **extra}
    if spatial:
        params.update(geometry=f"{x0},{y0},{x1},{y1}", geometryType="esriGeometryEnvelope", inSR=4326,
                      spatialRel="esriSpatialRelIntersects")
    if geometry:
        params.update(maxAllowableOffset=simplify, geometryPrecision=precision)
    for i in range(3):
        try:
            r = requests.get(f"{url}/query", params=params, timeout=60, headers={"User-Agent": "pnw-briefing/1.0"})
            r.raise_for_status()
            js = r.json()
            if "error" in js:
                raise RuntimeError(js["error"].get("message", js["error"]))
            return js.get("features", [])
        except Exception:
            if i == 2:
                raise
    return []


def _polys(geom):
    """A (Multi)Polygon as a list of polygons, each a list of rings."""
    if not geom:
        return []
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def _trim(geom, cfg, digits=3):
    """Keep the polygon parts that touch the map area (padded), with rounded coordinates."""
    x0, y0, x1, y1 = _bbox(cfg, pad=0.5)
    keep = []
    for poly in _polys(geom):
        ring = np.asarray(poly[0], dtype=float)
        if ring.size == 0 or ring[:, 0].max() < x0 or ring[:, 0].min() > x1 or ring[:, 1].max() < y0 or ring[:, 1].min() > y1:
            continue
        keep.append([[[round(x, digits), round(y, digits)] for x, y in r] for r in poly])
    if not keep:
        return None
    return {"type": "MultiPolygon", "coordinates": keep}


def _contains(geom, lon, lat):
    """Point in (Multi)Polygon, holes respected."""
    for poly in _polys(geom):
        if not poly or not Path(np.asarray(poly[0])).contains_point((lon, lat)):
            continue
        if not any(Path(np.asarray(h)).contains_point((lon, lat)) for h in poly[1:]):
            return True
    return False


def _inside(geom, cfg):
    return [p["name"] for p in cfg["points"] if _contains(geom, p["lon"], p["lat"])]


def _ms(v):
    return datetime.fromtimestamp(v / 1000, timezone.utc).isoformat() if v else None


def _spc_time(s):
    """SPC valid/expire stamps, 'YYYYMMDDHHMM' in UTC."""
    try:
        return datetime.strptime(str(s), "%Y%m%d%H%M").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- parts

def fire_alerts(cfg, zones):
    """Red Flag Warnings and Fire Weather Watches issued by the region's offices, whether or not
    they cover a forecast location (fire weather zones run well beyond the towns)."""
    ua = nws.user_agent(cfg)
    js = nws._get(f"{nws.API}/alerts/active", ua,
                  params={"area": ",".join(cfg.get("nws_areas", ["WA", "OR"])), "event": ",".join(FIRE_EVENTS)})
    cities = [OFFICE_CITY[o] for o in cfg.get("nws_offices", []) if o in OFFICE_CITY]
    out = []
    for f in js.get("features", []):
        pr = f.get("properties", {})
        if pr.get("event") not in FIRE_EVENTS or (cities and not any(c in (pr.get("senderName") or "") for c in cities)):
            continue
        affected = {nws._zone_id(z) for z in pr.get("affectedZones", [])}
        out.append({
            "id": pr.get("id"), "event": pr.get("event"), "headline": pr.get("headline"),
            "onset": pr.get("onset") or pr.get("effective"), "ends": pr.get("ends") or pr.get("expires"),
            "sender": pr.get("senderName"), "areaDesc": pr.get("areaDesc"),
            "points": [n for n, zs in (zones or {}).items() if affected & set(zs)],
            "description": (pr.get("description") or "")[:1200],
            "url": nws.alert_url(pr.get("affectedZones")),
        })
    out.sort(key=lambda a: (a["event"] != "Red Flag Warning", a["onset"] or ""))
    return out


def spc_outlooks(cfg):
    """SPC fire weather outlook areas touching the map, by day, with the locations inside each."""
    tz = ZoneInfo(cfg["timezone"])
    days = {}
    for lid, (day, kind) in SPC_LAYERS.items():
        # each layer's valid period, from all its features (a quiet day has only a "none" record
        # and nothing over the map area)
        for f in _query(f"{SPC}/{lid}", cfg, geometry=False, spatial=False):
            a = f.get("properties", {})
            valid, expire = _spc_time(a.get("valid")), _spc_time(a.get("expire"))
            if valid and day not in days:
                days[day] = {"day": day, "valid": valid.isoformat(), "expire": expire.isoformat() if expire else None,
                             "date": valid.astimezone(tz).date().isoformat(), "areas": []}
        for f in _query(f"{SPC}/{lid}", cfg, simplify=0.02):
            a = f.get("properties", {})
            dn = int(a.get("dn") or 0)
            rec = days.get(day)
            if dn <= 0 or rec is None:
                continue
            geom = _trim(f.get("geometry"), cfg)
            if geom is None:
                continue
            if day <= 2:
                label = SPC_CATS[kind].get(dn, f"Category {dn}")
            else:
                label = f"{dn}% chance of {'critical wind and low humidity' if kind == 'windrh' else 'dry thunderstorms'}"
            rec["areas"].append({"kind": kind, "dn": dn, "label": label, "probability": day > 2,
                                 "points": _inside(geom, cfg), "geometry": geom})
    return [days[d] for d in sorted(days)]


def psa_potential(cfg):
    """NWCC 7-day significant fire potential: each Predictive Service Area's fuel dryness or
    high-risk trigger by day. The forecast polygons carry no names, so each is matched to the PSA
    boundary layer by the closest bounding box."""
    areas = []
    for f in _query(PSA_AREAS, cfg, simplify=0.01):
        a = f.get("properties", {})
        if a.get("GACC_Label") != "Northwest" or not f.get("geometry"):
            continue
        geom = _trim(f["geometry"], cfg)
        if geom is None:
            continue
        areas.append({"code": a.get("NAT_CODE"), "name": a.get("PSA_NAME"), "geometry": geom,
                      "box": _box(f["geometry"]), "days": {}})
    if not areas:
        return None
    dates = set()
    for f in _query(PSA_FORECAST, cfg, simplify=0.05, precision=2):
        a = f.get("properties", {})
        when = _ms(a.get("timestampdate"))
        if not when or not f.get("geometry"):
            continue
        date = when[:10]
        box = _box(f["geometry"])
        best = min(areas, key=lambda r: sum(abs(p - q) for p, q in zip(r["box"], box)))
        if sum(abs(p - q) for p, q in zip(best["box"], box)) > 1.0:
            continue        # not one of these areas (a neighbouring GACC's PSA)
        dates.add(date)
        best["days"][date] = int(a.get("drynesscode") or 0)
    dates = sorted(dates)
    out = []
    for r in sorted(areas, key=lambda r: r["code"] or ""):
        codes = [r["days"].get(d) for d in dates]
        out.append({"code": r["code"], "name": r["name"], "points": _inside(r["geometry"], cfg),
                    "days": [_psa_day(c) for c in codes], "geometry": r["geometry"]})
    return {"dates": dates, "areas": out}


def _psa_day(code):
    if code is None:
        return None
    short, label, level = PSA_CODES.get(code, (str(code), f"Code {code}", 0))
    return {"code": code, "short": short, "label": label, "level": level}


def _box(geom):
    pts = np.asarray([xy for poly in _polys(geom) for xy in poly[0]], dtype=float)
    return (pts[:, 0].min(), pts[:, 1].min(), pts[:, 0].max(), pts[:, 1].max()) if pts.size else (0, 0, 0, 0)


def incidents(cfg):
    """Current wildfire, complex and prescribed-fire incidents in the map area, largest first."""
    out = []
    for f in _query(WFIGS.format("WFIGS_Incident_Locations_Current"), cfg, precision=4):
        a = f.get("properties", {})
        kind = a.get("IncidentTypeCategory")
        if kind not in ("WF", "RX", "CX"):
            continue
        lon, lat = (f.get("geometry") or {}).get("coordinates", [None, None])[:2]
        out.append({
            "id": a.get("UniqueFireIdentifier") or a.get("IrwinID"), "name": (a.get("IncidentName") or "").strip().title(),
            "type": {"WF": "Wildfire", "RX": "Prescribed fire", "CX": "Complex"}[kind],
            "acres": a.get("IncidentSize"), "contained": a.get("PercentContained"),
            "discovered": _ms(a.get("FireDiscoveryDateTime")), "updated": _ms(a.get("ModifiedOnDateTime_dt")),
            "cause": a.get("FireCause"), "state": (a.get("POOState") or "").replace("US-", ""), "county": a.get("POOCounty"),
            "lon": lon, "lat": lat,
        })
    out.sort(key=lambda r: (r["type"] == "Prescribed fire", -(r["acres"] or 0)))
    return out


def perimeters(cfg):
    out = []
    for f in _query(WFIGS.format("WFIGS_Interagency_Perimeters_Current"), cfg, simplify=0.002, precision=4):
        a = f.get("properties", {})
        geom = _trim(f.get("geometry"), cfg, digits=4)
        if geom is None:
            continue
        out.append({"type": "Feature", "geometry": geom, "properties": {
            "name": (a.get("poly_IncidentName") or a.get("attr_IncidentName") or "").strip().title(),
            "acres": a.get("poly_GISAcres") or a.get("attr_IncidentSize"),
            "contained": a.get("attr_PercentContained"),
            "kind": a.get("attr_IncidentTypeCategory")}})
    return {"type": "FeatureCollection", "features": out}


def drought(cfg):
    """US Drought Monitor categories touching the map, and the worst category at each location."""
    feats = _query(USDM, cfg, simplify=0.02)
    if not feats:
        return None
    a0 = feats[0].get("properties", {})
    cats, points = [], {p["name"]: None for p in cfg["points"]}
    for f in sorted(feats, key=lambda f: f["properties"].get("DM", 0)):
        dm = int(f["properties"].get("DM", 0))
        geom = _trim(f.get("geometry"), cfg)
        if geom is None:
            continue
        for name in _inside(geom, cfg):
            points[name] = dm
        cats.append({"dm": dm, "label": USDM_LABELS.get(dm, f"D{dm}"), "geometry": geom})
    return {"released": _ms(a0.get("ReleaseDate")), "mapDate": _ms(a0.get("MapDate")),
            "validEnd": _ms(a0.get("ValidEnd")), "points": points, "categories": cats}


# ---------------------------------------------------------------- all parts

def fetch(cfg, zones=None, demo: bool = False):
    if demo:
        return _demo(cfg)
    out = {"fetched": datetime.now(timezone.utc).isoformat(), "sources": {}}
    parts = [("alerts", lambda: fire_alerts(cfg, zones)), ("spc", lambda: spc_outlooks(cfg)),
             ("psa", lambda: psa_potential(cfg)), ("incidents", lambda: incidents(cfg)),
             ("perimeters", lambda: perimeters(cfg)), ("drought", lambda: drought(cfg))]
    for key, fn in parts:
        try:
            out[key] = fn()
            out["sources"][key] = True
        except Exception as e:
            log.warning("wildfire %s unavailable (%s)", key, e)
            out[key] = None
            out["sources"][key] = False
    n = len(out["incidents"] or [])
    log.info("wildfire: %d fire weather alerts, %d incidents, %d perimeters", len(out["alerts"] or []), n,
             len((out["perimeters"] or {}).get("features", [])))
    return out


def _demo(cfg):
    """A late-summer east-wind event: a Red Flag Warning for the west Cascades, SPC elevated and
    critical areas, NWCC dry to very dry fuels with two high-risk days, a few fires, and drought."""
    now = datetime.now(timezone.utc)
    tz = ZoneInfo(cfg["timezone"])
    today = now.astimezone(tz).date()
    iso = lambda h: (now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=h)).isoformat()
    box = lambda x0, y0, x1, y1: {"type": "MultiPolygon", "coordinates": [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]]}
    cascades = box(-122.3, 45.0, -121.0, 48.9)
    gorge = box(-122.4, 45.4, -121.0, 45.9)
    passes = [p["name"] for p in cfg["points"] if p["kind"] == "pass"]
    spc = []
    for d in range(1, 9):
        valid = datetime.combine(today + timedelta(days=d - 1), datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=12)
        areas = []
        if d == 2:
            areas = [{"kind": "windrh", "dn": 5, "label": "Elevated", "probability": False, "geometry": cascades},
                     {"kind": "windrh", "dn": 8, "label": "Critical", "probability": False, "geometry": gorge}]
        elif d == 3:
            areas = [{"kind": "windrh", "dn": 40, "label": "40% chance of critical wind and low humidity",
                      "probability": True, "geometry": cascades}]
        elif d == 6:
            areas = [{"kind": "dryt", "dn": 10, "label": "10% chance of dry thunderstorms", "probability": True,
                      "geometry": box(-122.0, 44.0, -120.5, 47.0)}]
        for a in areas:
            a["points"] = _inside(a["geometry"], cfg)
        spc.append({"day": d, "valid": valid.isoformat(), "expire": (valid + timedelta(days=1)).isoformat(),
                    "date": (today + timedelta(days=d - 1)).isoformat(), "areas": areas})
    dates = [(today + timedelta(days=k)).isoformat() for k in range(10)]
    psa_rows = [("NW01", "W1", box(-124.8, 47.0, -122.6, 48.5), [1, 1, 2, 2, 1, 1, 1, 1, 1, 1]),
                ("NW02", "W2", box(-124.2, 44.0, -122.6, 47.0), [1, 2, 2, 2, 1, 1, 1, 1, 1, 1]),
                ("NW03", "W3", box(-122.6, 46.5, -121.2, 49.0), [2, 3, 5, 3, 2, 2, 1, 1, 1, 1]),
                ("NW04", "W4", box(-122.6, 44.0, -121.2, 46.5), [2, 3, 5, 7, 3, 2, 2, 1, 1, 1]),
                ("NW05", "C1", box(-121.2, 47.5, -119.5, 49.0), [3, 3, 3, 3, 3, 4, 3, 2, 2, 2])]
    psa = {"dates": dates, "areas": [{"code": c, "name": n, "geometry": g, "points": _inside(g, cfg),
                                      "days": [_psa_day(x) for x in codes]} for c, n, g, codes in psa_rows]}
    fires = [("Bedrock", "Wildfire", 2140, 35, -121.9, 45.7, 3), ("Sheep Creek", "Wildfire", 380, 10, -121.5, 47.2, 1),
             ("Lost Lake", "Wildfire", 12, 80, -122.2, 46.3, 6), ("Tumwater Rx", "Prescribed fire", 150, None, -120.9, 47.6, 2)]
    inc = [{"id": f"demo-{k}", "name": n, "type": t, "acres": a, "contained": c, "lon": lo, "lat": la,
            "discovered": iso(-24 * d), "updated": iso(-3), "cause": "Natural" if k % 2 else "Human",
            "state": "WA" if la > 45.8 else "OR", "county": None} for k, (n, t, a, c, lo, la, d) in enumerate(fires)]
    ring = lambda lo, la, r: [[round(lo + r * np.cos(t) * 1.3, 4), round(la + r * np.sin(t), 4)] for t in np.linspace(0, 2 * np.pi, 24)]
    per = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[ring(lo, la, 0.004 * np.sqrt(a))]]},
         "properties": {"name": n, "acres": a, "contained": c, "kind": "WF" if t == "Wildfire" else "RX"}}
        for n, t, a, c, lo, la, _ in fires if a > 100]}
    cats = [{"dm": 0, "label": USDM_LABELS[0], "geometry": box(-123.5, 44.0, -120.0, 48.5)},
            {"dm": 1, "label": USDM_LABELS[1], "geometry": box(-122.6, 44.5, -120.5, 47.5)},
            {"dm": 2, "label": USDM_LABELS[2], "geometry": box(-121.8, 45.2, -120.5, 46.5)}]
    pts = {p["name"]: None for p in cfg["points"]}
    for c in cats:
        for n in _inside(c["geometry"], cfg):
            pts[n] = c["dm"]
    rfw = {"id": "demo-rfw", "event": "Red Flag Warning",
           "headline": "Red Flag Warning from Saturday 11 AM to Sunday 8 PM for east winds and low humidity (demo)",
           "onset": iso(30), "ends": iso(63), "sender": "NWS Portland OR",
           "areaDesc": "Western Columbia River Gorge; Willamette National Forest", "points": passes,
           "description": "East winds 15 to 25 mph with gusts to 40 mph through the Gorge; humidity 12 to 20 percent.",
           "url": None}
    return {"fetched": now.isoformat(), "demo": True, "sources": {k: True for k in ("alerts", "spc", "psa", "incidents", "perimeters", "drought")},
            "alerts": [rfw], "spc": spc, "psa": psa, "incidents": inc, "perimeters": per,
            "drought": {"released": iso(-24), "mapDate": iso(-48), "validEnd": iso(120), "points": pts, "categories": cats}}
