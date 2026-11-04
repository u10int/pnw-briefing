"""GRIB2 from NOAA (NODD on AWS/NOMADS) and ECMWF open data, via Herbie.

Every model is reduced to the same shape, on the briefing's 12Z-12Z days:

    {"id", "label", "source": "grib", "run", "range_days",
     "dates": [local date of each day start],
     "lat", "lon": 1-D (regular grids) or 2-D (projected: HRRR, RRFS, NAM, NBM),
     "precip_mm": [day_boundary, y, x] cumulative from the first boundary,
     "snow_in":   same or None, "snow_method",
     "data": {point: {precipitation_sum, rain_sum, snowfall_sum,
                      temperature_2m_max, temperature_2m_min, wind_gusts_10m_max}}}

Ensembles reduce to {"id", "label", "dates", "members": {point: [member, day]}}.

Only the needed GRIB messages are downloaded (byte ranges from .idx files).
A model that is late, renamed or missing a field is skipped or partially
filled and logged; it never fails the briefing.
"""
from __future__ import annotations

import logging
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

def day0(cfg) -> datetime:
    """First briefing-day boundary: today's 12Z (naive UTC)."""
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return now.replace(hour=12, minute=0, second=0, microsecond=0) - (timedelta(days=1) if now.hour < 12 else timedelta(0))


