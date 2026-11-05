"""Optional Open-Meteo supplement for models with no public GRIB feed.

Hourly data is summed into the briefing's 12Z-12Z days so it lines up with
the GRIB models. Output shapes match grib.py.
"""
from __future__ import annotations

import logging
import time
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests

from . import report

log = logging.getLogger(__name__)

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ENSEMBLE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble"
HOURLY = ["precipitation", "rain", "snowfall", "temperature_2m", "wind_speed_10m", "wind_gusts_10m",
          "relative_humidity_2m", "vapour_pressure_deficit"]
UNITS = {"precipitation_unit": "inch", "temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
         "timezone": "GMT"}
HEADERS = {"User-Agent": "pnw-briefing/1.0"}


def _get(url, params, tries=3):
    for i in range(tries):
        r = requests.get(url, params=params, headers=HEADERS, timeout=90)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 400:
            raise ValueError(r.json().get("reason", r.text[:200]))
        time.sleep(5 * (i + 1))
    r.raise_for_status()


def _first_working(url, params, ids):
    last = None
    for mid in ids:
        try:
            js = _get(url, {**params, "models": mid})
            return mid, (js if isinstance(js, list) else [js])
        except Exception as e:
            last = e
    raise last or ValueError("no ids")


def _days(df, start, n):
    """Bin an hourly frame (UTC index, values valid at end of hour) into 12Z-12Z days."""
    edges = pd.date_range(start, periods=n + 1, freq="24h")
    lab = pd.cut(df.index, edges, right=True, labels=False)
    return df.groupby(lab)


def fetch_deterministic(cfg, start):
    sup = cfg.get("supplement", {})
    if not sup.get("enabled"):
        return []
    pts, n = cfg["points"], cfg["days"]
    tz = ZoneInfo(cfg["timezone"])
    base = {"latitude": ",".join(str(p["lat"]) for p in pts),
            "longitude": ",".join(str(p["lon"]) for p in pts),
            "hourly": ",".join(HOURLY), "forecast_days": n + 2, **UNITS}
    dates = [(start + timedelta(days=d)).replace(tzinfo=timezone.utc).astimezone(tz).date() for d in range(n)]
    out = []
    for m in sup.get("point_models", []):
        try:
            mid, js = _first_working(FORECAST_URL, base, m["ids"])
            data = {}
            for p, loc in zip(pts, js):
                h = loc["hourly"]
                df = pd.DataFrame({k: h.get(k) for k in HOURLY}, index=pd.to_datetime(h["time"])).astype(float)
                # surface Hot-Dry-Windy Index: VPD (kPa -> hPa) times wind (mph -> m/s)
                df["hdw"] = df["vapour_pressure_deficit"] * 10 * df["wind_speed_10m"] / 2.23694
                g = _days(df, start, n)
                agg = pd.DataFrame({
                    "precipitation_sum": g["precipitation"].sum(min_count=1),
                    "rain_sum": g["rain"].sum(min_count=1),
                    "snowfall_sum": g["snowfall"].sum(min_count=1),
                    "temperature_2m_max": g["temperature_2m"].max(),
                    "temperature_2m_min": g["temperature_2m"].min(),
                    "wind_gusts_10m_max": g["wind_gusts_10m"].max(),
                    "wind_speed_10m_max": g["wind_speed_10m"].max(),
                    "relative_humidity_2m_min": g["relative_humidity_2m"].min(),
                    "hdw_max": g["hdw"].max(),
                }).reindex(range(n))
                # a day is only valid if the model covers all of it
                counts = g["precipitation"].count().reindex(range(n)).fillna(0)
                agg[counts < 20] = np.nan
                data[p["name"]] = {k: list(agg[k].to_numpy(dtype=float)) for k in agg}
            arr = np.array([data[p]["precipitation_sum"] for p in data], dtype=float)
            rng = int(np.sum(~np.all(np.isnan(arr), axis=0)))   # days with data at any point
            if rng == 0:
                log.warning("supplement %s: no data over the region", m["label"])
                report.fail(m["label"], "no data over the region")
                continue
            out.append({"id": mid, "label": m["label"], "source": "open-meteo", "tier": m.get("tier", "global"),
                        "run": None, "range_days": rng, "dates": dates, "data": data})
            log.info("supplement %s (%s): %d days", m["label"], mid, rng)
        except Exception as e:
            log.warning("supplement %s: skipped (%s)", m["label"], e)
            report.fail(m["label"], report.short(e))
    return out


def fetch_ensembles(cfg, start):
    sup = cfg.get("supplement", {})
    if not sup.get("enabled"):
        return []
    pts, n = [p for p in cfg["points"] if p.get("plume")], cfg["days"]
    tz = ZoneInfo(cfg["timezone"])
    dates = [(start + timedelta(days=d)).replace(tzinfo=timezone.utc).astimezone(tz).date() for d in range(n)]
    out = []
    for m in sup.get("ensemble_models", []):
        try:
            mid, js = _first_working(ENSEMBLE_URL, {
                "latitude": ",".join(str(p["lat"]) for p in pts),
                "longitude": ",".join(str(p["lon"]) for p in pts),
                "hourly": "precipitation", "forecast_days": n + 2, **UNITS}, m["ids"])
            members = {}
            for p, loc in zip(pts, js):
                h = loc["hourly"]
                keys = [k for k in h if k.startswith("precipitation")]
                df = pd.DataFrame({k: h[k] for k in keys}, index=pd.to_datetime(h["time"])).astype(float)
                daily = _days(df, start, n).sum(min_count=1).reindex(range(n))
                daily = daily.dropna(how="all")
                members[p["name"]] = daily.to_numpy().T
            nd = next(iter(members.values())).shape[1]
            out.append({"id": mid, "label": m["label"], "source": "open-meteo", "run": None,
                        "dates": dates[:nd], "members": members})
            log.info("supplement ensemble %s: ok", m["label"])
        except Exception as e:
            log.warning("supplement ensemble %s: skipped (%s)", m["label"], e)
            report.fail(m["label"], report.short(e))
    return out
