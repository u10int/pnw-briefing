"""Landslide risk from the USGS rainfall threshold for the Seattle area (Chleborad, Baum and Godt,
USGS Open-File Report 2006-1064): landslides become likely once

    P3 >= 3.5 - 0.67 * P15        (inches)

where P3 is rain over the last 3 days and P15 is rain over the 15 days before those. Written as an
index, P3 + 0.67 * P15 reaches 3.5 at the threshold, so wet antecedent weeks lower the 3-day
total it takes.

Each location's series runs from observed rain (MRMS, the past 30 days) straight into each
model's forecast days, so the index for the first forecast days is mostly what has already fallen.
The threshold was calibrated for Seattle and the nearby Puget Sound bluffs; the locations it's
applied to are set under `landslide` in config.yaml.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

log = logging.getLogger(__name__)
A, B, N3, N15 = 3.5, 0.67, 3, 15


def _r(x, nd=2):
    return None if x is None else round(float(x), nd)


def index_series(observed, forecast, a=A, b=B):
    """Per forecast day: (P3, P15, index) from a run of observed days (oldest first) followed by
    forecast days. Missing observed days count as dry; a missing forecast day ends the series."""
    obs = [0.0 if v is None else float(v) for v in observed]
    out = []
    for d, v in enumerate(forecast):
        if v is None:
            break
        seq = obs + [float(x) for x in forecast[: d + 1]]
        if len(seq) < N3 + N15:
            out.append((None, None, None))
            continue
        p3 = sum(seq[-N3:])
        p15 = sum(seq[-(N3 + N15):-N3])
        out.append((p3, p15, p3 + b * p15))
    return out


def compute(models, obs, cfg, start: datetime):
    spec = cfg.get("landslide") or {}
    names = spec.get("points") or []
    if not names or not obs or not obs.get("daily"):
        return None
    a, b = float(spec.get("threshold_in", A)), float(spec.get("p15_factor", B))
    ndays = cfg["days"]
    s = start if start.tzinfo else start.replace(tzinfo=timezone.utc)
    days = [{"start": (s + timedelta(days=d)).isoformat().replace("+00:00", "Z"),
             "end": (s + timedelta(days=d + 1)).isoformat().replace("+00:00", "Z")} for d in range(ndays)]
    points = []
    for name in names:
        past = obs["daily"].get(name)
        if not past:
            continue
        p15_now = sum(0.0 if v is None else v for v in past[-N15:])
        p3_now = sum(0.0 if v is None else v for v in past[-N3:])
        rows = []
        for m in models:
            fc = (m.get("data") or {}).get(name, {}).get("precipitation_sum")
            if not fc:
                continue
            ser = index_series(past, list(fc)[:ndays], a, b)
            if not any(x[2] is not None for x in ser):
                continue
            rows.append({"model": m["label"], "tier": m.get("tier"),
                         "p3": [_r(x[0]) for x in ser], "p15": [_r(x[1]) for x in ser], "index": [_r(x[2]) for x in ser]})
        points.append({"name": name,
                       # what has already fallen, and the 3-day rain from today that would reach the threshold
                       "observed": {"p3": _r(p3_now), "p15": _r(p15_now), "index": _r(p3_now + b * p15_now),
                                    "needed3": _r(max(0.0, a - b * p15_now))},
                       "models": rows})
    if not points:
        return None
    log.info("landslide index: %d locations, %d models", len(points), max(len(p["models"]) for p in points))
    return {"threshold": a, "p15Factor": b, "days": days, "points": points,
            "source": "USGS Open-File Report 2006-1064 (Seattle-area cumulative threshold); observed rain from MRMS"}
