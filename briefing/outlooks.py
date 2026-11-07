"""What NWS forecasters are saying: the latest Area Forecast Discussion synopsis (and key messages
and hydrology, when present) from each office, WPC's Excessive Rainfall Outlook for days 1 – 5, and
CPC's 6 – 10 and 8 – 14 day temperature and precipitation outlooks, all at the forecast locations.

The outlooks are read from NOAA's public map services: one query per layer for the polygons over
the domain, then point-in-polygon locally, so 9 small requests cover every location.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone

import numpy as np
from matplotlib.path import Path as MplPath

from . import report
from .alerts import _get, user_agent

log = logging.getLogger(__name__)
MS = "https://mapservices.weather.noaa.gov/vector/rest/services"
ERO = f"{MS}/hazards/wpc_precip_hazards/MapServer"              # layers 0-4: days 1-5
CPC = {"6-10": f"{MS}/outlooks/cpc_6_10_day_outlk/MapServer",  # layer 0 temperature, 1 precipitation
       "8-14": f"{MS}/outlooks/cpc_8_14_day_outlk/MapServer"}


# ---------------------------------------------------------------- forecast discussions

def _section(text, name):
    m = re.search(rf"^\.{name}[^\n]*?\.\.\.(.*?)(?=^\.[A-Z][A-Z /\-0-9]+?\.\.\.|^&&|\Z)", text, re.M | re.S)
    if not m:
        return None
    body = m.group(1).strip()
    # reflow: NWS text is hard-wrapped at ~66 characters; keep blank lines as paragraph breaks
    paras = [re.sub(r"\s*\n\s*", " ", p).strip() for p in re.split(r"\n\s*\n", body)]
    return [p for p in paras if p] or None


def _sections(text):
    """Every section of a discussion in order, as [{"title", "paragraphs"}]: ".SHORT TERM /TONIGHT
    THROUGH MONDAY/..." becomes "Short term (tonight through Monday)". Paragraphs are reflowed;
    lines that start a list item ("-", "*") stay on their own."""
    out = []
    for m in re.finditer(r"^\.([A-Z][A-Z /\-0-9]+?)\.\.\.(.*?)(?=^\.[A-Z][A-Z /\-0-9]+?\.\.\.|^&&|^\$\$|\Z)", text, re.M | re.S):
        head, body = m.group(1).strip(), m.group(2)
        if re.search(r"WATCHES/WARNINGS", head):
            head = "WATCHES, WARNINGS AND ADVISORIES"      # ".SEW WATCHES/WARNINGS/ADVISORIES..."
        name, _, when = head.partition(" /")             # ".SHORT TERM /TONIGHT THROUGH MONDAY/..."
        when = re.sub(r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", lambda d: d.group(1).capitalize(),
                      when.strip(" /").lower())
        title = name.strip().capitalize() + (f" ({when})" if when else "")
        paras = []
        for block in re.split(r"\n\s*\n", body.strip()):
            lines = [l.strip() for l in block.splitlines() if l.strip()]
            cur = []
            for l in lines:
                if re.match(r"^[-*]\s", l) and cur:
                    paras.append(" ".join(cur)); cur = []
                cur.append(l)
            if cur:
                paras.append(" ".join(cur))
        paras = [p for p in paras if p]
        if paras:
            out.append({"title": title, "paragraphs": paras})
    return out or None


OFFICE_NAME = {"SEW": "NWS Seattle", "PQR": "NWS Portland", "OTX": "NWS Spokane", "PDT": "NWS Pendleton", "MFR": "NWS Medford"}


def discussions(cfg):
    ua = user_agent(cfg)
    out = []
    for office in cfg.get("nws_offices", ["SEW", "PQR"]):
        try:
            lst = _get(f"https://api.weather.gov/products/types/AFD/locations/{office}", ua)
            items = lst.get("@graph") or []
            if not items:
                continue
            p = _get(f"https://api.weather.gov/products/{items[0]['id']}", ua)
            text = p.get("productText", "")
            out.append({"office": office, "name": OFFICE_NAME.get(office, p.get("issuingOffice") or office),
                        "issued": p.get("issuanceTime"),
                        "url": f"https://forecast.weather.gov/product.php?site={office}&issuedby={office}&product=AFD",
                        "synopsis": _section(text, "SYNOPSIS"), "keyMessages": _section(text, "KEY MESSAGES"),
                        "hydrology": _section(text, "HYDROLOGY"), "sections": _sections(text)})
        except Exception as e:
            log.warning("AFD %s unavailable (%s)", office, report.short(e))
    return out


# ---------------------------------------------------------------- outlook polygons

def _polygons(url, layer, dom):
    """Features (attributes, list of rings) intersecting the domain."""
    from .snowpack import http_json
    js = http_json(f"{url}/{layer}/query", timeout=40, params={
        "geometry": f"{dom['lon_min']},{dom['lat_min']},{dom['lon_max']},{dom['lat_max']}",
        "geometryType": "esriGeometryEnvelope", "inSR": "4326", "outSR": "4326",
        "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "true", "f": "json"})
    if "error" in js:
        raise RuntimeError(js["error"].get("message", "map service error"))
    return [(f.get("attributes", {}), (f.get("geometry") or {}).get("rings", [])) for f in js.get("features", [])]


def _inside(rings, lon, lat):
    """Point in polygon with even-odd rings (holes cancel out)."""
    n = sum(MplPath(np.asarray(r)).contains_point((lon, lat)) for r in rings if len(r) >= 3)
    return n % 2 == 1


def _date(ms):
    return None if ms is None else datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat()


ERO_LEVELS = [("marginal", 1, "Marginal"), ("slight", 2, "Slight"), ("moderate", 3, "Moderate"), ("high", 4, "High")]
ERO_CODES = {"MRGL": 1, "SLGT": 2, "MDT": 3, "HIGH": 4}


def _ero_level(attrs):
    """Risk level 1-4 from whatever field the service uses for the category."""
    for v in attrs.values():
        if isinstance(v, str):
            s = v.strip()
            if s.upper() in ERO_CODES:
                return ERO_CODES[s.upper()]
            for word, lvl, _ in ERO_LEVELS:
                if s.lower().startswith(word):
                    return lvl
    return None


def excessive_rainfall(cfg):
    """WPC ERO risk (0 none, 1 marginal ... 4 high) per location for days 1-5."""
    dom, pts = cfg["domain"], cfg["points"]
    days = []
    for layer in range(5):
        try:
            feats = _polygons(ERO, layer, dom)
        except Exception as e:
            log.warning("ERO day %d unavailable (%s)", layer + 1, report.short(e))
            days.append(None)
            continue
        level = {}
        for p in pts:
            hits = [_ero_level(a) or 0 for a, rings in feats if _inside(rings, p["lon"], p["lat"])]
            level[p["name"]] = max(hits, default=0)
        days.append({"day": layer + 1, "points": level})
    return {"names": {lvl: name for _, lvl, name in ERO_LEVELS},
            "url": "https://www.wpc.ncep.noaa.gov/qpf/excessive_rainfall_outlook_ero.php", "days": days}


def cpc(cfg):
    """CPC 6-10 and 8-14 day outlooks: category and probability per location, with valid dates."""
    dom, pts = cfg["domain"], cfg["points"]
    out = []
    for period, url in CPC.items():
        for layer, var in ((0, "temperature"), (1, "precipitation")):
            try:
                feats = _polygons(url, layer, dom)
            except Exception as e:
                log.warning("CPC %s %s unavailable (%s)", period, var, report.short(e))
                continue
            vals, start, end = {}, None, None
            for p in pts:
                hit = next(((a, r) for a, r in feats if _inside(r, p["lon"], p["lat"])), None)
                if hit:
                    a = hit[0]
                    start, end = _date(a.get("start_date")) or start, _date(a.get("end_date")) or end
                    vals[p["name"]] = {"cat": a.get("cat"), "prob": a.get("prob")}
                else:
                    vals[p["name"]] = None
            out.append({"period": period, "var": var, "start": start, "end": end, "points": vals})
    return {"url": "https://www.cpc.ncep.noaa.gov/products/predictions/610day/", "outlooks": out}


def fetch(cfg, demo: bool = False):
    if demo:
        from .demo import outlooks as demo_outlooks
        return demo_outlooks(cfg)
    res = {"discussions": discussions(cfg)}
    try:
        res["ero"] = excessive_rainfall(cfg)
    except Exception as e:
        log.warning("excessive rainfall outlook unavailable (%s)", report.short(e))
    try:
        res["cpc"] = cpc(cfg)
    except Exception as e:
        log.warning("CPC outlooks unavailable (%s)", report.short(e))
    log.info("NWS outlooks: %d discussions, ERO %s, CPC %d layers", len(res["discussions"]),
             "ok" if res.get("ero") else "missing", len((res.get("cpc") or {}).get("outlooks", [])))
    return res
