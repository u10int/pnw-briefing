"""What has actually been observed at each forecast location over the last few days, and the
reports NWS offices have put out.

- Stations (config `obs_reports.stations`): per local calendar day, precipitation, peak gust, new
  snow and the high and low temperature at the station that stands for each location.
  - ASOS (lowland and coast): the Iowa Environmental Mesonet's daily summaries of the airport
    observations (precipitation in inches, a trace stored as 0.0001; gusts in knots).
  - Environment Canada climate stations (B.C.): daily totals from MSC GeoMet, usually a day behind.
  - SNOTEL (the passes): hourly precipitation and snow depth from NRCS; a day's precipitation is
    the rise in the accumulated gauge, its new snow the rise in depth over the previous day's last
    reading (to the whole inch, since depth sensors wobble), its high and low the extremes of the
    hourly air temperature.
- NWS local storm reports (IEM's archive, by office): rain and snow totals, wind gusts, wind damage,
  flooding and ice, from spotters, mesonets and officials, each tied to the nearest forecast location.
- Reports are kept for `report_hours` (48) after the time of the event, whether or not the office
  issues anything newer; the page also drops them once they pass that age while it's open.
- NWS Public Information Statement summaries (Seattle and Portland, via IEM's text archive): after
  an event the offices list the highest wind reports, snowfall or rainfall totals from dozens of
  sites, grouped by county or zone, each with an amount, time and position. Every row becomes a
  report; a single storm report repeated in a summary is kept once. High and low temperature
  summaries become `high` and `low` reports. Portland's list a provider in place of a position;
  those rows have no coordinates and are tied to a location only when the place names it.
"""
from __future__ import annotations

import re

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import requests

from .snowpack import _km, http_json

log = logging.getLogger(__name__)
PT = ZoneInfo("America/Los_Angeles")
IEM = "https://mesonet.agron.iastate.edu"
ECCC = "https://api.weather.gc.ca/collections/climate-daily/items"
AWDB = "https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data"
KT_TO_MPH = 1.15078
NEAR_KM = 30


def _network(pt, sid):
    if sid.startswith("C") and len(sid) == 4:
        return "CA_BC_ASOS"
    return "OR_ASOS" if pt.get("region") == "nwor" else "WA_ASOS"


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def asos(sid, network, days):
    """{date: {precip, gust, gustTime, snow}} from IEM daily summaries."""
    months = sorted({(d.year, d.month) for d in days})
    rows = []
    for y, m in months:
        rows += http_json(f"{IEM}/api/1/daily.json", {"station": sid, "network": network, "year": y, "month": m}).get("data", [])
    want = {d.isoformat() for d in days}
    out = {}
    for r in rows:
        if r.get("date") not in want:
            continue
        p, g, sn = _num(r.get("precip")), _num(r.get("max_gust")), _num(r.get("snow"))
        hi, lo = _num(r.get("max_tmpf")), _num(r.get("min_tmpf"))
        out[r["date"]] = {"precip": None if p is None else (0.001 if 0 < p < 0.001 else round(p, 2)),   # 0.001 = trace
                          "gust": None if g is None else round(g * KT_TO_MPH),
                          "gustTime": r.get("max_gust_localts") or None,
                          "snow": None if sn is None else round(sn, 1),
                          "tmax": None if hi is None else round(hi), "tmin": None if lo is None else round(lo)}
    return out


def eccc(cid, days):
    """{date: {precip, gust, snow}} from Environment Canada's daily climate data (mm, km/h, cm)."""
    js = http_json(ECCC, {"f": "json", "CLIMATE_IDENTIFIER": cid, "sortby": "-LOCAL_DATE", "limit": len(days) + 3})
    want = {d.isoformat() for d in days}
    out = {}
    for f in js.get("features", []):
        a = f.get("properties", {})
        d = str(a.get("LOCAL_DATE", ""))[:10]
        if d not in want:
            continue
        p, g, sn = _num(a.get("TOTAL_PRECIPITATION")), _num(a.get("SPEED_MAX_GUST")), _num(a.get("TOTAL_SNOW"))
        hi, lo = _num(a.get("MAX_TEMPERATURE")), _num(a.get("MIN_TEMPERATURE"))
        f = lambda c: None if c is None else round(c * 9 / 5 + 32)
        out[d] = {"precip": None if p is None else round(p / 25.4, 2), "gust": None if g is None else round(g / 1.609),
                  "tmax": f(hi), "tmin": f(lo),
                  "snow": None if sn is None else round(sn / 2.54, 1), "name": a.get("STATION_NAME")}
    return out


