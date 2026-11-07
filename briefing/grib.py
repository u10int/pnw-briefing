"""GRIB2 from NOAA (NODD on AWS/NOMADS) and ECMWF open data, via Herbie.

Every model is reduced to the same shape, on the briefing's 12Z-12Z days:

    {"id", "label", "source": "grib", "run", "range_days",
     "dates": [local date of each day start],
     "lat", "lon": 1-D (regular grids) or 2-D (projected: HRRR, RRFS, NAM, NBM),
     "precip_mm": [day_boundary, y, x] cumulative from the first boundary,
     "snow_in":   same or None, "snow_method",
     "data": {point: {precipitation_sum, rain_sum, snowfall_sum,
                      temperature_2m_max, temperature_2m_min, wind_gusts_10m_max,
                      wind_speed_10m_max, relative_humidity_2m_min, hdw_max, smoke_max}}}

Ensembles reduce to {"id", "label", "dates", "members": {point: [member, day]}}.

Only the needed GRIB messages are downloaded (byte ranges from .idx files).
A model that is late, renamed or missing a field is skipped or partially
filled and logged; it never fails the briefing.
"""
from __future__ import annotations

import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import numpy as np

from . import report

log = logging.getLogger(__name__)

ACC_RE = re.compile(r"(\d+)-(\d+) (hour|day) acc")
SKIP_RE = re.compile(r"prob|std dev|ens spread|%", re.I)  # NBM/ensemble statistic records
WORKERS = 8
M_S_TO_MPH = 2.23694


# ---------------------------------------------------------------- timing

CYCLE_LAG_H = 3     # an edition is named for the latest 00/06/12/18Z cycle at least this many hours old


