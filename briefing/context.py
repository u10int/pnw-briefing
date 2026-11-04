"""Forecast context from fields the models already provide: sea-level pressure gradients between
station pairs, and snow level at the passes.

Both read each model's time-stepped map fields (briefing/fields.py) at the nearest grid cell, so
they cost no extra downloads: hourly for the regional models' first 48 hours, then every 3–6 h.
"""
from __future__ import annotations

import logging
from datetime import timedelta, timezone

import numpy as np

from .grib import nearest_index

log = logging.getLogger(__name__)


def _valid_times(m, hours):
    run = m["run"]
    run = run if run.tzinfo else run.replace(tzinfo=timezone.utc)
    return [(run + timedelta(hours=int(h))).isoformat().replace("+00:00", "Z") for h in hours]


def _at(m, var, sites):
    """{"times": [...], "values": [[site values] per time]} for one field at the nearest cells."""
    f = (m.get("fields") or {}).get(var)
    if not f or not len(f["hours"]):
        return None
    lat, lon = m["lat"], m["lon"]
    shape = lat.shape if lat.ndim == 2 else (lat.size, lon.size)
    if f["data"].shape[-2:] != shape:
        return None
    cols = []
    for s in sites:
        if lat.min() <= s["lat"] <= lat.max() and lon.min() <= s["lon"] <= lon.max():
            (i, j), = nearest_index(lat, lon, [s])
            cols.append(f["data"][:, i, j])
            continue
        # outside the map area: values read from the full grid before cropping, if this model reaches
        out = f.get("sites") or {}
        k = out.get("names", []).index(s["name"]) if s["name"] in out.get("names", []) else None
        if k is None or not np.isfinite(out["data"][:, k]).any():
            return None
        cols.append(out["data"][:, k])
    return {"times": _valid_times(m, f["hours"]), "values": np.stack(cols, axis=1)}          # [t, site]


def _r(x, nd=1):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def gradients(grib_models, cfg):
    """Pressure difference A − B (hPa) per configured station pair and model."""
    out = []
    for g in cfg.get("gradients", []):
        series = []
        for m in grib_models:
            got = _at(m, "mslp", [g["a"], g["b"]])
            if not got:
                continue
            diff = got["values"][:, 0] - got["values"][:, 1]
            series.append({"model": m["label"], "tier": m.get("tier"), "times": got["times"],
                           "values": [_r(v) for v in diff]})
        out.append({"id": g["id"], "a": g["a"]["name"], "b": g["b"]["name"],
                    "codes": [g["a"].get("code"), g["b"].get("code")], "meaning": g["meaning"],
                    "locs": [[g["a"]["lon"], g["a"]["lat"]], [g["b"]["lon"], g["b"]["lat"]]],
                    "thresholds": g.get("thresholds", []), "series": series})
    log.info("pressure gradients: %s", ", ".join(f"{g['id']} ({len(g['series'])} models)" for g in out))
    return out


def snow_levels(grib_models, cfg):
    """Snow level (freezing level minus an offset, ft) at each pass with an elevation, per model."""
    passes = [p for p in cfg["points"] if p.get("elev_ft")]
    offset = float(cfg.get("snow_level_offset_ft", 1000))
    out = []
    for p in passes:
        series = []
        for m in grib_models:
            got = _at(m, "frz", [p])
            if not got:
                continue
            series.append({"model": m["label"], "tier": m.get("tier"), "times": got["times"],
                           # below sea level means snow to sea level
                           "values": [_r(max(v - offset, 0.0), 0) for v in got["values"][:, 0]]})
        out.append({"name": p["name"], "elev_ft": p["elev_ft"], "series": series})
    log.info("snow level: %d passes, %d models with a freezing level",
             len(out), max((len(o["series"]) for o in out), default=0))
    return {"offset_ft": offset, "passes": out}


# ---------------------------------------------------------------- atmospheric rivers

# AR scale (Ralph et al. 2019, CW3E): rank from the peak IVT, +1 if IVT >= 250 lasts 48 h or more,
# -1 if it lasts under 24 h. Rank 0 is below the scale (weak and brief).
AR_BREAKS = [250, 500, 750, 1000, 1250]
AR_NAMES = {0: "Below AR scale", 1: "AR1 Weak", 2: "AR2 Moderate", 3: "AR3 Strong", 4: "AR4 Extreme",
            5: "AR5 Exceptional"}


def ar_events(hours, ivt, step=6):
    """Periods with IVT >= 250 kg m-1 s-1 at one place: start/end hours, peak, duration, AR rank."""
    out, run = [], []
    for h, v in list(zip(hours, ivt)) + [(None, None)]:
        if v is not None and np.isfinite(v) and v >= AR_BREAKS[0]:
            run.append((h, v))
            continue
        if run:
            peak_h, peak = max(run, key=lambda x: x[1])
            dur = len(run) * step
            base = sum(peak >= b for b in AR_BREAKS)
            rank = int(np.clip(base + (1 if dur >= 48 else -1 if dur < 24 else 0), 0, 5))
            out.append({"start": run[0][0], "end": run[-1][0], "peak": round(float(peak)), "peakHour": peak_h,
                        "hours": dur, "rank": rank})
            run = []
    return out


def atmospheric_rivers(grib_models, cfg):
    """IVT at the coastal locations per model, and the AR events (with scale rank) it implies."""
    coast = [p for p in cfg["points"] if p["kind"] == "coast"]
    if not coast:
        return None
    models, events = [], []
    for m in grib_models:
        ivt = m.get("ivt")
        if not ivt:
            continue
        mag = np.hypot(ivt["u"], ivt["v"])                                   # [t, y, x]
        idx = nearest_index(ivt["lat"], ivt["lon"], coast)
        hours = ivt["hours"]
        step = int(np.median(np.diff(hours))) if len(hours) > 1 else 6
        times = _valid_times(m, hours)
        series = {}
        for p, (i, j) in zip(coast, idx):
            vals = mag[:, i, j]
            series[p["name"]] = [_r(v, 0) for v in vals]
            for e in ar_events(hours, vals, step):
                events.append({"model": m["label"], "point": p["name"], "rank": e["rank"],
                               "name": AR_NAMES[e["rank"]], "peak": e["peak"], "hours": e["hours"],
                               "start": times[hours.index(e["start"])], "end": times[hours.index(e["end"])],
                               "peakTime": times[hours.index(e["peakHour"])]})
        models.append({"model": m["label"], "tier": m.get("tier"), "times": times, "ivt": series})
    if not models:
        return None
    log.info("atmospheric rivers: %d models, %d events (max rank %s)", len(models), len(events),
             max((e["rank"] for e in events), default="none"))
    return {"points": [p["name"] for p in coast], "breaks": AR_BREAKS, "models": models,
            "events": sorted(events, key=lambda e: (e["start"], e["point"], e["model"]))}