def snotel(triplets, days):
    """{triplet: {date: {precip, snow, depth, tmax, tmin}}} from hourly SNOTEL readings (local standard time)."""
    js = http_json(AWDB, {"stationTriplets": ",".join(triplets), "elements": "PREC,SNWD,TOBS", "duration": "HOURLY",
                          "beginDate": f"{(days[0] - timedelta(days=1)).isoformat()} 00:00",
                          "endDate": f"{(days[-1] + timedelta(days=1)).isoformat()} 00:00", "returnFlags": "false"})
    out = {}
    for st in js:
        ser = {}
        for d in st.get("data", []):
            el = d.get("stationElement", {}).get("elementCode")
            ser[el] = [(v["date"], v["value"]) for v in d.get("values", []) if v.get("value") is not None]
        by = {}
        for el in ("PREC", "SNWD", "TOBS"):
            for t, v in ser.get(el, []):
                by.setdefault(t[:10], {}).setdefault(el, []).append(v)
        rec = {}
        for d in days:
            k, prev = d.isoformat(), (d - timedelta(days=1)).isoformat()
            today, before = by.get(k, {}), by.get(prev, {})
            p = round(max(today["PREC"][-1] - before["PREC"][-1], 0), 2) if today.get("PREC") and before.get("PREC") else None
            sn = round(max(max(today["SNWD"]) - before["SNWD"][-1], 0)) if today.get("SNWD") and before.get("SNWD") else None
            t = today.get("TOBS") or []
            # a day's high and low need most of its hours (today: whatever has come in so far)
            ok = len(t) >= (1 if d == days[-1] else 18)
            rec[k] = {"precip": p, "snow": sn, "depth": today["SNWD"][-1] if today.get("SNWD") else None,
                      "tmax": round(max(t)) if ok else None, "tmin": round(min(t)) if ok else None}
        out[st["stationTriplet"]] = rec
    return out


def _station_names(networks):
    names = {}
    for n in networks:
        try:
            js = http_json(f"{IEM}/geojson/network/{n}.geojson", {})
            names.update({f["properties"]["sid"]: f["properties"].get("sname") for f in js.get("features", [])})
        except Exception as e:
            log.info("station names for %s unavailable (%s)", n, e)
    return names


def _snotel_names(triplets):
    try:
        js = http_json("https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations",
                       {"stationTriplets": ",".join(triplets), "returnStationElements": "false"})
        return {s["stationTriplet"]: (s.get("name"), s.get("elevation")) for s in js}
    except Exception as e:
        log.info("SNOTEL names unavailable (%s)", e)
        return {}


LSR_KIND = (("FREEZING RAIN", "ice"), ("ICE", "ice"), ("SLEET", "ice"), ("SNOW", "snow"), ("RAIN", "rain"),
            ("WND GST", "gust"), ("WND DMG", "damage"), ("FLOOD", "flood"))


def _lsr_kind(text):
    t = (text or "").upper()
    if "TSTM" in t and "NON-TSTM" not in t:
        return None                                    # thunderstorm reports are on the Outlooks tab
    return next((k for key, k in LSR_KIND if key in t), None)