TRANSIENT = re.compile(r"\b(429|500|502|503|504)\b|slow ?down|connection (reset|aborted)|timed? ?out|"
                       r"remotedisconnected|incompleteread|temporarily unavailable|max retries", re.I)


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
        ndays = min(spec["range_days"], (spec["max_hours"] - lead0) // 24)
        if ndays < 1:
            continue
        # A cycle that's still being written can be listed before its files are readable, and a
        # fallback source can error outright (Herbie's Azure lookup raises KeyError 'href' for
        # runs it doesn't have). Either way, move on to the previous cycle instead of failing.
        try:
            ok = all(_readable(spec, run, h) for h in (lead0 + 24 * ndays, lead0 + 24))
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


# ---------------------------------------------------------------- points

def nearest_index(lat, lon, points):
    """Grid index (tuple) of the nearest cell for each point; works for 1-D or 2-D coords."""
    if lat.ndim == 1:
        return [(int(np.abs(lat - p["lat"]).argmin()), int(np.abs(lon - p["lon"]).argmin())) for p in points]
    from scipy.spatial import cKDTree
    k = np.cos(np.deg2rad(46))
    tree = cKDTree(np.column_stack([lat.ravel(), lon.ravel() * k]))
    _, idx = tree.query([[p["lat"], p["lon"] * k] for p in points])
    return [tuple(int(i) for i in np.unravel_index(j, lat.shape)) for j in idx]


def _daily_extreme(samples, lead0, ndays, idx, fn):
    """Per point, per day: fn over samples whose valid time falls inside that 12Z-12Z day."""
    out = np.full((len(idx), ndays), np.nan)
    for d in range(ndays):
        a, b = lead0 + 24 * d, lead0 + 24 * (d + 1)
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
        targets = [lead0 + 24 * d for d in range(ndays + 1)]
        log.info("%s: %s run, %d days", spec["label"], run.strftime("%Y-%m-%d %HZ"), ndays)

        fam = spec["family"]
        if fam == "ncep":
            lat, lon, cum = _accum_ncep(spec, run, "APCP", targets, dom)
        else:
            lat, lon, cum = _accum_ecmwf(spec, run, "tp", targets, dom)
        cum = np.maximum(cum - cum[0], 0)  # from today's 12Z

        snow, snow_method = None, None
        try:
            if fam == "ncep":
                _, _, s = _accum_ncep(spec, run, "ASNOW", targets, dom)
                snow, snow_method = np.maximum(s - s[0], 0) * 39.37, "model snowfall (ASNOW)"
            else:
                _, _, s = _accum_ecmwf(spec, run, "sf", targets, dom)
                snow, snow_method = np.maximum(s - s[0], 0) / 25.4 * 10, "snowfall water equivalent at 10:1"
        except Exception as e:
            log.info("%s: no snowfall field (%s)", spec["label"], e)

        step = spec.get("sample_hours", 6)
        hours = list(range(lead0, targets[-1] + 1, step))
        t2m = _samples(spec, run, hours, FIELDS[fam]["t2m"], dom)
        gust = _samples(spec, run, hours, FIELDS[fam]["gust"], dom) if spec.get("gust", True) else {}

        idx = nearest_index(lat, lon, points)
        daily_p = np.diff(np.stack([[c[i, j] for i, j in idx] for c in cum]), axis=0).T / 25.4
        check_plausible(spec["label"], daily_p)

        # time-stepped fields for the interactive map; optional, never fails the model
        try:
            from . import fields
            model_fields = fields.fetch(spec, run, lead0, targets[-1], hours, {"t2m": t2m, "gust": gust}, dom)
        except Exception as e:
            log.warning("%s: hourly fields skipped (%s)", spec["label"], report.short(e))
            model_fields = {}
        # Models without 10 m wind components on the map (NBM) still publish wind speed; sample it
        # for the window's strongest sustained wind.
        wind_speed = None
        if "u10" not in model_fields and fam == "ncep":
            ws = _samples(spec, run, hours, [":WIND:10 m above ground:"], dom)
            if ws:
                hrs = sorted(ws)
                wind_speed = {"hours": hrs, "data": np.stack([ws[h] for h in hrs]) * M_S_TO_MPH}
        daily_s = (np.diff(np.stack([[c[i, j] for i, j in idx] for c in snow]), axis=0).T
                   if snow is not None else np.full_like(daily_p, np.nan))
        tmax = (_daily_extreme(t2m, lead0, ndays, idx, np.nanmax) - 273.15) * 9 / 5 + 32 if t2m else np.full_like(daily_p, np.nan)
        tmin = (_daily_extreme(t2m, lead0, ndays, idx, np.nanmin) - 273.15) * 9 / 5 + 32 if t2m else np.full_like(daily_p, np.nan)
        gmax = _daily_extreme(gust, lead0, ndays, idx, np.nanmax) * M_S_TO_MPH if gust else np.full_like(daily_p, np.nan)
        rain = np.clip(daily_p - np.nan_to_num(daily_s) / 10, 0, None)

        n = cfg["days"]

        def pad(a):
            out = np.full(n, np.nan)
            out[: min(n, len(a))] = a[:n]
            return list(out)

        data = {p["name"]: {"precipitation_sum": pad(daily_p[k]), "rain_sum": pad(rain[k]),
                            "snowfall_sum": pad(daily_s[k]), "temperature_2m_max": pad(tmax[k]),
                            "temperature_2m_min": pad(tmin[k]), "wind_gusts_10m_max": pad(gmax[k])}
                for k, p in enumerate(points)}
        dates = [(start + timedelta(days=d)).replace(tzinfo=timezone.utc).astimezone(tz).date() for d in range(n)]
        return {"id": spec["id"], "label": spec["label"], "source": "grib", "tier": spec.get("tier", "global"),
                "run": run, "lead0": lead0, "range_days": ndays, "dates": dates, "data": data,
                "lat": lat, "lon": lon, "precip_mm": cum, "snow_in": snow, "snow_method": snow_method,
                "fields": model_fields, "wind_speed": wind_speed}
    except Exception as e:
        log.exception("%s: GRIB fetch failed", spec["label"])
        report.fail(spec["label"], report.short(e))
        return None


# ---------------------------------------------------------------- ensembles

def fetch_ensemble(spec, cfg, start, points):
    """Per-member daily precip at plume points."""
    dom = cfg["domain"]
    tz = ZoneInfo(cfg["timezone"])
    try:
        probe = {**spec, "herbie": {**spec["herbie"], **spec.get("probe_member", {})}}
        run, lead0, ndays = _latest_run(probe, start)
        if run is None:
            log.warning("%s: no usable run", spec["label"])
            report.fail(spec["label"], "no complete run found on any source in the last 48 h")
            return None
        targets = [lead0 + 24 * d for d in range(ndays + 1)]

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
        dates = [(start + timedelta(days=d)).replace(tzinfo=timezone.utc).astimezone(tz).date() for d in range(ndays)]
        n = next(iter(per.values())).shape[0]
        log.info("%s: %s run, %d members, %d days", spec["label"], run.strftime("%Y-%m-%d %HZ"), n, ndays)
        return {"id": spec["id"], "label": spec["label"], "source": "grib", "run": run,
                "dates": dates, "members": per}
    except Exception as e:
        log.exception("%s: ensemble fetch failed", spec["label"])
        report.fail(spec["label"], report.short(e))
        return None


def fetch_all(cfg):
    start = day0(cfg)
    pts = cfg["points"]
    det = [m for m in (fetch_model(s, cfg, start, pts) for s in cfg["grib_models"] if s.get("enabled", True)) if m]
    plume_pts = [p for p in pts if p.get("plume")]
    ens = [e for e in (fetch_ensemble(s, cfg, start, plume_pts) for s in cfg.get("grib_ensembles", [])
                       if s.get("enabled", True)) if e]
    return det, ens
