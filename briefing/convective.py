"""Thunderstorms: SPC's convective outlooks and recent storm reports over the map area.

- Outlooks (NOAA mapservices, SPC_wx_outlks): the categorical risk for days 1 – 3 (general
  thunder, marginal, slight, enhanced, moderate, high), the tornado, wind and hail probabilities
  for days 1 – 2, the severe probability for day 3, and days 4 – 8 when any area is drawn. Each
  area keeps its polygon (trimmed to the map) and the forecast locations inside it.
- Storm reports (SPC's filtered local storm reports): tornado, wind and hail reports from the last
  three convective days (12Z – 12Z) inside the map area.

Mesoscale discussions are short-lived (a few hours), so the page fetches those live.
"""
from __future__ import annotations

import csv
import io
import logging
from datetime import datetime, timedelta, timezone

import requests

from .wildfire import _bbox, _inside, _query, _spc_time, _trim

log = logging.getLogger(__name__)

SPC_WX = "https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/SPC_wx_outlks/MapServer"
# layer id: (day, kind); kind "cat" is the categorical outlook, the rest probabilities
LAYERS = {1: (1, "cat"), 3: (1, "tornado"), 5: (1, "hail"), 7: (1, "wind"),
          9: (2, "cat"), 11: (2, "tornado"), 13: (2, "hail"), 15: (2, "wind"),
          17: (3, "cat"), 19: (3, "severe"),
          21: (4, "severe"), 22: (5, "severe"), 23: (6, "severe"), 24: (7, "severe"), 25: (8, "severe")}
CAT_RANK = {"TSTM": 1, "MRGL": 2, "SLGT": 3, "ENH": 4, "MDT": 5, "HIGH": 6}
REPORTS = "https://www.spc.noaa.gov/climo/reports"


def outlooks(cfg):
    """[{day, issued, valid, expire, areas: [{kind, label, name, rank, dn, fill, stroke, points, geometry}]}]
    for the days with anything over the map area (the categorical outlook's general-thunder area
    counts), most severe area first within each kind."""
    days = {}
    for lid, (day, kind) in LAYERS.items():
        for f in _query(f"{SPC_WX}/{lid}", cfg, simplify=0.02):
            a = f.get("properties", {})
            dn = int(a.get("dn") or 0)
            geom = _trim(f.get("geometry"), cfg)
            if dn <= 0 or geom is None:
                continue
            rec = days.setdefault(day, {"day": day, "issued": None, "valid": None, "expire": None, "areas": []})
            for k, s in (("issued", a.get("issue")), ("valid", a.get("valid")), ("expire", a.get("expire"))):
                t = _spc_time(s)
                if t and not rec[k]:
                    rec[k] = t.isoformat()
            label = str(a.get("label") or "")
            rec["areas"].append({
                "kind": kind, "label": label, "name": a.get("label2") or label, "dn": dn,
                "rank": CAT_RANK.get(label, 0) if kind == "cat" else dn,
                "sig": label.upper() == "SIGN",
                "fill": a.get("fill"), "stroke": a.get("stroke"),
                "points": _inside(geom, cfg), "geometry": geom,
            })
    for rec in days.values():
        rec["areas"].sort(key=lambda x: (x["kind"] != "cat", -x["rank"]))
    return [days[d] for d in sorted(days)]


def _report_rows(text, kind, date):
    """Rows of one section of an SPC daily report CSV (times are HHMM UTC; before 12Z is the
    next calendar day of the 12Z – 12Z convective day)."""
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            hhmm = str(r["Time"]).zfill(4)
            t = datetime(date.year, date.month, date.day, int(hhmm[:2]), int(hhmm[2:]), tzinfo=timezone.utc)
            if t.hour < 12:
                t += timedelta(days=1)
            lat, lon = float(r["Lat"]), float(r["Lon"])
        except (KeyError, TypeError, ValueError):
            continue
        mag = r.get("F_Scale") if kind == "tornado" else r.get("Speed") if kind == "wind" else r.get("Size")
        out.append({"type": kind, "time": t.isoformat(), "lat": lat, "lon": lon, "mag": (mag or "").strip(),
                    "location": (r.get("Location") or "").strip().title(), "county": (r.get("County") or "").strip().title(),
                    "state": (r.get("State") or "").strip(), "comments": (r.get("Comments") or "").strip()[:300]})
    return out


def _parse_reports(text, date):
    """An SPC daily report CSV holds three sections, each with its own header line."""
    sections, cur, kind = [], [], None
    for line in text.splitlines():
        if line.startswith("Time,"):
            if kind and cur:
                sections.append((kind, "\n".join(cur)))
            kind = "tornado" if "F_Scale" in line else "wind" if "Speed" in line else "hail" if "Size" in line else None
            cur = [line]
        elif line.strip():
            cur.append(line)
    if kind and cur:
        sections.append((kind, "\n".join(cur)))
    return [row for k, body in sections for row in _report_rows(body, k, date)]


def reports(cfg, now=None, ndays=3):
    """Tornado, wind and hail reports from the last `ndays` convective days inside the map area,
    newest first. Today's and yesterday's come from SPC's rolling files, older days from the
    dated archive."""
    now = now or datetime.now(timezone.utc)
    x0, y0, x1, y1 = _bbox(cfg)
    today = (now - timedelta(hours=12)).date()                    # the convective day now in progress
    out = []
    for k in range(ndays):
        d = today - timedelta(days=k)
        url = (f"{REPORTS}/today_filtered.csv" if k == 0 else f"{REPORTS}/yesterday_filtered.csv" if k == 1
               else f"{REPORTS}/{d:%y%m%d}_rpts_filtered.csv")
        try:
            r = requests.get(url, timeout=30, headers={"User-Agent": "pnw-briefing/1.0"})
            if r.status_code == 404:
                continue
            r.raise_for_status()
        except Exception as e:
            log.info("storm reports for %s unavailable (%s)", d, e)
            continue
        out += [x for x in _parse_reports(r.text, d) if x0 <= x["lon"] <= x1 and y0 <= x["lat"] <= y1]
    out.sort(key=lambda x: x["time"], reverse=True)
    return out


def fetch(cfg, demo=False):
    if demo:
        from . import demo as src
        return src.convective(cfg)
    o = outlooks(cfg)
    try:
        rp = reports(cfg)
    except Exception as e:
        log.warning("storm reports skipped (%s)", e)
        rp = []
    return {"source": "NOAA/NWS Storm Prediction Center", "outlooks": o, "reports": rp}