def lsrs(cfg, wfos, start, end):
    """Local storm reports in the map area, newest first."""
    js = http_json(f"{IEM}/geojson/lsr.geojson", {"wfos": ",".join(wfos), "sts": start.strftime("%Y-%m-%dT%H:%MZ"),
                                                  "ets": end.strftime("%Y-%m-%dT%H:%MZ")})
    d = cfg["domain"]
    pts = cfg["points"]
    out = []
    for f in js.get("features", []):
        a = f.get("properties", {})
        kind = _lsr_kind(a.get("typetext"))
        lon, lat = _num(a.get("lon")), _num(a.get("lat"))
        if not kind or lon is None or lat is None:
            continue
        if not (d["lon_min"] <= lon <= d["lon_max"] and d["lat_min"] <= lat <= d["lat_max"]):
            continue
        dist = [(_km(lat, lon, p["lat"], p["lon"]), p["name"]) for p in pts]
        km, near = min(dist)
        unit = (a.get("unit") or "").upper()
        mag = _num(a.get("magf"))
        if mag is not None and unit == "KNOTS":
            mag, unit = round(mag * KT_TO_MPH), "MPH"
        out.append({"kind": kind, "type": (a.get("typetext") or "").title(), "time": a.get("valid"),
                    "lat": lat, "lon": lon, "mag": mag, "unit": unit.lower() or None,
                    "measured": a.get("qualifier") == "M",
                    "place": a.get("city"), "county": a.get("county"), "state": a.get("st") or a.get("state"),
                    "source": a.get("source"), "remark": (a.get("remark") or "").strip()[:300] or None,
                    "near": near if km <= NEAR_KM else None})
    out.sort(key=lambda x: x["time"] or "", reverse=True)
    return out


# ------------------------------------------------------------------ PNS summaries

PNS_KIND = (("HIGH TEMP", "high"), ("LOW TEMP", "low"), ("MAX TEMP", "high"), ("MIN TEMP", "low"), ("WIND", "gust"), ("GUST", "gust"), ("SNOW", "snow"), ("ICE", "ice"), ("FREEZING", "ice"),
            ("RAIN", "rain"), ("PRECIP", "rain"))
# a report row: the location fills the first 29 columns, then amount, time/date, lat/lon[/elev]
# (temperature summaries: "97 F"; Portland's give a provider where Seattle's give the lat/lon)
PNS_ROW = re.compile(r"^(?P<mag>T|-?\d+(?:\.\d+)?)\s*(?P<unit>MPH|KTS?|IN(?:CH(?:ES)?)?|F)\s+(?P<hm>\d{3,4}) (?P<ap>[AP]M) "
                     r"(?P<mo>\d{1,2})/(?P<dd>\d{1,2})(?:\s+(?P<lat>\d+(?:\.\d+)?)N/(?P<lon>\d+(?:\.\d+)?)W(?:/(?P<elev>-?\d+))?.*|\s+(?P<prov>\S.*?))?\s*$", re.I)
TEMP_KINDS = ("high", "low")
HEAD = re.compile(r"^\.\.\.(.+?)\.\.\.\s*$")


def _pns_issued(text):
    """The issuance time from '549 AM PST Sun Nov 8 2026'."""
    m = re.search(r"^(\d{3,4}) ([AP]M) [A-Z]{3} \w{3} (\w{3}) (\d{1,2}) (\d{4})\s*$", text, re.M)
    if not m:
        return None
    hm = m[1].zfill(4)
    h = int(hm[:2]) % 12 + (12 if m[2] == "PM" else 0)
    from .fronts import MONTHS
    return datetime(int(m[5]), MONTHS[m[3].upper()], int(m[4]), h, int(hm[2:]), tzinfo=PT)


def parse_pns(text, office):
    """Report rows of one Public Information Statement, or [] when it holds none."""
    issued = _pns_issued(text)
    if not issued:
        return []
    out, kind, section, area = [], None, None, None
    for raw in text.replace("\r", "").split("\n"):
        ln = raw.rstrip()
        h = HEAD.match(ln.strip())
        if h:
            name = h[1].strip()
            up = name.upper()
            k = next((v for key, v in PNS_KIND if key in up), None) if ("REPORT" in up or "TOTAL" in up) else None
            if k:
                kind, section, area = k, name.title(), None
            elif kind and not name.isupper():
                area = name                                   # a county or forecast zone
            continue
        if not kind or len(ln) < 40:
            continue
        m = PNS_ROW.match(ln[29:].strip()) if len(ln) > 29 else None
        if not m:
            continue
        place = ln[:29].strip()
        hm = m["hm"].zfill(4)
        hour = int(hm[:2]) % 12 + (12 if m["ap"].upper() == "PM" else 0)
        yr = issued.year - (1 if int(m["mo"]) > issued.month + 6 else 0)
        try:
            t = datetime(yr, int(m["mo"]), int(m["dd"]), hour, int(hm[2:]), tzinfo=PT)
        except ValueError:
            continue
        unit = m["unit"].upper()
        if (unit == "F") != (kind in TEMP_KINDS):
            continue
        if m["lat"] is None and kind not in TEMP_KINDS:
            continue
        mag = 0.001 if m["mag"].upper() == "T" else float(m["mag"])
        if unit.startswith("KT"):
            mag, unit = round(mag * KT_TO_MPH), "MPH"
        out.append({"kind": kind, "type": {"gust": "Wind Gust", "snow": "Snowfall", "rain": "Rainfall", "ice": "Ice",
                                           "high": "High Temperature", "low": "Low Temperature"}.get(kind, section),
                    "time": t.astimezone(timezone.utc).isoformat(),
                    "lat": float(m["lat"]) if m["lat"] else None, "lon": -float(m["lon"]) if m["lon"] else None,
                    "mag": mag, "unit": "mph" if unit == "MPH" else "F" if unit == "F" else "inch",
                    "measured": None, "place": place, "county": area, "state": None, "source": (m["prov"] or "").strip() or None, "remark": None,
                    "elev_ft": int(m["elev"]) if m["elev"] else None,
                    "summary": {"office": office, "title": section, "issued": issued.astimezone(timezone.utc).isoformat()}})
    return out


