"""Surface fronts and pressure centres from NOAA's Weather Prediction Center, for the map.

- Analyses: WPC's coded surface bulletin (high-resolution version), issued every 3 hours. The
  timed copies (codsus00_hr … codsus21_hr) hold the latest analysis for each synoptic hour, so
  the last day of analyses comes from eight files. Each gives fronts as point lists and highs and
  lows with their central pressure. The bulletin has no CORS headers, so it's read at build time.
- Forecasts: the fronts and highs and lows of WPC's National Forecast Chart for days 1 – 3 (NOAA
  mapservices, natl_fcst_wx_chart), one valid time per day. Only the ones after the latest
  analysis are kept.

Point order follows WPC's convention: walking along a front in the order given, the pips (the
triangles and half circles) are on the left.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone

import requests

from .wildfire import _bbox, _query

log = logging.getLogger(__name__)

CODSUS = "https://www.wpc.ncep.noaa.gov/discussions"
NFC = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/natl_fcst_wx_chart/MapServer"
NFC_LAYERS = {1: (1, 2), 2: (13, 14), 3: (25, 26)}           # day: (highs and lows, fronts)
CODE_TYPES = {"COLD": "cold", "WARM": "warm", "STNRY": "stationary", "OCFNT": "occluded", "TROF": "trough",
              "DRYLINE": "dryline", "SQLN": "squall"}
PAD = 12                                                      # degrees around the map area to keep
MONTHS = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}


def _box(cfg):
    return _bbox(cfg, pad=PAD)


def _near(coords, box):
    x0, y0, x1, y1 = box
    return any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in coords)


def _coord(tok):
    """Coded position: LLLOOOO (tenths of degrees, high-resolution bulletin) or LLOOO (whole
    degrees); longitudes west."""
    if len(tok) == 7:
        return [-int(tok[3:]) / 10, int(tok[:3]) / 10]
    if len(tok) == 5:
        return [-float(int(tok[2:])), float(int(tok[:2]))]
    return None


def parse_coded(text, now=None):
    """One coded bulletin: {"valid", "fronts": [{"type", "coords"}], "centers": [{"type", "lon", "lat", "p"}]},
    or None when it can't be read."""
    now = now or datetime.now(timezone.utc)
    lines = [ln.strip() for ln in text.replace("\r", "").split("\n")]
    m = next((re.match(r"VALID (\d{2})(\d{2})(\d{2})Z", ln) for ln in lines if ln.startswith("VALID")), None)
    if not m:
        return None
    mo, dd, hh = int(m[1]), int(m[2]), int(m[3])
    # the year: the issuance line's, else the one that puts the time nearest now
    yr = next((int(x[1]) for ln in lines if (x := re.search(r"\b[A-Z]{3} \d{2} (\d{4})$", ln))), now.year)
    valid = datetime(yr, mo, dd, hh, tzinfo=timezone.utc)
    if valid - now > timedelta(days=200):
        valid = valid.replace(year=yr - 1)
    # join continuation lines (they start with a digit) onto their keyword line
    recs = []
    for ln in lines:
        if not ln or ln == "$$":
            continue
        if ln[0].isdigit() and recs:
            recs[-1] += " " + ln
        elif ln.split()[0] in CODE_TYPES or ln.startswith(("HIGHS", "LOWS")):
            recs.append(ln)
    fronts, centers = [], []
    for r in recs:
        key, *toks = r.split()
        if key in ("HIGHS", "LOWS"):
            for p, c in zip(toks[0::2], toks[1::2]):
                xy = _coord(c)
                if xy:
                    centers.append({"type": "H" if key == "HIGHS" else "L", "lon": xy[0], "lat": xy[1], "p": int(p)})
        else:
            coords = [xy for t in toks if (xy := _coord(t))]
            if len(coords) >= 2:
                fronts.append({"type": CODE_TYPES[key], "coords": coords})
    return {"valid": valid.isoformat(), "fronts": fronts, "centers": centers}


def _clip(frame, box):
    """Keep what's near the map area."""
    x0, y0, x1, y1 = box
    return {**frame,
            "fronts": [f for f in frame["fronts"] if _near(f["coords"], box)],
            "centers": [c for c in frame["centers"] if x0 <= c["lon"] <= x1 and y0 <= c["lat"] <= y1]}


