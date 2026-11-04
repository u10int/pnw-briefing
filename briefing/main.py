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

from . import alerts, analysis, change, cogs, fields, impacts, maps, normals, report
from .grib import day0

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
    models = model_order(grib_models + sup)
    ensembles = grib_ens + sup_ens
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
                       "run": hit["run"].strftime("%HZ %-d %b") if hit is not None and hit.get("run") else None})

    # ---- analysis
    wins = analysis.windows(cfg)
    summ = analysis.summary(models, ensembles, cfg)
    for w in summ["windows"]:
        top = max([r["hi"] for r in w["regions"]] + [0.1])
        steps = [s for s in (0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100) if s >= top * 1.05]
        w["scale"] = float(steps[0] if steps else np.ceil(top * 1.05 / 10) * 10)   # never fails on large totals
    dates, agree = impacts.detect(models, cfg)
    evts = impacts.events(dates, agree, cfg)
    tl_labels, tl = impacts.timeline(dates, agree)

    # ---- normals and departure from normal
    norm_cache = Path(cfg.get("cache_dir", ".cache")) / "prism"
    norm, norm_grid = safe("normals", lambda: normals.summarize(models, cfg, norm_cache, demo), (None, None))

    # ---- maps and COGs
    img = {} if not products else {
        "short": safe("48-hour maps", lambda: maps.window_precip(grib_models, cfg, wins[0]["days"], out / "precip_48h.png")),
        "snow_short": safe("48-hour snow maps", lambda: maps.snow(grib_models, cfg, wins[0]["days"], out / "snow_48h.png")),
        "long": safe("long-range maps", lambda: maps.full_range_precip(grib_models, cfg, 7, out / "precip_long.png")),
        "snow_long": safe("7-day snow maps", lambda: maps.snow(grib_models, cfg, 7, out / "snow_7d.png")),
    }
    field_manifest = safe("hourly fields", lambda: fields.export(grib_models, cfg, out / "fields"), []) \
        if products and grib_models else []
    if products:
        (out / "fields.json").write_text(json.dumps(clean({"fields": field_manifest})), encoding="utf-8")
    cog_manifest = safe("GeoTIFF export", lambda: cogs.export(grib_models, cfg, out / "cogs", norm_grid), []) \
        if products and grib_models else []

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
        grib_rows.append({"model": r["label"], "tier": m.get("tier"), "run": m["run"].strftime("%HZ %-d %b"),
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
    data = {
        "meta": {"title": cfg["title"], "issued": datetime.now(tz), "demo": demo, "days": cfg["days"],
                 "minAgreement": cfg["impacts"]["min_agreement"],
                 "hasSupplement": any(m.get("source") == "open-meteo" for m in models),
                 "sources": {"ncep": [m["label"] for m in grib_models if m.get("family") == "ncep"],
                             "ecmwf": [m["label"] for m in grib_models if m.get("family") == "ecmwf"]}},
        "regions": [{"id": rid, "name": r["name"], "short": r.get("short", r["name"])} for rid, r in cfg["regions"].items()],
        "points": [{"name": p["name"], "kind": p["kind"], "region": p.get("region"), "plume": bool(p.get("plume")),
                    "lat": p["lat"], "lon": p["lon"]} for p in cfg["points"]],
        "regionShapes": {rid: r["polygon"] for rid, r in cfg["regions"].items()},
        "status": status,
        "windows": summ["windows"],
        "wettest": {"start": summ["wettest_window"][0], "end": summ["wettest_window"][1],
                    "amount": summ["wettest_window"][2]},
        "events": [{**e, "points": [{"name": n, "frac": f, "peak": pk} for n, f, pk in e["points"]]} for e in evts],
        "timeline": {"labels": tl_labels, "dates": dates, "matrix": tl},
        "totals": totals,
        "gribAreaMeans": grib_rows,
        "dates": models[0]["dates"],
        "models": [{"label": m["label"], "tier": m.get("tier"), "source": m.get("source"),
                    "run": m["run"].strftime("%HZ %-d %b") if m.get("run") else None,
                    "days": analysis.coverage(m), "data": m["data"]} for m in models],
        "ensembles": ens_out,
        "maps": {k: (v.name if v else None) for k in ("short", "snow_short", "long", "snow_long") for v in [img.get(k)]},
        "cogs": cog_manifest,
        "domain": cfg["domain"],
        "normals": norm,
        "alerts": safe("NWS alerts", lambda: alerts.fetch(cfg, demo)) if products else None,
    }
    return clean(data)


def build(cfg: dict, out: Path, demo: bool = False, previous: Path | None = None) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    data = collect(cfg, out, demo)

    # ---- change since the previous briefing
    prev = None
    if demo:
        from . import demo as src
        src.reset(day_offset=1, scale=0.85, seed=11)   # a synthetic "yesterday"
        prev = collect(cfg, out, demo=True, products=False)
        prev["meta"]["issued"] = (datetime.fromisoformat(data["meta"]["issued"]) - timedelta(days=1)).isoformat()
        src.reset()
    elif previous and previous.exists():
        try:
            prev = json.loads(previous.read_text())
        except Exception as e:
            log.warning("previous briefing unreadable (%s)", e)
    data["change"] = clean(safe("change since yesterday", lambda: change.compare(data, prev, analysis.windows(cfg))))
    if data["change"] is None:
        log.info("no previous briefing to compare with")

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
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("herbie").setLevel(logging.WARNING)
    cfg = yaml.safe_load(open(a.config))
    build(cfg, Path(a.out), demo=a.demo, previous=a.previous)


if __name__ == "__main__":
    main()
