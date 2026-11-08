"""The coast and inland waters: buoys, the wave forecast, tides against flood levels, and marine
warnings. Everything here is read when the briefing builds.

- Buoys (NDBC realtime2, config `coast.buoys`): the latest reading and the last 24 hours' highest
  waves and gusts. Waves in feet, wind in mph, water temperature in °F.
- Wave forecast (Open-Meteo's marine API, config `coast.wave_points`): hourly significant wave
  height, period and direction offshore of the coastal locations and in the Strait, and each
  local day's highest waves.
- Tides (NOAA CO-OPS, config `coast.tides`): the next week's high tides at each gauge, its minor
  flood level (NWS's, else NOS's), and how far the water is running above or below the
  prediction right now (a rough storm surge). Each high tide is compared with the flood level,
  with that surge added on, so a king tide and a storm lining up shows.
- Marine warnings (api.weather.gov, Pacific marine area PZ): gale, storm, hurricane-force and
  hazardous seas warnings, small craft advisories and the like for the zones NWS Seattle (PZZ1xx)
  and Portland (PZZ2xx) cover. The page refreshes these live.
"""
from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

from .alerts import user_agent

log = logging.getLogger(__name__)
PT = ZoneInfo("America/Los_Angeles")
NDBC = "https://www.ndbc.noaa.gov/data/realtime2"
MARINE = "https://marine-api.open-meteo.com/v1/marine"
COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
COOPS_MD = "https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations"
NWS = "https://api.weather.gov"
M_TO_FT = 3.28084
MS_TO_MPH = 2.23694
UA = {"User-Agent": "pnw-briefing/1.0"}


def _get(url, params=None, headers=None, timeout=45):
    r = requests.get(url, params=params, headers=headers or UA, timeout=timeout)
    r.raise_for_status()
    return r