def pns_reports(cfg, offices, start, end):
    """Rows from the offices' Public Information Statements issued since `start`, in the map area;
    where a summary is reissued, the latest issue's rows win."""
    d = cfg["domain"]
    rows = {}
    for off in offices:
        try:
            r = requests.get(f"{IEM}/cgi-bin/afos/retrieve.py", timeout=60, headers={"User-Agent": "pnw-briefing/1.0"},
                             params={"pil": f"PNS{off}", "limit": 20, "fmt": "text", "sdate": start.strftime("%Y-%m-%d"),
                                     "edate": (end + timedelta(days=1)).strftime("%Y-%m-%d")})
            r.raise_for_status()
        except Exception as e:
            log.info("PNS%s unavailable (%s)", off, e)
            continue
        for prod in r.text.split("\x01"):
            for x in parse_pns(prod, off):
                if x["lat"] is not None and not (d["lon_min"] <= x["lon"] <= d["lon_max"] and d["lat_min"] <= x["lat"] <= d["lat_max"]):
                    continue
                if x["summary"]["issued"] < start.isoformat():
                    continue
                k = (x["kind"], x["place"], x["time"])
                if k not in rows or (x["summary"]["issued"], x["mag"]) > (rows[k]["summary"]["issued"], rows[k]["mag"]):
                    rows[k] = x
    return list(rows.values())


def merge_reports(lsr, pns, pts):
    """Storm reports and summary rows together, a storm report dropped where a summary repeats it
    (same kind and amount, within 3 km and 15 minutes); each tied to the nearest location."""
    def same(a, b):
        if a["lat"] is None or b["lat"] is None:
            return False
        return (a["kind"] == b["kind"] and a["mag"] is not None and b["mag"] is not None and abs(a["mag"] - b["mag"]) < 0.51
                and _km(a["lat"], a["lon"], b["lat"], b["lon"]) <= 3
                and abs(datetime.fromisoformat(a["time"].replace("Z", "+00:00")) - datetime.fromisoformat(b["time"])) <= timedelta(minutes=15))
    out = [r for r in lsr if not any(same(r, p) for p in pns)]
    for p in pns:
        if p["lat"] is None:                        # no position: the location its place names, if any
            name = (p["place"] or "").lower()
            near = next((q["name"] for q in pts if re.match(rf"{re.escape(q['name'].lower())}\b", name)), None)
            out.append({**p, "near": near})
            continue
        km, near = min((_km(p["lat"], p["lon"], q["lat"], q["lon"]), q["name"]) for q in pts)
        out.append({**p, "near": near if km <= NEAR_KM else None})
    out.sort(key=lambda x: x["time"] or "", reverse=True)
    return out