def cycle_start(now: datetime | None = None) -> datetime:
    """The edition's cycle (naive UTC): BRIEFING_CYCLE (e.g. 2026-11-07T18Z) when set, otherwise
    the latest 00/06/12/18Z at least CYCLE_LAG_H hours before now."""
    env = os.environ.get("BRIEFING_CYCLE", "").strip()
    if env:
        return datetime.strptime(env.rstrip("Zz")[:13], "%Y-%m-%dT%H")
    t = (now or datetime.now(timezone.utc)).replace(tzinfo=None) - timedelta(hours=CYCLE_LAG_H)
    return t.replace(hour=t.hour // 6 * 6, minute=0, second=0, microsecond=0)


def day0(cfg) -> datetime:
    """The briefing's start: its cycle. Days still run 12Z – 12Z, so after a 18Z, 00Z or 06Z cycle
    the first day is the rest of the current one (see first_day_hours)."""
    return cycle_start()


def day12(start: datetime) -> datetime:
    """The 12Z that opens the 12Z – 12Z day containing `start`."""
    return start.replace(hour=12, minute=0, second=0, microsecond=0) - (timedelta(days=1) if start.hour < 12 else timedelta(0))


def first_day_hours(start: datetime) -> int:
    """Hours from the start to the end of its 12Z – 12Z day: 24 for a 12Z start, 6 for 06Z."""
    return int((day12(start) + timedelta(days=1) - start).total_seconds() // 3600)


def day_bounds(lead0: int, ndays: int, h1: int) -> list[int]:
    """Forecast hours of the day boundaries: the start, then each 12Z (ndays + 1 values)."""
    return [lead0] + [lead0 + h1 + 24 * k for k in range(ndays)]


def day_dates(start: datetime, n: int, tz) -> list:
    """Local date of each 12Z – 12Z day, the first being the one containing the start."""
    d0 = day12(start)
    return [(d0 + timedelta(days=d)).replace(tzinfo=timezone.utc).astimezone(tz).date() for d in range(n)]


# "Range request not honored": S3 occasionally answers a byte-range request with a redirect (HTTP
# 302) instead of the bytes; the same request a moment later succeeds.
TRANSIENT = re.compile(r"\b(429|500|502|503|504)\b|slow ?down|connection (reset|aborted)|timed? ?out|"
                       r"remotedisconnected|incompleteread|temporarily unavailable|max retries|"
                       r"range request not honored", re.I)


def _retry(fn, *args, tries=4, **kw):
    """Retry network calls that fail transiently (S3 throttling, dropped connections), with backoff."""
    import random
    import time
    for attempt in range(tries):
        try:
            return fn(*args, **kw)
        except Exception as e:
            if attempt == tries - 1 or not TRANSIENT.search(f"{type(e).__name__}: {e}"):
                raise
            time.sleep((3, 8, 20)[min(attempt, 2)] + random.uniform(0, 2))


def _H(spec, run, fxx):
    from herbie import Herbie
    return _retry(Herbie, run, fxx=fxx, verbose=False, **spec["herbie"])


def _latest_run(spec, start: datetime):
    """Latest cycle at or before `start` whose last needed step exists."""
    cycles = spec.get("cycles", [0, 12])
    for back in range(0, 48):
        run = start - timedelta(hours=back)
        if run.hour not in cycles:
            continue
        lead0 = int((start - run).total_seconds() // 3600)
        h1 = first_day_hours(start)
        avail = spec["max_hours"] - lead0
        ndays = 0 if avail < h1 else min(spec["range_days"], 1 + (avail - h1) // 24)
        if ndays < 1:
            continue
        b = day_bounds(lead0, ndays, h1)
        # A cycle that's still being written can be listed before its files are readable, and a
        # fallback source can error outright (Herbie's Azure lookup raises KeyError 'href' for
        # runs it doesn't have). Either way, move on to the previous cycle instead of failing.
        try:
            ok = all(_readable(spec, run, h) for h in (b[-1], b[1]))
        except Exception as e:
            log.info("%s %s: not usable yet (%s)", spec["label"], run.strftime("%HZ"), report.short(e))
            ok = False
        if ok:
            return run, lead0, ndays
    return None, None, 0


def _readable(spec, run, fxx):
    """The step exists and its index can actually be read."""
    H = _H(spec, run, fxx)
    if H.grib is None or H.idx is None:
        return False
    return len(_retry(H.inventory)) > 0


# ---------------------------------------------------------------- reading

def _crop(da, dom):
    """DataArray -> (lat, lon, values) cut to the domain; handles 1-D and 2-D coords."""
    lat_name = "latitude" if "latitude" in da.coords else "lat"
    lon_name = "longitude" if "longitude" in da.coords else "lon"
    lat, lon = da[lat_name].values, ((da[lon_name].values + 180) % 360) - 180
    vals = np.asarray(da.values, dtype="float32")
    if lat.ndim == 1:
        oi, oj = np.argsort(lat), np.argsort(lon)
        lat, lon, vals = lat[oi], lon[oj], vals[..., oi, :][..., oj]
        yi = (lat >= dom["lat_min"]) & (lat <= dom["lat_max"])
        xi = (lon >= dom["lon_min"]) & (lon <= dom["lon_max"])
        return lat[yi], lon[xi], vals[..., yi, :][..., xi]
    m = (lat >= dom["lat_min"]) & (lat <= dom["lat_max"]) & (lon >= dom["lon_min"]) & (lon <= dom["lon_max"])
    ys, xs = np.where(m)
    sl = (slice(ys.min(), ys.max() + 1), slice(xs.min(), xs.max() + 1))
    return lat[sl], lon[sl], vals[(..., *sl)]


def _first_var(ds, prefer=None):
    """The data variable to use. With `prefer` (cfgrib names), pick that variable by name: some
    files pack several fields in one GRIB message (NAM's 10 m u and v share one), so position
    can't be trusted. Raises if a preferred name is given but absent."""
    dss = ds if isinstance(ds, list) else [ds]
    if prefer:
        for d in dss:
            for name in prefer:
                if name in d.data_vars:
                    return d[name]
        raise LookupError(f"none of {prefer} in {[list(d.data_vars) for d in dss]}")
    return dss[0][list(dss[0].data_vars)[0]]


def _rows(H, pattern):
    inv = _retry(H.inventory, pattern)
    return [s for s in inv["search_this"] if not SKIP_RE.search(s)] if len(inv) else []


def water_mm_factor(da, default: float = 1.0) -> float:
    """Multiplier to millimetres of water for an accumulated-water field, from its own GRIB units.

    ECMWF publishes tp/sf in metres for some models and kg m**-2 (= mm) for others, and that has
    changed over time, so the file is trusted rather than the model family.
    """
    u = (da.attrs.get("GRIB_units") or da.attrs.get("units") or "").lower().replace(" ", "")
    if not u:
        return default   # no units in the file: family convention; check_plausible is the backstop
    if u in ("m", "mofwaterequivalent", "m(waterequivalent)", "mwe"):
        return 1000.0
    if u in ("kgm**-2", "kgm-2", "kgm^-2", "kg/m2", "kg/m**2", "mm"):
        return 1.0
    raise ValueError(f"unexpected units {u!r} for an accumulated water field")


def _read(H, row, dom, water=False, default=1.0, prefer=None):
    """Crop one GRIB message to the domain. With water=True, convert to mm from the message's units."""
    # Anchor to the whole record: Herbie matches by regex, and NBM's probability records begin with
    # the plain record's text (":APCP:surface:0-6 hour acc fcst:" vs "...fcst:prob >0.254:..."),
    # so an unanchored search downloads both and the probability (0-100 %) can come back first.
    da = _first_var(_retry(H.xarray, f"^{re.escape(row)}$", remove_grib=True), prefer)
    lat, lon, v = _crop(da, dom)
    return (lat, lon, v * water_mm_factor(da, default)) if water else (lat, lon, v)


_SITE_TREES: dict = {}


def _sample_sites(da, sites, max_deg=0.3):
    """Values at `sites` from the full (uncropped) field, for places outside the map area such as
    a pressure-gradient station; NaN where the model's grid doesn't reach a site."""
    lat_name = "latitude" if "latitude" in da.coords else "lat"
    lon_name = "longitude" if "longitude" in da.coords else "lon"
    lat, lon = da[lat_name].values, ((da[lon_name].values + 180) % 360) - 180
    vals = np.asarray(da.values, dtype="float32")
    out = np.full(len(sites), np.nan, dtype="float32")
    if lat.ndim == 1:
        for k, p in enumerate(sites):
            i, j = int(np.abs(lat - p["lat"]).argmin()), int(np.abs(lon - p["lon"]).argmin())
            step = max(abs(float(lat[1] - lat[0])), abs(float(lon[1] - lon[0]))) if lat.size > 1 and lon.size > 1 else max_deg
            if abs(lat[i] - p["lat"]) <= step and abs(lon[j] - p["lon"]) <= step:
                out[k] = vals[..., i, j]
        return out
    from scipy.spatial import cKDTree
    key = (lat.shape, float(lat.flat[0]), float(lon.flat[0]))
    tree = _SITE_TREES.get(key)
    if tree is None:
        k0 = np.cos(np.deg2rad(46))
        tree = _SITE_TREES[key] = (cKDTree(np.column_stack([lat.ravel(), lon.ravel() * k0])), k0)
    t, k0 = tree
    dist, idx = t.query([[p["lat"], p["lon"] * k0] for p in sites])
    for k, (dd, j) in enumerate(zip(dist, idx)):
        if dd <= max_deg:
            out[k] = vals[(..., *np.unravel_index(j, lat.shape))]
    return out


def _read_with_sites(H, row, dom, sites, prefer=None):
    """Like _read, plus the values at `sites` taken before cropping: (cropped values, site values)."""
    da = _first_var(_retry(H.xarray, f"^{re.escape(row)}$", remove_grib=True), prefer)
    return _crop(da, dom)[2], _sample_sites(da, sites)


def outside_sites(cfg):
    """Pressure-gradient stations outside the map area (read from the full grids)."""
    dom = cfg["domain"]
    seen, out = set(), []
    for g in cfg.get("gradients", []):
        for st in (g["a"], g["b"]):
            if not (dom["lat_min"] <= st["lat"] <= dom["lat_max"] and dom["lon_min"] <= st["lon"] <= dom["lon_max"]) \
                    and st["name"] not in seen:
                seen.add(st["name"])
                out.append({"name": st["name"], "lat": st["lat"], "lon": st["lon"]})
    return out


def _read_first(H, patterns, dom, water=False, default=1.0):
    for p in patterns:
        rows = _rows(H, p)
        if rows:
            return _read(H, rows[0], dom, water, default)
    raise LookupError(f"none of {patterns}")


# ---------------------------------------------------------------- accumulations

def _accum_ncep(spec, run, var, targets, dom):
    """Cumulative-from-init field at each target hour for NCEP 'VAR:a-b acc' records.

    Prefers a record spanning from a known hour (0-N running total, or a bucket
    that starts where we already are). Otherwise chains buckets every
    `chain_step` hours.
    """
    cum, grid = {0: 0.0}, {}
    step = spec.get("chain_step", 6)

    def options(fxx):
        H = _H(spec, run, fxx)
        out = []
        for s in _rows(H, f":{var}:surface:"):
            m = ACC_RE.search(s)
            if m:
                mult = 24 if m[3] == "day" else 1
                a, b = int(m[1]) * mult, int(m[2]) * mult
                if b == fxx:
                    out.append((a, s))
        return H, out

    def take(H, a, s):
        lat, lon, v = _read(H, s, dom, water=(var == "APCP"))
        grid.update(lat=lat, lon=lon)
        return v if a == 0 else cum[a] + v

    for h in sorted(targets):
        if h == 0:
            continue
        H, opts = options(h)
        known = [(a, s) for a, s in opts if a in cum]
        if known:
            cum[h] = take(H, *min(known))
            continue
        last = max(k for k in cum if k < h)
        for sub in range(last + step, h + 1, step):
            if sub in cum:
                continue
            Hs, o = options(sub)
            ok = [(a, s) for a, s in o if a in cum]
            if not ok:
                raise LookupError(f"{spec['label']} {var}: nothing chainable at f{sub:03d}")
            cum[sub] = take(Hs, *min(ok))
    zeros = None
    out = []
    for h in sorted(targets):
        v = cum[h]
        if isinstance(v, float):
            zeros = zeros if zeros is not None else np.zeros_like(next(x for x in cum.values() if not isinstance(x, float)))
            v = zeros
        out.append(v)
    return grid["lat"], grid["lon"], np.stack(out)


def _accum_ecmwf(spec, run, param, targets, dom):
    """ECMWF open data: accumulated from init; returned in mm of water whatever the file's units."""
    def one(h):
        if h == 0:
            return None
        return _read_first(_H(spec, run, h), [f":{param}:"], dom, water=True, default=1000.0)

    with ThreadPoolExecutor(WORKERS) as ex:
        res = list(ex.map(one, sorted(targets)))
    ref = next(r for r in res if r is not None)
    lat, lon = ref[0], ref[1]
    return lat, lon, np.stack([np.zeros_like(ref[2]) if r is None else r[2] for r in res])


# ---------------------------------------------------------------- instantaneous samples

def _samples(spec, run, hours, patterns, dom):
    """{hour: 2-D field} for instantaneous fields; missing steps are skipped."""
    def one(h):
        try:
            return h, _read_first(_H(spec, run, h), patterns, dom)[2]
        except Exception:
            return h, None
    with ThreadPoolExecutor(WORKERS) as ex:
        return {h: v for h, v in ex.map(one, hours) if v is not None}


# ---------------------------------------------------------------- interval extremes
#
# Highs, lows, strongest wind and gusts are read at each model's native output steps, using the
# max/min-since-the-previous-output records wherever the model publishes them, so a peak between
# output times isn't missed. What each model publishes (checked against their inventories):
#   HRRR        hourly max 10 m wind; no 2 m max/min (hourly 2 m temperature instead)
#   RRFS        hourly 2 m max/min and max 10 m wind
#   NAM 3 km    hourly 2 m max/min; hourly max 10 m wind as components (MAXUW/MAXVW)
#   NBM         12-hour daytime max / overnight min; instantaneous 10 m wind speed and gust
#   GFS         2 m max/min over each 6-hour bucket (3-hour after day 5); instantaneous wind, gust
#   ECMWF IFS   mx2t3/mn2t3 (to day 6), then mx2t6/mn2t6; 10fg = max gust since the last step
#   ECMWF AIFS  6-hourly instantaneous values only
# The schedule comes from each model's `extremes` block in config.yaml; models without one keep
# their `sample_hours` instantaneous samples.

EXT_PATTERNS = {
    "ncep": {
        "tmax": [":TMAX:2 m above ground:"], "tmin": [":TMIN:2 m above ground:"],
        "t2m": [":TMP:2 m above ground:"],
        "gust": [":GUST:surface:", ":GUST:10 m above ground:"],
        "wind_max": [r":WIND:10 m above ground:\d+-\d+ hour max fcst:"],
        "wind_speed": [r":WIND:10 m above ground:\d+ hour fcst:"],
        "u10": [":UGRD:10 m above ground:", ":VGRD:10 m above ground:"],
        "v10": [":VGRD:10 m above ground:", ":UGRD:10 m above ground:"],
    },
    "ecmwf": {
        "tmax": [":mx2t3:", ":mx2t6:", ":mx2t1:"], "tmin": [":mn2t3:", ":mn2t6:", ":mn2t1:"],
        "t2m": [":2t:"], "gust": [":10fg:", ":10fg3:", ":10fg6:", ":fg10:"],
        "u10": [":10u:"], "v10": [":10v:"],
    },
}
K_TO_F = lambda k: (k - 273.15) * 9 / 5 + 32
_SPAN = re.compile(r":(\d+)-(\d+) hour (?:max|min|acc|ave) fcst:")
_ECMWF_SPAN = re.compile(r":(?:mx2t|mn2t|10fg)(\d+):")


def extreme_hours(spec, lead0, last):
    """The model's native output steps from today's 12Z to `last`: `extremes.steps` is a list of
    [up_to_fxx, step_hours] segments, or `extremes.step` a single step."""
    ex = spec.get("extremes") or {}
    segs = ex.get("steps") or [[last, ex.get("step", spec.get("sample_hours", 6))]]
    out, h = [], 0
    for upto, step in segs:
        while h + step <= min(upto, last):
            h += step
            if h > lead0:
                out.append(h)
        if h >= last:
            break
    return out


def _read_row(H, patterns, dom):
    """(row, values) for the first pattern with a record at this step."""
    for p in patterns:
        rows = _rows(H, p)
        if rows:
            return rows[0], _read(H, rows[0], dom)[2]
    raise LookupError(f"none of {patterns}")


def _span(row, h, prev):
    """(start, end) forecast hours a record covers: the range in NCEP rows, ECMWF's suffix
    (mx2t3 = 3 h), or since the previous step for ECMWF's plain 10fg."""
    m = _SPAN.search(row)
    if m:
        return int(m[1]), int(m[2])
    m = _ECMWF_SPAN.search(row)
    if m:
        return h - int(m[1]), h
    return prev, h


def _plan(spec, lead0, last, t2m, gust, model_fields):
    """{name: (hours, patterns, interval?, have)} for what to read at each step."""
    fam = spec["family"]
    P = EXT_PATTERNS[fam]
    ex = spec.get("extremes") or {}
    hours = extreme_hours(spec, lead0, last) if ex else sorted(set(t2m) | set(gust))
    plan = {}
    # instantaneous 2 m temperature: every step when there's no max/min record (HRRR), else the
    # samples already downloaded for the map
    plan["t2m"] = (hours if ex.get("temp") != "maxmin" else sorted(t2m), P["t2m"], False, t2m)
    if ex.get("temp") == "maxmin":
        plan["tmax"] = (hours, P["tmax"], True, {})
        plan["tmin"] = (hours, P["tmin"], True, {})
    if spec.get("gust", True):
        # ECMWF's gust is already a max since the previous step; NCEP's is instantaneous
        plan["gust"] = (hours, P["gust"], fam == "ecmwf", {} if fam == "ecmwf" else gust)
    wind = ex.get("wind")
    if wind == "max":
        plan["wind"] = (hours, P["wind_max"], True, {})
    elif wind == "maxuv":
        plan["maxuw"] = (hours, [r":MAXUW:10 m above ground:\d+-\d+ hour max fcst:"], True, {})
        plan["maxvw"] = (hours, [r":MAXVW:10 m above ground:\d+-\d+ hour max fcst:"], True, {})
    elif wind == "speed":
        plan["wind"] = (hours, P["wind_speed"], False, {})
    else:
        plan["u10"] = (hours, P["u10"], False, _by_hour(model_fields.get("u10"), 1 / M_S_TO_MPH))
        plan["v10"] = (hours, P["v10"], False, _by_hour(model_fields.get("v10"), 1 / M_S_TO_MPH))
    return plan


def extreme_series(spec, run, lead0, last, dom, t2m, gust, model_fields):
    """{tmax, tmin, gust, wind: [(start, end, field)]} in °F / mph, for the window extremes and the
    daily values at the forecast locations. One index lookup per forecast hour serves every field
    read at that hour; samples already downloaded are reused."""
    plan = _plan(spec, lead0, last, t2m, gust, model_fields)
    all_hours = sorted({h for hrs, *_ in plan.values() for h in hrs})
    prev = {h: (all_hours[i - 1] if i else h) for i, h in enumerate(all_hours)}
    failures: dict[str, int] = {}

    def one(h):
        got, H = {}, None
        for name, (hrs, pats, interval, have) in plan.items():
            if h not in hrs:
                continue
            if h in have:
                got[name] = (h, h, have[h])
                continue
            try:
                if H is None:
                    H = _H(spec, run, h)
                rows = next((r for p in pats for r in _rows(H, p)[:1]), None)
                if rows is None:
                    continue                                  # not published at this step
                v = _read(H, rows, dom)[2]
                a, b = _span(rows, h, prev[h]) if interval else (h, h)
                got[name] = (a, b, v)
            except Exception as e:
                got.setdefault("_errors", []).append(f"{name}: {report.short(e)}")
        return got

    raw: dict[str, list] = {k: [] for k in plan}
    with ThreadPoolExecutor(WORKERS) as ex:
        for got in ex.map(one, all_hours):
            for msg in got.pop("_errors", []):
                failures[msg.split(":")[0]] = failures.get(msg.split(":")[0], 0) + 1
            for name, entry in got.items():
                raw[name].append(entry)
    if failures:
        log.warning("%s extremes: read failures %s", spec["label"], failures)

    f = lambda entries, conv: [(a, b, conv(v)) for a, b, v in entries]
    mph = lambda v: v * M_S_TO_MPH
    inst_t = f(raw["t2m"], K_TO_F)
    out = {"tmax": f(raw.get("tmax", []), K_TO_F) + inst_t, "tmin": f(raw.get("tmin", []), K_TO_F) + inst_t}
    if "gust" in raw:
        out["gust"] = f(raw["gust"], mph)
    if "wind" in raw:
        out["wind"] = f(raw["wind"], mph)
    pairs = [("maxuw", "maxvw"), ("u10", "v10")]
    for un, vn in pairs:
        if un in raw:
            vb = {(a, b): v for a, b, v in raw[vn]}
            out["wind"] = [(a, b, np.hypot(u, vb[(a, b)]) * M_S_TO_MPH) for a, b, u in raw[un] if (a, b) in vb]
    out = {k: v for k, v in out.items() if v}
    log.info("%s extremes: %s", spec["label"], ", ".join(f"{k} {len(v)} steps" for k, v in out.items()) or "none")
    return out


# ---------------------------------------------------------------- water vapour transport

IVT_LEVELS = [1000, 925, 850, 700, 500, 300]     # hPa; trapezoid integral, the usual 6-level approximation
IVT_PATTERNS = {"ncep": r":(SPFH|UGRD|VGRD):(1000|925|850|700|500|300) mb:",
                "ecmwf": r":(q|u|v):(1000|925|850|700|500|300):pl:"}
G = 9.80665


def ivt_from_levels(q, u, v, levels_hpa):
    """Integrated vapour transport components (kg m-1 s-1) from q (kg/kg), u, v (m/s) on pressure
    levels [lev, ...]: IVT = (1/g) * integral of q*V dp over the levels given."""
    order = np.argsort(levels_hpa)[::-1]                       # surface (high p) to top
    p = np.asarray(levels_hpa, dtype="float64")[order] * 100.0
    q, u, v = q[order], u[order], v[order]
    dp = -np.diff(p)                                           # positive Pa per layer
    qu, qv = q * u, q * v
    iu = np.tensordot(dp, 0.5 * (qu[:-1] + qu[1:]), axes=(0, 0)) / G
    iv = np.tensordot(dp, 0.5 * (qv[:-1] + qv[1:]), axes=(0, 0)) / G
    return iu.astype("float32"), iv.astype("float32")


def fetch_ivt(spec, run, lead0, last, dom, step=6):
    """{"hours", "u", "v"} IVT components [t, y, x] every `step` hours, or None."""
    pattern = IVT_PATTERNS[spec["family"]]
    hours = [h for h in range(lead0, last + 1, step) if h > 0]

    def one(h):
        try:
            ds = _retry(_H(spec, run, h).xarray, pattern, remove_grib=True)
            ds = ds if isinstance(ds, list) else [ds]
            got = {}
            for d in ds:
                for name in d.data_vars:
                    if name in ("q", "u", "v") and "isobaricInhPa" in d[name].dims:
                        da = d[name].sortby("isobaricInhPa")
                        lat, lon, vals = _crop(da, dom)
                        got[name] = (da["isobaricInhPa"].values, vals, lat, lon)
            if len(got) < 3 or not (list(got["q"][0]) == list(got["u"][0]) == list(got["v"][0])):
                return h, None
            levs, lat, lon = got["q"][0], got["q"][2], got["q"][3]
            iu, iv = ivt_from_levels(got["q"][1], got["u"][1], got["v"][1], levs)
            return h, (lat, lon, iu, iv)
        except Exception as e:
            log.debug("%s IVT f%03d: %s", spec["label"], h, e)
            return h, None
    with ThreadPoolExecutor(4) as ex:
        res = [(h, r) for h, r in ex.map(one, hours) if r is not None]
    if not res:
        return None
    lat, lon = res[0][1][0], res[0][1][1]
    log.info("%s IVT: %d steps", spec["label"], len(res))
    return {"hours": [h for h, _ in res], "lat": lat, "lon": lon,
            "u": np.stack([r[2] for _, r in res]), "v": np.stack([r[3] for _, r in res])}


def _by_hour(entry, factor=1.0):
    """Map-field entry {"hours", "data"} back to {hour: raw field}."""
    if not entry:
        return {}
    return {h: entry["data"][i] * factor for i, h in enumerate(entry["hours"])}


# ---------------------------------------------------------------- points

def _point_series(entry, idx, grid):
    """{hour: values at the points} from a map-field entry on the model grid."""
    if not entry or np.shape(entry["data"])[-2:] != grid:
        return {}
    d = np.asarray(entry["data"])
    return {h: np.array([d[k, i, j] for i, j in idx], dtype="float64") for k, h in enumerate(entry["hours"])}


def _daily_points(series, bounds, npts, reduce):
    """[point, day] reduction over each 12Z-12Z day (hours a < h <= b); NaN where none."""
    ndays = len(bounds) - 1
    out = np.full((npts, ndays), np.nan)
    for d in range(ndays):
        a, b = bounds[d], bounds[d + 1]
        vals = [v for h, v in series.items() if a < h <= b]
        if vals:
            with np.errstate(all="ignore"):
                out[:, d] = reduce(np.stack(vals), axis=0)
    return out


def hdw_surface(t_f, rh, wind_mph):
    """Hot-Dry-Windy Index from 2 m temperature and humidity and 10 m wind: vapour pressure
    deficit (hPa) times wind speed (m/s). The published index takes the largest product in the
    lowest 500 m; at the surface it runs lower, so read it against its own history rather than
    the published thresholds."""
    t = (np.asarray(t_f) - 32) * 5 / 9
    es = 6.112 * np.exp(17.67 * t / (t + 243.5))
    return es * (1 - np.asarray(rh) / 100) * np.asarray(wind_mph) / M_S_TO_MPH


def fire_points(model_fields, lat, lon, idx, bounds):
    """Daily minimum humidity, maximum surface Hot-Dry-Windy Index and maximum near-surface smoke
    at each point, from the map fields (whatever hours the model has). Missing inputs give NaN."""
    grid = lat.shape if lat.ndim == 2 else (lat.size, lon.size)
    npts = len(idx)
    rh = _point_series(model_fields.get("rh"), idx, grid)
    t = _point_series(model_fields.get("t2m"), idx, grid)
    u, v = _point_series(model_fields.get("u10"), idx, grid), _point_series(model_fields.get("v10"), idx, grid)
    smoke = _point_series(model_fields.get("smoke"), idx, grid)
    hdw = {h: hdw_surface(t[h], rh[h], np.hypot(u[h], v[h])) for h in rh if h in t and h in u and h in v}
    nan = np.full((npts, len(bounds) - 1), np.nan)
    return {"relative_humidity_2m_min": _daily_points(rh, bounds, npts, np.nanmin) if rh else nan,
            "hdw_max": _daily_points(hdw, bounds, npts, np.nanmax) if hdw else nan,
            "smoke_max": _daily_points(smoke, bounds, npts, np.nanmax) if smoke else nan}


def nearest_index(lat, lon, points):
    """Grid index (tuple) of the nearest cell for each point; works for 1-D or 2-D coords."""
    if lat.ndim == 1:
        return [(int(np.abs(lat - p["lat"]).argmin()), int(np.abs(lon - p["lon"]).argmin())) for p in points]
    from scipy.spatial import cKDTree
    k = np.cos(np.deg2rad(46))
    tree = cKDTree(np.column_stack([lat.ravel(), lon.ravel() * k]))
    _, idx = tree.query([[p["lat"], p["lon"] * k] for p in points])
    return [tuple(int(i) for i in np.unravel_index(j, lat.shape)) for j in idx]


def _daily_extreme(samples, bounds, idx, fn):
    """Per point, per day: fn over samples whose valid time falls inside that 12Z-12Z day."""
    ndays = len(bounds) - 1
    out = np.full((len(idx), ndays), np.nan)
    for d in range(ndays):
        a, b = bounds[d], bounds[d + 1]
        fields = [samples[h] for h in samples if a < h <= b] if fn is np.nanmax else \
                 [samples[h] for h in samples if a <= h < b]
        if fields:
            st = np.stack(fields)
            out[:, d] = [fn(st[:, i, j]) for i, j in idx]
    return out


# ---------------------------------------------------------------- sanity

MAX_DAILY_IN = 25.0   # far above any PNW 24-hour total; anything bigger is a units or decoding error


def check_plausible(label, daily_in):
    """Reject a model whose daily precipitation can't be real, rather than let it skew the briefing."""
    a = np.asarray(daily_in, dtype=float)
    peak = float(np.nanmax(a)) if np.isfinite(a).any() else 0.0
    low = float(np.nanmin(a)) if np.isfinite(a).any() else 0.0
    if peak > MAX_DAILY_IN or low < -0.05:
        raise ValueError(f"implausible daily precipitation for {label} (range {low:.2f} to {peak:.1f} in); "
                         f"likely a units or accumulation error, so it was left out")


# ---------------------------------------------------------------- one deterministic model

FIELDS = {
    "ncep":  {"t2m": [":TMP:2 m above ground:"],
              "gust": [":GUST:surface:", ":GUST:10 m above ground:"]},
    "ecmwf": {"t2m": [":2t:"],
              "gust": [":10fg:", ":fg10:", ":10fg6:", ":10fg3:"]},
}


def fetch_model(spec, cfg, start, points):
    dom = cfg["domain"]
    tz = ZoneInfo(cfg["timezone"])
    try:
        run, lead0, ndays = _latest_run(spec, start)
        if run is None:
            log.warning("%s: no usable run", spec["label"])
            report.fail(spec["label"], "no complete run found on any source in the last 48 h")
            return None
        targets = day_bounds(lead0, ndays, first_day_hours(start))
        log.info("%s: %s run, %d days", spec["label"], run.strftime("%Y-%m-%d %HZ"), ndays)

        fam = spec["family"]
        step = spec.get("sample_hours", 6)
        # The daily values use whole 12Z-12Z days (`targets`); the map runs on to the end of a
        # regional model's forecast (RRFS 84 h, NAM 60 h), whose last part is less than a day.
        map_last = max(targets[-1], spec.get("max_hours", 0)) if spec.get("tier") == "regional" else targets[-1]
        hours = list(range(lead0, map_last + 1, step))
        from . import fields
        fhours = fields.field_hours(spec, lead0, map_last, hours)

        def accum(var):
            """Cumulative-from-init grids at the daily targets and, for the map, at every field hour
            (with those hours). If the hours past the last whole day can't be read, the map stops
            there; if no extra hours can be read, the daily targets alone (no accumulated map layer)."""
            fn = (lambda t: _accum_ncep(spec, run, var, t, dom)) if fam == "ncep" else \
                 (lambda t: _accum_ecmwf(spec, run, var, t, dom))
            tries = [fhours, [h for h in fhours if h <= targets[-1]]] if fhours else []
            for fh in [t for k, t in enumerate(tries) if t and (k == 0 or t != tries[0])]:
                allh = sorted(set(targets) | set(fh))
                try:
                    la, lo, a = fn(allh)
                    pos = {h: i for i, h in enumerate(allh)}
                    return la, lo, a[[pos[h] for h in targets]], (fh, a[[pos[h] for h in fh]])
                except Exception as e:
                    log.info("%s: %s accumulation to f%03d unavailable (%s)", spec["label"], var, fh[-1], report.short(e))
            la, lo, a = fn(targets)
            return la, lo, a, None

        lat, lon, cum_all, cum_f = accum("APCP" if fam == "ncep" else "tp")
        cum = np.maximum(cum_all - cum_all[0], 0)  # from the briefing's start
        acc_fields = {}
        if cum_f is not None:
            acc_fields["apcp"] = {"hours": cum_f[0], "data": (np.maximum(cum_f[1] - cum_all[0], 0) / 25.4).astype("float32")}

        snow, snow_method = None, None
        try:
            _, _, s, s_f = accum("ASNOW" if fam == "ncep" else "sf")
            # NCEP ASNOW is snow depth in metres; ECMWF sf is water equivalent in mm, shown at 10:1
            to_in = (lambda x: x * 39.37) if fam == "ncep" else (lambda x: x / 25.4 * 10)
            snow = to_in(np.maximum(s - s[0], 0))
            snow_method = "model snowfall (ASNOW)" if fam == "ncep" else "snowfall water equivalent at 10:1"
            if s_f is not None:
                acc_fields["asnow"] = {"hours": s_f[0], "data": to_in(np.maximum(s_f[1] - s[0], 0)).astype("float32")}
        except Exception as e:
            log.info("%s: no snowfall field (%s)", spec["label"], e)
        t2m = _samples(spec, run, hours, FIELDS[fam]["t2m"], dom)
        gust = _samples(spec, run, hours, FIELDS[fam]["gust"], dom) if spec.get("gust", True) else {}

        idx = nearest_index(lat, lon, points)
        daily_p = np.diff(np.stack([[c[i, j] for i, j in idx] for c in cum]), axis=0).T / 25.4
        check_plausible(spec["label"], daily_p)

        # time-stepped fields for the interactive map; optional, never fails the model
        try:
            model_fields = fields.fetch(spec, run, lead0, map_last, hours, {"t2m": t2m, "gust": gust}, dom,
                                        sites=outside_sites(cfg))
        except Exception as e:
            log.warning("%s: hourly fields skipped (%s)", spec["label"], report.short(e))
            model_fields = {}
        # highs, lows, strongest wind and gusts from interval max/min records at native steps
        from . import extremes
        # reuse the map's hourly temperature and gusts (display units back to raw) so the extremes
        # don't download those hours again
        t2m_all = {**t2m, **{h: (f - 32) * 5 / 9 + 273.15 for h, f in _by_hour(model_fields.get("t2m")).items()}}
        gust_all = {**gust, **_by_hour(model_fields.get("gust"), 1 / M_S_TO_MPH)}
        try:
            ext_series = extreme_series(spec, run, lead0, targets[-1], dom, t2m_all, gust_all, model_fields)
        except Exception as e:
            log.warning("%s: interval extremes skipped (%s)", spec["label"], report.short(e))
            ext_series = {}
        # water vapour transport for the atmospheric-river view (optional)
        ivt = None
        if spec.get("ivt"):
            try:
                ivt = fetch_ivt(spec, run, lead0, targets[-1], dom)
            except Exception as e:
                log.warning("%s: IVT skipped (%s)", spec["label"], report.short(e))
        model_fields.update(acc_fields)     # added after the extremes, which read only t2m, gust and wind
        daily_s = (np.diff(np.stack([[c[i, j] for i, j in idx] for c in snow]), axis=0).T
                   if snow is not None else np.full_like(daily_p, np.nan))
        def at_points(var, fallback):
            if ext_series.get(var):
                d = extremes.daily(ext_series[var], targets, "min" if var == "tmin" else "max")
                return np.array([d[:, i, j] for i, j in idx])
            return fallback()
        nan = lambda: np.full_like(daily_p, np.nan)
        tmax = at_points("tmax", lambda: K_TO_F(_daily_extreme(t2m, targets, idx, np.nanmax)) if t2m else nan())
        tmin = at_points("tmin", lambda: K_TO_F(_daily_extreme(t2m, targets, idx, np.nanmin)) if t2m else nan())
        gmax = at_points("gust", lambda: _daily_extreme(gust, targets, idx, np.nanmax) * M_S_TO_MPH if gust else nan())

        def wind_from_fields():
            # no interval wind maximum: the strongest of the map's 10 m wind samples (mph) that day
            w = extremes._from_fields({"fields": model_fields}).get("wind")
            grid = lat.shape if lat.ndim == 2 else (lat.size, lon.size)
            if not w or w[0][2].shape != grid:
                return nan()
            d = extremes.daily(w, targets, "max")
            return np.array([d[:, i, j] for i, j in idx])
        wmax = at_points("wind", wind_from_fields)
        fire = fire_points(model_fields, lat, lon, idx, targets)
        rain = np.clip(daily_p - np.nan_to_num(daily_s) / 10, 0, None)

        n = cfg["days"]

        def pad(a):
            out = np.full(n, np.nan)
            out[: min(n, len(a))] = a[:n]
            return list(out)

        data = {p["name"]: {"precipitation_sum": pad(daily_p[k]), "rain_sum": pad(rain[k]),
                            "snowfall_sum": pad(daily_s[k]), "temperature_2m_max": pad(tmax[k]),
                            "temperature_2m_min": pad(tmin[k]), "wind_gusts_10m_max": pad(gmax[k]),
                            "wind_speed_10m_max": pad(wmax[k]),
                            **{key: pad(v[k]) for key, v in fire.items()}}
                for k, p in enumerate(points)}
        dates = day_dates(start, n, tz)
        return {"id": spec["id"], "label": spec["label"], "source": "grib", "tier": spec.get("tier", "global"),
                "run": run, "lead0": lead0, "range_days": ndays, "targets": targets, "dates": dates, "data": data,
                "lat": lat, "lon": lon, "precip_mm": cum, "snow_in": snow, "snow_method": snow_method,
                "fields": model_fields, "ext_series": ext_series, "ivt": ivt}
    except Exception as e:
        log.exception("%s: GRIB fetch failed", spec["label"])
        report.fail(spec["label"], report.short(e))
        return None


# ---------------------------------------------------------------- ensembles

def fetch_ensemble(spec, cfg, start, points):
    """Per-member daily precip at every forecast location."""
    dom = cfg["domain"]
    tz = ZoneInfo(cfg["timezone"])
    try:
        probe = {**spec, "herbie": {**spec["herbie"], **spec.get("probe_member", {})}}
        run, lead0, ndays = _latest_run(probe, start)
        if run is None:
            log.warning("%s: no usable run", spec["label"])
            report.fail(spec["label"], "no complete run found on any source in the last 48 h")
            return None
        targets = day_bounds(lead0, ndays, first_day_hours(start))

        if spec["family"] == "ecmwf":
            # one file per step holds every member; cfgrib returns cf and pf as separate datasets
            def step(h):
                ds = _retry(_H(spec, run, h).xarray, ":tp:", remove_grib=True)
                ds = ds if isinstance(ds, list) else [ds]
                parts = []
                for d in ds:
                    da = d[list(d.data_vars)[0]]
                    lat, lon, v = _crop(da, dom)
                    parts.append(v.reshape(-1, *v.shape[-2:]) * water_mm_factor(da, 1000.0))
                return lat, lon, np.concatenate(parts)
            with ThreadPoolExecutor(4) as ex:
                res = list(ex.map(step, [t for t in targets if t > 0]))
            lat, lon = res[0][0], res[0][1]
            stack = np.stack([r[2] for r in res])                # [t, member, y, x]
            if targets[0] == 0:
                stack = np.concatenate([np.zeros_like(stack[:1]), stack])
            idx = nearest_index(lat, lon, points)
            # stack[:, :, i, j] is [t, member]; daily totals are the diff along t
            per = {p["name"]: np.diff(stack[:, :, i, j], axis=0).T / 25.4
                   for p, (i, j) in zip(points, idx)}
            check_plausible(spec["label"], np.stack(list(per.values())))
            daily_grid = np.moveaxis(np.diff(stack, axis=0), 0, 1) / 25.4    # [member, day, y, x]
            snow_grid = _ens_snow(spec, run, targets, dom) if spec.get("snow") else None
        else:
            members = spec["members"]

            def one(mem):
                s = {**spec, "herbie": {**spec["herbie"], "member": mem}}
                try:
                    lat, lon, cum = _accum_ncep(s, run, "APCP", targets, dom)
                    return lat, lon, cum
                except Exception as e:
                    log.info("%s %s: skipped (%s)", spec["label"], mem, e)
                    return None
            # fewer parallel members than other fetches: 31 members at once trips S3's "Slow Down"
            with ThreadPoolExecutor(3) as ex:
                res = [r for r in ex.map(one, members) if r is not None]
            lat, lon = res[0][0], res[0][1]
            idx = nearest_index(lat, lon, points)
            per = {}
            for p, (i, j) in zip(points, idx):
                cum = np.stack([r[2][:, i, j] for r in res])     # [member, t]
                per[p["name"]] = np.diff(cum, axis=1) / 25.4
            check_plausible(spec["label"], np.stack(list(per.values())))
            daily_grid = np.diff(np.stack([r[2] for r in res]), axis=1) / 25.4   # [member, day, y, x]
            snow_grid = None
        dates = day_dates(start, ndays, tz)
        n = next(iter(per.values())).shape[0]
        log.info("%s: %s run, %d members, %d days", spec["label"], run.strftime("%Y-%m-%d %HZ"), n, ndays)
        # full grids too, for exceedance odds at every location and on the map
        return {"id": spec["id"], "label": spec["label"], "source": "grib", "run": run,
                "dates": dates, "members": per,
                "grid": {"lat": lat, "lon": lon, "precip_in": daily_grid.astype("float32"),
                         "snow_in": None if snow_grid is None else snow_grid.astype("float32")}}
    except Exception as e:
        log.exception("%s: ensemble fetch failed", spec["label"])
        report.fail(spec["label"], report.short(e))
        return None


def _ens_snow(spec, run, targets, dom):
    """ECMWF ENS daily snowfall per member [member, day, y, x] in inches (water equivalent at 10:1).
    Optional: any failure leaves the ensemble without snow odds."""
    try:
        def step(h):
            ds = _retry(_H(spec, run, h).xarray, ":sf:", remove_grib=True)
            ds = ds if isinstance(ds, list) else [ds]
            parts = []
            for d in ds:
                da = d[list(d.data_vars)[0]]
                _, _, v = _crop(da, dom)
                parts.append(v.reshape(-1, *v.shape[-2:]) * water_mm_factor(da, 1000.0))
            return np.concatenate(parts)
        with ThreadPoolExecutor(4) as ex:
            res = list(ex.map(step, [t for t in targets if t > 0]))
        stack = np.stack(res)
        if targets[0] == 0:
            stack = np.concatenate([np.zeros_like(stack[:1]), stack])
        return np.clip(np.moveaxis(np.diff(stack, axis=0), 0, 1), 0, None) / 25.4 * 10
    except Exception as e:
        log.info("%s: no ensemble snowfall (%s)", spec["label"], report.short(e))
        return None


def fetch_all(cfg):
    start = day0(cfg)
    pts = cfg["points"]
    det = [m for m in (fetch_model(s, cfg, start, pts) for s in cfg["grib_models"] if s.get("enabled", True)) if m]
    ens = [e for e in (fetch_ensemble(s, cfg, start, pts) for s in cfg.get("grib_ensembles", [])
                       if s.get("enabled", True)) if e]
    return det, ens
