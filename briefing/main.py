"""Build the briefing data: one JSON file plus map images, rendered by the web/ app.

    python -m briefing.main --out web/public/data            # live data
    python -m briefing.main --out web/public/data --demo     # synthetic data, no network
"""
from __future__ import annotations

import argparse
import json
import logging
import math
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import yaml

from . import (alerts, analysis, avalanche, change, cogs, context, convective, extremes, fields, impacts, landslide,
               maps, normals, observed, odds, outlooks, report, rivers, snowpack, summary, tempdep, timing, trends, urma, verify, wildfire)
from .grib import day0, day12, first_day_hours

ROOT = Path(__file__).resolve().parent
log = logging.getLogger("briefing")
TIER_ORDER = {"regional": 0, "blend": 1, "global": 2}


def model_order(models):
    return sorted(models, key=lambda m: (TIER_ORDER.get(m.get("tier"), 3), m.get("source") != "grib", m["label"]))


def safe(what: str, fn, default=None):
    """Run an optional product; on failure log it, annotate the run, and carry on without it."""
    try:
        return fn()
    except Exception as e:
        log.exception("%s failed; the briefing is published without it", what)
        report.annotate("warning", f"{what} left out", report.short(e))
        return default


def clean(x):
    """JSON-safe: NaN/inf -> None, numpy -> python, dates -> ISO strings."""
    if isinstance(x, dict):
        return {str(k): clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [clean(v) for v in x]
    if isinstance(x, np.ndarray):
        return clean(x.tolist())
    if isinstance(x, (np.floating, float)):
        f = float(x)
        return None if math.isnan(f) or math.isinf(f) else round(f, 3)
    if isinstance(x, np.integer):
        return int(x)
    if hasattr(x, "isoformat"):
        return x.isoformat()
    return x


def collect(cfg: dict, out: Path, demo: bool = False, products: bool = True) -> dict:
    """Fetch, analyse and (when `products`) draw maps and write COGs. Returns the briefing dict."""
    start = day0(cfg)
    h1 = first_day_hours(start)          # 24 for a 12Z edition; the rest of the day after 18Z, 00Z, 06Z
    if demo:
        from . import demo as src
        grib_models, grib_ens = src.grib(cfg), src.ensembles(cfg)
        sup, sup_ens = src.supplement(cfg), []
    else:
        from . import grib, points
        grib_models, grib_ens = grib.fetch_all(cfg)
        sup, sup_ens = points.fetch_deterministic(cfg, start), points.fetch_ensembles(cfg, start)

    for m in grib_models:
        m.setdefault("family", next((s["family"] for s in cfg["grib_models"] if s["id"] == m["id"]), "ncep"))
        # highest/lowest temperature, strongest wind and gust over each window, on the model's grid
        m["extremes"] = safe(f"{m['label']} extremes", lambda m=m: extremes.compute(m), {})
        # daily highs and lows for the departure maps (before the map export frees the fields)
        m["daily_temps"] = safe(f"{m['label']} daily temperatures", lambda m=m: extremes.daily_temps(m), {})
    models = model_order(grib_models + sup)
    ensembles = grib_ens + sup_ens
    # After a 00Z or 06Z start (late afternoon or night in Pacific time) the first day's afternoon
    # has passed, so its "high" would only be the evening's temperature: leave it out.
    if h1 <= 12:
        for m in models:
            for series in (m.get("data") or {}).values():
                if series.get("temperature_2m_max"):
                    series["temperature_2m_max"] = [None] + list(series["temperature_2m_max"][1:])
            if (m.get("daily_temps") or {}).get("tmax") is not None:
                m["daily_temps"]["tmax"][0] = np.nan
    if not models:
        lines = [f"{k}: {v}" for k, v in report.REASONS.items()] or ["no source reported a reason"]
        report.annotate("error", "No model data arrived", "Every source failed. " + " | ".join(lines))
        raise SystemExit("No model data arrived; nothing to brief.\n  " + "\n  ".join(lines))

    # ---- which runs made it
    expected = ([(s["label"], "model") for s in cfg["grib_models"] if s.get("enabled", True)] +
                [(s["label"], "ensemble") for s in cfg.get("grib_ensembles", []) if s.get("enabled", True)])
    if cfg.get("supplement", {}).get("enabled"):
        expected += [(s["label"], "model") for s in cfg["supplement"].get("point_models", [])]
        expected += [(s["label"], "ensemble") for s in cfg["supplement"].get("ensemble_models", [])]
    status = []
    for label, kind in expected:
        hit = next((x for x in models + ensembles if x["label"] == label), None)
        status.append({"label": label, "kind": kind, "ok": hit is not None, "reason": report.REASONS.get(label),
                       "source": (hit or {}).get("source", "grib"),
                       "run": hit["run"].strftime("%HZ %a %-m/%-d") if hit is not None and hit.get("run") else None})

    # ---- analysis
    wins = analysis.windows(cfg)
    summ = analysis.summary(models, ensembles, cfg)
    for w in summ["windows"]:
        top = max([r["hi"] for r in w["regions"]] + [0.1])
        steps = [s for s in (0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100) if s >= top * 1.05]
        w["scale"] = float(steps[0] if steps else np.ceil(top * 1.05 / 10) * 10)   # never fails on large totals
    dates, agree = impacts.detect(models, cfg)
    evts = impacts.events(dates, agree, cfg)
    tl_labels, tl, tl_detail = impacts.timeline(dates, agree)

    # ---- normals and departure from normal
    norm_cache = Path(cfg.get("cache_dir", ".cache")) / "prism"
    norm, norm_grid = safe("normals", lambda: normals.summarize(models, cfg, norm_cache, demo, first=h1 / 24), (None, None))
    tdep, tnorm_grid = safe("temperature departures", lambda: tempdep.summarize(models, cfg, norm_cache, demo), (None, None))

    # ---- forecast context: AR strength, pressure gradients, pass snow level, ensemble odds, and
    # how much has already fallen (observed). Each is optional; a failure leaves it out.
    # when the strongest gusts and heaviest precipitation come at each location (next 2 days)
    peak_timing = safe("peak timing", lambda: timing.compute(models, cfg, start))
    ar = safe("atmospheric rivers", lambda: context.atmospheric_rivers(grib_models, cfg))
    ar_out = safe("AR coast outlook", lambda: context.ar_coast(grib_models, cfg, start, analysis.windows(cfg)))
    grads = safe("pressure gradients", lambda: context.gradients(grib_models, cfg), [])
    snow_lvl = safe("pass snow level", lambda: context.snow_levels(grib_models, cfg))
    ens_odds = safe("ensemble odds", lambda: odds.point_odds(ensembles, cfg))
    obs, obs_grids = (safe("observed precipitation", lambda: observed.summarize(cfg, day12(start), norm_cache, demo), (None, None))
                      if products else (None, None))
    slide = safe("landslide index", lambda: landslide.compute(models, obs, cfg, start)) if obs else None

    # ---- maps and COGs
    img = {} if not products else {
        "observed": safe("observed maps", lambda: maps.observed(obs_grids, cfg, out / "observed.png")) if obs_grids else None,
        "short": safe("48-hour maps", lambda: maps.window_precip(grib_models, cfg, wins[0]["days"], out / "precip_48h.png")),
        "snow_short": safe("48-hour snow maps", lambda: maps.snow(grib_models, cfg, wins[0]["days"], out / "snow_48h.png")),
        "long": safe("long-range maps", lambda: maps.full_range_precip(grib_models, cfg, 7, out / "precip_long.png")),
        "snow_long": safe("7-day snow maps", lambda: maps.snow(grib_models, cfg, 7, out / "snow_7d.png")),
        **{f"{v}_short": safe(f"48-hour {v} maps", lambda v=v: maps.window_extreme(grib_models, cfg, v, wins[0]["days"], out / f"{v}_48h.png"))
           for v in extremes.VARS},
        **{f"{v}_long": safe(f"long-range {v} maps", lambda v=v: maps.full_range_extreme(grib_models, cfg, v, 7, out / f"{v}_long.png"))
           for v in extremes.VARS},
    }
    field_manifest = safe("hourly fields", lambda: fields.export(grib_models, cfg, out / "fields"), []) \
        if products and grib_models else []
    if products:
        (out / "fields.json").write_text(json.dumps(clean({"fields": field_manifest})), encoding="utf-8")
    cog_manifest = safe("GeoTIFF export", lambda: cogs.export(grib_models, cfg, out / "cogs", norm_grid), []) \
        if products and grib_models else []
    if products:
        cog_manifest += safe("ensemble odds maps", lambda: odds.grids(ensembles, cfg, out / "cogs"), [])
        if obs_grids:
            cog_manifest += safe("observed GeoTIFFs", lambda: observed.export(obs_grids, out / "cogs"), [])
        if tnorm_grid and grib_models:
            cog_manifest += safe("temperature departure maps", lambda: tempdep.grids(grib_models, cfg, tnorm_grid, out / "cogs"), [])

    # ---- per-window totals by model (regions and points)
    totals = []
    for w in wins:
        tot, ravg = analysis.point_window_totals(models, cfg, w["days"])
        totals.append({"days": w["days"], "label": w["label"], "rows": [
            {"model": m["label"], "tier": m.get("tier"), "source": m.get("source"),
             "regions": ravg[m["label"]], "points": tot[m["label"]]}
            for m in models if m["label"] in tot]})

    # ---- GRIB area means
    ordered_grib = model_order(grib_models)
    grib_rows = []
    for r, m in zip(analysis.grib_region_series(ordered_grib, cfg), ordered_grib):
        grib_rows.append({"model": r["label"], "tier": m.get("tier"), "run": m["run"].strftime("%HZ %a %-m/%-d"),
                          "windows": [{rid: (r["series"][rid][w["days"] - 1] if len(r["series"][rid]) >= w["days"] else None)
                                       for rid in cfg["regions"]} for w in wins]})

    # ---- ensembles: cumulative percentiles per point
    ens_out = []
    for e in ensembles:
        pts = {}
        for p, mem in e["members"].items():
            cum = np.cumsum(np.nan_to_num(mem), axis=1)
            pts[p] = {q: np.percentile(cum, int(q[1:]), axis=0) for q in ("p10", "p50", "p90")}
        n = next(iter(e["members"].values())).shape[0]
        ens_out.append({"label": e["label"], "members": n, "source": e.get("source", "grib"),
                        "dates": e["dates"][: len(next(iter(pts.values()))["p50"])], "points": pts})

    tz = ZoneInfo(cfg["timezone"])
    # alerts first: the wildfire tab reuses their resolved fire weather zones
    nws_alerts = safe("NWS alerts", lambda: alerts.fetch(cfg, demo)) if products else None
    data = {
        "meta": {"title": cfg["title"], "issued": datetime.now(tz), "demo": demo, "days": cfg["days"],
                 # the edition's model cycle, and how much of the first 12Z – 12Z day it covers
                 "cycle": start.strftime("%Y-%m-%dT%H:00Z"), "firstDayHours": h1,
                 "minAgreement": cfg["impacts"]["min_agreement"],
                 "hasSupplement": any(m.get("source") == "open-meteo" for m in models),
                 "sources": {"ncep": [m["label"] for m in grib_models if m.get("family") == "ncep"],
                             "ecmwf": [m["label"] for m in grib_models if m.get("family") == "ecmwf"]}},
        "regions": [{"id": rid, "name": r["name"], "short": r.get("short", r["name"])} for rid, r in cfg["regions"].items()],
        "points": [{"name": p["name"], "kind": p["kind"], "region": p.get("region"), "plume": bool(p.get("plume")), "area": p.get("area"), "zone": p.get("zone"),
                    "lat": p["lat"], "lon": p["lon"]} for p in cfg["points"]],
        "regionShapes": {rid: r["polygon"] for rid, r in cfg["regions"].items()},
        "status": status,
        "windows": summ["windows"],
        "wettest": {"start": summ["wettest_window"][0], "end": summ["wettest_window"][1],
                    "amount": summ["wettest_window"][2]},
        "events": [{**e, "points": [{"name": n, "frac": f, "peak": pk} for n, f, pk in e["points"]]} for e in evts],
        # the gust levels the wind summary grades against (see config.yaml impacts)
        "windLevels": {k: cfg["impacts"].get(k) for k in (
            "wind_gust_mph", "wind_gust_leaf_mph", "wind_gust_severe_mph", "wind_widespread_mph",
            "wind_widespread_points", "leaf_season", "wind_wet_soil_drop_mph")},
        "timeline": {"labels": tl_labels, "dates": dates, "matrix": tl, "detail": tl_detail},
        "totals": totals,
        "gribAreaMeans": grib_rows,
        "dates": models[0]["dates"],
        "models": [{"label": m["label"], "tier": m.get("tier"), "source": m.get("source"),
                    "run": m["run"].strftime("%HZ %a %-m/%-d") if m.get("run") else None,
                    "days": analysis.coverage(m), "data": m["data"]} for m in models],
        "ensembles": ens_out,
        "maps": {k: (v.name if v else None)
                 for k in ("short", "snow_short", "long", "snow_long", "observed",
                           *(f"{x}_{h}" for x in extremes.VARS for h in ("short", "long")))
                 for v in [img.get(k)]},
        "cogs": cog_manifest,
        "domain": cfg["domain"],
        "normals": norm,
        "tempDeparture": tdep,
        "alerts": nws_alerts,
        # thunderstorms: SPC convective outlooks and recent storm reports (mesoscale discussions load live)
        "convective": safe("thunderstorm outlooks", lambda: convective.fetch(cfg, demo)) if products else None,
        "timing": peak_timing,
        "wildfire": safe("wildfire", lambda: wildfire.fetch(cfg, (nws_alerts or {}).get("zones"), demo, (nws_alerts or {}).get("pages"))) if products else None,
        "ar": ar,
        "arCoast": ar_out,
        "gradients": grads,
        "snowLevel": snow_lvl,
        "odds": ens_odds,
        "observed": obs,
        "landslide": slide,
        "avalanche": safe("avalanche danger", lambda: avalanche.fetch(cfg, demo)) if products else None,
        "snowpack": safe("snowpack", lambda: snowpack.fetch(cfg, demo)) if products else None,
        "outlooks": safe("NWS discussions and outlooks", lambda: outlooks.fetch(cfg, demo)) if products else None,
        "rivers": safe("river forecasts", lambda: rivers.fetch(cfg, demo)) if products else None,
    }
    data = clean(data)
    # window cards for the snow, wind and temperature tabs, from the cleaned per-point series
    data["trends"] = clean(safe("window trends", lambda: trends.summarize(data, analysis.windows(cfg))))
    return data


def build(cfg: dict, out: Path, demo: bool = False, previous: Path | None = None, history: Path | None = None) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    if first_day_hours(day0(cfg)) < 24:
        # after a 18Z, 00Z or 06Z cycle the first window is the rest of today and tomorrow
        cfg = {**cfg, "windows": [{**w, "label": "Through tomorrow"} if w["days"] == 2 else w for w in cfg["windows"]]}
    data = collect(cfg, out, demo)

    # ---- change since the previous briefing
    prev, earlier = None, []
    if demo:
        from . import demo as src
        for k, (scale, seed) in enumerate([(0.85, 11), (0.7, 12), (1.1, 13), (0.9, 14)], start=1):   # synthetic earlier days
            src.reset(day_offset=k, scale=scale, seed=seed)
            d = collect(cfg, out, demo=True, products=False)
            d["meta"]["issued"] = (datetime.fromisoformat(data["meta"]["issued"]) - timedelta(days=k)).isoformat()
            earlier.append(d)
        prev = earlier[0]
        src.reset()
    elif previous and previous.exists():
        try:
            prev = json.loads(previous.read_text())
        except Exception as e:
            log.warning("previous briefing unreadable (%s)", e)
    if not demo and history and history.is_dir():
        # earlier days' briefings for the trends table's run-to-run sparklines
        for f in sorted(history.glob("*.json")):
            try:
                earlier.append(json.loads(f.read_text()))
            except Exception as e:
                log.warning("earlier briefing %s unreadable (%s)", f.name, e)
    if prev and not any(e.get("meta", {}).get("issued") == prev.get("meta", {}).get("issued") for e in earlier):
        earlier.append(prev)
    data["change"] = clean(safe("change since yesterday", lambda: change.compare(data, prev, analysis.windows(cfg))))
    if data["change"] is None:
        log.info("no previous briefing to compare with")
    else:
        data["change"]["trends"] = clean(safe("window trends since yesterday", lambda: trends.compare(data, prev, analysis.windows(cfg))))
    if earlier:
        data["trendHistory"] = clean(safe("trend history", lambda: trends.history(data, earlier, analysis.windows(cfg))))
        # how the models have been doing: earlier briefings' precipitation against MRMS
        data["verification"] = clean(safe("model verification", lambda: verify.verify(data, earlier)))
    # analysed highs and lows (URMA) for the recent days, reusing the ones earlier briefings fetched
    data["observedTemps"] = clean(safe("analysed temperatures (URMA)", lambda: urma.collect(cfg, earlier, demo=demo)))
    if earlier and data["observedTemps"]:
        data["tempVerification"] = clean(safe("temperature verification", lambda: verify.verify_temps(data, earlier)))

    # the headline and lead: facts from the data above, worded by a language model when a key is set
    data["summary"] = clean(safe("overview", lambda: summary.overview(data, cfg, demo)))

    ok = [x["label"] for x in data["status"] if x["ok"]]
    missing = [x["label"] for x in data["status"] if not x["ok"]]
    report.annotate("notice", "Briefing built",
                    f"{len(ok)} of {len(data['status'])} sources arrived. Missing: {', '.join(missing) or 'none'}")
    path = out / "briefing.json"
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    log.info("wrote %s (%.0f KB)", path, path.stat().st_size / 1024)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=str(ROOT.parent / "config.yaml"))
    ap.add_argument("--out", default="web/public/data")
    ap.add_argument("--demo", action="store_true")
    ap.add_argument("--previous", type=Path, help="yesterday's briefing.json, for the change view")
    ap.add_argument("--history", type=Path, help="a folder of earlier days' briefing.json files, for the trend sparklines")
    ap.add_argument("--cycle", help="the edition's model cycle, e.g. 2026-11-07T18Z (default: the latest 00/06/12/18Z at least 3 h old)")
    a = ap.parse_args()
    if a.cycle:
        import os
        os.environ["BRIEFING_CYCLE"] = a.cycle
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("herbie").setLevel(logging.WARNING)
    cfg = yaml.safe_load(open(a.config))
    build(cfg, Path(a.out), demo=a.demo, previous=a.previous, history=a.history)


if __name__ == "__main__":
    main()