def _f(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v


# ------------------------------------------------------------------ buoys

def parse_ndbc(text, now, hours=24):
    """Rows of an NDBC realtime2 standard met file within `hours` of now, newest first."""
    lines = text.splitlines()
    head = lines[0].lstrip("#").split() if lines else []
    rows = []
    for ln in lines[2:]:
        p = ln.split()
        if len(p) != len(head):
            continue
        r = dict(zip(head, p))
        try:
            t = datetime(int(r["YY"]), int(r["MM"]), int(r["DD"]), int(r["hh"]), int(r["mm"]), tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        if now - t > timedelta(hours=hours):
            break
        v = {k: (None if r.get(k) in (None, "MM") else _f(r[k])) for k in ("WDIR", "WSPD", "GST", "WVHT", "DPD", "MWD", "WTMP", "PRES")}
        rows.append({"time": t.isoformat(),
                     "wave": None if v["WVHT"] is None else round(v["WVHT"] * M_TO_FT, 1),
                     "period": v["DPD"], "waveDir": v["MWD"],
                     "wind": None if v["WSPD"] is None else round(v["WSPD"] * MS_TO_MPH),
                     "gust": None if v["GST"] is None else round(v["GST"] * MS_TO_MPH),
                     "windDir": v["WDIR"],
                     "water": None if v["WTMP"] is None else round(v["WTMP"] * 9 / 5 + 32)})
    return rows


def buoy(b, now):
    rows = parse_ndbc(_get(f"{NDBC}/{b['id']}.txt").text, now)
    if not rows:
        return None
    latest = lambda k: next(((r[k], r["time"]) for r in rows if r[k] is not None), (None, None))
    wave, wt = latest("wave")
    wind, _ = latest("wind")
    gust, gt = latest("gust")
    i = next((k for k, r in enumerate(rows) if r["wave"] is not None), None)
    peak = lambda k: max((r[k] for r in rows if r[k] is not None), default=None)
    # 3-hourly wave heights for a sparkline, oldest first
    spark = [r["wave"] for r in rows[::-1] if r["wave"] is not None][::3][-9:]
    return {**{k: b[k] for k in ("id", "name", "lat", "lon", "area")},
            "time": wt or gt or rows[0]["time"],
            "wave": wave, "period": rows[i]["period"] if i is not None else None, "waveDir": rows[i]["waveDir"] if i is not None else None,
            "wind": wind, "gust": gust, "windDir": next((r["windDir"] for r in rows if r["windDir"] is not None), None),
            "water": latest("water")[0],
            "waveMax24": peak("wave"), "gustMax24": peak("gust"), "spark": spark}


# ------------------------------------------------------------------ wave forecast

def wave_forecast(pts, days=7):
    """{name: {hourly: {time, height, period, dir}, daily: [{date, max, period, dir, time}]}} (feet, seconds)."""
    js = _get(MARINE, {"latitude": ",".join(str(p["lat"]) for p in pts), "longitude": ",".join(str(p["lon"]) for p in pts),
                       "hourly": "wave_height,wave_period,wave_direction", "forecast_days": days,
                       "timezone": "America/Los_Angeles", "length_unit": "imperial"}).json()
    if isinstance(js, dict):
        js = [js]
    out = {}
    for p, loc in zip(pts, js):
        h = loc.get("hourly") or {}
        t, ht, per, dr = h.get("time", []), h.get("wave_height", []), h.get("wave_period", []), h.get("wave_direction", [])
        if not any(x is not None for x in ht):
            continue                                   # outside the wave model (inland waters)
        unit = (loc.get("hourly_units") or {}).get("wave_height", "ft")
        k = 1 if unit.startswith("ft") else M_TO_FT
        height = [None if x is None else round(x * k, 1) for x in ht]
        daily = {}
        for i, ts in enumerate(t):
            if height[i] is None:
                continue
            d = ts[:10]
            if d not in daily or height[i] > daily[d]["max"]:
                daily[d] = {"date": d, "max": height[i], "period": per[i], "dir": dr[i], "time": ts}
        out[p["name"]] = {"name": p["name"], "lat": p["lat"], "lon": p["lon"], "near": p.get("near"), "area": p.get("area"),
                          "hourly": {"time": t, "height": height, "period": per, "dir": dr},
                          "daily": [daily[d] for d in sorted(daily)]}
    return out


# ------------------------------------------------------------------ tides

def _coops(params):
    js = _get(COOPS, {"datum": "MLLW", "units": "english", "format": "json", "application": "pnw-briefing", **params}).json()
    if "error" in js:
        raise RuntimeError(js["error"].get("message", "CO-OPS error"))
    return js


def _surge(sid, now):
    """Observed minus predicted water level over the last hour (ft), or None."""
    begin = (now - timedelta(hours=3)).strftime("%Y%m%d %H:%M")
    end = now.strftime("%Y%m%d %H:%M")
    obs = _coops({"product": "water_level", "station": sid, "begin_date": begin, "end_date": end, "time_zone": "gmt"}).get("data", [])
    pred = _coops({"product": "predictions", "station": sid, "begin_date": begin, "end_date": end, "time_zone": "gmt"}).get("predictions", [])
    pm = {p["t"]: _f(p["v"]) for p in pred}
    diffs = [(o["t"], _f(o["v"]) - pm[o["t"]]) for o in obs if _f(o.get("v")) is not None and pm.get(o["t"]) is not None]
    last = [d for t, d in diffs if t >= (now - timedelta(hours=1)).strftime("%Y-%m-%d %H:%M")]
    return round(sum(last) / len(last), 2) if last else None


def tide(g, now, days=7):
    pred = _coops({"product": "predictions", "station": g["id"], "begin_date": now.astimezone(PT).strftime("%Y%m%d"),
                   "range": 24 * days, "time_zone": "lst_ldt", "interval": "hilo"}).get("predictions", [])
    highs = [{"time": p["t"].replace(" ", "T"), "height": round(_f(p["v"]), 2)} for p in pred if p.get("type") == "H" and _f(p.get("v")) is not None]
    flood = None
    if g.get("flood", True):
        try:
            f = _get(f"{COOPS_MD}/{g['id']}/floodlevels.json").json()
            flood = f.get("nws_minor") or f.get("nos_minor")
        except Exception as e:
            log.info("flood levels for %s unavailable (%s)", g["name"], e)
    try:
        surge = _surge(g["id"], now)
    except Exception as e:
        log.info("water level at %s unavailable (%s)", g["name"], e)
        surge = None
    for h in highs:
        h["margin"] = round(flood - h["height"] - (surge or 0), 2) if flood else None
    return {"id": g["id"], "name": g["name"], "near": g.get("near"), "area": g.get("area"),
            "flood": flood, "surge": surge, "highs": highs}


# ------------------------------------------------------------------ marine warnings

def marine_alerts(cfg, prefixes):
    js = _get(f"{NWS}/alerts/active", {"area": "PZ"}, headers={"User-Agent": user_agent(cfg), "Accept": "application/geo+json"}).json()
    out = []
    for f in js.get("features", []):
        a = f.get("properties", {})
        zones = [z for z in (a.get("geocode") or {}).get("UGC", []) if z.startswith(tuple(prefixes))]
        if not zones:
            continue
        out.append({"id": a.get("id"), "event": a.get("event"), "severity": a.get("severity"), "headline": a.get("headline"),
                    "onset": a.get("onset") or a.get("effective"), "ends": a.get("ends") or a.get("expires"),
                    "areaDesc": a.get("areaDesc"), "zones": zones, "sender": a.get("senderName"),
                    "url": f"https://alerts.weather.gov/search?id={a.get('id')}" if a.get("id") else None})
    return out


# ------------------------------------------------------------------

def fetch(cfg, demo=False, now=None):
    spec = cfg.get("coast") or {}
    if not spec:
        return None
    if demo:
        from . import demo as src
        return src.coast(cfg)
    now = now or datetime.now(timezone.utc)
    with ThreadPoolExecutor(8) as ex:
        bj = [(b, ex.submit(buoy, b, now)) for b in spec.get("buoys", [])]
        tj = [(g, ex.submit(tide, g, now)) for g in spec.get("tides", [])]
        wj = ex.submit(wave_forecast, spec.get("wave_points", [])) if spec.get("wave_points") else None
        aj = ex.submit(marine_alerts, cfg, spec.get("marine_zone_prefixes", ["PZZ1", "PZZ2"]))

    def res(job, what):
        try:
            return job.result() if job else None
        except Exception as e:
            log.warning("%s unavailable (%s)", what, e)
            return None

    buoys = [x for b, j in bj if (x := res(j, f"buoy {b['id']}"))]
    tides = [x for g, j in tj if (x := res(j, f"tides at {g['name']}"))]
    waves = res(wj, "wave forecast") or {}
    alerts = res(aj, "marine alerts")
    log.info("coast: %d buoys, %d wave points, %d tide gauges, %s marine alerts", len(buoys), len(waves), len(tides),
             "no" if alerts is None else len(alerts))
    if not (buoys or tides or waves or alerts):
        return None
    return {"fetched": now.isoformat(), "buoys": buoys, "waves": list(waves.values()), "tides": tides,
            "marineAlerts": alerts, "zonePrefixes": spec.get("marine_zone_prefixes", ["PZZ1", "PZZ2"]),
            "source": "NOAA NDBC buoys; Open-Meteo marine forecast; NOAA CO-OPS tides and flood levels; NWS marine alerts"}
