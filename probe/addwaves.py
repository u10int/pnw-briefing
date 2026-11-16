"""Fetch the wave grids for real and add them to a copy of the published data."""
import json, sys, time, logging
from datetime import datetime, timezone
from pathlib import Path
import yaml
from briefing import waves, analysis
from briefing.grib import cycle_start
logging.basicConfig(level=logging.INFO)
cfg = yaml.safe_load(open("config.yaml"))
site = Path(sys.argv[1])
import numpy as np
ws = []
for fn in (lambda: waves.fetch(cfg, datetime.now(timezone.utc)), lambda: waves.fetch_rdwps(cfg, datetime.now(timezone.utc))):
    t0 = time.time()
    w = fn()
    print(w["label"], "fetch seconds", round(time.time() - t0), "steps", len(w["hours"]), "grid", w["lat"].shape, w["lon"].shape)
    print(w["label"], "wave max ft", float(np.nanmax(w["wave"])), "period range", float(np.nanmin(w["wper"])), float(np.nanmax(w["wper"])))
    # inland water cells with values
    la, lo = np.meshgrid(w["lat"], w["lon"], indexing="ij")
    for name, b in {"puget": (47.0, 48.0, -122.7, -122.2), "jdf": (48.1, 48.5, -124.6, -123.0), "georgia": (48.9, 49.8, -124.5, -123.2)}.items():
        m = (la >= b[0]) & (la <= b[1]) & (lo >= b[2]) & (lo <= b[3])
        print(w["label"], name, int(np.isfinite(w["wave"][6][m]).sum()), "of", int(m.sum()))
    # direction check off the coast: mean travel vector at 47N 126W
    i, j = np.abs(w["lat"] - 47).argmin(), np.abs(w["lon"] + 126).argmin()
    print(w["label"], "47N126W hs", float(w["wave"][6, i, j]), "T", float(w["wper"][6, i, j]), "travel u,v", float(w["wu"][6, i, j]), float(w["wv"][6, i, j]))
    ws.append(w)
b = json.load(open(site / "briefing.json"))
start = datetime.fromisoformat(b["meta"]["cycle"].replace("Z", "+00:00")).replace(tzinfo=None) if b["meta"].get("cycle") else cycle_start()
fm, cm = [], []
for w in ws:
    fm += waves.export_fields(w, site / "fields")
    cm += waves.export_cogs(w, analysis.windows(cfg), start, site / "cogs")
print("cogs", [(c["days"]) for c in cm])
f = json.load(open(site / "fields.json")); f["fields"] += fm; json.dump(f, open(site / "fields.json", "w"))
b["cogs"] += cm; b["waveGrids"] = [waves.summary(w, None, start) for w in ws]; json.dump(b, open(site / "briefing.json", "w"))
for w in ws:
    print(w["label"], "field MB", round(sum((site / "fields" / f"{w['id']}_{v}.tif").stat().st_size for v in waves.VARS) / 1e6, 1))