def analyses(cfg, now=None, hours=27):
    """The analyses from the last `hours`, oldest first."""
    now = now or datetime.now(timezone.utc)
    box = _box(cfg)
    out = {}
    for name in [f"codsus{h:02d}_hr" for h in range(0, 24, 3)] + ["codsus_hr"]:
        try:
            r = requests.get(f"{CODSUS}/{name}", timeout=30, headers={"User-Agent": "pnw-briefing/1.0"})
            r.raise_for_status()
            f = parse_coded(r.text, now)
        except Exception as e:
            log.info("surface analysis %s unavailable (%s)", name, e)
            continue
        if f and now - datetime.fromisoformat(f["valid"]) <= timedelta(hours=hours):
            out[f["valid"]] = {"kind": "analysis", **_clip(f, box)}
    return [out[k] for k in sorted(out)]


def nfc_valid(popup):
    """'Cold Front Valid: Sun Morning Nov 08 2026' → 12Z that day; a bare date is the chart's
    evening fronts (7 PM EST, 00Z the next day)."""
    m = re.search(r"Valid:\s*\w{3}\s*(Morning|Afternoon|Evening|Night)?\s*([A-Z][a-z]{2}) (\d{1,2}) (\d{4})", popup or "")
    if not m:
        return None
    d = datetime(int(m[4]), MONTHS[m[2].upper()], int(m[3]), tzinfo=timezone.utc)
    part = m[1] or "Evening"
    return d + timedelta(hours={"Morning": 12, "Afternoon": 18}.get(part, 24))


def _nfc_type(feat):
    f = (feat or "").lower()
    for k, v in (("cold", "cold"), ("warm", "warm"), ("stationary", "stationary"), ("occluded", "occluded"),
                 ("trough", "trough"), ("dry", "dryline"), ("squall", "squall")):
        if k in f:
            return v
    return None


def _lines(geom):
    if not geom:
        return []
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def nfc_frame(centers_fc, fronts_fc, box):
    """One day of the forecast chart from its two layers' GeoJSON features."""
    valid, fronts, centers = None, [], []
    for f in fronts_fc:
        a = f.get("properties", {})
        valid = valid or nfc_valid(a.get("popupconte"))
        t = _nfc_type(a.get("feat"))
        for ln in _lines(f.get("geometry")) if t else []:
            coords = [[round(x, 3), round(y, 3)] for x, y in ln]
            if len(coords) >= 2 and _near(coords, box):
                fronts.append({"type": t, "coords": coords})
    x0, y0, x1, y1 = box
    for f in centers_fc:
        a = f.get("properties", {})
        valid = valid or nfc_valid(a.get("popupconte"))
        g = f.get("geometry") or {}
        feat = (a.get("feat") or "").lower()
        if g.get("type") != "Point" or not ("high" in feat or "low" in feat):
            continue
        x, y = g["coordinates"][:2]
        if x0 <= x <= x1 and y0 <= y <= y1:
            centers.append({"type": "H" if "high" in feat else "L", "lon": round(x, 2), "lat": round(y, 2), "p": None})
    if not valid:
        return None
    return {"kind": "forecast", "valid": valid.isoformat(), "fronts": fronts, "centers": centers}


def forecasts(cfg):
    box = _box(cfg)
    # the services' envelope filter returns whole features; ask over the padded box
    qcfg = {**cfg, "domain": {"lon_min": box[0], "lat_min": box[1], "lon_max": box[2], "lat_max": box[3]}}
    out = []
    for day, (hl, fr) in NFC_LAYERS.items():
        try:
            f = nfc_frame(_query(f"{NFC}/{hl}", qcfg, simplify=0.02), _query(f"{NFC}/{fr}", qcfg, simplify=0.02), box)
        except Exception as e:
            log.info("forecast chart day %d unavailable (%s)", day, e)
            continue
        if f:
            out.append({**f, "day": day})
    return out


def fetch(cfg, demo=False):
    if demo:
        from . import demo as src
        return src.fronts(cfg)
    an = analyses(cfg)
    last = an[-1]["valid"] if an else ""
    fc = [f for f in forecasts(cfg) if f["valid"] > last]
    if not an and not fc:
        return None
    return {"source": "NOAA/NWS Weather Prediction Center", "frames": an + sorted(fc, key=lambda f: f["valid"])}