def fetch(cfg, demo=False, now=None):
    spec = cfg.get("obs_reports") or {}
    if not spec:
        return None
    if demo:
        from . import demo as src
        return src.obs_reports(cfg)
    now = now or datetime.now(timezone.utc)
    today = now.astimezone(PT).date()
    days = [today - timedelta(days=k) for k in range(int(spec.get("days", 3)), -1, -1)]
    pts = {p["name"]: p for p in cfg["points"]}
    st = {k: v for k, v in (spec.get("stations") or {}).items() if k in pts}

    jobs = {}
    with ThreadPoolExecutor(8) as ex:
        for name, s in st.items():
            if s.get("asos"):
                jobs[(name, "asos")] = ex.submit(asos, s["asos"], s.get("network") or _network(pts[name], s["asos"]), days)
            if s.get("eccc"):
                jobs[(name, "eccc")] = ex.submit(eccc, s["eccc"], days)
        trips = sorted({s["snotel"] for s in st.values() if s.get("snotel")})
        sn_job = ex.submit(snotel, trips, days) if trips else None
        names_job = ex.submit(_station_names, sorted({s.get("network") or _network(pts[n], s["asos"]) for n, s in st.items() if s.get("asos")}))
        sn_names_job = ex.submit(_snotel_names, trips) if trips else None
        # reports drop out `report_hours` after the event; summaries issued a day later still count
        hours = float(spec.get("report_hours", 48))
        since = now - timedelta(hours=hours + 24)
        offices = spec.get("lsr_wfos", ["SEW", "PQR"])
        lsr_job = ex.submit(lsrs, cfg, offices, since, now)
        pns_job = ex.submit(pns_reports, cfg, offices, since, now)

    def res(job, what):
        try:
            return job.result() if job else None
        except Exception as e:
            log.warning("%s unavailable (%s)", what, e)
            return None

    sn = res(sn_job, "SNOTEL observations") or {}
    names = res(names_job, "station names") or {}
    sn_names = res(sn_names_job, "SNOTEL names") or {}
    points = {}
    for name, s in st.items():
        a = res(jobs.get((name, "asos")), f"{name} ASOS") or {}
        c = res(jobs.get((name, "eccc")), f"{name} climate station") or {}
        t = sn.get(s.get("snotel"), {})
        rows = {"precip": [], "gust": [], "gustTime": [], "snow": [], "tmax": [], "tmin": []}
        for d in days:
            k = d.isoformat()
            ad, cd, td = a.get(k, {}), c.get(k, {}), t.get(k, {})
            rows["precip"].append(next((x.get("precip") for x in (cd, ad, td) if x.get("precip") is not None), None))
            g = next((x for x in (ad, cd) if x.get("gust") is not None), {})
            rows["gust"].append(g.get("gust"))
            rows["gustTime"].append(g.get("gustTime"))
            rows["snow"].append(next((x.get("snow") for x in (td, cd, ad) if x.get("snow") is not None), None))
            # highs and lows: the airport first (current to the hour), then the climate station, then SNOTEL
            for v in ("tmax", "tmin"):
                rows[v].append(next((x.get(v) for x in (ad, cd, td) if x.get(v) is not None), None))
        sources = []
        if s.get("asos"):
            sources.append(f"{(names.get(s['asos']) or s['asos']).title()} ({s['asos']})")
        if s.get("eccc"):
            nm = next((v.get("name") for v in c.values() if v.get("name")), None)
            sources.append(f"{(nm or 'Environment Canada ' + s['eccc']).title()} (Environment Canada)")
        if s.get("snotel"):
            nm, el = sn_names.get(s["snotel"], (None, None))
            sources.append(f"{nm or s['snotel']} SNOTEL" + (f" ({int(el):,} ft)" if el else ""))
        if any(v is not None for r in ("precip", "gust", "snow", "tmax", "tmin") for v in rows[r]):
            points[name] = {**rows, "stations": sources}
    reports = merge_reports(res(lsr_job, "local storm reports") or [], res(pns_job, "NWS report summaries") or [], cfg["points"])
    cutoff = now - timedelta(hours=hours)
    reports = [r for r in reports if r["time"] and datetime.fromisoformat(r["time"].replace("Z", "+00:00")) >= cutoff]
    log.info("observed reports: %d locations, %d storm reports", len(points), len(reports))
    if not points and not reports:
        return None
    return {"days": [d.isoformat() for d in days], "today": today.isoformat(), "points": points, "reports": reports, "reportHours": hours,
            "source": "Airport observations via the Iowa Environmental Mesonet; Environment Canada; USDA NRCS SNOTEL; NWS local storm reports and Public Information Statement summaries (IEM archive)"}
