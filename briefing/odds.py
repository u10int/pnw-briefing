"""Ensemble exceedance odds: the share of GEFS and ECMWF ENS members (pooled) that reach the
briefing's own impact thresholds, per location and day, plus gridded probability maps.

Per location the thresholds are the same ones the impacts table uses for that kind of place
(lowland, coast, pass): heavy rain over 24 hours, multi-day rain over 72 hours, and pass snow
(ECMWF ENS snowfall at 10:1; GEFS has no snowfall field). The maps use fixed amounts from
`odds_map` in config.yaml, since a map can't switch thresholds by place.
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from . import analysis
from .grib import nearest_index

log = logging.getLogger(__name__)


def _rolling3(daily):
    """3-day totals ending each day [..., d] (NaN for the first two days)."""
    out = np.full_like(daily, np.nan)
    out[..., 2:] = daily[..., :-2] + daily[..., 1:-1] + daily[..., 2:]
    return out


def _pool(parts):
    """Pooled exceedance share per day from [(hits[d], counts[d]), ...]; None where no members."""
    nd = max(len(h) for h, _ in parts)
    hits, n = np.zeros(nd), np.zeros(nd)
    for h, c in parts:
        hits[: len(h)] += h
        n[: len(c)] += c
    return [round(float(100 * a / b)) if b else None for a, b in zip(hits, n)], [int(x) for x in n]


def point_odds(ensembles, cfg):
    imp = cfg["impacts"]
    ens = [e for e in ensembles if e.get("grid")]
    if not ens:
        return None
    out = {}
    for p in cfg["points"]:
        k = p["kind"]
        t24, t72, ts = imp["heavy_rain_24h"].get(k), imp["heavy_rain_72h"].get(k), imp["snow_24h"].get(k)
        r24, r72, sn = [], [], []
        for e in ens:
            g = e["grid"]
            (i, j), = nearest_index(g["lat"], g["lon"], [p])
            d = g["precip_in"][:, :, i, j]                                   # [member, day]
            ok = np.isfinite(d)
            if t24 is not None:
                r24.append(((d >= t24).sum(0), ok.sum(0)))
            if t72 is not None:
                d3 = _rolling3(d)
                r72.append(((d3 >= t72).sum(0), np.isfinite(d3).sum(0)))
            if ts is not None and g.get("snow_in") is not None:
                s = g["snow_in"][:, :, i, j]
                sn.append(((s >= ts).sum(0), np.isfinite(s).sum(0)))
        rec = {"thresholds": {"rain24": t24, "rain72": t72, "snow24": ts}}
        for key, parts in (("rain24", r24), ("rain72", r72), ("snow24", sn)):
            if parts:
                rec[key], rec[f"{key}N"] = _pool(parts)
        out[p["name"]] = rec
    dates = max((e["dates"] for e in ens), key=len)
    return {"dates": dates, "ensembles": [{"label": e["label"], "members": int(e["grid"]["precip_in"].shape[0]),
                                            "snow": e["grid"].get("snow_in") is not None} for e in ens],
            "points": out}


def grids(ensembles, cfg, out_dir: Path):
    """Pooled probability maps per window as COGs; returns cog-manifest entries."""
    from .cogs import write_cog
    spec = cfg.get("odds_map", {"rain24_in": 1.0, "rain72_in": 3.0})
    ens = [e for e in ensembles if e.get("grid")]
    if not ens:
        return []
    glat, glon = analysis.common_grid(cfg)
    manifest = []
    for w in analysis.windows(cfg):
        n = w["days"]
        for var, thr, label in (("p24", spec["rain24_in"], f"Chance of {spec['rain24_in']:g}\" or more in a day"),
                                ("p72", spec["rain72_in"], f"Chance of {spec['rain72_in']:g}\" or more in 3 days")):
            if var == "p72" and n < 3:
                continue
            num = np.zeros(glat.shape + glon.shape)
            den = 0
            for e in ens:
                g = e["grid"]
                daily = g["precip_in"]                                          # [member, day, y, x]
                if daily.shape[1] < n:
                    continue
                amt = daily[:, :n] if var == "p24" else _rolling3(np.moveaxis(daily[:, :n], 1, -1))
                amt = amt if var == "p24" else np.moveaxis(amt, -1, 1)
                with np.errstate(invalid="ignore"):
                    hit = (np.nanmax(amt, axis=1) >= thr).astype("float32")      # [member, y, x]
                share = analysis.regrid(g["lat"], g["lon"], hit.mean(0), glat, glon)
                num = num + share * daily.shape[0]
                den += daily.shape[0]
            if not den:
                continue
            prob = 100 * num / den
            rel = f"odds_{var}_{n}d.tif"
            write_cog(out_dir / rel, glat, glon, prob, "%", f"{label}, {w['label'].lower()} (pooled ensembles)")
            manifest.append({"path": f"cogs/{rel}", "model": "Ensembles", "tier": "consensus", "var": var, "days": n,
                             "units": "%", "members": [e["label"] for e in ens], "threshold": thr})
    log.info("ensemble odds maps: %d", len(manifest))
    return manifest
